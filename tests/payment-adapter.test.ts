import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADAPTER_STATUSES, assertCreatePaymentInput, assertNoSecretShape, assertSecretSchemeAllowed,
  assertWebhookAmount, checkoutVisible, containsSecretShape, derivedEventId, isSettled,
  normalizeAdapterStatus, PaymentAdapterError, secretRefTarget, webhookEventKey,
} from '../packages/domain/src/payment-adapter.js';

const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return (error as PaymentAdapterError).code; }
  return 'NO_ERROR';
};

/** 被测金额与币种的最小合法入参。 */
const amountOk = { amountMinor: 12000, currency: 'HKD', expectedAmountMinor: 12000, expectedCurrency: 'HKD' };

test('payment-adapter: status normalisation covers aliases, casing and whitespace', () => {
  assert.equal(normalizeAdapterStatus('TRADE_SUCCESS'), 'succeeded');
  assert.equal(normalizeAdapterStatus('  Paid  '), 'succeeded');
  assert.equal(normalizeAdapterStatus('requires_capture'), 'authorized');
  assert.equal(normalizeAdapterStatus('EXPIRED'), 'cancelled');
  assert.equal(normalizeAdapterStatus('processing'), 'pending');
  assert.equal(normalizeAdapterStatus('requires_action'), 'pending');
});

test('payment-adapter: unknown channel status degrades to unknown instead of throwing', () => {
  // 渠道新状态不能让回调 5xx，否则触发重试风暴；只能记 unknown 等查询收敛。
  assert.equal(normalizeAdapterStatus('SOME_NEW_CHANNEL_STATE'), 'unknown');
  assert.equal(normalizeAdapterStatus(''), 'unknown');
  assert.equal(normalizeAdapterStatus(null), 'unknown');
  assert.equal(normalizeAdapterStatus(42), 'unknown');
  assert.equal(normalizeAdapterStatus('x'.repeat(65)), 'unknown');
});

test('payment-adapter: per-channel mapping wins over generic aliases', () => {
  // 同一渠道把 pending 叫成 "waiting"，通用表不认识，靠第二参数补。
  assert.equal(normalizeAdapterStatus('waiting'), 'unknown');
  assert.equal(normalizeAdapterStatus('waiting', { waiting: 'pending' }), 'pending');
  assert.equal(normalizeAdapterStatus('WAITING', { waiting: 'pending' }), 'pending');
  // 自定义映射可以覆盖通用别名
  assert.equal(normalizeAdapterStatus('paid', { paid: 'authorized' }), 'authorized');
});

test('payment-adapter: only succeeded counts as settled', () => {
  assert.equal(isSettled('succeeded'), true);
  for (const status of ADAPTER_STATUSES) {
    if (status !== 'succeeded') assert.equal(isSettled(status), false, status);
  }
});

test('payment-adapter: webhook dedupe key is provider-scoped and validated', () => {
  assert.equal(webhookEventKey('mock', 'evt_123'), 'mock:evt_123');
  assert.equal(code(() => webhookEventKey('Mock', 'evt_1')), 'WEBHOOK_PROVIDER_INVALID');
  assert.equal(code(() => webhookEventKey('mock', '')), 'WEBHOOK_EVENT_ID_INVALID');
  assert.equal(code(() => webhookEventKey('mock', 'bad id with space')), 'WEBHOOK_EVENT_ID_INVALID');
  assert.equal(code(() => webhookEventKey('mock', 'x'.repeat(121))), 'WEBHOOK_EVENT_ID_INVALID');
});

test('payment-adapter: derived event id is stable within the same second', () => {
  const at = new Date('2026-11-20T10:00:00.500Z');
  const a = derivedEventId('txn_1', 'succeeded', at);
  const b = derivedEventId('txn_1', 'succeeded', new Date('2026-11-20T10:00:00.900Z'));
  assert.equal(a, b);
  // 不同状态必须产生不同键，否则"失败后又成功"会被当成重复事件丢掉
  assert.notEqual(a, derivedEventId('txn_1', 'failed', at));
  assert.equal(code(() => derivedEventId('txn 1', 'succeeded', at)), 'WEBHOOK_EVENT_ID_INVALID');
});

test('payment-adapter: webhook amount must match order exactly', () => {
  assert.equal(code(() => assertWebhookAmount(amountOk)), 'NO_ERROR');
  assert.equal(code(() => assertWebhookAmount({ ...amountOk, amountMinor: null })), 'WEBHOOK_AMOUNT_MISSING');
  assert.equal(code(() => assertWebhookAmount({ ...amountOk, amountMinor: 0 })), 'WEBHOOK_AMOUNT_MISSING');
  assert.equal(code(() => assertWebhookAmount({ ...amountOk, amountMinor: 1.5 })), 'WEBHOOK_AMOUNT_MISSING');
  assert.equal(code(() => assertWebhookAmount({ ...amountOk, currency: 'usd' })), 'WEBHOOK_CURRENCY_INVALID');
  assert.equal(code(() => assertWebhookAmount({ ...amountOk, currency: 'USD' })), 'WEBHOOK_CURRENCY_MISMATCH');
  assert.equal(code(() => assertWebhookAmount({ ...amountOk, amountMinor: 11999 })), 'WEBHOOK_AMOUNT_MISMATCH');
});

test('payment-adapter: secret refs accept only known schemes', () => {
  assert.deepEqual(secretRefTarget('secret://aws-sm/ezstart/mrinhk/payment/gateway'),
    { scheme: 'aws-sm', name: 'ezstart/mrinhk/payment/gateway' });
  assert.deepEqual(secretRefTarget('secret://env/PAY_KEY'), { scheme: 'env', name: 'PAY_KEY' });
  assert.deepEqual(secretRefTarget('secret://file/run/secrets/pay'), { scheme: 'file', name: 'run/secrets/pay' });
  assert.equal(code(() => secretRefTarget('secret://vault/pay')), 'SECRET_REFERENCE_INVALID');
  // 明文密钥形状必须被拒，不能悄悄当引用存下来
  assert.equal(code(() => secretRefTarget('sk_live_abcdefgh12345678')), 'SECRET_REFERENCE_INVALID');
  assert.equal(code(() => secretRefTarget(null)), 'SECRET_REFERENCE_INVALID');
});

test('payment-adapter: production rejects env and file secret schemes', () => {
  assert.equal(code(() => assertSecretSchemeAllowed('aws-sm', 'production')), 'NO_ERROR');
  assert.equal(code(() => assertSecretSchemeAllowed('ssm', 'production')), 'NO_ERROR');
  assert.equal(code(() => assertSecretSchemeAllowed('env', 'production')), 'SECRET_SCHEME_NOT_ALLOWED_IN_PRODUCTION');
  assert.equal(code(() => assertSecretSchemeAllowed('file', 'production')), 'SECRET_SCHEME_NOT_ALLOWED_IN_PRODUCTION');
  // 沙箱与本地开发允许，否则跑不起来
  assert.equal(code(() => assertSecretSchemeAllowed('env', 'sandbox')), 'NO_ERROR');
  assert.equal(code(() => assertSecretSchemeAllowed('file', 'sandbox')), 'NO_ERROR');
});

test('payment-adapter: checkout hides methods that are enabled but unverified', () => {
  const base = { enabled: true, connectionStatus: 'verified', environment: 'production', requestEnvironment: 'production' };
  assert.equal(checkoutVisible(base), true);
  assert.equal(checkoutVisible({ ...base, enabled: false }), false);
  assert.equal(checkoutVisible({ ...base, connectionStatus: 'failed' }), false);
  assert.equal(checkoutVisible({ ...base, connectionStatus: 'unverified' }), false);
  // 生产配置不应出现在沙箱请求里，反之亦然
  assert.equal(checkoutVisible({ ...base, requestEnvironment: 'sandbox' }), false);
});

test('payment-adapter: create payment input is validated field by field', () => {
  const ok = {
    paymentNumber: 'PAY-20261120-ABC123',
    orderNumber: 'SO-20261120-0001',
    amountMinor: 12000,
    currency: 'HKD',
    returnUrl: 'https://mrinhk.com/checkout/return',
    notifyUrl: 'https://mrinhk.com/webhooks/payments/mock',
    locale: 'zh-HK',
  };
  assert.deepEqual(assertCreatePaymentInput(ok, 'production'), ok);
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, paymentNumber: 'PAY-1' }, 'production')), 'PAYMENT_NUMBER_INVALID');
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, orderNumber: '  ' }, 'production')), 'ORDER_NUMBER_INVALID');
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, amountMinor: 0 }, 'production')), 'AMOUNT_INVALID');
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, amountMinor: -1 }, 'production')), 'AMOUNT_INVALID');
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, currency: 'HKDX' }, 'production')), 'CURRENCY_INVALID');
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, locale: 'ZH_hk' }, 'production')), 'LOCALE_INVALID');
  // 生产必须 https：明文回调等于把订单信息暴露在公网
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, notifyUrl: 'http://mrinhk.com/cb' }, 'production')), 'URL_INVALID');
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, notifyUrl: 'http://mrinhk.com/cb' }, 'sandbox')), 'NO_ERROR');
  assert.equal(code(() => assertCreatePaymentInput({ ...ok, returnUrl: 'not-a-url' }, 'production')), 'URL_INVALID');
});

test('payment-adapter: metadata guard blocks secret shapes and forbidden keys', () => {
  assert.equal(containsSecretShape('sk_live_abcdefgh1234'), true);
  assert.equal(containsSecretShape('AKIAIOSFODNN7EXAMPLE'), true);
  assert.equal(containsSecretShape('order 12345 paid'), false);

  assert.equal(code(() => assertNoSecretShape({ channel: 'mock', status: 'succeeded' })), 'NO_ERROR');
  assert.equal(code(() => assertNoSecretShape({ nested: { token: 'abc' } })), 'METADATA_FORBIDDEN_KEY');
  assert.equal(code(() => assertNoSecretShape({ list: ['ok', 'sk_live_abcdefgh1234'] })), 'METADATA_CONTAINS_SECRET');
  assert.equal(code(() => assertNoSecretShape({ apiKey: 'whatever' })), 'METADATA_FORBIDDEN_KEY');
  assert.equal(code(() => assertNoSecretShape({ a: { b: { c: { d: { e: { f: { g: 'x' } } } } } } })), 'METADATA_TOO_DEEP');
  assert.equal(code(() => assertNoSecretShape(Array.from({ length: 201 }, () => 1))), 'METADATA_TOO_LARGE');
  // 非字符串标量不触发误报
  assert.equal(code(() => assertNoSecretShape({ amount: 12000, ok: true, note: null })), 'NO_ERROR');
});
