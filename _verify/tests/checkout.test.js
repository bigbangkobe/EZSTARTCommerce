import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertQuoteActive, assertQuoteMath, assertQuoteVersion, CheckoutRuleError, normalizeAddress, normalizeContact, normalizeCouponCode, normalizePolicyAcceptances, normalizeQuantity, orderRequestFingerprint, publicOrderNumber, quoteExpiry, shippingFeeMinor, zoneCovers } from '../packages/domain/src/checkout.js';
import { assertNoOverlap, normalizeCountries, normalizeMoney, normalizeNames, zonesOverlap } from '../packages/domain/src/shipping.js';
function rejects(fn, code = 'VALIDATION_ERROR') {
    assert.throws(fn, (error) => error instanceof CheckoutRuleError && error.code === code);
}
test('quantities are integers inside 1–99 and never coerced from strings', () => {
    assert.equal(normalizeQuantity(1), 1);
    assert.equal(normalizeQuantity(99), 99);
    for (const value of [0, 100, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '2'])
        rejects(() => normalizeQuantity(value));
});
test('contact needs at least one valid channel and both blank values are refused', () => {
    assert.deepEqual(normalizeContact({ email: 'buyer@example.com', phone: null, fullName: null }), { email: 'buyer@example.com', phone: null, fullName: null });
    assert.deepEqual(normalizeContact({ email: null, phone: '+852 1234 5678', fullName: ' Mei ' }), { email: null, phone: '+852 1234 5678', fullName: 'Mei' });
    for (const value of [{ email: null, phone: null, fullName: null }, { email: '  ', phone: '   ', fullName: null }]) {
        rejects(() => normalizeContact(value));
    }
    rejects(() => normalizeContact({ email: 'not-an-email', phone: null, fullName: null }));
    rejects(() => normalizeContact({ email: null, phone: 'abc', fullName: null }));
    rejects(() => normalizeContact({ email: 'a'.repeat(250) + '@example.com', phone: null, fullName: null }));
});
test('addresses are trimmed, country codes uppercased and length-capped', () => {
    const address = normalizeAddress({ recipientName: ' Mei ', phone: null, countryCode: 'hk', regionCode: null,
        city: null, district: null, addressLine1: ' 1 Queen Road ', addressLine2: null, postalCode: null });
    assert.equal(address.countryCode, 'HK');
    assert.equal(address.addressLine1, '1 Queen Road');
    assert.equal(address.recipientName, 'Mei');
    rejects(() => normalizeAddress({ ...address, addressLine1: '   ' }));
    rejects(() => normalizeAddress({ ...address, countryCode: 'HKG' }));
    rejects(() => normalizeAddress({ ...address, addressLine1: 'x'.repeat(201) }));
});
test('coupon codes are trimmed and uppercased, blank means unused', () => {
    assert.equal(normalizeCouponCode(' save10 '), 'SAVE10');
    assert.equal(normalizeCouponCode('   '), null);
    assert.equal(normalizeCouponCode(null), null);
    rejects(() => normalizeCouponCode('SAVE 10'));
    rejects(() => normalizeCouponCode('X'.repeat(81)));
});
test('policy acceptances reject duplicates and implicit consent', () => {
    assert.deepEqual(normalizePolicyAcceptances([{ policyKey: 'terms', version: '2', accepted: true }]), [{ policyKey: 'terms', version: '2', accepted: true }]);
    assert.deepEqual(normalizePolicyAcceptances(undefined), []);
    rejects(() => normalizePolicyAcceptances([{ policyKey: 'terms', version: '2', accepted: false }]));
    rejects(() => normalizePolicyAcceptances([{ policyKey: 'terms', version: '2', accepted: true },
        { policyKey: 'terms', version: '3', accepted: true }]));
    rejects(() => normalizePolicyAcceptances([{ policyKey: '', version: '1', accepted: true }]));
});
test('shipping fee honours the free-shipping threshold exactly at the boundary', () => {
    const rate = { fixedFeeMinor: 3_000, freeAboveMinor: 20_000 };
    assert.equal(shippingFeeMinor(rate, 19_999), 3_000);
    assert.equal(shippingFeeMinor(rate, 20_000), 0);
    assert.equal(shippingFeeMinor({ fixedFeeMinor: 0, freeAboveMinor: null }, 1), 0);
    rejects(() => shippingFeeMinor({ fixedFeeMinor: -1, freeAboveMinor: null }, 100));
});
test('zone coverage follows country then region specificity', () => {
    const address = { countryCode: 'HK', regionCode: 'KLN', recipientName: null, phone: null, city: null, district: null,
        addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
    assert.equal(zoneCovers({ countryCodes: ['HK'], regionCodes: [] }, address), true);
    assert.equal(zoneCovers({ countryCodes: ['HK'], regionCodes: ['KLN'] }, address), true);
    assert.equal(zoneCovers({ countryCodes: ['HK'], regionCodes: ['HKI'] }, address), false);
    assert.equal(zoneCovers({ countryCodes: ['MO'], regionCodes: [] }, address), false);
    assert.equal(zoneCovers({ countryCodes: ['HK'], regionCodes: ['KLN'] }, { ...address, regionCode: null }), false);
});
test('overlapping enabled zones are refused while disjoint regions coexist', () => {
    assert.equal(zonesOverlap({ countryCodes: ['HK'], regionCodes: [] }, { countryCodes: ['HK'], regionCodes: [] }), true);
    assert.equal(zonesOverlap({ countryCodes: ['HK'], regionCodes: ['KLN'] }, { countryCodes: ['HK'], regionCodes: ['KLN', 'HKI'] }), true);
    assert.equal(zonesOverlap({ countryCodes: ['HK'], regionCodes: ['KLN'] }, { countryCodes: ['HK'], regionCodes: ['HKI'] }), false);
    assert.equal(zonesOverlap({ countryCodes: ['HK'], regionCodes: [] }, { countryCodes: ['MO'], regionCodes: [] }), false);
    const existing = [{ id: 'a', enabled: true, countryCodes: ['HK'], regionCodes: ['KLN'] }];
    assert.throws(() => assertNoOverlap({ code: 'K', nameByLocale: { en: 'K' }, countryCodes: ['HK'], regionCodes: ['KLN'],
        priority: 0, enabled: true }, existing), (error) => error instanceof Error && error.code === 'ZONE_OVERLAP');
    // 停用的区不参与冲突判断，可以保留历史配置。
    assert.doesNotThrow(() => assertNoOverlap({ code: 'K', nameByLocale: { en: 'K' }, countryCodes: ['HK'], regionCodes: ['KLN'],
        priority: 0, enabled: false }, existing));
});
test('shipping inputs are normalized and bounded', () => {
    assert.deepEqual(normalizeCountries(['hk', 'MO', 'HK']), ['HK', 'MO']);
    assert.deepEqual(normalizeNames({ en: ' Standard ' }, 20), { en: 'Standard' });
    assert.equal(normalizeMoney(null, 'freeAboveMinor', true), null);
    assert.equal(normalizeMoney(0, 'fixedFeeMinor'), 0);
    assert.throws(() => normalizeMoney(undefined, 'fixedFeeMinor')); // 必填字段缺省不能被当成 0
    assert.throws(() => normalizeCountries(['H']));
    assert.throws(() => normalizeNames({}, 20));
    assert.throws(() => normalizeMoney(1.5, 'fixedFeeMinor'));
});
test('quote math is an invariant, not a preference', () => {
    assert.doesNotThrow(() => assertQuoteMath({ subtotalMinor: 10_000, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: 13_000 }));
    rejects(() => assertQuoteMath({ subtotalMinor: 10_000, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: 12_999 }));
    rejects(() => assertQuoteMath({ subtotalMinor: 1_000, discountMinor: 1_001, shippingMinor: 0, taxMinor: 0, totalMinor: 0 }));
    rejects(() => assertQuoteMath({ subtotalMinor: 1_000.5, discountMinor: 0, shippingMinor: 0, taxMinor: 0, totalMinor: 1_000.5 }));
    // 积分抵扣只减商品金额：1 万分小计、2 千分运费、用 3 千分积分，总额应为 9 千。
    assert.doesNotThrow(() => assertQuoteMath({ subtotalMinor: 10_000, discountMinor: 0, pointsValueMinor: 3_000,
        shippingMinor: 2_000, taxMinor: 0, totalMinor: 9_000 }));
    rejects(() => assertQuoteMath({ subtotalMinor: 10_000, discountMinor: 0, pointsValueMinor: 3_000,
        shippingMinor: 2_000, taxMinor: 0, totalMinor: 12_000 }));
    rejects(() => assertQuoteMath({ subtotalMinor: 10_000, discountMinor: 9_000, pointsValueMinor: 1_001,
        shippingMinor: 0, taxMinor: 0, totalMinor: 0 }));
});
test('quote version and lifetime gate order creation', () => {
    assert.doesNotThrow(() => assertQuoteVersion(2, 2));
    assert.throws(() => assertQuoteVersion(2, 1), (error) => error.code === 'QUOTE_VERSION_CONFLICT');
    const now = new Date('2026-11-16T00:00:00.000Z');
    assert.doesNotThrow(() => assertQuoteActive('active', quoteExpiry(now), now));
    assert.throws(() => assertQuoteActive('consumed', quoteExpiry(now), now), (error) => error.code === 'QUOTE_NOT_AVAILABLE');
    assert.throws(() => assertQuoteActive('active', now, now), (error) => error.code === 'QUOTE_EXPIRED');
    assert.equal(quoteExpiry(now).getTime() - now.getTime(), 15 * 60_000);
});
test('public order numbers are dated and random-suffixed', () => {
    assert.equal(publicOrderNumber('20261116', 'ABC234'), 'EZ-20261116-ABC234');
    assert.throws(() => publicOrderNumber('2026-11-16', 'ABC234'));
    assert.throws(() => publicOrderNumber('20261116', 'abc234'));
});
test('idempotency fingerprint ignores whitespace but not meaningful fields', () => {
    const base = { quoteId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', confirmedQuoteVersion: 1, paymentMethodCode: 'cod', customerNote: null };
    assert.equal(orderRequestFingerprint(base), orderRequestFingerprint({ ...base, quoteId: base.quoteId.toLowerCase(), paymentMethodCode: ' cod ' }));
    assert.notEqual(orderRequestFingerprint(base), orderRequestFingerprint({ ...base, customerNote: 'leave at door' }));
    assert.notEqual(orderRequestFingerprint(base), orderRequestFingerprint({ ...base, confirmedQuoteVersion: 2 }));
});
