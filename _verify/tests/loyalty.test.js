import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDelta, dueExpiry, earnPoints, expiryDate, LOYALTY_REDEEM_RULE_VERSION, LOYALTY_RULE_VERSION, LoyaltyRuleError, loyaltyPolicy, normalizeAdjustment, normalizeSettingPatch, normalizeTierInput, normalizeTierPatch, redeemPoints, resolveTier, tierName, } from '../packages/domain/src/loyalty.js';
function rejects(fn, code = 'VALIDATION_ERROR') {
    assert.throws(fn, (error) => error instanceof LoyaltyRuleError && error.code === code);
}
const tier = (overrides = {}) => normalizeTierInput({ code: 'GOLD',
    nameByLocale: { en: 'Gold', 'zh-HK': '金級' }, rank: 2, minLifetimeSpendMinor: 50_000, ...overrides });
test('tier codes are trimmed and uppercased so one tier cannot exist twice', () => {
    assert.equal(tier().code, 'GOLD');
    assert.equal(tier({ code: ' silver ' }).code, 'SILVER');
    for (const code of ['', ' ', 'GOLD TIER', 'gold_tier', '-GOLD', 'G'.repeat(41), 42, null]) {
        rejects(() => tier({ code }));
    }
});
test('a tier must carry at least one display name, but not every locale', () => {
    assert.deepEqual(tier({ nameByLocale: { en: 'Gold' } }).nameByLocale, { en: 'Gold' });
    // 名称两端空白会被裁掉：否则前端出现" 金級 "这种对齐错位的标签。
    assert.deepEqual(tier({ nameByLocale: { 'zh-HK': '  金級  ' } }).nameByLocale, { 'zh-HK': '金級' });
    rejects(() => tier({ nameByLocale: {} }));
    rejects(() => tier({ nameByLocale: { en: '   ' } }));
    rejects(() => tier({ nameByLocale: { en: 'x'.repeat(121) } }));
    rejects(() => tier({ nameByLocale: ['Gold'] }));
});
test('rank, threshold and rate are bounded integers', () => {
    rejects(() => tier({ rank: 0 }));
    rejects(() => tier({ rank: loyaltyPolicy.maxTierRank + 1 }));
    rejects(() => tier({ rank: 1.5 }));
    rejects(() => tier({ minLifetimeSpendMinor: -1 }));
    rejects(() => tier({ minorPerPoint: 0 }));
    rejects(() => tier({ minorPerPoint: 1.5 }));
    // 空或未给都表示沿用店铺口径，不能悄悄变成 0。
    assert.equal(tier({ minorPerPoint: null }).minorPerPoint, null);
    assert.equal(tier().minorPerPoint, null);
});
test('benefits are short display strings, deduplicated', () => {
    assert.deepEqual(tier({ benefits: ['Free shipping', 'Free shipping', 'Early access'] }).benefits, ['Free shipping', 'Early access']);
    assert.deepEqual(tier().benefits, []);
    rejects(() => tier({ benefits: ['x'.repeat(121)] }));
    rejects(() => tier({ benefits: Array.from({ length: 21 }, (_, index) => `b${index}`) }));
    rejects(() => tier({ benefits: 'Free shipping' }));
});
test('a patch touches only the fields it names, and an empty patch is rejected', () => {
    assert.deepEqual(normalizeTierPatch({ rank: 3 }), { rank: 3 });
    assert.deepEqual(normalizeTierPatch({ minorPerPoint: null }), { minorPerPoint: null });
    // 空补丁不能"看起来保存成功"：直接报错，调用方才不会误以为改过了。
    rejects(() => normalizeTierPatch({}), 'EMPTY_PATCH');
});
test('loyalty settings accept only the three documented knobs', () => {
    assert.deepEqual(normalizeSettingPatch({ enabled: true, minorPerPoint: 50, pointsExpiryMonths: 12 }), { enabled: true, minorPerPoint: 50, pointsExpiryMonths: 12 });
    assert.deepEqual(normalizeSettingPatch({ pointsExpiryMonths: null }), { pointsExpiryMonths: null });
    rejects(() => normalizeSettingPatch({}), 'EMPTY_PATCH');
    rejects(() => normalizeSettingPatch({ enabled: 'yes' }));
    rejects(() => normalizeSettingPatch({ minorPerPoint: 0 }));
    rejects(() => normalizeSettingPatch({ pointsExpiryMonths: 121 }));
});
test('a manual adjustment needs a non-zero delta, a reason code and a reason', () => {
    assert.deepEqual(normalizeAdjustment({ deltaPoints: -250, reasonCode: 'goodwill', reason: 'Late delivery' }), { deltaPoints: -250, reasonCode: 'goodwill', reason: 'Late delivery' });
    rejects(() => normalizeAdjustment({ deltaPoints: 0, reasonCode: 'goodwill', reason: 'x' }));
    rejects(() => normalizeAdjustment({ deltaPoints: loyaltyPolicy.maxAdjustmentPoints + 1, reasonCode: 'goodwill', reason: 'x' }));
    // 原因码是机器可读的固定词表风格，原因文本是给人看的。
    rejects(() => normalizeAdjustment({ deltaPoints: 10, reasonCode: 'Goodwill', reason: 'x' }));
    rejects(() => normalizeAdjustment({ deltaPoints: 10, reasonCode: 'goodwill', reason: '   ' }));
    rejects(() => normalizeAdjustment({ deltaPoints: 10, reasonCode: 'goodwill', reason: 'x'.repeat(1001) }));
});
test('the highest reachable active tier wins, not the most expensive one', () => {
    const tiers = [{ rank: 1, status: 'active', minLifetimeSpendMinor: 0 },
        { rank: 3, status: 'active', minLifetimeSpendMinor: 100_000 },
        { rank: 2, status: 'active', minLifetimeSpendMinor: 50_000 }];
    assert.equal(resolveTier(tiers, 0).rank, 1);
    assert.equal(resolveTier(tiers, 49_999).rank, 1);
    assert.equal(resolveTier(tiers, 50_000).rank, 2);
    assert.equal(resolveTier(tiers, 10_000_000).rank, 3);
    // 退役等级不再参与解析，即使门槛更低也不会把人降回去。
    assert.equal(resolveTier([{ rank: 1, status: 'retired', minLifetimeSpendMinor: 0 },
        { rank: 2, status: 'active', minLifetimeSpendMinor: 10_000 }], 20_000).rank, 2);
    // 一个都没够着就是没有等级：未配置等级的店铺不该凭空给一个。
    assert.equal(resolveTier([{ rank: 1, status: 'active', minLifetimeSpendMinor: 10 }], 0), null);
    assert.equal(resolveTier([], 5_000), null);
    rejects(() => resolveTier(tiers, -1));
});
test('tier thresholds compare as numbers even when stored as bigint', () => {
    assert.equal(resolveTier([{ rank: 1, status: 'active', minLifetimeSpendMinor: 0n },
        { rank: 2, status: 'active', minLifetimeSpendMinor: 5000n }], 5_000).rank, 2);
});
test('points round down: a short cent never buys a point', () => {
    assert.equal(earnPoints(10_000, 100), 100);
    assert.equal(earnPoints(10_099, 100), 100);
    assert.equal(earnPoints(99, 100), 0);
    assert.equal(earnPoints(0, 100), 0);
    // 加速倍率用更小的分母表达：同样金额积更多点。
    assert.equal(earnPoints(10_000, 50), 200);
    rejects(() => earnPoints(-1, 100));
    rejects(() => earnPoints(100, 0));
    rejects(() => earnPoints(100.5, 100));
});
test('the balance can never go negative and a zero delta is not a ledger entry', () => {
    assert.equal(applyDelta(500, -200), 300);
    assert.equal(applyDelta(300, 1_200), 1_500);
    rejects(() => applyDelta(500, -501), 'POINT_BALANCE_INSUFFICIENT');
    rejects(() => applyDelta(0, -1), 'POINT_BALANCE_INSUFFICIENT');
    rejects(() => applyDelta(500, 0));
    rejects(() => applyDelta(-1, 10));
});
test('tier names fall back from the requested locale to English to any available name', () => {
    const names = { en: 'Gold', 'zh-HK': '金級' };
    assert.equal(tierName(names, 'zh-HK'), '金級');
    assert.equal(tierName(names, 'zh-CN'), 'Gold');
    assert.equal(tierName({ 'zh-HK': '金級' }, 'en'), '金級');
    assert.equal(tierName(null, 'en'), null);
    assert.equal(tierName({}, 'en'), null);
});
test('the rule version is stable so historical ledger rows stay explainable', () => {
    assert.equal(LOYALTY_RULE_VERSION, 'loyalty-v1');
});
test('expiry is a snapshot taken at earn time, not a live setting', () => {
    const earned = new Date('2026-11-17T00:00:00.000Z');
    // 永不过期：配置为空时入账的积分一直有效。
    assert.equal(expiryDate(earned, null), null);
    assert.equal(expiryDate(earned, 3)?.toISOString(), '2027-02-17T00:00:00.000Z');
    for (const months of [0, 121, 1.5, '3'])
        rejects(() => expiryDate(earned, months));
});
test('expiry consumes the oldest points first and never expires manual grants', () => {
    const now = new Date('2026-11-17T00:00:00.000Z');
    const past = new Date('2026-10-01T00:00:00.000Z');
    const future = new Date('2027-01-01T00:00:00.000Z');
    const rows = [
        { id: 'a', deltaPoints: 100, entryType: 'adjust', sourceRef: null, expiresAt: past },
        { id: 'b', deltaPoints: 50, entryType: 'earn', sourceRef: 'EZ-1', expiresAt: future },
        { id: 'c', deltaPoints: -30, entryType: 'adjust', sourceRef: null, expiresAt: null },
    ];
    // 扣掉的 30 点先吃掉最早那一笔，于是 a 只剩 70 点该过期；b 还没到期。
    assert.deepEqual(dueExpiry(rows, now), [{ entryId: 'a', points: 70 }]);
});
test('a deduction larger than one grant spills into the next grant', () => {
    const now = new Date('2026-11-17T00:00:00.000Z');
    const past = new Date('2026-10-01T00:00:00.000Z');
    const rows = [
        { id: 'a', deltaPoints: 100, entryType: 'earn', sourceRef: 'EZ-1', expiresAt: past },
        { id: 'b', deltaPoints: 80, entryType: 'earn', sourceRef: 'EZ-2', expiresAt: past },
        { id: 'c', deltaPoints: -130, entryType: 'redeem', sourceRef: null, expiresAt: null },
    ];
    // 130 点按先进先出扣完 a（100）再扣 b 的 30，b 剩 50 点到期。
    assert.deepEqual(dueExpiry(rows, now), [{ entryId: 'b', points: 50 }]);
});
test('an expire entry writes off its own grant instead of consuming the oldest points', () => {
    const now = new Date('2026-11-17T00:00:00.000Z');
    const past = new Date('2026-10-01T00:00:00.000Z');
    // 这正是第一版实现的缺陷：到期流水如果按先进先出扣，会吃掉更早的人工补发，
    // 于是那笔已过期的发放又被判定为到期，清扫反复插同一条 expire。
    const rows = [
        { id: 'grant', deltaPoints: 500, entryType: 'adjust', sourceRef: null, expiresAt: null },
        { id: 'spend', deltaPoints: -200, entryType: 'adjust', sourceRef: null, expiresAt: null },
        { id: 'earn', deltaPoints: 200, entryType: 'earn', sourceRef: 'EZ-1', expiresAt: past },
        { id: 'expire:earn', deltaPoints: -200, entryType: 'expire', sourceRef: 'earn', expiresAt: null },
    ];
    assert.deepEqual(dueExpiry(rows, now), []);
    assert.deepEqual(dueExpiry([], now), []);
    // 只有永不过期的发放（人工补发）时什么都不做。
    assert.deepEqual(dueExpiry([{ id: 'x', deltaPoints: 10, entryType: 'adjust', sourceRef: null,
            expiresAt: null }], now), []);
    // 找不到原发放的 expire 行不会误伤别人的积分。
    assert.deepEqual(dueExpiry([
        { id: 'keep', deltaPoints: 30, entryType: 'adjust', sourceRef: null, expiresAt: null },
        { id: 'orphan', deltaPoints: -30, entryType: 'expire', sourceRef: 'missing', expiresAt: null },
    ], now), []);
});
test('checkout redemption caps by balance and merchandise amount but never invents points', () => {
    assert.equal(LOYALTY_REDEEM_RULE_VERSION, 'loyalty-redeem-v1');
    assert.deepEqual(redeemPoints(0, 500, 100, 1_000), { points: 0, valueMinor: 0, cappedByAmount: false });
    assert.deepEqual(redeemPoints(undefined, 500, 100, 1_000), { points: 0, valueMinor: 0, cappedByAmount: false });
    assert.deepEqual(redeemPoints(7, 10, 100, 1_000), { points: 7, valueMinor: 700, cappedByAmount: false });
    // 金额只够 4 点：请求 7 点会收敛到 4 点并标记原因，不会让订单变成负数。
    assert.deepEqual(redeemPoints(7, 10, 100, 450), { points: 4, valueMinor: 400, cappedByAmount: true });
    assert.deepEqual(redeemPoints(2, 10, 100, 1_000), { points: 2, valueMinor: 200, cappedByAmount: false });
    // 余额不足是明确拒绝，不是静默少扣。
    rejects(() => redeemPoints(9, 2, 100, 1_000), 'POINT_BALANCE_INSUFFICIENT');
    for (const value of [-1, 1.5, '5', Number.NaN])
        rejects(() => redeemPoints(value, 10, 100, 1_000));
    rejects(() => redeemPoints(1, -1, 100, 1_000));
    rejects(() => redeemPoints(1, 10, 0, 1_000));
    rejects(() => redeemPoints(1, 10, 100, -1));
});
