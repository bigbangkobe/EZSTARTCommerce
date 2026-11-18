/**
 * 商店设置（M01）的纯规则层。
 *
 * 这里只做不依赖数据库的判断：语言/币种/时区/市场的字段校验、市场审核状态机，
 * 以及“未审核市场不得开放交易”的判定。审核记录本身只保存客户提供的依据，
 * 不代表系统对目标市场作出法规结论。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'zh-HK', 'en'] as const;
export type StoreLocale = (typeof SUPPORTED_LOCALES)[number];

/** 实例认识的功能开关；未知开关一律拒绝，避免写入无人实现的配置。 */
export const FEATURE_FLAGS = ['guestCheckout', 'memberOtpLogin', 'codPayment', 'onlinePayment', 'ageVerification', 'analyticsEnabled'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export const DEFAULT_FEATURE_FLAGS: Readonly<Record<FeatureFlag, boolean>> = {
  // 访客结账是产品基线；会员登录、货到付款默认开启；线上支付与年龄验证需按市场审核后再开。
  // 分析采集默认关闭：未经批准的追踪不得默认启用，须由店主显式打开并配合同意策略。
  guestCheckout: true, memberOtpLogin: true, codPayment: true, onlinePayment: false, ageVerification: false,
  analyticsEnabled: false,
};

export type ReviewDecision = 'approved' | 'rejected' | 'revoked';
export type ReviewStatus = 'pending' | ReviewDecision | 'expired';

export class StoreRuleError extends Error {
  constructor(readonly field: string) { super(field); }
}

const fail = (field: string): never => { throw new StoreRuleError(field); };

export interface StoreSettings {
  displayName: string;
  locales: readonly string[];
  defaultLocale: string;
  baseCurrency: string;
  timezone: string;
  featureFlags: Readonly<Record<string, boolean>>;
  logoMediaId: string | null;
  faviconMediaId: string | null;
}

export interface MarketInput { marketCode: string; enabled: boolean; eligibleProductIds?: readonly string[] }

export interface MarketState {
  marketCode: string;
  enabled: boolean;
  eligibleProductIds: readonly string[];
  reviewStatus: string;
  reviewValidUntil: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeMarketCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,16}$/.test(code)) fail('marketCode');
  return code;
}

/** 时区必须是运行时真实存在的 IANA 区域，不能只校验字符串形状。 */
export function isValidTimezone(value: string): boolean {
  if (!value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

export function effectiveReviewStatus(status: string, validUntil: Date | null, now: Date): ReviewStatus {
  if (status === 'approved' && validUntil && validUntil.getTime() <= now.getTime()) return 'expired';
  return status as ReviewStatus;
}

/** 规范并校验整套设置；任何一项不合法都抛 StoreRuleError，由 API 映射为 422。 */
export function normalizeStoreSettings(input: StoreSettings): StoreSettings {
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 120) fail('displayName');

  const locales = [...new Set(input.locales.map(locale => locale.trim()))];
  if (locales.length < 1 || locales.length > SUPPORTED_LOCALES.length) fail('locales');
  if (locales.some(locale => !(SUPPORTED_LOCALES as readonly string[]).includes(locale))) fail('locales');
  if (!locales.includes(input.defaultLocale)) fail('defaultLocale');

  if (!/^[A-Z]{3}$/.test(input.baseCurrency)) fail('baseCurrency');
  if (!isValidTimezone(input.timezone)) fail('timezone');

  const flags: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(input.featureFlags)) {
    if (!(FEATURE_FLAGS as readonly string[]).includes(key) || typeof value !== 'boolean') fail('featureFlags');
  }
  for (const flag of FEATURE_FLAGS) flags[flag] = input.featureFlags[flag] ?? DEFAULT_FEATURE_FLAGS[flag];
  for (const key of ['logoMediaId', 'faviconMediaId'] as const) {
    const value = input[key];
    if (value !== null && !UUID.test(value)) fail(key);
  }

  return { displayName, locales, defaultLocale: input.defaultLocale, baseCurrency: input.baseCurrency,
    timezone: input.timezone, featureFlags: flags, logoMediaId: input.logoMediaId, faviconMediaId: input.faviconMediaId };
}

/** 按审核结论推导市场的新状态：审核通过也不自动开放交易，开放仍需显式启用。 */
export function marketAfterReview(decision: ReviewDecision, validUntil: Date | null, now: Date) {
  if (decision === 'approved' && validUntil && validUntil.getTime() <= now.getTime()) fail('validUntil');
  return { enabled: false, reviewStatus: decision as ReviewStatus, reviewValidUntil: decision === 'approved' ? validUntil : null };
}

export function marketView(market: MarketState, now: Date) {
  const reviewStatus = effectiveReviewStatus(market.reviewStatus, market.reviewValidUntil, now);
  return {
    marketCode: market.marketCode,
    // 过期或未通过的审核使既有启用状态立即失效，不等清理任务。
    enabled: market.enabled && reviewStatus === 'approved',
    eligibleProductIds: [...market.eligibleProductIds],
    reviewStatus,
    reviewValidUntil: reviewStatus === 'approved' ? market.reviewValidUntil?.toISOString() ?? null : null,
  };
}

/** 只有当前有效通过的审核才允许把市场设为启用。 */
export function assertMarketCanEnable(market: MarketState, now: Date): void {
  const status = effectiveReviewStatus(market.reviewStatus, market.reviewValidUntil, now);
  if (status !== 'approved') fail('marketProfiles');
}

/** eligibleProductIds 只在格式层校验；商品是否存在、能否进入该市场在发布时复核。 */
export function normalizeMarketInput(input: MarketInput): { marketCode: string; enabled: boolean; eligibleProductIds: string[] } {
  const marketCode = normalizeMarketCode(input.marketCode);
  const ids = input.eligibleProductIds ?? [];
  if (new Set(ids).size !== ids.length || ids.some(id => !UUID.test(id))) fail('eligibleProductIds');
  return { marketCode, enabled: input.enabled === true, eligibleProductIds: [...ids] };
}
