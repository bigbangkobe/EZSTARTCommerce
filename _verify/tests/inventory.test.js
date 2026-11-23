import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjustmentDedupeKey, adjustmentMovement, assertAdjustmentAllowed, assertInventoryVersion, availableOf, lowStockState, normalizeAdjustment, normalizeThreshold, MAX_ADJUSTMENT, } from '../packages/domain/src/inventory.js';
/** 领域错误必须是可识别的码，接口层靠它映射 409/422，而不是靠字符串。 */
const code = (fn) => {
    try {
        fn();
    }
    catch (error) {
        return error.code;
    }
    return 'NO_ERROR';
};
const base = { variantId: '0b8f8b1c-1111-4222-8333-444455556666', delta: 5, reason: 'Received delivery',
    expectedVersion: 3 };
test('adjustments are signed deltas with a bounded absolute size and no coercion', () => {
    const input = normalizeAdjustment({ ...base, delta: -12, reason: '  Stocktake correction  ' }, base.variantId);
    assert.equal(input.delta, -12);
    assert.equal(input.reason, 'Stocktake correction', '原因去首尾空格');
    assert.equal(input.reasonCode, null);
    assert.equal(input.reference, null);
    assert.equal(code(() => normalizeAdjustment({ ...base, delta: 0 }, base.variantId)), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeAdjustment({ ...base, delta: '5' }, base.variantId)), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeAdjustment({ ...base, delta: 2.5 }, base.variantId)), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeAdjustment({ ...base, delta: MAX_ADJUSTMENT + 1 }, base.variantId)), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeAdjustment({ ...base, delta: -MAX_ADJUSTMENT - 1 }, base.variantId)), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeAdjustment({ ...base, reason: '   ' }, base.variantId)), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeAdjustment({ ...base, reason: 'bad\u0007reason' }, base.variantId)), 'VALIDATION_ERROR');
    // 版本 0 用来表示“这个 SKU 还没有库存记录”，负数和字符串都不接受。
    assert.equal(normalizeAdjustment({ ...base, expectedVersion: 0 }, base.variantId).expectedVersion, 0);
    assert.equal(code(() => normalizeAdjustment({ ...base, expectedVersion: -1 }, base.variantId)), 'VALIDATION_ERROR');
});
test('a stale inventory version is a conflict, not an overwrite', () => {
    assertInventoryVersion(4, 4);
    assert.equal(code(() => assertInventoryVersion(3, 4)), 'VERSION_CONFLICT');
    assert.equal(code(() => assertInventoryVersion(0, 1)), 'VERSION_CONFLICT');
    assert.equal(code(() => assertInventoryVersion(Number.NaN, 1)), 'VALIDATION_ERROR');
});
test('decreases stop at reserved units instead of pushing availability negative', () => {
    // 现存 5、已预留 3：最多只能减 2。
    assert.equal(assertAdjustmentAllowed({ onHand: 5, reserved: 3, version: 1 }, -2), 3);
    assert.equal(code(() => assertAdjustmentAllowed({ onHand: 5, reserved: 3, version: 1 }, -3)), 'INSUFFICIENT_ON_HAND');
    assert.equal(code(() => assertAdjustmentAllowed({ onHand: 0, reserved: 0, version: 1 }, -1)), 'INSUFFICIENT_ON_HAND');
    assert.equal(assertAdjustmentAllowed({ onHand: 0, reserved: 0, version: 0 }, 10), 10, '未建库存行的 SKU 可以直接加');
    assert.equal(availableOf(8, 3), 5);
});
test('the movement keeps a signed delta and an absolute quantity', () => {
    assert.deepEqual(adjustmentMovement(-4, 6), { type: 'adjustment', quantity: 4, stockDelta: -4, onHandAfter: 6 });
    assert.deepEqual(adjustmentMovement(4, 14), { type: 'adjustment', quantity: 4, stockDelta: 4, onHandAfter: 14 });
    assert.equal(code(() => adjustmentMovement(0, 1)), 'VALIDATION_ERROR');
    assert.equal(code(() => adjustmentMovement(1, -1)), 'STATE_CONFLICT');
});
test('one idempotency key maps to exactly one adjustment movement', () => {
    const key = 'a'.repeat(20);
    assert.equal(adjustmentDedupeKey(key), `inventory:adjustment:${key}`);
    assert.equal(code(() => adjustmentDedupeKey('short')), 'VALIDATION_ERROR');
    assert.equal(code(() => adjustmentDedupeKey('x'.repeat(129))), 'VALIDATION_ERROR');
});
test('low-stock state only looks at availability and never at on-hand alone', () => {
    assert.equal(lowStockState(10, 0, 3), 'ok');
    assert.equal(lowStockState(10, 7, 3), 'low', '可售 3 等于阈值即算低库存');
    assert.equal(lowStockState(10, 6, 3), 'ok', '可售 4 高于阈值');
    assert.equal(lowStockState(10, 10, 3), 'out_of_stock');
    assert.equal(lowStockState(0, 0, 3), 'out_of_stock');
    // 阈值为 0 时只关心售罄。
    assert.equal(lowStockState(1, 0, 0), 'ok');
    assert.equal(lowStockState(0, 0, 0), 'out_of_stock');
});
test('threshold levels are bounded integers and never negative', () => {
    const input = normalizeThreshold({ variantId: base.variantId, lowStockLevel: 12, expectedVersion: 0 });
    assert.equal(input.lowStockLevel, 12);
    assert.equal(input.expectedVersion, 0);
    assert.equal(code(() => normalizeThreshold({ variantId: base.variantId, lowStockLevel: -1 })), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeThreshold({ variantId: base.variantId, lowStockLevel: 1_000_001 })), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeThreshold({ variantId: base.variantId, lowStockLevel: 1.5 })), 'VALIDATION_ERROR');
    assert.equal(normalizeThreshold({ variantId: base.variantId, lowStockLevel: 0 }).expectedVersion, null);
});
