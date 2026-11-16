/**
 * 优惠引擎（M11）纯规则层。
 *
 * 只做“这张券能不能用、优惠多少、怎么分摊到行”，不碰数据库与网络：
 * 码格式、有效区间、最低消费、范围、次数上限、金额计算与分摊余数都在这里收敛。
 * 金额一律整数最小货币单位；百分比用整数 basis points（100 bps = 1%）。
 */

export class PromotionRuleError extends Error {
  constructor(readonly code: string) { super(code); }
}

function fail(code: string): never { throw new PromotionRuleError(code); }

export const DISCOUNT_TYPES = ['fixed', 'percent'] as const;
export const COUPON_STATUSES = ['active', 'disabled'] as const;
export const REDEMPTION_STATUSES = ['reserved', 'redeemed', 'released', 'expired'] as const;
export const REFUND_POLICIES = ['none', 'restore'] as const;
export const MAX_PERCENT_BPS = 10_000;
/** 固定额上限 1,000,000.00（最小货币单位），防止一次输错把整店毛利打穿。 */
export const MAX_FIXED_DISCOUNT_MINOR = 100_000_000;
export const MAX_COUPON_TOTAL_LIMIT = 1_000_000;
export const MAX_PER_CUSTOMER_LIMIT = 1_000;
export const MAX_SCOPE_ITEMS = 200;
export const MAX_TIER_ITEMS = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,79}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type DiscountType = (typeof DISCOUNT_TYPES)[number];
export type CouponStatus = (typeof COUPON_STATUSES)[number];
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];
export type RefundPolicy = (typeof REFUND_POLICIES)[number];

/** 券规则的可判定形状：数据库行与请求体都先归一化到这个形状。 */
export interface CouponRule {
  code: string;
  status: CouponStatus;
  discountType: DiscountType;
  discountValue: number;
  currency: string;
  validFrom: Date;
  validUntil: Date;
  minSubtotalMinor: number | null;
  totalLimit: number | null;
  perCustomerLimit: number | null;
  eligibleProductIds: string[];
  eligibleCategoryIds: string[];
  memberTierIds: string[];
  refundPolicy: RefundPolicy;
}

export interface CouponLine {
  key: string;
  productId: string;
  categoryIds: readonly string[];
  amountMinor: number;
}

function integer(value: unknown, code: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function optionalInteger(value: unknown, code: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  return integer(value, code, min, max);
}

function timestamp(value: unknown, code: string): Date {
  if (typeof value !== 'string') fail(code);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(code);
  return date;
}

function uuidList(value: unknown, code: string, limit: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limit) fail(code);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !UUID.test(item)) fail(code);
    if (seen.has(item)) fail(code); // 重复项没有业务含义，说明客户端在拼凑范围
    seen.add(item);
  }
  return [...seen];
}

/** 优惠码 trim + uppercase；空串按“未使用”处理。 */
export function normalizeCouponCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('couponCode');
  const code = value.trim().toUpperCase();
  if (!code.length) return null;
  if (!CODE.test(code)) fail('couponCode');
  return code;
}

/** 只用于展示与日志：保住首尾各 2 位，中间打码；短码只留最后一位。 */
export function maskCouponCode(code: string): string {
  if (code.length <= 4) return `${'*'.repeat(Math.max(0, code.length - 1))}${code.slice(-1)}`;
  return `${code.slice(0, 2)}${'*'.repeat(Math.min(8, code.length - 4))}${code.slice(-2)}`;
}

/** 创建券：所有字段必须一次性给全；币种取自店铺基础币种，不接受客户端指定。 */
export function normalizeCoupon(input: Record<string, unknown>, currency: string): CouponRule {
  if (!CURRENCY.test(currency)) fail('currency');
  const code = normalizeCouponCode(input['code']);
  if (code === null) fail('code');
  const discountType = input['discountType'];
  if (typeof discountType !== 'string' || !DISCOUNT_TYPES.includes(discountType as DiscountType)) fail('discountType');
  const discountValue = discountType === 'percent'
    ? integer(input['discountValue'], 'discountValue', 1, MAX_PERCENT_BPS)
    : integer(input['discountValue'], 'discountValue', 1, MAX_FIXED_DISCOUNT_MINOR);
  const validFrom = timestamp(input['validFrom'], 'validFrom');
  const validUntil = timestamp(input['validUntil'], 'validUntil');
  if (validUntil.getTime() <= validFrom.getTime()) fail('validity');
  const status = input['status'] ?? 'active';
  if (typeof status !== 'string' || !COUPON_STATUSES.includes(status as CouponStatus)) fail('status');
  const refundPolicy = input['refundPolicy'] ?? 'none';
  if (typeof refundPolicy !== 'string' || !REFUND_POLICIES.includes(refundPolicy as RefundPolicy)) fail('refundPolicy');
  return {
    code, status: status as CouponStatus, discountType: discountType as DiscountType, discountValue, currency,
    validFrom, validUntil,
    minSubtotalMinor: optionalInteger(input['minSubtotalMinor'], 'minSubtotalMinor', 0, MAX_FIXED_DISCOUNT_MINOR),
    totalLimit: optionalInteger(input['totalLimit'], 'totalLimit', 1, MAX_COUPON_TOTAL_LIMIT),
    perCustomerLimit: optionalInteger(input['perCustomerLimit'], 'perCustomerLimit', 1, MAX_PER_CUSTOMER_LIMIT),
    eligibleProductIds: uuidList(input['eligibleProductIds'], 'eligibleProductIds', MAX_SCOPE_ITEMS),
    eligibleCategoryIds: uuidList(input['eligibleCategoryIds'], 'eligibleCategoryIds', MAX_SCOPE_ITEMS),
    memberTierIds: uuidList(input['memberTierIds'], 'memberTierIds', MAX_TIER_ITEMS),
    refundPolicy: refundPolicy as RefundPolicy,
  };
}

/**
 * PATCH 只改给出的字段，但类型/面值必须成对校验：
 * 单独把 percent 的额度留在 50000 bps 而只改类型为 fixed，会得到一张五万元的券。
 */
export function mergeCouponPatch(current: CouponRule, patch: Record<string, unknown>): CouponRule {
  const merged: Record<string, unknown> = {
    code: current.code, status: current.status, discountType: current.discountType,
    discountValue: current.discountValue, validFrom: current.validFrom.toISOString(),
    validUntil: current.validUntil.toISOString(), minSubtotalMinor: current.minSubtotalMinor,
    totalLimit: current.totalLimit, perCustomerLimit: current.perCustomerLimit,
    eligibleProductIds: current.eligibleProductIds, eligibleCategoryIds: current.eligibleCategoryIds,
    memberTierIds: current.memberTierIds, refundPolicy: current.refundPolicy,
  };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) continue;
    merged[key] = patch[key];
  }
  // 清空可空字段必须显式传 null；undefined 保留原值（上面的循环已经跳过）。
  return normalizeCoupon(merged, current.currency);
}

/** 有效区间为 validFrom <= now < validUntil；停用优先于时间。 */
export function couponState(coupon: { status: string; validFrom: Date; validUntil: Date }, now: Date) {
  if (coupon.status === 'disabled') return 'disabled' as const;
  if (now.getTime() < coupon.validFrom.getTime()) return 'not_started' as const;
  if (now.getTime() >= coupon.validUntil.getTime()) return 'expired' as const;
  return 'active' as const;
}

export function assertCouponUsable(coupon: { status: string; validFrom: Date; validUntil: Date;
  currency: string }, now: Date, currency: string) {
  const state = couponState(coupon, now);
  if (state === 'disabled') fail('COUPON_DISABLED');
  if (state === 'not_started') fail('COUPON_NOT_STARTED');
  if (state === 'expired') fail('COUPON_EXPIRED');
  if (coupon.currency !== currency) fail('COUPON_CURRENCY_MISMATCH');
}

export function assertMinSubtotal(coupon: { minSubtotalMinor: number | null }, subtotalMinor: number) {
  if (coupon.minSubtotalMinor !== null && subtotalMinor < coupon.minSubtotalMinor) fail('COUPON_MIN_SUBTOTAL_NOT_MET');
}

/** 范围为空 = 全部商品；商品与分类是“或”关系，任一命中即可。 */
export function couponLineEligible(coupon: { eligibleProductIds: readonly string[];
  eligibleCategoryIds: readonly string[] }, line: { productId: string; categoryIds: readonly string[] }) {
  if (!coupon.eligibleProductIds.length && !coupon.eligibleCategoryIds.length) return true;
  if (coupon.eligibleProductIds.includes(line.productId)) return true;
  return line.categoryIds.some(id => coupon.eligibleCategoryIds.includes(id));
}

export function eligibleLines<T extends CouponLine>(coupon: { eligibleProductIds: readonly string[];
  eligibleCategoryIds: readonly string[] }, lines: readonly T[]): T[] {
  return lines.filter(line => couponLineEligible(coupon, line));
}

/**
 * 优惠金额：固定额取 min(面值, 符合条件金额)；百分比按最小货币单位 half-up 舍入，
 * 且不超过符合条件金额——任何情况下都不能把商品金额打成负数。
 */
export function couponDiscount(coupon: { discountType: string; discountValue: number }, eligibleSubtotalMinor: number) {
  if (!Number.isSafeInteger(eligibleSubtotalMinor) || eligibleSubtotalMinor < 0) fail('subtotal');
  if (eligibleSubtotalMinor === 0) return 0;
  if (coupon.discountType === 'fixed') return Math.min(coupon.discountValue, eligibleSubtotalMinor);
  if (coupon.discountType !== 'percent') fail('discountType');
  const scaled = BigInt(eligibleSubtotalMinor) * BigInt(coupon.discountValue);
  // (x + 5000) / 10000 的整数版本即 half-up。
  const rounded = (scaled + 5_000n) / 10_000n;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) fail('discount');
  return Math.min(value, eligibleSubtotalMinor);
}

/**
 * 固定额与百分比都按行金额比例分摊；整数余数按订单行创建顺序逐行 +1。
 * 调用方必须按订单行创建顺序传入（报价/订单写入都使用这个顺序）。
 */
export function allocateDiscount(lines: readonly { key: string; amountMinor: number }[], discountMinor: number) {
  if (!Number.isSafeInteger(discountMinor) || discountMinor < 0) fail('discount');
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (discountMinor === 0) return new Map(lines.map(line => [line.key, 0]));
  if (!lines.length) fail('discount');
  if (discountMinor > total) fail('DISCOUNT_EXCEEDS_SUBTOTAL');
  const shares = lines.map(line => {
    const share = (BigInt(line.amountMinor) * BigInt(discountMinor)) / BigInt(total);
    return Number(share);
  });
  let remainder = discountMinor - shares.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < lines.length && remainder > 0; index += 1) {
    if (shares[index]! < lines[index]!.amountMinor) { shares[index] = shares[index]! + 1; remainder -= 1; }
  }
  if (remainder !== 0) fail('DISCOUNT_ALLOCATION_FAILED');
  return new Map(lines.map((line, index) => [line.key, shares[index]!]));
}

/** 总次数与单顾客次数都只统计“预占 + 已核销”，返还过的额度已经扣回。 */
export function assertUsageLimits(coupon: { totalLimit: number | null; perCustomerLimit: number | null },
  usedTotal: number, usedByCustomer: number | null) {
  if (coupon.totalLimit !== null && usedTotal >= coupon.totalLimit) fail('COUPON_LIMIT_REACHED');
  if (coupon.perCustomerLimit !== null && usedByCustomer !== null && usedByCustomer >= coupon.perCustomerLimit)
    fail('COUPON_CUSTOMER_LIMIT_REACHED');
}

/** 核销状态机只进不退：reserved 只能去 redeemed / released / expired，其余为终态。 */
export function assertRedemptionTransition(from: RedemptionStatus, to: RedemptionStatus) {
  const allowed: Record<RedemptionStatus, readonly RedemptionStatus[]> = {
    reserved: ['redeemed', 'released', 'expired'],
    redeemed: [], released: [], expired: [],
  };
  if (!allowed[from].includes(to)) fail('STATE_CONFLICT');
}

/** 订单/报价里的券快照：规则后续被改也不能改变这张单的金额与解释。 */
export function couponSnapshot(coupon: CouponRule & { id: string; version: number }, discountMinor: number) {
  return {
    couponId: coupon.id, code: coupon.code, codeMasked: maskCouponCode(coupon.code),
    discountType: coupon.discountType, discountValue: coupon.discountValue, discountMinor,
    currency: coupon.currency, minSubtotalMinor: coupon.minSubtotalMinor,
    totalLimit: coupon.totalLimit, perCustomerLimit: coupon.perCustomerLimit,
    validFrom: coupon.validFrom.toISOString(), validUntil: coupon.validUntil.toISOString(),
    eligibleProductIds: coupon.eligibleProductIds, eligibleCategoryIds: coupon.eligibleCategoryIds,
    refundPolicy: coupon.refundPolicy, ruleVersion: coupon.version,
  };
}

/** 规则说明只用于审计详情，不含任何顾客联系方式。 */
export function describeCoupon(coupon: { code: string; discountType: string; discountValue: number }) {
  const value = coupon.discountType === 'percent'
    ? `${(coupon.discountValue / 100).toFixed(2)}%`
    : `${coupon.discountValue} minor units`;
  return `${coupon.code} (${value})`.slice(0, 200);
}

/** 控制字符会把日志/CSV 导出撑坏；码与备注都拒绝。 */
export function assertPrintable(value: string, code = 'VALIDATION_ERROR') {
  if (CONTROL.test(value)) fail(code);
}
