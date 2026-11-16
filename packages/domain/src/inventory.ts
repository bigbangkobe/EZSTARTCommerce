/**
 * 库存（M12）领域规则。
 *
 * 与其它领域模块一样，这里只有判定与规范化，不碰数据库。四条底线：
 * 1. 只有流水能改 onHand：没有“把现存量设成 X”的入口，每次调整都必须留下 delta 与调整后数量。
 * 2. 可售数 = onHand − reserved；调减不能让任何已预留的单位变成负可售。
 * 3. 调整必须带版本：两个人同时改同一 SKU 时，后一个必须失败而不是静默覆盖。
 * 4. 阈值只影响提醒，不影响可售数量；0 表示只关心“售罄”。
 */
export class InventoryRuleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new InventoryRuleError(code);
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const REASON_CODE = /^[a-z0-9][a-z0-9_]{0,79}$/;

/** 单次调整的绝对值上限：够覆盖整批盘点，又不至于一个手滑把库存打成天文数字。 */
export const MAX_ADJUSTMENT = 100_000;
export const MAX_LOW_STOCK_LEVEL = 1_000_000;
export const MOVEMENT_TYPES: readonly string[] = ['return_restock', 'return_damaged', 'return_quarantine',
  'return_scrap', 'adjustment'];

export type LowStockState = 'out_of_stock' | 'low' | 'ok';

export interface AdjustmentInput {
  variantId: string;
  delta: number;
  reasonCode: string | null;
  reason: string;
  reference: string | null;
  expectedVersion: number;
}

export interface ThresholdInput { variantId: string; lowStockLevel: number; expectedVersion: number | null }

export interface StockSnapshot { onHand: number; reserved: number; version: number }

export function availableOf(onHand: number, reserved: number) {
  return onHand - reserved;
}

function text(value: unknown, field: string, max: number) {
  if (typeof value !== 'string') fail('VALIDATION_ERROR');
  const trimmed = value.trim();
  if (!trimmed.length || trimmed.length > max || CONTROL.test(trimmed)) fail('VALIDATION_ERROR');
  if (field === 'reasonCode' && !REASON_CODE.test(trimmed)) fail('VALIDATION_ERROR');
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null) return null;
  return text(value, field, max);
}

/** 数量必须是整数：库存不接受小数，也不接受字符串形式的数字。 */
function integer(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('VALIDATION_ERROR');
  return value;
}

export function normalizeAdjustment(body: Record<string, unknown>, variantId: string): AdjustmentInput {
  const delta = integer(body.delta, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
  if (delta === 0) fail('VALIDATION_ERROR');
  return { variantId, delta, reasonCode: optionalText(body.reasonCode, 'reasonCode', 80),
    reason: text(body.reason, 'reason', 1000), reference: optionalText(body.reference, 'reference', 200),
    expectedVersion: integer(body.expectedVersion, 0, Number.MAX_SAFE_INTEGER) };
}

export function normalizeThreshold(body: Record<string, unknown>): ThresholdInput {
  if (body.variantId !== undefined && body.variantId !== null && typeof body.variantId !== 'string') fail('VALIDATION_ERROR');
  return { variantId: typeof body.variantId === 'string' ? body.variantId : '',
    lowStockLevel: integer(body.lowStockLevel, 0, MAX_LOW_STOCK_LEVEL),
    expectedVersion: body.expectedVersion === undefined || body.expectedVersion === null ? null
      : integer(body.expectedVersion, 0, Number.MAX_SAFE_INTEGER) };
}

export function assertInventoryVersion(expected: number, actual: number) {
  // 0 是合法期望值：它表示“我读到的是这个 SKU 还没有库存记录”。
  if (!Number.isSafeInteger(expected) || expected < 0) fail('VALIDATION_ERROR');
  if (expected !== actual) fail('VERSION_CONFLICT');
}

/**
 * 调减的边界不是 0，而是「不能吃掉已预留的量」：
 * onHand 5 里有 3 件已经被订单占住，此时最多只能减 2 件。
 */
export function assertAdjustmentAllowed(current: StockSnapshot, delta: number) {
  if (!Number.isSafeInteger(current.onHand) || !Number.isSafeInteger(current.reserved)) fail('STATE_CONFLICT');
  const nextOnHand = current.onHand + delta;
  if (nextOnHand < 0) fail('INSUFFICIENT_ON_HAND');
  if (availableOf(nextOnHand, current.reserved) < 0) fail('INSUFFICIENT_ON_HAND');
  return nextOnHand;
}

/** 流水形状由数据库 CHECK 再兜一次：delta 带符号，quantity 记绝对值，调整必须写调整后现存量。 */
export function adjustmentMovement(delta: number, onHandAfter: number) {
  if (!Number.isSafeInteger(delta) || delta === 0) fail('VALIDATION_ERROR');
  if (!Number.isSafeInteger(onHandAfter) || onHandAfter < 0) fail('STATE_CONFLICT');
  return { type: 'adjustment' as const, quantity: Math.abs(delta), stockDelta: delta, onHandAfter };
}

/** 同一 Idempotency-Key 只能对应一条调整流水；重放读旧行，换内容则拒绝。 */
export function adjustmentDedupeKey(idempotencyKey: string) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
    fail('VALIDATION_ERROR');
  }
  return `inventory:adjustment:${idempotencyKey}`;
}

export function lowStockState(onHand: number, reserved: number, lowStockLevel: number): LowStockState {
  const available = availableOf(onHand, reserved);
  if (available <= 0) return 'out_of_stock';
  if (lowStockLevel > 0 && available <= lowStockLevel) return 'low';
  return 'ok';
}
