import type { Copy } from './i18n';

// 会员身份的浏览器端调用层。
//
// 与游客购物袋的区别：会员会话 cookie（ez_member_session）是 HttpOnly 且 path=/api/v1，
// 前端读不到原文；登出这类「撤销」写操作必须带会话派生的 CSRF 令牌。
// 令牌只在两种情况下到手：刚验证成功（verify 响应），或读取自己的档案（profile 响应）。
// 因此这里把它放 sessionStorage，并在每次 profile 成功后刷新——刷新页面、开新标签都不会丢。

export type MemberTierView = {
  code: string;
  rank: number;
  nameByLocale: Record<string, string>;
  benefits: string[];
};

export type MemberProfileView = {
  memberNo: string;
  status: string;
  joinedAt: string;
  displayName: string;
  email: string | null;
  csrfToken: string;
  loyalty: {
    balance: number;
    accountStatus: string;
    lifetimeSpendMinor: number;
    tier: MemberTierView | null;
    minorPerPoint: number;
    pointsEnabled: boolean;
  };
};

export type MemberOrderView = {
  orderNumber: string;
  orderStatus: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  totalMinor: number;
  placedAt: string;
  linkedAt: string;
};

export type MemberPointsView = {
  balance: number;
  accountStatus: string;
  lifetimeSpendMinor: number;
  tier: (MemberTierView & { minorPerPoint: number }) | null;
  minorPerPoint: number;
  pointsExpiryMonths: number | null;
  enabled: boolean;
  items: {
    id: string;
    deltaPoints: number;
    balanceAfter: number;
    entryType: string;
    sourceType: string;
    sourceRef: string | null;
    reasonCode: string;
    reason: string | null;
    createdAt: string;
  }[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type OtpChallengeView = {
  challengeId: string;
  challengeAccepted: boolean;
  resendAfterSeconds: number;
  expiresInSeconds: number;
};

export type MemberLoginView = {
  member: { memberNo: string; status: string; joinedAt: string; displayName: string; email: string | null };
  csrfToken: string;
  expiresAt: string;
};

type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };
export type MemberOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code?: string; message?: string };

const CSRF_KEY = 'ez_member_csrf';

/** sessionStorage 在隐私模式或 SSR 下可能不可用，一律按「没有令牌」处理。 */
function readCsrf(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.sessionStorage.getItem(CSRF_KEY);
    return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberCsrf(token: string | undefined) {
  if (typeof window === 'undefined' || !token || !/^[0-9a-f]{64}$/.test(token)) return;
  try {
    window.sessionStorage.setItem(CSRF_KEY, token);
  } catch {
    // 存不进去也不致命：下次 profile 会再给一次。
  }
}

function forgetCsrf() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(CSRF_KEY);
  } catch {
    // 忽略：清不掉也不影响服务端已撤销的会话。
  }
}

async function call<T>(method: string, path: string, body?: unknown,
  { csrf = false }: { csrf?: boolean } = {}): Promise<MemberOutcome<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf) {
    const token = readCsrf();
    // 本地没有令牌就不发请求：服务端只会回 403，不如直接提示重新登入。
    if (!token) return { ok: false, status: 403, code: 'NO_CSRF', message: '請重新登入後再試' };
    headers['x-csrf-token'] = token;
  }
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method, headers, credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', message: '網絡異常，請稍後再試' };
  }
  const text = await response.text();
  let json: Envelope<T> | null = null;
  try {
    json = text ? JSON.parse(text) as Envelope<T> : null;
  } catch {
    // 204 或非 JSON 错误页
  }
  if (!response.ok) {
    return { ok: false, status: response.status, code: json?.error?.code, message: json?.error?.message };
  }
  return { ok: true, data: (json?.data ?? null) as T };
}

/** 验证码请求：响应形状对已登记与未登记邮箱一致，页面不做任何「是否存在」判断。 */
export function requestOtp(email: string, locale: string): Promise<MemberOutcome<OtpChallengeView>> {
  return call<OtpChallengeView>('POST', '/storefront/member/otp/request',
    { email, locale, purpose: 'member_login' });
}

export async function verifyOtp(challengeId: string, code: string): Promise<MemberOutcome<MemberLoginView>> {
  const result = await call<MemberLoginView>('POST', '/storefront/member/otp/verify', { challengeId, code });
  if (result.ok) rememberCsrf(result.data.csrfToken);
  return result;
}

export async function fetchProfile(): Promise<MemberOutcome<MemberProfileView>> {
  const result = await call<MemberProfileView>('GET', '/storefront/member/profile');
  if (result.ok) rememberCsrf(result.data.csrfToken);
  return result;
}

export function fetchOrders(limit = 20, cursor?: string): Promise<MemberOutcome<{
  items: MemberOrderView[]; hasMore: boolean; nextCursor: string | null }>> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return call('GET', `/storefront/member/orders?${query.toString()}`);
}

export function fetchPoints(limit = 20, cursor?: string): Promise<MemberOutcome<MemberPointsView>> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return call('GET', `/storefront/member/points?${query.toString()}`);
}

/** 登出必须在服务端撤销会话，不能只清本地状态。 */
export async function logout(): Promise<MemberOutcome<null>> {
  const result = await call<null>('POST', '/storefront/member/logout', undefined, { csrf: true });
  // 无论服务端是否接受（例如会话已过期），本地令牌都要作废。
  if (result.ok || result.status === 401 || result.status === 403) forgetCsrf();
  return result;
}

/** 页面文案统一由调用方传入（当前语言的字典）：接口只给 code，措辞与语言由前台决定。 */
export function memberErrorMessage(error: { status: number; code?: string }, t: Copy): string {
  if (error.code === 'NETWORK' || error.status === 0) return t.member.networkError;
  switch (error.code) {
    case 'UNAUTHORIZED': return error.status === 401 ? t.member.codeInvalid : t.member.signInRequired;
    case 'RATE_LIMITED': return t.member.rateLimited;
    case 'FORBIDDEN': return t.member.forbidden;
    case 'VALIDATION_ERROR': return t.member.validation;
    case 'SERVICE_NOT_READY': return t.member.serviceNotReady;
    default: return error.status >= 500 ? t.member.serverError : t.member.fallbackError;
  }
}
