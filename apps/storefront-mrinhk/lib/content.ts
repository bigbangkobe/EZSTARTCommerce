// 内容页数据获取：读 EZSTARTCommerce 的公开前台接口。
// 对应接口：GET /api/v1/storefront/pages/{slug}、GET /api/v1/storefront/pages、
// GET /api/v1/storefront/preview/{token}、GET /api/v1/storefront/redirect?path=
// （envelope: { data, meta }）
// 字段契约见 packages/contracts/openapi.yaml 的 PublicPage / PublicPageSummary。
//
// 关键事实：接口只返回**已发布版本快照**。保存草稿不会改变这里的数据，
// 因此前台不需要（也不允许）自己判断哪段内容该不该显示。

export type ContentBlock = {
  id: string;
  type: 'rich_text' | 'faq_list' | 'contact_card' | 'notice';
  position: number;
  config: Record<string, unknown>;
};

export type ContentAlternate = { locale: string; slug: string };

export type ContentPage = {
  pageKey: string;
  pageType: string;
  locale: string;
  slug: string;
  title: string;
  seoTitle: string | null;
  seoDescription: string | null;
  indexable: boolean;
  blocks: ContentBlock[];
  alternates: ContentAlternate[];
  version: number;
  contentRelease: string;
};

export type ContentPageSummary = {
  pageKey: string;
  pageType: string;
  locale: string;
  slug: string;
  title: string;
  indexable: boolean;
  alternates: ContentAlternate[];
};

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';

type Envelope<T> = { data?: T };

async function getJson<T>(path: string): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${apiBase}/api/v1/storefront/${path}`, { next: { revalidate: 60 } });
    if (!res.ok) return { status: res.status, data: null };
    const body = (await res.json()) as Envelope<T>;
    return { status: 200, data: body.data ?? null };
  } catch {
    // API 不可用时不阻断页面渲染：调用方按空态处理。
    return { status: 0, data: null };
  }
}

/**
 * 单个内容页。实例没启用该语言（422）时退回不带语言，
 * 与商品列表同一策略：店铺只开一种语言时仍要能打开政策页。
 */
export async function fetchPage(slug: string, locale?: string): Promise<ContentPage | null> {
  const one = async (withLocale: boolean) => {
    const query = new URLSearchParams();
    if (withLocale && locale) query.set('locale', locale);
    const search = query.toString();
    return getJson<ContentPage>(`pages/${encodeURIComponent(slug)}${search ? `?${search}` : ''}`);
  };
  const first = await one(true);
  if (first.status === 422 && locale) return (await one(false)).data;
  return first.data;
}

/** 已发布内容页清单：导航与站点地图用，只含地址与索引资格。 */
export async function fetchPages(locale?: string): Promise<ContentPageSummary[]> {
  const query = new URLSearchParams();
  if (locale) query.set('locale', locale);
  const search = query.toString();
  const first = await getJson<{ items: ContentPageSummary[] }>(`pages${search ? `?${search}` : ''}`);
  if (first.status === 422 && locale) return (await getJson<{ items: ContentPageSummary[] }>('pages')).data?.items ?? [];
  return first.data?.items ?? [];
}

/**
 * 内容发布标记（cr-N）：主题把它作为区块埋点的 publishVersionId。
 * 取不到时返回固定标记——埋点字段必须是合法短标识，不能为空。
 */
export async function fetchContentRelease(locale?: string): Promise<string> {
  const query = new URLSearchParams();
  if (locale) query.set('locale', locale);
  const search = query.toString();
  const config = await getJson<{ contentRelease?: string }>(`config${search ? `?${search}` : ''}`);
  const value = config.data?.contentRelease;
  return typeof value === 'string' && /^cr-[0-9]+$/.test(value) ? value : 'cr-0';
}

export type PreviewPage = Omit<ContentPage, 'contentRelease'> & {
  preview: true;
  viewport: 'mobile' | 'desktop';
  expiresAt: string;
};

/**
 * 预览页：带 token 才能读，且**永远不缓存**（草稿会继续被编辑，缓存会把旧草稿钉在链接上）。
 * 返回 null 表示 token 过期或不存在——两种情况看起来必须一样。
 */
export async function fetchPreview(token: string): Promise<PreviewPage | null> {
  try {
    const res = await fetch(`${apiBase}/api/v1/storefront/preview/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as Envelope<PreviewPage>;
    return body.data ?? null;
  } catch {
    return null;
  }
}

/**
 * 旧地址解析（改过 slug 的页面）：命中才返回目标，未命中返回 null。
 * 前台据此发 301；接口不可用时也返回 null——宁可 404，也不猜一个地址把访客送错。
 */
export async function fetchRedirect(path: string): Promise<{ toPath: string; statusCode: number } | null> {
  try {
    const query = new URLSearchParams({ path });
    const res = await fetch(`${apiBase}/api/v1/storefront/redirect?${query.toString()}`, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    const body = (await res.json()) as Envelope<{ redirect: { toPath: string; statusCode: number } | null }>;
    const redirect = body.data?.redirect ?? null;
    return redirect && redirect.toPath.startsWith('/') ? redirect : null;
  } catch {
    return null;
  }
}

/** 摘要长度上限：够读出一句完整意思，又不至于把索引页变成正文列表。 */
const EXCERPT_MAX = 120;

/**
 * 段落拼接：中文段落之间不加空格（「過程， 時間」读起来是断的），拉丁文之间要留空格。
 * 用「前一段结尾 / 后一段开头是否 CJK」判断，混合语言（中文正文夹 WhatsApp）也能得到正常结果。
 */
function joinParagraphs(parts: readonly string[]): string {
  const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
  return parts.reduce((merged, part) => {
    if (!merged) return part;
    const glue = cjk.test(merged.slice(-1)) || cjk.test(part.slice(0, 1)) ? '' : ' ';
    return `${merged}${glue}${part}`;
  }, '');
}

/**
 * 从已发布区块里取一段摘要（索引页用）。
 *
 * 只读第一个有文字的区块，按「正文 → FAQ 首问 → 联络卡正文 → 提示」的顺序取：
 * 索引页是入口，不是正文，几条并列的摘要是让访客判断「要不要点进去」，
 * 因此不拼多个区块，也不改写成营销话术——正文说什么就摘什么。
 *
 * 区块 config 在服务端发布时已按类型白名单校验过，这里仍逐字段做类型判断：
 * 快照是历史数据，旧版本可能缺字段，读不到文字就安静返回 null。
 */
export function pageExcerpt(blocks: readonly ContentBlock[]): string | null {
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
  let raw: string | null = null;
  for (const block of blocks) {
    const config = block.config;
    if (block.type === 'rich_text') {
      const paragraphs = Array.isArray(config['paragraphs']) ? (config['paragraphs'] as unknown[]) : [];
      const joined = joinParagraphs(paragraphs.map(paragraph => text(paragraph))
        .filter((item): item is string => item !== null));
      raw = text(joined) ?? text(config['heading']);
    } else if (block.type === 'faq_list') {
      const items = Array.isArray(config['items']) ? (config['items'] as unknown[]) : [];
      const first = items[0] as Record<string, unknown> | undefined;
      raw = text(first?.['question']);
    } else if (block.type === 'contact_card') {
      raw = text(config['body']) ?? text(config['heading']);
    } else if (block.type === 'notice') {
      raw = text(config['text']);
    }
    if (raw) break;
  }
  if (!raw) return null;
  // 正文里的换行与连续空白在列表里没有意义（HTML 会折叠），先压平再按长度截断。
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX).trimEnd()}…` : flat;
}
