import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANALYTICS_EVENT_NAMES, ANALYTICS_BATCH_MAX, ANALYTICS_SCHEMA_VERSION,
  assertSessionId, assertEventId, assertBrowserEventName, assertConsentState,
  assertInstant, assertSchemaVersion, assertDeviceClass, assertSource,
  normalizeAnalyticsEvent, normalizeAnalyticsBatch, countsTowardFunnel, funnelStepIndex,
  AnalyticsRuleError,
} from '../packages/domain/src/analytics.js';

const NOW = new Date().toISOString();
const baseEvent = {
  eventId: 'e1234567890abcdef', sessionId: 'sess_abcdefghijklmnop',
  eventName: 'page_view', occurredAt: NOW, schemaVersion: '1.0', consentState: 'granted',
  pageKey: 'home', locale: 'zh-HK', deviceClass: 'mobile', source: 'newsletter',
};

test('analytics: event names are a closed set that never includes purchase', () => {
  assert.deepEqual([...ANALYTICS_EVENT_NAMES], ['page_view', 'view_item', 'add_to_cart', 'begin_checkout']);
  for (const name of ANALYTICS_EVENT_NAMES) assert.equal(assertBrowserEventName(name), name);
  // 浏览器 purchase 必须拒绝：成交只认服务端订单。
  assert.throws(() => assertBrowserEventName('purchase'), AnalyticsRuleError);
  assert.throws(() => assertBrowserEventName('refund'), AnalyticsRuleError);
  assert.throws(() => assertBrowserEventName(42), AnalyticsRuleError);
  assert.equal(funnelStepIndex('purchase'), 4);
  assert.equal(funnelStepIndex('page_view'), 0);
  assert.equal(funnelStepIndex('unknown'), -1);
});

test('analytics: session id and event id must be random-safe, never PII-shaped', () => {
  assert.equal(assertSessionId('sess_abcdefghijklmnop'), 'sess_abcdefghijklmnop');
  assert.equal(assertSessionId('a'.repeat(32)), 'a'.repeat(32));
  for (const bad of ['a@b.com', 'user.123@example', 'short', 'a'.repeat(129), 42]) {
    assert.throws(() => assertSessionId(bad), AnalyticsRuleError);
  }
  assert.equal(assertEventId('e1234567890abcdef'), 'e1234567890abcdef');
  for (const bad of ['short', 'has spaces in id!!', 'a'.repeat(129)]) {
    assert.throws(() => assertEventId(bad), AnalyticsRuleError);
  }
});

test('analytics: consent and schema version are gated', () => {
  assert.equal(assertConsentState('granted'), 'granted');
  assert.equal(assertConsentState('denied'), 'denied');
  assert.throws(() => assertConsentState('yes'), AnalyticsRuleError);
  assert.equal(assertSchemaVersion('1.0'), '1.0');
  assert.equal(assertSchemaVersion('12.34'), '12.34');
  for (const bad of ['v1', '1', '1.0.1', 42]) assert.throws(() => assertSchemaVersion(bad), AnalyticsRuleError);
  assert.equal(countsTowardFunnel({ consentState: 'granted' }), true);
  assert.equal(countsTowardFunnel({ consentState: 'denied' }), false);
  assert.equal(countsTowardFunnel({ consentState: 'unknown' }), false);
});

test('analytics: source rejects full URLs; device class is closed; time skew bounded', () => {
  assert.equal(assertSource('newsletter'), 'newsletter');
  for (const bad of ['https://x.com/?q=secret', 'a/b', 'mail@example', 'x.y']) {
    assert.throws(() => assertSource(bad), AnalyticsRuleError);
  }
  assert.equal(assertDeviceClass('mobile'), 'mobile');
  assert.equal(assertDeviceClass(undefined), null);
  assert.throws(() => assertDeviceClass('smartwatch'), AnalyticsRuleError);
  assert.equal(assertInstant(NOW).toISOString(), NOW);
  assert.throws(() => assertInstant('2026-11-01'), AnalyticsRuleError);
  // 过期很久的事件不能污染报表（浏览器时钟错误）。
  assert.throws(() => assertInstant('2020-01-01T00:00:00.000Z'), AnalyticsRuleError);
});

test('analytics: normalize event keeps only whitelisted fields and drops PII keys', () => {
  const normalized = normalizeAnalyticsEvent({ ...baseEvent, email: 'a@b.com', url: 'https://x/?p=1', phone: '123' });
  assert.equal(normalized.eventName, 'page_view');
  assert.equal(normalized.consentState, 'granted');
  assert.equal(normalized.pageKey, 'home');
  assert.equal((normalized as unknown as Record<string, unknown>)['email'], undefined);
  assert.equal((normalized as unknown as Record<string, unknown>)['url'], undefined);
  assert.match(ANALYTICS_SCHEMA_VERSION, /^\d+\.\d+$/);
});

test('analytics: batch size is bounded and every event is validated', () => {
  assert.throws(() => normalizeAnalyticsBatch({}), AnalyticsRuleError);
  assert.throws(() => normalizeAnalyticsBatch({ events: [] }), AnalyticsRuleError);
  const tooMany = Array.from({ length: ANALYTICS_BATCH_MAX + 1 }, (_, i) => ({
    ...baseEvent, eventId: `e${String(i).padStart(16, '0')}`,
  }));
  assert.throws(() => normalizeAnalyticsBatch({ events: tooMany }), AnalyticsRuleError);
  const ok = normalizeAnalyticsBatch({ events: [baseEvent] });
  assert.equal(ok.length, 1);
  assert.throws(() => normalizeAnalyticsBatch({ events: [{ ...baseEvent, eventName: 'purchase' }] }), AnalyticsRuleError);
});
