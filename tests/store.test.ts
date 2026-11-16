import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FEATURE_FLAGS, StoreRuleError, assertMarketCanEnable, effectiveReviewStatus, isValidTimezone,
  marketAfterReview, marketView, normalizeMarketCode, normalizeMarketInput, normalizeStoreSettings } from '../packages/domain/src/store.js';

const now = new Date('2026-11-16T00:00:00.000Z');
const base = {
  displayName: '  我的店铺  ', locales: ['zh-CN', 'zh-HK', 'en'], defaultLocale: 'zh-CN', baseCurrency: 'HKD',
  timezone: 'Asia/Hong_Kong', featureFlags: {}, logoMediaId: null, faviconMediaId: null,
} as const;

test('store settings are normalised and every cross-field rule is enforced', () => {
  const settings = normalizeStoreSettings({ ...base, locales: ['zh-CN', 'en', 'en'] });
  assert.equal(settings.displayName, '我的店铺');
  assert.deepEqual(settings.locales, ['zh-CN', 'en']);
  assert.deepEqual(settings.featureFlags, { ...DEFAULT_FEATURE_FLAGS });

  assert.throws(() => normalizeStoreSettings({ ...base, locales: ['zh-CN'], defaultLocale: 'en' }), StoreRuleError);
  assert.throws(() => normalizeStoreSettings({ ...base, locales: ['fr'] }), StoreRuleError);
  assert.throws(() => normalizeStoreSettings({ ...base, displayName: '   ' }), StoreRuleError);
  assert.throws(() => normalizeStoreSettings({ ...base, baseCurrency: 'hkd' }), StoreRuleError);
  assert.throws(() => normalizeStoreSettings({ ...base, timezone: 'Mars/Olympus' }), StoreRuleError);
  assert.throws(() => normalizeStoreSettings({ ...base, featureFlags: { guestCheckout: 'yes' as unknown as boolean } }), StoreRuleError);
  // 未知功能开关必须被拒绝：写入无人实现的开关等于制造静默失效的配置。
  assert.throws(() => normalizeStoreSettings({ ...base, featureFlags: { teleportation: true } }), StoreRuleError);
  assert.throws(() => normalizeStoreSettings({ ...base, logoMediaId: 'not-a-uuid' }), StoreRuleError);

  // 显式关闭的开关不会被默认值覆盖。
  assert.equal(normalizeStoreSettings({ ...base, featureFlags: { guestCheckout: false } }).featureFlags['guestCheckout'], false);
  assert.equal(isValidTimezone('Asia/Macau'), true);
  assert.equal(isValidTimezone(''), false);
});

test('market review state machine never enables trading by itself', () => {
  const approved = marketAfterReview('approved', new Date(now.getTime() + 86_400_000), now);
  assert.deepEqual(approved.enabled, false);
  assert.equal(approved.reviewStatus, 'approved');
  assert.throws(() => marketAfterReview('approved', new Date(now.getTime() - 1), now), StoreRuleError, '审核有效期必须在未来');

  const rejected = marketAfterReview('rejected', new Date(now.getTime() + 86_400_000), now);
  assert.deepEqual(rejected, { enabled: false, reviewStatus: 'rejected', reviewValidUntil: null });
  assert.deepEqual(marketAfterReview('revoked', null, now), { enabled: false, reviewStatus: 'revoked', reviewValidUntil: null });
});

test('expiry is computed at read time and immediately withdraws tradability', () => {
  assert.equal(effectiveReviewStatus('approved', new Date(now.getTime() - 1), now), 'expired');
  assert.equal(effectiveReviewStatus('approved', null, now), 'approved');
  assert.equal(effectiveReviewStatus('pending', null, now), 'pending');

  const expired = marketView({ marketCode: 'HK', enabled: true, eligibleProductIds: [], reviewStatus: 'approved', reviewValidUntil: new Date(now.getTime() - 1) }, now);
  assert.equal(expired.enabled, false);
  assert.equal(expired.reviewStatus, 'expired');
  assert.equal(expired.reviewValidUntil, null);

  const live = marketView({ marketCode: 'HK', enabled: true, eligibleProductIds: [], reviewStatus: 'approved', reviewValidUntil: new Date(now.getTime() + 1_000) }, now);
  assert.equal(live.enabled, true);
  assert.equal(live.reviewStatus, 'approved');
  assert.match(live.reviewValidUntil!, /^2026-11-16T00:00:01/);
});

test('only a currently approved market may be enabled', () => {
  assert.throws(() => assertMarketCanEnable({ marketCode: 'HK', enabled: false, eligibleProductIds: [], reviewStatus: 'pending', reviewValidUntil: null }, now), StoreRuleError);
  assert.throws(() => assertMarketCanEnable({ marketCode: 'HK', enabled: true, eligibleProductIds: [], reviewStatus: 'approved', reviewValidUntil: new Date(now.getTime() - 1) }, now), StoreRuleError);
  assert.doesNotThrow(() => assertMarketCanEnable({ marketCode: 'HK', enabled: true, eligibleProductIds: [], reviewStatus: 'approved', reviewValidUntil: null }, now));
});

test('market codes and eligibility lists are normalised without guessing', () => {
  assert.equal(normalizeMarketCode(' hk '), 'HK');
  assert.equal(normalizeMarketCode('mo-01'), 'MO-01');
  assert.throws(() => normalizeMarketCode('H'), StoreRuleError);
  assert.throws(() => normalizeMarketCode('香港'), StoreRuleError);

  const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  assert.deepEqual(normalizeMarketInput({ marketCode: 'hk', enabled: false, eligibleProductIds: [id] }),
    { marketCode: 'HK', enabled: false, eligibleProductIds: [id] });
  assert.throws(() => normalizeMarketInput({ marketCode: 'HK', enabled: false, eligibleProductIds: [id, id] }), StoreRuleError);
  assert.throws(() => normalizeMarketInput({ marketCode: 'HK', enabled: false, eligibleProductIds: ['nope'] }), StoreRuleError);
});
