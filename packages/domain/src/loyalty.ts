/**
 * 会员等级与积分（M10 第二批）纯规则层。
 *
 * 只回答四件事：等级怎么定、积分怎么算、余额能不能扣、调整单长什么样。
 * 不碰数据库、不碰时钟——所有函数输入输出都是普通值，便于逐条断言。
 *
 * 三条口径：
 * 1. 积分只用整数运算：金额是「分」，换算率是「多少分换 1 点」，不足 1 点的零头直接舍去，
 *    绝不预支（舍入方向影响对账，不能两头都占）。
 * 2. 等级按 rank 而不是金额排序：两个等级门槛相同时，rank 大的才更高，结果确定。
 * 3. 余额不可为负是硬约束：扣减、兑换、退款回冲都走 applyDelta，负数一律拒绝，
 *    不允许"先欠着"这种账。
 */

import { SUPPORTED_LOCALES } from './store.js';
import { normalizeNames, ShippingRuleError } from './shipping.js';

export class LoyaltyRuleError extends Error {
  constructor(readonly field: string, readonly code = 'VALIDATION_ERROR') { super(field); }
}

function fail(field: string, code?: string): never { throw new LoyaltyRuleError(field, code); }

/**
 * 等级名沿用配送区的本地化名校验（同一套长度与去空白规则），
 * 但错误类型必须换成积分自己的：调用方按错误类型分派，类型不对就变成 500。
 */
function names(value: unknown): Record<string, string> {
  try { return normalizeNames(value as Record<string, string>, SUPPORTED_LOCALES.length); }
  catch (error) { if (error instanceof ShippingRuleError) fail('nameByLocale'); throw error; }
}

/** 流水里的规则版本：规则改了要升版本，历史流水保留旧版本号，便于解释当时的计算口径。 */
export const LOYALTY_RULE_VERSION = 'loyalty-v1';
/** 兑换快照单独标版本：换算率与上限改了以后，旧报价仍按当时的版本解释。 */
export const LOYALTY_REDEEM_RULE_VERSION = 'loyalty-redeem-v1';

export const loyaltyPolicy = Object.freeze({
  /** 单笔人工调整的绝对值上限：防止误操作一次性写入天文数字。 */
  maxAdjustmentPoints: 1_000_000,
  /** 换算率上限对应的最小分母（1）与最大分母（100 万）在迁移里也有 CHECK。 */
  maxMinorPerPoint: 1_000_000,
  maxTierRank: 100,
  maxBenefits: 20,
  maxBenefitLength: 120,
  maxReasonLength: 1_000,
  maxCodeLength: 40,
});

const CODE = /^[A-Z0-9][A-Z0-9-]{0,39}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,79}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const TIER_STATUSES = ['active', 'retired'] as const;
export type TierStatus = typeof TIER_STATUSES[number];

export interface TierInput {
  code: string;
  nameByLocale: Record<string, string>;
  rank: number;
  minLifetimeSpendMinor: number;
  minorPerPoint: number | null;
  benefits: string[];
  status: TierStatus;
}

export interface AdjustmentInput { deltaPoints: number; reasonCode: string; reason: string }

export interface SettingPatch { enabled?: boolean; minorPerPoint?: number; pointsExpiryMonths?: number | null }

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(field);
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail(field);
  const trimmed = value.trim();
  if (!trimmed.length || trimmed.length > max || CONTROL.test(trimmed)) fail(field);
  return trimmed;
}

/** 等级编码 trim + 大写：gold 与 GOLD 是同一个等级，不能并存。 */
export function normalizeTierCode(value: unknown): string {
  if (typeof value !== 'string') fail('code');
  const code = value.trim().toUpperCase();
  if (!CODE.test(code)) fail('code');
  return code;
}

export function normalizeRank(value: unknown): number {
  return integer(value, 'rank', 1, loyaltyPolicy.maxTierRank);
}

/** 门槛是累计消费的「分」：0 表示不限，任何会员都够得着。 */
export function normalizeMinSpend(value: unknown): number {
  return integer(value, 'minLifetimeSpendMinor', 0, Number.MAX_SAFE_INTEGER);
}

/** 空/未给表示沿用店铺口径；给了就必须是正整数，不允许 0（0 会让积分变成无穷大）。 */
export function normalizeMinorPerPoint(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, 'minorPerPoint', 1, loyaltyPolicy.maxMinorPerPoint);
}

/** 权益只是给人看的短句，不做结构化承诺；超过上限或带控制字符一律拒绝。 */
export function normalizeBenefits(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('benefits');
  if (value.length > loyaltyPolicy.maxBenefits) fail('benefits');
  const list = value.map(entry => text(entry, 'benefits', loyaltyPolicy.maxBenefitLength));
  return [...new Set(list)];
}

export function normalizeTierStatus(value: unknown): TierStatus {
  if (value === undefined) return 'active';
  if (typeof value !== 'string' || !(TIER_STATUSES as readonly string[]).includes(value)) fail('status');
  return value as TierStatus;
}

/** 新建等级：六个字段全必填（status 可省，默认 active）。 */
export function normalizeTierInput(body: Record<string, unknown>): TierInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body');
  return {
    code: normalizeTierCode(body['code']),
    nameByLocale: names(body['nameByLocale']),
    rank: normalizeRank(body['rank']),
    minLifetimeSpendMinor: normalizeMinSpend(body['minLifetimeSpendMinor']),
    minorPerPoint: normalizeMinorPerPoint(body['minorPerPoint']),
    benefits: normalizeBenefits(body['benefits']),
    status: normalizeTierStatus(body['status']),
  };
}

/** 改等级：只改出现的字段；空补丁直接拒绝，避免"看起来保存成功了但什么都没改"。 */
export function normalizeTierPatch(body: Record<string, unknown>): Partial<TierInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body');
  const patch: Partial<TierInput> = {};
  if (body['code'] !== undefined) patch.code = normalizeTierCode(body['code']);
  if (body['nameByLocale'] !== undefined) {
    patch.nameByLocale = names(body['nameByLocale']);
  }
  if (body['rank'] !== undefined) patch.rank = normalizeRank(body['rank']);
  if (body['minLifetimeSpendMinor'] !== undefined) patch.minLifetimeSpendMinor = normalizeMinSpend(body['minLifetimeSpendMinor']);
  if (body['minorPerPoint'] !== undefined) patch.minorPerPoint = normalizeMinorPerPoint(body['minorPerPoint']);
  if (body['benefits'] !== undefined) patch.benefits = normalizeBenefits(body['benefits']);
  if (body['status'] !== undefined) patch.status = normalizeTierStatus(body['status']);
  if (!Object.keys(patch).length) fail('body', 'EMPTY_PATCH');
  return patch;
}

/** 店铺口径补丁：三个字段都可选，但至少要有一个。 */
export function normalizeSettingPatch(body: Record<string, unknown>): SettingPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body');
  const patch: SettingPatch = {};
  if (body['enabled'] !== undefined) {
    if (typeof body['enabled'] !== 'boolean') fail('enabled');
    patch.enabled = body['enabled'];
  }
  if (body['minorPerPoint'] !== undefined) {
    patch.minorPerPoint = integer(body['minorPerPoint'], 'minorPerPoint', 1, loyaltyPolicy.maxMinorPerPoint);
  }
  if (body['pointsExpiryMonths'] !== undefined) {
    const value = body['pointsExpiryMonths'];
    patch.pointsExpiryMonths = value === null ? null : integer(value, 'pointsExpiryMonths', 1, 120);
  }
  if (!Object.keys(patch).length) fail('body', 'EMPTY_PATCH');
  return patch;
}

/** 人工调整：必须带原因码与原因文本，金额不为 0。 */
export function normalizeAdjustment(body: Record<string, unknown>): AdjustmentInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body');
  const deltaPoints = integer(body['deltaPoints'], 'deltaPoints', -loyaltyPolicy.maxAdjustmentPoints, loyaltyPolicy.maxAdjustmentPoints);
  if (deltaPoints === 0) fail('deltaPoints');
  const reasonCode = text(body['reasonCode'], 'reasonCode', 80);
  if (!REASON_CODE.test(reasonCode)) fail('reasonCode');
  const reason = text(body['reason'], 'reason', loyaltyPolicy.maxReasonLength);
  return { deltaPoints, reasonCode, reason };
}

export interface TierCandidate { rank: number; status: string; minLifetimeSpendMinor: bigint | number }

/**
 * 按累计消费解析等级：取「门槛已够」的 active 等级里 rank 最大的一个。
 * 一个都没够着返回 null —— 未配置等级的店铺不应该凭空给一个等级。
 */
export function resolveTier<T extends TierCandidate>(tiers: readonly T[], lifetimeSpendMinor: number): T | null {
  if (!Number.isSafeInteger(lifetimeSpendMinor) || lifetimeSpendMinor < 0) fail('lifetimeSpendMinor');
  let best: T | null = null;
  for (const tier of tiers) {
    if (tier.status !== 'active') continue;
    if (Number(tier.minLifetimeSpendMinor) > lifetimeSpendMinor) continue;
    if (best === null || tier.rank > best.rank) best = tier;
  }
  return best;
}

/**
 * 订单积分：只按商品金额（小计减折扣）计算，运费与税费不积分。
 * 向下取整——差 1 分不该白送 1 点，否则对账时分母永远对不上。
 */
export function earnPoints(eligibleMinor: number, minorPerPoint: number): number {
  if (!Number.isSafeInteger(eligibleMinor) || eligibleMinor < 0) fail('eligibleMinor');
  if (!Number.isSafeInteger(minorPerPoint) || minorPerPoint < 1) fail('minorPerPoint');
  return Math.floor(eligibleMinor / minorPerPoint);
}

/** 登记一笔流水后的余额；扣成负数直接拒绝，不做"先欠着"。 */
export function applyDelta(balance: number, delta: number): number {
  if (!Number.isSafeInteger(balance) || balance < 0) fail('balance');
  if (!Number.isSafeInteger(delta) || delta === 0) fail('deltaPoints');
  const next = balance + delta;
  if (!Number.isSafeInteger(next)) fail('deltaPoints');
  if (next < 0) fail('deltaPoints', 'POINT_BALANCE_INSUFFICIENT');
  return next;
}

/**
 * 结账抵扣：客户端只能「请求用多少点」，实际用多少由服务端按余额与可抵扣金额收敛。
 *
 * 三条口径：
 * 1. 请求点数超过余额是直接拒绝（POINT_BALANCE_INSUFFICIENT），不静默少扣——
 *    那是「我以为用了 100 点，其实只用了 30 点」的误解。
 * 2. 可抵扣金额只算商品小计减优惠，不含运费与税；金额不够时按换算率向下取整收敛点数，
 *    并在报价的 warnings 里说明，总额永远非负。
 * 3. 换算率用会员当时的等级率；报价把它冻结在 pointsValueMinor 里，下单不重算。
 */
export interface PointsRedemption { points: number; valueMinor: number; cappedByAmount: boolean }

export function redeemPoints(requested: unknown, available: number, minorPerPoint: number,
  eligibleMinor: number): PointsRedemption {
  const wanted = requested === undefined || requested === null ? 0 : requested;
  if (!Number.isSafeInteger(wanted) || (wanted as number) < 0) fail('pointsToUse');
  if (!Number.isSafeInteger(available) || available < 0) fail('balance');
  if (!Number.isSafeInteger(minorPerPoint) || minorPerPoint < 1) fail('minorPerPoint');
  if (!Number.isSafeInteger(eligibleMinor) || eligibleMinor < 0) fail('eligibleMinor');
  if ((wanted as number) > available) fail('pointsToUse', 'POINT_BALANCE_INSUFFICIENT');
  const byAmount = Math.floor(eligibleMinor / minorPerPoint);
  const points = Math.min(wanted as number, available, byAmount);
  return { points, valueMinor: points * minorPerPoint, cappedByAmount: (wanted as number) > byAmount };
}

/** 等级名按当前语言取，缺失时退到英文，再退到第一个可用的名字。 */
export function tierName(nameByLocale: unknown, locale: string): string | null {
  if (!nameByLocale || typeof nameByLocale !== 'object' || Array.isArray(nameByLocale)) return null;
  const names = nameByLocale as Record<string, unknown>;
  const candidates = [locale, 'en', ...Object.keys(names)];
  for (const key of candidates) {
    const value = names[key];
    if (typeof value === 'string' && value.trim().length) return value.trim();
  }
  return null;
}

// ---- 积分到期 ---------------------------------------------------------------

/**
 * 发放时的到期快照：months 为空表示这笔积分永不过期（包括人工补发）。
 * 快照落在 earn 行上，之后改配置不影响已入账的积分——「规则变更只影响未来」。
 */
export function expiryDate(earnedAt: Date, months: number | null): Date | null {
  if (months === null || months === undefined) return null;
  integer(months, 'pointsExpiryMonths', 1, 120);
  const expires = new Date(earnedAt.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + months);
  return expires;
}

export interface ExpiryLedgerEntry {
  id: string; deltaPoints: number; entryType: string; sourceRef: string | null; expiresAt: Date | null;
}
export interface DueExpiry { entryId: string; points: number }

/**
 * 按先进先出计算应作废的积分：扣减永远先消耗最早的积分，所以到期也只作用于
 * 「最早的、还没被扣掉的那部分」。entries 必须按入账顺序（createdAt, id）传入。
 *
 * 到期流水（entryType='expire'）是例外：它不参与先进先出，只冲销 sourceRef 指向的
 * 那一笔发放。否则它会在队列里吃掉更早的积分，让同一笔发放被反复判定为到期。
 *
 * 返回值按原 earn 行分组：每条最多出现一次，points 是该行尚未被扣减且已到期的数量。
 */
export function dueExpiry(entries: readonly ExpiryLedgerEntry[], now: Date): DueExpiry[] {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('now');
  const queue: { id: string; points: number; expiresAt: Date | null }[] = [];
  for (const entry of entries) {
    if (entry.deltaPoints > 0) {
      queue.push({ id: entry.id, points: entry.deltaPoints, expiresAt: entry.expiresAt });
      continue;
    }
    if (entry.entryType === 'expire') {
      // 只冲自己那一笔：找不到（已被其他扣减消耗或数据异常）就跳过，绝不动别人的积分。
      const index = entry.sourceRef === null ? -1 : queue.findIndex(portion => portion.id === entry.sourceRef);
      if (index >= 0) {
        const portion = queue[index]!;
        portion.points += entry.deltaPoints;
        if (portion.points <= 0) queue.splice(index, 1);
      }
      continue;
    }
    let remaining = -entry.deltaPoints;
    while (remaining > 0 && queue.length > 0) {
      const front = queue[0]!;
      const take = Math.min(front.points, remaining);
      front.points -= take;
      remaining -= take;
      if (front.points === 0) queue.shift();
    }
  }
  const due: DueExpiry[] = [];
  for (const portion of queue) {
    if (portion.expiresAt !== null && portion.expiresAt.getTime() <= now.getTime()) {
      due.push({ entryId: portion.id, points: portion.points });
    }
  }
  return due;
}
