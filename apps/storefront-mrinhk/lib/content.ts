// 内容页数据获取：读 EZSTARTCommerce 的公开前台接口。
// 对应接口：GET /api/v1/storefront/pages/{slug}、GET /api/v1/storefront/pages（envelope: { data, meta }）
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
