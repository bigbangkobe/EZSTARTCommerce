// 第一方匿名事件采集 SDK（M14 第二批）。
//
// 安全与隐私不变量：
// - sessionId 是浏览器随机生成的高熵串（crypto.randomUUID），不来自购物袋 token、手机号、邮箱。
// - 只有店铺开关 analyticsEnabled 打开、且访客明示同意（ez_analytics_consent=granted）时才上报。
// - 只上报页面标识/匿名桶，不含姓名、电话、邮箱、地址、完整 URL 或支付凭证；source 只发 UTM 来源标识。
// - 不上报 purchase：成交由服务端订单权威归因，浏览器事件不进经营指标。
// - fire-and-forget：上报失败绝不影响加购/结账主流程；事件用随机 eventId 幂等。

export type AnalyticsEventName = 'page_view' | 'view_item' | 'add_to_cart' | 'begin_checkout'
  | 'section_impression' | 'section_click';
export type DeviceClass = 'desktop' | 'mobile' | 'tablet';

const SESSION_KEY = 'ez_analytics_session_id';
const CONSENT_COOKIE = 'ez_analytics_consent';
const SCHEMA_VERSION = '1.0';

type EventInput = {
  eventName: AnalyticsEventName;
  pageKey?: string;
  locale?: string;
  deviceClass?: DeviceClass;
  marketCode?: string;
  variantId?: string;
  interactionId?: string;
  source?: string;
  sectionId?: string;
  sectionKey?: string;
  placementId?: string;
  publishVersionId?: string;
};

let enabledCache: boolean | null = null;

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** 随机会话 ID：localStorage 持久化，跨页面保持稳定；不跨设备。 */
function sessionId(): string {
  try {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // 隐私模式禁用 localStorage 时，退化为内存会话（同页多次事件仍归到同一 id）。
    return (globalThis as unknown as { __ezAnalyticsSession?: string }).__ezAnalyticsSession
      ?? ((globalThis as unknown as { __ezAnalyticsSession?: string }).__ezAnalyticsSession = crypto.randomUUID().replace(/-/g, ''));
  }
}

function consent(): 'granted' | 'denied' | 'unknown' {
  const value = readCookie(CONSENT_COOKIE);
  return value === 'granted' ? 'granted' : value === 'denied' ? 'denied' : 'unknown';
}

/** 供未来的告知横幅调用；首期默认未授予（unknown），不采集。 */
export function setAnalyticsConsent(granted: boolean): void {
  document.cookie = `${CONSENT_COOKIE}=${granted ? 'granted' : 'denied'}; Path=/; Max-Age=${365 * 86400}; SameSite=Lax`;
}

function deviceClass(): DeviceClass {
  const width = window.innerWidth;
  return width < 640 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop';
}

/** 读取店铺采集开关，结果缓存到本次会话（后台改开关后刷新页面生效）。 */
async function isEnabled(): Promise<boolean> {
  if (enabledCache !== null) return enabledCache;
  try {
    const response = await fetch('/api/v1/storefront/config', { cache: 'no-store' });
    if (!response.ok) { enabledCache = false; return false; }
    const json = await response.json() as { data?: { featureFlags?: Record<string, boolean> } };
    enabledCache = json.data?.featureFlags?.analyticsEnabled === true;
    return enabledCache;
  } catch {
    enabledCache = false;
    return false;
  }
}

/** 上报单个事件：三重门槛（开关、同意、事件白名单），失败静默。 */
export async function track(input: EventInput): Promise<void> {
  try {
    if (consent() !== 'granted') return;
    if (!await isEnabled()) return;
    const csrf = readCookie('ez_cart_csrf');
    if (!csrf) return; // 还没有购物袋（没有 CSRF cookie），本事件放弃；关键路径事件会在建袋后重来。
    const event = {
      eventId: crypto.randomUUID(),
      sessionId: sessionId(),
      eventName: input.eventName,
      occurredAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      consentState: 'granted',
      ...(input.pageKey ? { pageKey: input.pageKey } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.deviceClass ? { deviceClass: input.deviceClass } : { deviceClass: deviceClass() }),
      ...(input.marketCode ? { marketCode: input.marketCode } : {}),
      ...(input.variantId ? { variantId: input.variantId } : {}),
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.sectionId ? { sectionId: input.sectionId } : {}),
      ...(input.sectionKey ? { sectionKey: input.sectionKey } : {}),
      ...(input.placementId ? { placementId: input.placementId } : {}),
      ...(input.publishVersionId ? { publishVersionId: input.publishVersionId } : {}),
    };
    // keepalive 保证页面跳转时事件仍能送达；不 await 结果，绝不阻塞主流程。
    void fetch('/api/v1/storefront/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ events: [event] }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 采集失败不影响业务。
  }
}

/** 页面浏览：首页/商品列表/商品详情各调用一次。 */
export function trackPageView(pageKey: string, locale?: string): void {
  void track({ eventName: 'page_view', pageKey, ...(locale ? { locale } : {}) });
}

/** 商品浏览：商品详情页调用。 */
export function trackViewItem(variantId: string, pageKey: string, locale?: string): void {
  void track({ eventName: 'view_item', variantId, pageKey, ...(locale ? { locale } : {}) });
}

/** 加购成功：在 addToCart 成功后调用。 */
export function trackAddToCart(variantId: string, pageKey: string, locale?: string): void {
  void track({ eventName: 'add_to_cart', variantId, pageKey, ...(locale ? { locale } : {}) });
}

/** 开始结账：在创建报价（createQuote）之前调用。 */
export function trackBeginCheckout(pageKey: string, locale?: string, marketCode?: string): void {
  void track({ eventName: 'begin_checkout', pageKey, ...(locale ? { locale } : {}), ...(marketCode ? { marketCode } : {}) });
}

/**
 * 区块曝光：主题按「区块至少 50% 进入可视区域并持续 1 秒」上报。
 * 是否重复由调用方按会话+页面+区块去重；服务端再按 sessionId 去重一次。
 */
export function trackSectionImpression(input: { pageKey: string; sectionId: string; sectionKey: string;
  publishVersionId: string; placementId?: string; locale?: string }): void {
  void track({ eventName: 'section_impression', ...input });
}

/** 区块点击：带上被点击商品（若有）与本次交互的随机 interactionId，供 24 小时归因。 */
export function trackSectionClick(input: { pageKey: string; sectionId: string; sectionKey: string;
  publishVersionId: string; placementId?: string; locale?: string; variantId?: string; interactionId: string }): void {
  void track({ eventName: 'section_click', ...input });
}
