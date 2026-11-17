// 商品数据获取：接 EZSTARTCommerce 核心 API（apps/api）的公开前台接口。
// 对应接口：GET /api/v1/storefront/products（返回 envelope：{ data: { items, hasMore, nextCursor }, meta }）
// 字段契约见 packages/contracts/openapi.yaml 的 StorefrontProduct。

export type Product = {
  id: string;
  slug: string;
  name: string;
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
  priceMinor: number | string;
  currency: string;
  available: number;
};

type ApiProduct = {
  id: string;
  slug: string;
  name: string;
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
    const products = items.map((item) => {
      const price = startingPrice(item.variants ?? []);
      return {
        id: item.id,
        slug: item.slug,
        name: item.name,
        price: price?.price ?? 0,
        currency: price?.currency ?? 'HKD',
        inStock: item.inStock,
      };
    });
    return { ok: true, products };
  } catch {
    // 本地未启动 API（3001）或生产 API 不可用时降级
    return { ok: false, error: 'unavailable' };
  }
}

export function formatPrice(price: number, currency = 'HK$'): string {
  // 接口里 currency 是 ISO 代码（HKD），前台展示沿用站点符号
  const symbol = currency === 'HKD' || currency === 'HK$' ? 'HK$' : currency;
  return `${symbol}${price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)}`;
}
