// 商品数据获取：接 EZSTARTCommerce 核心 API（apps/api）。
// API 契约冻结后，将这里的占位实现替换为正式的 storefront 商品接口调用。

export type Product = {
  id: string;
  name: string;
  price: number;
  currency: string;
  image?: string;
  category?: string;
};

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';

export type ProductResult =
  | { ok: true; products: Product[] }
  | { ok: false; error: 'unavailable' };

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
    const data = (await res.json()) as { items?: Product[] };
    return { ok: true, products: data.items ?? [] };
  } catch {
    // 本地未启动 API（3001）或生产 API 不可用时降级
    return { ok: false, error: 'unavailable' };
  }
}

export function formatPrice(price: number, currency = 'HK$'): string {
  return `${currency}${price.toFixed(0)}`;
}
