// 游客购物袋的浏览器端调用层。
// 会话完全由 cookie 承载：ez_guest_cart（HttpOnly）+ ez_cart_csrf（可读，双提交用），
// 全部走同源 /api/v1（Next rewrite 反代到核心 API），浏览器不感知内网地址。

export type CartLineView = {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceMinor: number;
  lineSubtotalMinor: number;
  available: boolean;
  availableQuantity: number;
};

export type CartView = {
  cartId: string;
  currency: string;
  locale: string | null;
  itemCount: number;
  subtotalMinor: number;
  items: CartLineView[];
  warnings: string[];
  expiresAt: string;
};

export type ShippingMethodView = {
  id: string;
  code: string;
  name: string;
  feeMinor: number;
  estimatedMinDays: number | null;
  estimatedMaxDays: number | null;
  codEnabled: boolean;
};

export type QuoteView = {
  quoteId: string;
  version: number;
  expiresAt: string;
  currency: string;
  lines: { variantId: string; sku: string; productName: string; quantity: number;
    unitPriceMinor: number; lineSubtotalMinor: number; lineTotalMinor: number }[];
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  pointsRequested: number;
  pointsRedeemed: number;
  pointsValueMinor: number;
  pointsRuleVersion: string | null;
  shippingMethod: { code: string; name: string; estimatedMinDays: number | null; estimatedMaxDays: number | null };
  warnings: string[];
};

export type OrderCreatedView = {
  orderId: string;
  publicOrderNumber: string;
  orderStatus: string;
  paymentStatus: string;
  currency: string;
  totalMinor: number;
  pointsRedeemed: number;
  pointsValueMinor: number;
  paymentAction: { type: string; redirectUrl: string | null; instructions: string | null };
};

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
export type ApiOutcome<T> = { ok: true; data: T } | { ok: false; status: number; code?: string; message?: string };

/** 购物袋 CSRF 采用双提交：cookie 里的值原样放请求头。 */
function cartCsrf(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)ez_cart_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** 所有写操作共用：没有 CSRF cookie 就先建袋。 */
export async function ensureCart(): Promise<ApiOutcome<CartView>> {
  const existing = await api<CartView>('GET', '/storefront/cart');
  if (existing.ok) return existing;
  if (existing.status === 401) {
    // 401 = 还没有购物袋（或已转换/过期），创建会种下两个 cookie
    return api<CartView>('POST', '/storefront/cart');
  }
  return existing;
}

export async function api<T>(method: string, path: string, body?: unknown,
  { write = false, idempotencyKey }: { write?: boolean; idempotencyKey?: string } = {}): Promise<ApiOutcome<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const csrf = cartCsrf();
  if (write && !csrf) return { ok: false, status: 403, code: 'NO_CSRF', message: '購物袋尚未建立' };
  if (write && csrf) headers['x-csrf-token'] = csrf;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', message: '網絡異常，請稍後再試' };
  }
  const text = await response.text();
  let json: Envelope<T> | null = null;
  try { json = text ? JSON.parse(text) as Envelope<T> : null; } catch { /* 空响应（204 等） */ }
  if (!response.ok || (response.status >= 400 && json?.data === undefined && json !== null && json.error)) {
    return { ok: false, status: response.status, code: json?.error?.code, message: json?.error?.message };
  }
  return { ok: true, data: (json?.data ?? (text === '' ? null : json)) as T };
}

export async function addToCart(variantId: string, quantity: number): Promise<ApiOutcome<CartView>> {
  const ensured = await ensureCart();
  if (!ensured.ok) return ensured;
  return api<CartView>('POST', '/storefront/cart/items', { variantId, quantity }, { write: true });
}

export async function updateCartItem(itemId: string, quantity: number): Promise<ApiOutcome<CartView>> {
  return api<CartView>('PATCH', `/storefront/cart/items/${itemId}`, { quantity }, { write: true });
}

export async function removeCartItem(itemId: string): Promise<ApiOutcome<null>> {
  return api<null>('DELETE', `/storefront/cart/items/${itemId}`, undefined, { write: true });
}

export async function listShippingMethods(countryCode: string, locale: string): Promise<ApiOutcome<{ items: ShippingMethodView[] }>> {
  return api<{ items: ShippingMethodView[] }>('GET',
    `/storefront/checkout/shipping-methods?countryCode=${encodeURIComponent(countryCode)}&locale=${encodeURIComponent(locale)}`);
}

export type QuoteRequest = {
  cartId: string;
  locale: string;
  marketCode: string;
  contact: { fullName?: string; phone?: string };
  shippingAddress: { recipientName?: string; phone?: string; countryCode: string; city?: string;
    district?: string; addressLine1: string; addressLine2?: string };
  shippingMethodId: string;
  pointsToUse?: number;
  policyAcceptances: { policyKey: string; version: string; accepted: true }[];
};

export async function createQuote(request: QuoteRequest): Promise<ApiOutcome<QuoteView>> {
  return api<QuoteView>('POST', '/storefront/checkout/quote', request, { write: true });
}

export async function placeOrder(quoteId: string, confirmedQuoteVersion: number,
  paymentMethodCode: string, customerNote?: string): Promise<ApiOutcome<OrderCreatedView>> {
  return api<OrderCreatedView>('POST', '/storefront/checkout/orders',
    { quoteId, confirmedQuoteVersion, paymentMethodCode, ...(customerNote ? { customerNote } : {}) },
    { write: true, idempotencyKey: crypto.randomUUID() });
}
/** 购物袋变化后通知页头徽标等组件刷新。 */
export function notifyCartUpdated() {
  window.dispatchEvent(new CustomEvent('cart-updated'));
}

export function formatMinor(minor: number, currency = 'HKD'): string {
  const symbol = currency === 'HKD' ? 'HK$' : currency;
  const value = minor / 100;
  return `${symbol}${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}`;
}
