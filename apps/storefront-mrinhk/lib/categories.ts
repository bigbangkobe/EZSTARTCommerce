// 分类页数据获取：分类列表与「分类详情 + 排版」。
// 分类详情一次请求拿齐分类信息、已发布版面与平铺商品：版面没发布时直接渲染商品，
// 不让分类页因为运营还没排班而变成空白页。

import { toProduct, type Product } from './products';

export type CategorySummary = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  position: number;
  /** 列表接口带（站点地图用）；详情接口把 alternates 放在顶层，分类自身不带。 */
  alternates?: CategoryAlternate[];
};

export type CategoryAlternate = { locale: string; slug: string };

export type CategorySection = {
  sectionId: string;
  title: string;
  sortMode: string;
  products: Product[];
};

export type CategoryDetail = CategorySummary & { slug: string };

export type CategoryResult =
  | { ok: true; category: CategoryDetail; layout: { version: number; sections: CategorySection[] } | null;
    products: Product[]; alternates: CategoryAlternate[]; contentRelease: string }
  | { ok: false; error: 'not_found' | 'unavailable' };

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';
const SITE_MARKET = 'HK';

type ApiSection = { sectionId?: string; title?: string; sortMode?: string; products?: Parameters<typeof toProduct>[0][] };

/** 分类列表：接口不可用时返回空集合，导航与分类页据此显示空状态而不是整页报错。 */
export async function fetchCategories(locale: string): Promise<{ ok: boolean; items: CategorySummary[] }> {
  const query = new URLSearchParams({ locale, marketCode: SITE_MARKET });
  try {
    const response = await fetch(`${apiBase}/api/v1/storefront/categories?${query.toString()}`, {
      next: { revalidate: 60 },
    });
    if (!response.ok) return { ok: false, items: [] };
    const body = (await response.json()) as { data?: { items?: CategorySummary[] } };
    return { ok: true, items: (body.data?.items ?? []).filter(item => item.slug) };
  } catch {
    return { ok: false, items: [] };
  }
}

/**
 * 分类详情。404 与「接口挂了」必须区分开：
 * 前者是分类真的不存在（该 404），后者只该显示「暂时无法加载」，不能让已收录的分类页消失。
 */
export async function fetchCategory(slug: string, locale: string): Promise<CategoryResult> {
  const query = new URLSearchParams({ locale, marketCode: SITE_MARKET });
  try {
    const response = await fetch(
      `${apiBase}/api/v1/storefront/categories/${encodeURIComponent(slug)}?${query.toString()}`,
      { next: { revalidate: 30 } },
    );
    if (response.status === 404) return { ok: false, error: 'not_found' };
    if (!response.ok) return { ok: false, error: 'unavailable' };
    const body = (await response.json()) as { data?: {
      category?: CategorySummary & { slug?: string };
      layout?: { version?: number; sections?: ApiSection[] } | null;
      products?: Parameters<typeof toProduct>[0][];
      alternates?: CategoryAlternate[];
      contentRelease?: string;
    } };
    const category = body.data?.category;
    if (!category?.id) return { ok: false, error: 'unavailable' };
    const sections = (body.data?.layout?.sections ?? []).map(section => ({
      sectionId: String(section.sectionId ?? ''), title: String(section.title ?? ''),
      sortMode: String(section.sortMode ?? 'manual'),
      products: (section.products ?? []).map(item => toProduct(item)),
    })).filter(section => section.sectionId && section.products.length > 0);
    return {
      ok: true,
      category: { ...category, slug: category.slug ?? slug },
      layout: body.data?.layout ? { version: body.data.layout.version ?? 1, sections } : null,
      products: (body.data?.products ?? []).map(item => toProduct(item)),
      alternates: body.data?.alternates ?? [],
      contentRelease: body.data?.contentRelease ?? 'cr-0',
    };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}
