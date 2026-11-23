// 商品数据获取：接 EZSTARTCommerce 核心 API（apps/api）的公开前台接口。
// 对应接口：GET /api/v1/storefront/products（返回 envelope：{ data: { items, hasMore, nextCursor, total }, meta }）
// 字段契约见 packages/contracts/openapi.yaml 的 StorefrontProduct。
//
// 类型与纯展示函数在 lib/product-view.ts：那边不碰 fetch，客户端组件才能复用。
// 这里的职责只有「取数 + 透出游标与总数」，列表渲染不在这里做决定。

import { toProduct, type ApiProduct, type Product } from './product-view';

export type { Product, ProductVariant } from './product-view';
// 展示函数继续从这里透传：已有的 import 路径不用为了这次拆分全改一遍。
export { formatPrice, toProduct } from './product-view';

export type ProductResult =
  | { ok: true; products: Product[]; nextCursor: string | null; total: number | null }
  | { ok: false; error: 'unavailable' };

// 语言是服务端接口的必填业务参数（不传就落到店铺默认语言）：
// 显式带上才能保证 /en/products 里看到的是英文名称，而不是缓存里另一次请求的结果。

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';
/** 与后台店铺设置的市场码一致；报价、目录都要带，否则服务端按默认市场处理。 */
const SITE_MARKET = 'HK';

type ListPage = { items: ApiProduct[]; nextCursor: string | null; total: number | null };

/**
 * 拉取在售商品列表。
 * cursor 为空时取第一页；返回的 nextCursor 交给页面续取，total 用来显示「已出现 N / 总数」。
 * 不在这里替页面翻完——一次铺几百张卡既拖慢首屏，也让运营排序失去意义。
 */
export async function fetchProducts(locale?: string, limit?: number, cursor?: string | null): Promise<ProductResult> {
  const page = await requestList(locale, limit, cursor);
  if (!page) return { ok: false, error: 'unavailable' };
  return { ok: true, products: page.items.map(toProduct), nextCursor: page.nextCursor, total: page.total };
}

/**
 * 列表请求：先带语言，实例没启用该语言（422）时退回不带语言。
 * 退一步比整页报错合理：店铺只开了一种语言时，前台仍应能买到东西。
 */
async function requestList(locale?: string, limit?: number, cursor?: string | null): Promise<ListPage | null> {
  const query = new URLSearchParams();
  if (locale) query.set('locale', locale);
  query.set('marketCode', SITE_MARKET);
  if (limit) query.set('limit', String(limit));
  if (cursor) query.set('cursor', cursor);
  const first = await getList(query);
  if (first.status === 422 && locale) {
    query.delete('locale');
    const retry = await getList(query);
    return retry.page;
  }
  return first.status === 200 ? first.page : null;
}

async function getList(query: URLSearchParams): Promise<{ status: number; page: ListPage }> {
  const empty: ListPage = { items: [], nextCursor: null, total: null };
  try {
    const res = await fetch(`${apiBase}/api/v1/storefront/products?${query.toString()}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return { status: res.status, page: empty };
    // 服务端统一返回 { data, meta } envelope，不能直接在根上取 items
    const body = (await res.json()) as { data?: { items?: ApiProduct[]; nextCursor?: string | null; total?: number | null } };
    return {
      status: 200,
      page: {
        items: body.data?.items ?? [],
        nextCursor: body.data?.nextCursor ?? null,
        total: typeof body.data?.total === 'number' ? body.data.total : null,
      },
    };
  } catch {
    // 本地未启动 API（3001）或生产 API 不可用时降级
    return { status: 0, page: empty };
  }
}

/** 单个商品详情：找不到返回 null，交给页面渲染 404。 */
export async function fetchProduct(slug: string, locale?: string): Promise<Product | null> {
  const one = async (withLocale: boolean) => {
    const query = new URLSearchParams({ marketCode: SITE_MARKET });
    if (withLocale && locale) query.set('locale', locale);
    try {
      const res = await fetch(`${apiBase}/api/v1/storefront/products/${encodeURIComponent(slug)}?${query.toString()}`, {
        next: { revalidate: 60 },
      });
      return { status: res.status, item: res.ok ? (await res.json() as { data?: ApiProduct }).data ?? null : null };
    } catch { return { status: 0, item: null }; }
  };
  const first = await one(true);
  if (first.status === 422 && locale) {
    const fallback = await one(false);
    return fallback.item ? toProduct(fallback.item) : null;
  }
  return first.item ? toProduct(first.item) : null;
}
