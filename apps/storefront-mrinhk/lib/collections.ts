// 专题数据获取：列表与「专题详情 + 排版」。
// 与分类页同一口径：详情一次请求拿齐专题信息、已发布版面与平铺商品；
// 没有版面时按运营编排的商品顺序展示，不让专题页因为还没排版而变成空白页。

import { toProduct, type Product } from './products';

export type CollectionSummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
  productCount: number;
  alternates?: { locale: string; slug: string }[];
};

export type CollectionSection = {
  sectionId: string;
  title: string;
  sortMode: string;
  products: Product[];
};

export type CollectionDetail = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
};

export type CollectionResult =
  | { ok: true; collection: CollectionDetail; layout: { version: number; sections: CollectionSection[] } | null;
    products: Product[]; alternates: { locale: string; slug: string }[]; contentRelease: string }
  | { ok: false; error: 'not_found' | 'unavailable' };

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';
const SITE_MARKET = 'HK';

type ApiSection = { sectionId?: string; title?: string; sortMode?: string; products?: Parameters<typeof toProduct>[0][] };

/** 专题列表：接口不可用时返回 empty+ok=false，前台据此显示「暂时无法加载」而不是整页 404。 */
export async function fetchCollections(locale: string): Promise<{ ok: boolean; items: CollectionSummary[] }> {
  const query = new URLSearchParams({ locale, marketCode: SITE_MARKET });
  try {
    const response = await fetch(`${apiBase}/api/v1/storefront/collections?${query.toString()}`, {
      next: { revalidate: 60 },
    });
    if (!response.ok) return { ok: false, items: [] };
    const body = (await response.json()) as { data?: { items?: CollectionSummary[] } };
    return { ok: true, items: (body.data?.items ?? []).filter(item => item.slug) };
  } catch {
    return { ok: false, items: [] };
  }
}

/**
 * 专题详情。404 与「接口挂了」必须区分：
 * 前者是专题真的不存在（该 404 或按登记的 301 跳转），后者只该显示「暂时无法加载」。
 */
export async function fetchCollection(slug: string, locale: string): Promise<CollectionResult> {
  const query = new URLSearchParams({ locale, marketCode: SITE_MARKET });
  try {
    const response = await fetch(
      `${apiBase}/api/v1/storefront/collections/${encodeURIComponent(slug)}?${query.toString()}`,
      { next: { revalidate: 30 } },
    );
    if (response.status === 404) return { ok: false, error: 'not_found' };
    if (!response.ok) return { ok: false, error: 'unavailable' };
    const body = (await response.json()) as { data?: {
      collection?: { id?: string; name?: string; slug?: string; description?: string | null; position?: number };
      layout?: { version?: number; sections?: ApiSection[] } | null;
      products?: Parameters<typeof toProduct>[0][];
      alternates?: { locale: string; slug: string }[];
      contentRelease?: string;
    } };
    const collection = body.data?.collection;
    if (!collection?.id) return { ok: false, error: 'unavailable' };
    const sections = (body.data?.layout?.sections ?? []).map(section => ({
      sectionId: String(section.sectionId ?? ''), title: String(section.title ?? ''),
      sortMode: String(section.sortMode ?? 'manual'),
      products: (section.products ?? []).map(item => toProduct(item)),
    })).filter(section => section.sectionId && section.products.length > 0);
    return {
      ok: true,
      collection: { id: collection.id, name: collection.name ?? '', slug: collection.slug ?? slug,
        description: collection.description ?? null, position: collection.position ?? 0 },
      layout: body.data?.layout ? { version: body.data.layout.version ?? 1, sections } : null,
      products: (body.data?.products ?? []).map(item => toProduct(item)),
      alternates: body.data?.alternates ?? [],
      contentRelease: body.data?.contentRelease ?? 'cr-0',
    };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}
