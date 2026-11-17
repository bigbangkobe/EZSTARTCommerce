// 商品数据获取：接 EZSTARTCommerce 核心 API（apps/api）的公开前台接口。
// 对应接口：GET /api/v1/storefront/products（返回 envelope：{ data: { items, hasMore, nextCursor }, meta }）
// 字段契约见 packages/contracts/openapi.yaml 的 StorefrontProduct。

export type ProductVariant = {
  id: string;
  sku: string;
  optionValues: Record<string, string>;
  price: number;
  currency: string;
  available: number;
};

export type Product = {
  id: string;
  slug: string;
  name: string;
  /** 商品描述（缺省时退回短描述） */
  description?: string | null;
  variants: ProductVariant[];
  /** 起售价（主单位，已由最小货币单位换算） */
  price: number;
  currency: string;
  image?: string;
  category?: string;
  inStock: boolean;
};

export type ProductResult =
  | { ok: true; products: Product[] }
  | { ok: false; error: 'unavailable' };

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';

type ApiVariant = {
  id: string;
  sku: string;
  optionValues?: Record<string, string>;
  priceMinor: number | string;
  currency: string;
  available: number;
};

type ApiProduct = {
  id: string;
  slug: string;
  name: string;
  shortDescription?: string | null;
  description?: string | null;
  variants: ApiVariant[];
  media: { mediaId: string; position: number }[];
  inStock: boolean;
};

/** 起售价 = 所有可售变体里最低价；金额是 BigInt 序列化后的最小货币单位。 */
function startingPrice(variants: ApiVariant[]): { price: number; currency: string } | null {
  const priced = variants
    .map((variant) => ({ minor: Number(variant.priceMinor), currency: variant.currency }))
    .filter((item) => Number.isFinite(item.minor) && item.minor >= 0);
  if (!priced.length) return null;
  const lowest = priced.reduce((left, right) => (right.minor < left.minor ? right : left));
  return { price: lowest.minor / 100, currency: lowest.currency };
}

/**
 * 拉取在售商品列表。
 * API 未就绪或不可达时返回 ok:false，前台展示空态/错误态，不阻断页面渲染。
 */
export async function fetchProducts(): Promise<ProductResult> {
  try {
    const res = await fetch(`${apiBase}/api/v1/storefront/products`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return { ok: false, error: 'unavailable' };
    // 服务端统一返回 { data, meta } envelope，不能直接在根上取 items
    const body = (await res.json()) as { data?: { items?: ApiProduct[] } };
    const items = body.data?.items ?? [];
    return { ok: true, products: items.map(toProduct) };
  } catch {
    // 本地未启动 API（3001）或生产 API 不可用时降级
    return { ok: false, error: 'unavailable' };
  }
}

/** 单个商品详情：找不到返回 notFound，交给页面渲染 404。 */
export async function fetchProduct(slug: string): Promise<Product | null> {
  try {
    const res = await fetch(`${apiBase}/api/v1/storefront/products/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: ApiProduct };
    return body.data ? toProduct(body.data) : null;
  } catch { return null; }
}

function toProduct(item: ApiProduct): Product {
  const price = startingPrice(item.variants ?? []);
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    description: item.description ?? item.shortDescription ?? null,
    variants: (item.variants ?? []).map((variant) => ({ id: variant.id, sku: variant.sku,
      optionValues: variant.optionValues ?? {}, price: Number(variant.priceMinor) / 100,
      currency: variant.currency, available: variant.available })),
    price: price?.price ?? 0,
    currency: price?.currency ?? 'HKD',
    inStock: item.inStock,
  };
}

export function formatPrice(price: number, currency = 'HK$'): string {
  // 接口里 currency 是 ISO 代码（HKD），前台展示沿用站点符号
  const symbol = currency === 'HKD' || currency === 'HK$' ? 'HK$' : currency;
  return `${symbol}${price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)}`;
}
