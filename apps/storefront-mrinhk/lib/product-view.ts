// 商品展示层：类型 + 纯函数（起售价、主图、价格格式化）。
// 这里刻意不 import fetch、不读 process.env，客户端组件（「载入更多」）也能直接复用；
// 否则客户端包会把服务端取数逻辑一起打进去。

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

export type ApiVariant = {
  id: string;
  sku: string;
  optionValues?: Record<string, string>;
  priceMinor: number | string;
  currency: string;
  available: number;
};

export type ApiProduct = {
  id: string;
  slug: string;
  name: string;
  shortDescription?: string | null;
  description?: string | null;
  variants: ApiVariant[];
  media: { mediaId: string; position: number }[];
  inStock: boolean;
};

/**
 * 商品图走同源相对路径：浏览器请求 /api/v1/storefront/media/<id>，
 * 由 next.config 的 rewrite 转给 API（服务端只放 ready 对象，ETag 用内容摘要）。
 * 不拼绝对域名，避免本地预览与线上各写一份。
 */
export const MEDIA_PATH = '/api/v1/storefront/media';

/** 起售价 = 所有可售变体里最低价；金额是 BigInt 序列化后的最小货币单位。 */
export function startingPrice(variants: ApiVariant[]): { price: number; currency: string } | null {
  const priced = variants
    .map((variant) => ({ minor: Number(variant.priceMinor), currency: variant.currency }))
    .filter((item) => Number.isFinite(item.minor) && item.minor >= 0);
  if (!priced.length) return null;
  const lowest = priced.reduce((left, right) => (right.minor < left.minor ? right : left));
  return { price: lowest.minor / 100, currency: lowest.currency };
}

/** 主图 = 排位最靠前的那张；没有媒体时返回 undefined，卡片退回首字母占位。 */
export function primaryImage(media: { mediaId: string; position?: number }[] | undefined): string | undefined {
  const ordered = [...(media ?? [])].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  const first = ordered[0];
  return first?.mediaId ? `${MEDIA_PATH}/${first.mediaId}` : undefined;
}

export function toProduct(item: ApiProduct): Product {
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
    image: primaryImage(item.media),
    inStock: item.inStock,
  };
}

export function formatPrice(price: number, currency = 'HK$'): string {
  // 接口里 currency 是 ISO 代码（HKD），前台展示沿用站点符号
  const symbol = currency === 'HKD' || currency === 'HK$' ? 'HK$' : currency;
  return `${symbol}${price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)}`;
}
