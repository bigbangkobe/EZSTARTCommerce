import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allocateDiscount, assertBatchRecipientCount, assertCouponUsable, assertMemberTierEligible, assertMinSubtotal,
  assertRedemptionTransition, assertUsageLimits, couponDiscount, couponLineEligible, couponSnapshot, couponState,
  eligibleLines, maskCouponCode, memberLimitMaterial, mergeCouponPatch, normalizeBatchIssue, normalizeCoupon,
  normalizeCouponBatch, normalizeCouponCode, PromotionRuleError, MAX_PERCENT_BPS, MAX_BATCH_RECIPIENTS,
  type CouponRule,
} from '../packages/domain/src/promotions.js';

const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return (error as PromotionRuleError).code; }
  return 'NO_ERROR';
};

const PRODUCT = '0b8f8b1c-1111-4222-8333-444455556666';
const CATEGORY = '0b8f8b1c-2222-4222-8333-444455556666';
const OTHER = '0b8f8b1c-3333-4222-8333-444455556666';
const NOW = new Date('2026-11-16T09:00:00.000Z');

const write = {
  code: ' summer_10 ', discountType: 'percent', discountValue: 1_000,
  validFrom: '2026-11-01T00:00:00.000Z', validUntil: '2026-12-01T00:00:00.000Z',
  minSubtotalMinor: 5_000, totalLimit: 100, perCustomerLimit: 1,
  eligibleProductIds: [PRODUCT], eligibleCategoryIds: [CATEGORY], refundPolicy: 'restore',
};

test('coupon writes normalise the code and reject values that would misprice a cart', () => {
  const coupon = normalizeCoupon(write, 'HKD');
  assert.equal(coupon.code, 'SUMMER_10', '码去空格并转大写');
  assert.equal(coupon.discountType, 'percent');
  assert.equal(coupon.discountValue, 1_000, '1000 bps = 10%');
  assert.equal(coupon.status, 'active');
  assert.equal(coupon.refundPolicy, 'restore');
  assert.equal(coupon.currency, 'HKD');
  assert.equal(coupon.minSubtotalMinor, 5_000);

  assert.equal(code(() => normalizeCoupon({ ...write, code: '  ' }, 'HKD')), 'code');
  assert.equal(code(() => normalizeCoupon({ ...write, code: 'BAD CODE' }, 'HKD')), 'couponCode');
  assert.equal(code(() => normalizeCoupon({ ...write, code: '券' }, 'HKD')), 'couponCode');
  assert.equal(code(() => normalizeCoupon({ ...write, discountType: 'bogus' }, 'HKD')), 'discountType');
  // 百分比用 basis points，50000 不是“500%”，是非法值。
  assert.equal(code(() => normalizeCoupon({ ...write, discountValue: MAX_PERCENT_BPS + 1 }, 'HKD')), 'discountValue');
  assert.equal(normalizeCoupon({ ...write, discountType: 'fixed', discountValue: 2_500 }, 'HKD').discountValue, 2_500);
  assert.equal(code(() => normalizeCoupon({ ...write, discountType: 'fixed', discountValue: 0 }, 'HKD')), 'discountValue');
  assert.equal(code(() => normalizeCoupon({ ...write, validUntil: write.validFrom }, 'HKD')), 'validity');
  assert.equal(code(() => normalizeCoupon({ ...write, validFrom: 'not-a-date' }, 'HKD')), 'validFrom');
  assert.equal(code(() => normalizeCoupon({ ...write, totalLimit: 0 }, 'HKD')), 'totalLimit');
  assert.equal(code(() => normalizeCoupon({ ...write, perCustomerLimit: -1 }, 'HKD')), 'perCustomerLimit');
  assert.equal(code(() => normalizeCoupon({ ...write, eligibleProductIds: [PRODUCT, PRODUCT] }, 'HKD')), 'eligibleProductIds');
  assert.equal(code(() => normalizeCoupon({ ...write, eligibleProductIds: ['nope'] }, 'HKD')), 'eligibleProductIds');
  assert.equal(code(() => normalizeCoupon({ ...write, refundPolicy: 'refund' }, 'HKD')), 'refundPolicy');
  assert.equal(code(() => normalizeCoupon(write, 'hkd')), 'currency');
});

test('patching a coupon validates type and value together', () => {
  const current = normalizeCoupon(write, 'HKD');
  const percentToFixed = mergeCouponPatch(current, { discountType: 'fixed', discountValue: 2_000 });
  assert.equal(percentToFixed.discountType, 'fixed');
  assert.equal(percentToFixed.discountValue, 2_000);
  // 只改类型不改面值：1000 在两种类型下都合法，但语义不同，必须由调用方显式给值；
  // 百分比上限仍会拦住超过 10000 bps 的写入。
  assert.equal(code(() => mergeCouponPatch(current, { discountValue: 10_001 })), 'discountValue');
  // 只给新日期时其余字段保持原样；清空可空字段必须显式传 null。
  const extended = mergeCouponPatch(current, { validUntil: '2027-01-01T00:00:00.000Z', totalLimit: null });
  assert.equal(extended.totalLimit, null);
  assert.equal(extended.minSubtotalMinor, 5_000);
  assert.equal(code(() => mergeCouponPatch(current, { validUntil: '2026-10-01T00:00:00.000Z' })), 'validity');
});

test('the validity window is start-inclusive and end-exclusive', () => {
  const coupon = normalizeCoupon(write, 'HKD');
  assert.equal(couponState(coupon, new Date('2026-10-31T23:59:59.999Z')), 'not_started');
  assert.equal(couponState(coupon, new Date('2026-11-01T00:00:00.000Z')), 'active');
  assert.equal(couponState(coupon, new Date('2026-11-30T23:59:59.999Z')), 'active');
  assert.equal(couponState(coupon, new Date('2026-12-01T00:00:00.000Z')), 'expired');
  // 停用优先于时间：还没开始的券被停用也报 disabled。
  assert.equal(couponState({ ...coupon, status: 'disabled' }, NOW), 'disabled');

  assert.equal(code(() => assertCouponUsable({ ...coupon, status: 'disabled' }, NOW, 'HKD')), 'COUPON_DISABLED');
  assert.equal(code(() => assertCouponUsable(coupon, new Date('2026-10-01T00:00:00.000Z'), 'HKD')), 'COUPON_NOT_STARTED');
  assert.equal(code(() => assertCouponUsable(coupon, new Date('2027-01-01T00:00:00.000Z'), 'HKD')), 'COUPON_EXPIRED');
  assert.equal(code(() => assertCouponUsable(coupon, NOW, 'USD')), 'COUPON_CURRENCY_MISMATCH');
  assert.doesNotThrow(() => assertCouponUsable(coupon, NOW, 'HKD'));
});

test('scope is product-or-category and an empty scope means everything', () => {
  const coupon = normalizeCoupon(write, 'HKD');
  assert.equal(couponLineEligible(coupon, { productId: PRODUCT, categoryIds: [] }), true);
  assert.equal(couponLineEligible(coupon, { productId: OTHER, categoryIds: [CATEGORY] }), true);
  assert.equal(couponLineEligible(coupon, { productId: OTHER, categoryIds: [OTHER] }), false);
  const all = normalizeCoupon({ ...write, eligibleProductIds: [], eligibleCategoryIds: [] }, 'HKD');
  assert.equal(couponLineEligible(all, { productId: OTHER, categoryIds: [] }), true);

  const lines = [
    { key: 'a', productId: PRODUCT, categoryIds: [], amountMinor: 6_000 },
    { key: 'b', productId: OTHER, categoryIds: [], amountMinor: 4_000 },
  ];
  assert.deepEqual(eligibleLines(coupon, lines).map(line => line.key), ['a']);
});

test('fixed and percentage discounts never exceed the eligible subtotal', () => {
  const fixed = normalizeCoupon({ ...write, discountType: 'fixed', discountValue: 5_000 }, 'HKD');
  assert.equal(couponDiscount(fixed, 8_000), 5_000);
  assert.equal(couponDiscount(fixed, 3_000), 3_000, '固定额不超过符合条件金额');
  assert.equal(couponDiscount(fixed, 0), 0);

  const ten = normalizeCoupon({ ...write, discountValue: 1_000 }, 'HKD');
  assert.equal(couponDiscount(ten, 10_000), 1_000);
  // half-up：2,505 * 10% = 250.5 → 251。
  assert.equal(couponDiscount(ten, 2_505), 251);
  assert.equal(couponDiscount(ten, 2_504), 250);
  // 100% 券不会把金额打成负数。
  const full = normalizeCoupon({ ...write, discountValue: MAX_PERCENT_BPS }, 'HKD');
  assert.equal(couponDiscount(full, 9_999), 9_999);
  assert.equal(code(() => couponDiscount(ten, -1)), 'subtotal');
});

test('fixed discounts split by line share with remainder going to earlier lines', () => {
  const lines = [
    { key: 'a', amountMinor: 3_333 },
    { key: 'b', amountMinor: 3_333 },
    { key: 'c', amountMinor: 3_334 },
  ];
  const shares = allocateDiscount(lines, 1_000);
  assert.equal(shares.get('a'), 334, '余数按行创建顺序逐行 +1');
  assert.equal(shares.get('b'), 333);
  assert.equal(shares.get('c'), 333);
  assert.equal([...shares.values()].reduce((sum, value) => sum + value, 0), 1_000, '分摊之和等于总折扣');

  const even = allocateDiscount([{ key: 'a', amountMinor: 5_000 }, { key: 'b', amountMinor: 5_000 }], 1_000);
  assert.deepEqual([...even.values()], [500, 500]);
  assert.deepEqual([...allocateDiscount(lines, 0).values()], [0, 0, 0]);
  assert.equal(code(() => allocateDiscount(lines, 10_001)), 'DISCOUNT_EXCEEDS_SUBTOTAL');
  assert.equal(code(() => allocateDiscount(lines, -1)), 'discount');
  // 每一行都不能分到超过自己金额的折扣。
  const single = allocateDiscount([{ key: 'a', amountMinor: 100 }], 100);
  assert.equal(single.get('a'), 100);
});

test('usage limits count reservations and redemptions but not released quota', () => {
  const coupon = { totalLimit: 3, perCustomerLimit: 1 };
  assert.doesNotThrow(() => assertUsageLimits(coupon, 2, 0));
  assert.equal(code(() => assertUsageLimits(coupon, 3, 0)), 'COUPON_LIMIT_REACHED');
  assert.equal(code(() => assertUsageLimits(coupon, 1, 1)), 'COUPON_CUSTOMER_LIMIT_REACHED');
  // 没有配置限额时不做任何限制。
  assert.doesNotThrow(() => assertUsageLimits({ totalLimit: null, perCustomerLimit: null }, 1_000, 1_000));
  // 访客身份缺失时无法判断个人限额，不能凭“没有 key”就放行第二张。
  assert.doesNotThrow(() => assertUsageLimits({ totalLimit: null, perCustomerLimit: 1 }, 1, null));
});

test('redemption states only move forward from reserved', () => {
  assert.doesNotThrow(() => assertRedemptionTransition('reserved', 'redeemed'));
  assert.doesNotThrow(() => assertRedemptionTransition('reserved', 'released'));
  assert.doesNotThrow(() => assertRedemptionTransition('reserved', 'expired'));
  for (const from of ['redeemed', 'released', 'expired'] as const) {
    assert.equal(code(() => assertRedemptionTransition(from, 'redeemed')), 'STATE_CONFLICT');
    assert.equal(code(() => assertRedemptionTransition(from, 'released')), 'STATE_CONFLICT');
  }
  assert.equal(code(() => assertRedemptionTransition('reserved', 'reserved')), 'STATE_CONFLICT');
});

test('the snapshot freezes the rule version and masks the code for display', () => {
  const coupon = normalizeCoupon(write, 'HKD');
  const snapshot = couponSnapshot({ ...coupon, id: PRODUCT, version: 7 }, 1_234);
  assert.equal(snapshot.ruleVersion, 7);
  assert.equal(snapshot.code, 'SUMMER_10');
  assert.equal(snapshot.codeMasked, maskCouponCode('SUMMER_10'));
  assert.equal(snapshot.discountMinor, 1_234);
  assert.equal(snapshot.validUntil, '2026-12-01T00:00:00.000Z');
  assert.equal(maskCouponCode('AB'), '*B');
  assert.equal(maskCouponCode('ABCD'), '***D');
  assert.equal(maskCouponCode('ABCDE'), 'AB*DE');
  // 快照里不能出现任何顾客数据，只描述规则本身。
  assert.deepEqual(Object.keys(snapshot).sort(), ['code', 'codeMasked', 'couponId', 'currency', 'discountMinor',
    'discountType', 'discountValue', 'eligibleCategoryIds', 'eligibleProductIds', 'minSubtotalMinor',
    'perCustomerLimit', 'refundPolicy', 'ruleVersion', 'totalLimit', 'validFrom', 'validUntil']);
});

test('coupon codes are trimmed, upper-cased and bounded', () => {
  assert.equal(normalizeCouponCode('  save10  '), 'SAVE10');
  assert.equal(normalizeCouponCode(''), null);
  assert.equal(normalizeCouponCode(null), null);
  assert.equal(normalizeCouponCode(undefined), null);
  assert.equal(code(() => normalizeCouponCode('bad code')), 'couponCode');
  assert.equal(code(() => normalizeCouponCode('X'.repeat(81))), 'couponCode');
  assert.equal(code(() => normalizeCouponCode(42 as unknown as string)), 'couponCode');
  const coupon: CouponRule = normalizeCoupon(write, 'HKD');
  assert.equal(code(() => assertMinSubtotal(coupon, 4_999)), 'COUPON_MIN_SUBTOTAL_NOT_MET');
  assert.doesNotThrow(() => assertMinSubtotal(coupon, 5_000));
});

const TIER_A = '1a2b3c4d-0000-4222-8333-444455556666';
const TIER_B = '2a2b3c4d-0000-4222-8333-444455556666';
const MEMBER = '3a2b3c4d-0000-4222-8333-444455556666';
const BATCH_COUPON = '4a2b3c4d-0000-4222-8333-444455556666';

test('member-only coupons require the member to currently hold an allowed tier', () => {
  assert.equal(code(() => assertMemberTierEligible({ memberTierIds: [] }, null)), 'NO_ERROR');
  assert.equal(code(() => assertMemberTierEligible({ memberTierIds: [] }, TIER_A)), 'NO_ERROR');
  // 专属券：访客、无等级会员、等级不符会员都拒绝；命中等级才通过。
  const exclusive = { memberTierIds: [TIER_A, TIER_B] };
  assert.equal(code(() => assertMemberTierEligible(exclusive, null)), 'COUPON_MEMBER_ONLY');
  assert.equal(code(() => assertMemberTierEligible(exclusive, '9a2b3c4d-0000-4222-8333-444455556666')), 'COUPON_MEMBER_ONLY');
  assert.equal(code(() => assertMemberTierEligible(exclusive, TIER_A)), 'NO_ERROR');
  assert.equal(code(() => assertMemberTierEligible(exclusive, TIER_B)), 'NO_ERROR');
});

test('member limit key is instance-bound and derives only from the member id', () => {
  const a = memberLimitMaterial('instance-1', MEMBER);
  const b = memberLimitMaterial('instance-1', MEMBER);
  assert.equal(a, b); // 同一会员稳定
  assert.equal(a, 'instance-1:coupon:member:' + MEMBER);
  assert.notEqual(a, memberLimitMaterial('instance-2', MEMBER)); // 换实例不同
  assert.notEqual(a, memberLimitMaterial('instance-1', TIER_A)); // 换会员不同
  assert.equal(code(() => memberLimitMaterial('', MEMBER)), 'instanceId');
  assert.equal(code(() => memberLimitMaterial('instance-1', 'not-a-uuid')), 'memberId');
});

test('batch creation takes exactly one recipient source and freezes the members', () => {
  const base = { couponId: BATCH_COUPON, channel: 'account_only' };
  assert.equal(code(() => normalizeCouponBatch({ ...base, recipientMemberIds: [MEMBER] })), 'NO_ERROR');
  assert.equal(code(() => normalizeCouponBatch({ ...base, recipientFilter: { memberTierIds: [TIER_A] } })), 'NO_ERROR');
  // 两来源都没有 / 都有，都拒绝。
  assert.equal(code(() => normalizeCouponBatch(base)), 'recipientSource');
  assert.equal(code(() => normalizeCouponBatch({ ...base, recipientMemberIds: [MEMBER],
    recipientFilter: { memberTierIds: [TIER_A] } })), 'recipientSource');
  // 重复成员直接拒绝（与券范围口径一致）；非法 UUID、非法渠道、筛选夹带未知键都拒绝。
  assert.equal(code(() => normalizeCouponBatch({ ...base, recipientMemberIds: [MEMBER, MEMBER] })), 'recipientMemberIds');
  assert.equal(code(() => normalizeCouponBatch({ ...base, recipientMemberIds: ['bad'] })), 'recipientMemberIds');
  assert.equal(code(() => normalizeCouponBatch({ ...base, channel: 'wechat', recipientMemberIds: [MEMBER] })), 'channel');
  assert.equal(code(() => normalizeCouponBatch({ ...base, recipientFilter: { memberTierIds: [TIER_A], status: 'active' } })), 'recipientFilter');
  assert.equal(code(() => normalizeCouponBatch({ ...base, recipientFilter: { memberTierIds: [] } })), 'recipientFilter');
  assert.equal(code(() => normalizeCouponBatch({ ...base, recipientMemberIds: Array(MAX_BATCH_RECIPIENTS + 1).fill(MEMBER) })), 'recipientMemberIds');
});

test('batch issue only accepts a confirmed count and rejects a smuggled recipient list', () => {
  assert.deepEqual(normalizeBatchIssue({ confirmedRecipientCount: 0 }), { confirmedRecipientCount: 0 });
  assert.equal(code(() => normalizeBatchIssue({})), 'confirmedRecipientCount');
  assert.equal(code(() => normalizeBatchIssue({ confirmedRecipientCount: -1 })), 'confirmedRecipientCount');
  assert.equal(code(() => normalizeBatchIssue({ confirmedRecipientCount: 1.5 })), 'confirmedRecipientCount');
  assert.equal(code(() => normalizeBatchIssue({ confirmedRecipientCount: 1, recipientMemberIds: [MEMBER] })), 'VALIDATION_ERROR');
  // 确认数必须与建批时冻结的人数一致。
  assert.equal(code(() => assertBatchRecipientCount(120, 120)), 'NO_ERROR');
  assert.equal(code(() => assertBatchRecipientCount(120, 119)), 'BATCH_RECIPIENT_COUNT_CHANGED');
});
