import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyDelta, earnPoints, LOYALTY_RULE_VERSION, LoyaltyRuleError, loyaltyPolicy, normalizeAdjustment,
  normalizeSettingPatch, normalizeTierInput, normalizeTierPatch, resolveTier, tierName,
} from '../packages/domain/src/loyalty.js';

function rejects(fn: () => unknown, code = 'VALIDATION_ERROR') {
  assert.throws(fn, (error: unknown) => error instanceof LoyaltyRuleError && error.code === code);
}

const tier = (overrides: Record<string, unknown> = {}) => normalizeTierInput({ code: 'GOLD',
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
  rejects(() => tier({ nameByLocale: ['Gold'] as unknown as Record<string, string> }));
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
  assert.deepEqual(tier({ benefits: ['Free shipping', 'Free shipping', 'Early access'] }).benefits,
    ['Free shipping', 'Early access']);
  assert.deepEqual(tier().benefits, []);
  rejects(() => tier({ benefits: ['x'.repeat(121)] }));
  rejects(() => tier({ benefits: Array.from({ length: 21 }, (_, index) => `b${index}`) }));
  rejects(() => tier({ benefits: 'Free shipping' as unknown as string[] }));
});

test('a patch touches only the fields it names, and an empty patch is rejected', () => {
  assert.deepEqual(normalizeTierPatch({ rank: 3 }), { rank: 3 });
  assert.deepEqual(normalizeTierPatch({ minorPerPoint: null }), { minorPerPoint: null });
  // 空补丁不能"看起来保存成功"：直接报错，调用方才不会误以为改过了。
  rejects(() => normalizeTierPatch({}), 'EMPTY_PATCH');
});

test('loyalty settings accept only the three documented knobs', () => {
  assert.deepEqual(normalizeSettingPatch({ enabled: true, minorPerPoint: 50, pointsExpiryMonths: 12 }),
    { enabled: true, minorPerPoint: 50, pointsExpiryMonths: 12 });
  assert.deepEqual(normalizeSettingPatch({ pointsExpiryMonths: null }), { pointsExpiryMonths: null });
  rejects(() => normalizeSettingPatch({}), 'EMPTY_PATCH');
  rejects(() => normalizeSettingPatch({ enabled: 'yes' }));
  rejects(() => normalizeSettingPatch({ minorPerPoint: 0 }));
  rejects(() => normalizeSettingPatch({ pointsExpiryMonths: 121 }));
});

test('a manual adjustment needs a non-zero delta, a reason code and a reason', () => {
  assert.deepEqual(normalizeAdjustment({ deltaPoints: -250, reasonCode: 'goodwill', reason: 'Late delivery' }),
    { deltaPoints: -250, reasonCode: 'goodwill', reason: 'Late delivery' });
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
  assert.equal(resolveTier(tiers, 0)!.rank, 1);
  assert.equal(resolveTier(tiers, 49_999)!.rank, 1);
  assert.equal(resolveTier(tiers, 50_000)!.rank, 2);
  assert.equal(resolveTier(tiers, 10_000_000)!.rank, 3);
  // 退役等级不再参与解析，即使门槛更低也不会把人降回去。
  assert.equal(resolveTier([{ rank: 1, status: 'retired', minLifetimeSpendMinor: 0 },
    { rank: 2, status: 'active', minLifetimeSpendMinor: 10_000 }], 20_000)!.rank, 2);
  // 一个都没够着就是没有等级：未配置等级的店铺不该凭空给一个。
  assert.equal(resolveTier([{ rank: 1, status: 'active', minLifetimeSpendMinor: 10 }], 0), null);
  assert.equal(resolveTier([], 5_000), null);
  rejects(() => resolveTier(tiers, -1));
});

test('tier thresholds compare as numbers even when stored as bigint', () => {
  assert.equal(resolveTier([{ rank: 1, status: 'active', minLifetimeSpendMinor: 0n },
    { rank: 2, status: 'active', minLifetimeSpendMinor: 5_000n }], 5_000)!.rank, 2);
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
