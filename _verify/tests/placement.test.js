import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLACEMENT_ATTRIBUTION_WINDOW_MS, PLACEMENT_MIN_IMPRESSION_SESSIONS, PlacementRuleError, allocateRefund, assertSectionKey, attributionWithinWindow, impressionKey, netRevenueMinor, normalizeCartAttribution, pickAttribution, placementCoverage, placementRatio, } from '../packages/domain/src/placement.js';
import { normalizeAnalyticsEvent } from '../packages/domain/src/analytics.js';
import { normalizeReportFilters } from '../packages/domain/src/reports.js';
test('placement: section keys are anonymous stable identifiers, never URLs or PII', { timeout: 20_000 }, () => {
    assert.equal(assertSectionKey('home.hero'), 'home.hero');
    assert.equal(assertSectionKey('plp.category.1'), 'plp.category.1');
    for (const bad of ['https://shop.test/home', 'home hero', 'home/hero', '<script>', 'a', '@handle', '']) {
        assert.throws(() => assertSectionKey(bad), PlacementRuleError, bad);
    }
});
test('placement: cart attribution requires explicit consent and rejects PII shapes', { timeout: 20_000 }, () => {
    const now = new Date('2026-11-18T10:00:00.000Z');
    const base = { sectionId: 'home:hero', sectionKey: 'home.hero', publishVersionId: 'rel-2026-11',
        interactionId: 'i'.repeat(32), pageKey: 'home', sessionId: 's'.repeat(24) };
    const granted = normalizeCartAttribution({ ...base, consentState: 'granted', occurredAt: now.toISOString() }, now);
    assert.ok(granted);
    assert.equal(granted.sectionKey, 'home.hero');
    assert.equal(granted.placementId, null);
    // 未同意 / 未知：加购仍成功，但不写归因（不能靠加购接口绕过同意门槛）。
    assert.equal(normalizeCartAttribution({ ...base, consentState: 'denied' }, now), null);
    assert.equal(normalizeCartAttribution({ ...base, consentState: 'unknown' }, now), null);
    assert.equal(normalizeCartAttribution(undefined, now), null);
    for (const bad of [
        { ...base, consentState: 'granted', sectionKey: 'https://x/?q=1' },
        { ...base, consentState: 'granted', interactionId: 'short' },
        { ...base, consentState: 'granted', publishVersionId: '../etc/passwd' },
        { ...base, consentState: 'granted', sessionId: 'buyer@example.com' },
        { ...base, consentState: 'granted', occurredAt: '2026-01-01T00:00:00.000Z' },
    ])
        assert.throws(() => normalizeCartAttribution(bad, now), PlacementRuleError);
});
test('placement: only the last interaction inside the 24h window is attributed', { timeout: 20_000 }, () => {
    const orderedAt = new Date('2026-11-18T12:00:00.000Z');
    const at = (offsetMs) => new Date(orderedAt.getTime() + offsetMs);
    assert.equal(attributionWithinWindow(at(-PLACEMENT_ATTRIBUTION_WINDOW_MS), orderedAt), true);
    assert.equal(attributionWithinWindow(at(-PLACEMENT_ATTRIBUTION_WINDOW_MS - 1), orderedAt), false);
    assert.equal(attributionWithinWindow(at(1), orderedAt), false, '未来的交互不是有效交互');
    const candidates = [
        { id: 'a', variantId: 'v1', occurredAt: at(-3 * 3_600_000) },
        { id: 'b', variantId: 'v1', occurredAt: at(-1 * 3_600_000) },
        { id: 'c', variantId: 'v1', occurredAt: at(-30 * 3_600_000) },
        { id: 'd', variantId: 'v1', occurredAt: at(60_000) },
    ];
    assert.equal(pickAttribution(candidates, orderedAt)?.id, 'b');
    assert.equal(pickAttribution([candidates[2], candidates[3]], orderedAt), null, '窗口外与未来都不归因');
    assert.equal(pickAttribution([], orderedAt), null);
});
test('placement: refunds split by line amount with fixed-order remainder and floors at zero', { timeout: 20_000 }, () => {
    const items = [{ id: 'a', lineTotalMinor: 3333 }, { id: 'b', lineTotalMinor: 6667 }];
    const split = allocateRefund(items, 1000);
    // 333.3 / 666.7 → 各取整 333/666，余 1 分按固定行序补给第一行。
    assert.equal(split.get('a'), 334);
    assert.equal(split.get('b'), 666);
    assert.equal([...split.values()].reduce((sum, value) => sum + value, 0), 1000);
    // 余数按固定行序补 1 分：3 行各 1 分钱、退 2 分 → 前两行各 1 分。
    const remainder = allocateRefund([{ id: 'x', lineTotalMinor: 1 }, { id: 'y', lineTotalMinor: 1 },
        { id: 'z', lineTotalMinor: 1 }], 2);
    assert.deepEqual([...remainder.entries()], [['x', 1], ['y', 1], ['z', 0]]);
    // 全零金额：退款不凭空消失，落到第一行。
    const zero = allocateRefund([{ id: 'p', lineTotalMinor: 0 }, { id: 'q', lineTotalMinor: 0 }], 500);
    assert.deepEqual([...zero.entries()], [['p', 500], ['q', 0]]);
    assert.equal(allocateRefund([], 500).size, 0);
    assert.equal(netRevenueMinor(20_000, 10_000), 10_000);
    assert.equal(netRevenueMinor(20_000, 25_000), 0, '退款超过行金额时净实收不为负');
});
test('placement: coverage distinguishes no traffic, missing tracking, stale and ok', { timeout: 20_000 }, () => {
    const to = new Date('2026-11-18T00:00:00.000Z');
    const now = new Date('2026-11-18T01:00:00.000Z');
    assert.equal(placementCoverage({ pageViewSessions: 0, impressionSessions: 0, sectionEvents: 0,
        lastSectionEventAt: null, to, now }).status, 'no_traffic');
    assert.equal(placementCoverage({ pageViewSessions: 40, impressionSessions: 0, sectionEvents: 0,
        lastSectionEventAt: null, to, now }).status, 'tracking_missing');
    assert.equal(placementCoverage({ pageViewSessions: 40, impressionSessions: 0, sectionEvents: 9,
        lastSectionEventAt: new Date('2026-11-17T23:00:00.000Z'), to, now }).status, 'partial');
    assert.equal(placementCoverage({ pageViewSessions: 40, impressionSessions: 30, sectionEvents: 40,
        lastSectionEventAt: new Date('2026-11-14T00:00:00.000Z'), to, now }).status, 'stale');
    assert.equal(placementCoverage({ pageViewSessions: 40, impressionSessions: 30, sectionEvents: 40,
        lastSectionEventAt: new Date('2026-11-17T23:00:00.000Z'), to, now }).status, 'ok');
    // 曝光会话是去重键：同一会话同一页面同一区块只算一次。
    assert.equal(impressionKey('s1', 'home', 'home.hero'), impressionKey('s1', 'home', 'home.hero'));
    assert.notEqual(impressionKey('s1', 'home', 'home.hero'), impressionKey('s1', 'home', 'home.about'));
    // 小样本保护：曝光会话不足阈值时不给转化率。
    assert.equal(placementRatio(5, PLACEMENT_MIN_IMPRESSION_SESSIONS - 1), null);
    assert.equal(placementRatio(5, PLACEMENT_MIN_IMPRESSION_SESSIONS), 25);
});
test('placement: section events need stable identifiers and reject non-production values', { timeout: 20_000 }, () => {
    const base = { eventId: 'e'.repeat(32), sessionId: 's'.repeat(24), eventName: 'section_impression',
        occurredAt: new Date().toISOString(), schemaVersion: '1.0', consentState: 'granted' };
    const event = normalizeAnalyticsEvent({ ...base, sectionId: 'home:hero', sectionKey: 'home.hero',
        publishVersionId: 'rel-2026-11', environment: 'production', trafficClass: 'human' });
    assert.equal(event.sectionKey, 'home.hero');
    assert.equal(event.environment, 'production');
    // 普通页面事件不带区块字段也合法（区块字段默认 null）。
    const page = normalizeAnalyticsEvent({ ...base, eventName: 'page_view' });
    assert.equal(page.sectionKey, null);
    assert.throws(() => normalizeAnalyticsEvent({ ...base, sectionId: 'home:hero' }), /sectionKey/);
    assert.throws(() => normalizeAnalyticsEvent({ ...base, sectionId: 'home:hero', sectionKey: 'home.hero',
        environment: 'staging' }), /environment/);
    // 报表筛选：区块键是短标识，页面/版本接受点号与冒号，但不接受 URL 或空白。
    const { filters } = normalizeReportFilters({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z',
        timezone: 'Asia/Hong_Kong', sectionKey: 'home.hero', pageKey: 'home', publishVersionId: 'rel-2026-11',
        groupBy: 'section' });
    assert.equal(filters.sectionKey, 'home.hero');
    assert.equal(filters.groupBy, 'section');
    assert.throws(() => normalizeReportFilters({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z',
        timezone: 'Asia/Hong_Kong', sectionKey: 'https://x/?q=1' }));
});
