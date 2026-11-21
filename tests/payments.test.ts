import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertCodRequiresDispatch, assertCollectable, assertPaymentAmount, assertVersion, availableChannelsFor,
  nextPaymentStatus, normalizeAllowedChannels, normalizeMethodPatch, normalizeOutcome, normalizePublicConfig,
  orderPaymentStatusFor, paymentNumber, PRODUCT_PAYMENT_CHANNELS, provider, requiresPrepayment,
  PaymentRuleError,
} from '../packages/domain/src/payments.js';

const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof PaymentRuleError ? error.code : 'OTHER'; }
  return 'NO_ERROR';
};
const placedAt = new Date('2026-11-16T02:00:00.000Z');
const now = new Date('2026-11-16T10:00:00.000Z');

test('payment providers are a closed set with channel-specific credential needs', () => {
  assert.equal(provider('cod').channel, 'cod');
  assert.equal(provider('manual_bank_transfer').channel, 'manual');
  assert.equal(provider('cod').requiresSecret, false);
  assert.equal(code(() => provider('stripe')), 'UNSUPPORTED_PAYMENT_PROVIDER');
  assert.equal(code(() => provider('COD')), 'UNSUPPORTED_PAYMENT_PROVIDER');
});

test('ledger states only move forward along the channel that owns them', () => {
  assert.equal(nextPaymentStatus('pending', 'collected', 'cod'), 'collected');
  assert.equal(nextPaymentStatus('pending', 'rejected', 'cod'), 'rejected');
  assert.equal(nextPaymentStatus('collected', 'returned', 'cod'), 'returned');
  assert.equal(nextPaymentStatus('pending', 'succeeded', 'manual'), 'succeeded');
  assert.equal(nextPaymentStatus('succeeded', 'returned', 'manual'), 'returned');
  // COD 没有“授权成功”，人工转账没有“拒收”：渠道与结果不匹配就拒绝。
  assert.equal(code(() => nextPaymentStatus('pending', 'succeeded', 'cod')), 'PAYMENT_OUTCOME_NOT_ALLOWED');
  assert.equal(code(() => nextPaymentStatus('pending', 'rejected', 'manual')), 'PAYMENT_OUTCOME_NOT_ALLOWED');
  // 已收不能再收一次；未知不能人工改判。
  assert.equal(code(() => nextPaymentStatus('collected', 'collected', 'cod')), 'PAYMENT_STATE_CONFLICT');
  assert.equal(code(() => nextPaymentStatus('unknown', 'succeeded', 'online')), 'PAYMENT_STATUS_UNKNOWN_REQUIRES_PROVIDER');
  assert.equal(code(() => nextPaymentStatus('failed', 'succeeded', 'online')), 'PAYMENT_STATE_CONFLICT');
});

test('online channel owns a failure exit that offline channels must not use', () => {
  // 渠道拒付/风控拦截 = failed，与用户取消（cancelled）分开记，否则失败率统计失真。
  assert.equal(nextPaymentStatus('pending', 'failed', 'online'), 'failed');
  assert.equal(nextPaymentStatus('authorized', 'failed', 'online'), 'failed');
  assert.equal(nextPaymentStatus('pending', 'succeeded', 'online'), 'succeeded');
  assert.equal(nextPaymentStatus('pending', 'cancelled', 'online'), 'cancelled');
  // COD 与人工转账没有“渠道失败”这种结果。
  assert.equal(code(() => nextPaymentStatus('pending', 'failed', 'cod')), 'PAYMENT_OUTCOME_NOT_ALLOWED');
  assert.equal(code(() => nextPaymentStatus('pending', 'failed', 'manual')), 'PAYMENT_OUTCOME_NOT_ALLOWED');
  // failed 是终态：不能再前进，也不能退回。
  assert.equal(code(() => nextPaymentStatus('failed', 'succeeded', 'online')), 'PAYMENT_STATE_CONFLICT');
  assert.equal(code(() => nextPaymentStatus('failed', 'cancelled', 'online')), 'PAYMENT_STATE_CONFLICT');
});

test('failed outcome requires a reason, same as rejection and return', () => {
  const base = { outcome: 'failed', amountMinor: 23_000, occurredAt: '2026-11-16T09:00:00.000Z',
    reference: null, reason: null, expectedVersion: 3 };
  assert.equal(code(() => normalizeOutcome(base, new Date('2026-11-17T00:00:00.000Z'))), 'REASON_REQUIRED');
  const withReason = normalizeOutcome({ ...base, reason: 'card declined' }, new Date('2026-11-17T00:00:00.000Z'));
  assert.equal(withReason.outcome, 'failed');
  assert.equal(withReason.reason, 'card declined');
});

test('order payment status is a projection of the ledger, not a separate truth', () => {
  assert.equal(orderPaymentStatusFor('collected'), 'collected');
  assert.equal(orderPaymentStatusFor('succeeded'), 'succeeded');
  assert.equal(orderPaymentStatusFor('rejected'), 'rejected');
  assert.equal(orderPaymentStatusFor('returned'), 'returned');
  assert.equal(orderPaymentStatusFor('pending'), 'processing');
});

test('outcome requests must carry exact amounts, sane timestamps and a reason when money moved back', () => {
  const base = { outcome: 'collected', amountMinor: 23_000, occurredAt: '2026-11-16T09:00:00.000Z',
    reference: ' COD-778 ', reason: null, expectedVersion: 3 };
  const parsed = normalizeOutcome(base, now);
  assert.equal(parsed.amountMinor, 23_000);
  assert.equal(parsed.reference, 'COD-778');
  assert.equal(parsed.reason, null);
  assert.equal(parsed.occurredAt.toISOString(), '2026-11-16T09:00:00.000Z');
  // 未来时间、非整数金额、0 元都必须拒绝。
  assert.equal(code(() => normalizeOutcome({ ...base, occurredAt: '2026-11-16T12:00:00.000Z' }, now)), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeOutcome({ ...base, amountMinor: 230.5 }, now)), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeOutcome({ ...base, amountMinor: 0 }, now)), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeOutcome({ ...base, outcome: 'refunded' }, now)), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeOutcome({ ...base, outcome: 'rejected' }, now)), 'REASON_REQUIRED');
  assert.equal(code(() => normalizeOutcome({ ...base, outcome: 'returned', reason: '  ' }, now)), 'REASON_REQUIRED');
  assert.equal(code(() => normalizeOutcome({ ...base, reason: 'ok\u0007' }, now)), 'VALIDATION_ERROR');
});

test('amount and currency checks compare the ledger, the order and the request at once', () => {
  const ok = { paymentAmountMinor: 23_000, orderTotalMinor: 23_000, amountMinor: 23_000, currency: 'HKD', orderCurrency: 'HKD' };
  assert.equal(code(() => assertPaymentAmount(ok)), 'NO_ERROR');
  // 少收 0.01 也是错：不做四舍五入补齐。
  assert.equal(code(() => assertPaymentAmount({ ...ok, amountMinor: 22_999 })), 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(code(() => assertPaymentAmount({ ...ok, paymentAmountMinor: 22_000 })), 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(code(() => assertPaymentAmount({ ...ok, orderCurrency: 'USD' })), 'PAYMENT_CURRENCY_MISMATCH');
});

test('cancelled orders and backdated receipts are refused; COD waits for dispatch', () => {
  assert.equal(code(() => assertCollectable({ orderStatus: 'completed', placedAt }, new Date('2026-11-16T09:00:00Z'))), 'NO_ERROR');
  assert.equal(code(() => assertCollectable({ orderStatus: 'cancelled', placedAt }, new Date('2026-11-16T09:00:00Z'))), 'ORDER_ALREADY_CANCELLED');
  assert.equal(code(() => assertCollectable({ orderStatus: 'completed', placedAt }, new Date('2026-11-16T01:00:00Z'))), 'PAYMENT_TIME_INVALID');
  assert.equal(code(() => assertCodRequiresDispatch('cod', 'collected', false)), 'ORDER_NOT_SHIPPED');
  assert.equal(code(() => assertCodRequiresDispatch('cod', 'collected', true)), 'NO_ERROR');
  // 人工转账可以先到账再发货。
  assert.equal(code(() => assertCodRequiresDispatch('manual', 'collected', false)), 'NO_ERROR');
  assert.equal(code(() => assertVersion(2, 3)), 'VERSION_CONFLICT');
});

test('credential references are URIs, never raw keys', () => {
  const existing = { displayName: 'Gateway', publicConfig: { accountSummary: 'Bank: 123' }, secretRef: null, approvalReference: null };
  const enabled = { providerCode: 'manual_bank_transfer', environment: 'production', enabled: true };
  const withSecret = normalizeMethodPatch({ ...enabled, secretRef: 'secret://prod/gateway', approvalReference: 'ticket-1' }, existing);
  assert.equal(withSecret.secretRef, 'secret://prod/gateway');
  assert.equal(withSecret.approvalReference, 'ticket-1');
  assert.equal(withSecret.displayName, 'Gateway', '未提交的名称沿用原值');
  // 真实密钥形状、空白、无协议前缀一律拒绝。
  assert.equal(code(() => normalizeMethodPatch({ ...enabled, secretRef: 'sk_live_51H8' }, existing)), 'SECRET_REFERENCE_INVALID');
  assert.equal(code(() => normalizeMethodPatch({ ...enabled, secretRef: 'secret://prod key' }, existing)), 'SECRET_REFERENCE_INVALID');
  assert.equal(code(() => normalizeMethodPatch({ ...enabled, providerCode: 'paypal' }, existing)), 'UNSUPPORTED_PAYMENT_PROVIDER');
  assert.equal(code(() => normalizeMethodPatch({ ...enabled, environment: 'staging' }, existing)), 'VALIDATION_ERROR');
  // 未接入的服务商不能通过环境变量“借壳上线”。
  assert.equal(code(() => normalizeMethodPatch({ ...enabled, secretRef: null },
    { ...existing, secretRef: 'secret://prod/gateway' })), 'NO_ERROR', '停用时允许撤销凭证');
});

test('publicConfig only accepts allowlisted, short, control-character-free strings', () => {
  assert.deepEqual(normalizePublicConfig({ accountSummary: ' Bank: 0123 ' }), { accountSummary: 'Bank: 0123' });
  // checkoutBase 是收银台域名，适配器要读它；不放行等于收银台地址只能写死在代码里。
  assert.deepEqual(normalizePublicConfig({ checkoutBase: 'https://sandbox.example.test/mock-pay' }),
    { checkoutBase: 'https://sandbox.example.test/mock-pay' });
  // 密钥形状的键不管哪个渠道都不许进 publicConfig。
  assert.equal(code(() => normalizePublicConfig({ apiKey: 'x' })), 'PUBLIC_CONFIG_KEY_NOT_ALLOWED');
  assert.equal(code(() => normalizePublicConfig({ accountSummary: 12 })), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizePublicConfig({ accountSummary: '' })), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizePublicConfig({ accountSummary: 'x'.repeat(201) })), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizePublicConfig([])), 'VALIDATION_ERROR');
});

test('ledger numbers are date-stamped and shape-checked', () => {
  assert.equal(paymentNumber('20261116', 'AB12CD'), 'PAY-20261116-AB12CD');
  assert.equal(code(() => paymentNumber('2026-11-16', 'AB12CD')), 'VALIDATION_ERROR');
  assert.equal(code(() => paymentNumber('20261116', 'ab12cd')), 'VALIDATION_ERROR');
});

test('allowed channels are a closed set; empty means unrestricted', () => {
  assert.deepEqual(normalizeAllowedChannels(undefined), []);
  assert.deepEqual(normalizeAllowedChannels(null), []);
  assert.deepEqual(normalizeAllowedChannels([]), []);
  assert.deepEqual(normalizeAllowedChannels(['manual']), ['manual']);
  // 重复项收敛成一个，顺序按提交顺序保留。
  assert.deepEqual(normalizeAllowedChannels(['manual', 'cod', 'manual']), ['manual', 'cod']);
  // 未知渠道不能混进来：否则结账交集里会出现永远对不上的名字。
  assert.equal(code(() => normalizeAllowedChannels(['cod', 'stripe'])), 'UNSUPPORTED_PAYMENT_PROVIDER');
  assert.equal(code(() => normalizeAllowedChannels(['cod', 7])), 'UNSUPPORTED_PAYMENT_PROVIDER');
  assert.equal(code(() => normalizeAllowedChannels('cod')), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeAllowedChannels(['cod', 'manual', 'online', 'cod'])), 'VALIDATION_ERROR');
});

test('cart channel set is the intersection of every line, empty means unrestricted', () => {
  // 全部商品都没限制：三种渠道都可用。
  assert.deepEqual([...availableChannelsFor([[], []])].sort(), [...PRODUCT_PAYMENT_CHANNELS].sort());
  // 只要有一件要求先付款，整单就不能货到付款——这就是「整单按最严格」。
  assert.deepEqual([...availableChannelsFor([[], ['manual']])], ['manual']);
  // 两件商品各只允许不同渠道：交集为空，调用方必须明确拒绝而不是替顾客挑一个。
  assert.equal(availableChannelsFor([['cod'], ['manual']]).size, 0);
  // 空购物袋不产生约束（由上层拦空袋），这里是纯粹集合语义。
  assert.equal(availableChannelsFor([]).size, 3);
});

test('prepayment is required exactly when cash on delivery is gone', () => {
  assert.equal(requiresPrepayment(availableChannelsFor([[], ['cod']])), false);
  assert.equal(requiresPrepayment(availableChannelsFor([['manual']])), true);
  assert.equal(requiresPrepayment(availableChannelsFor([['online']])), true);
  assert.equal(requiresPrepayment(availableChannelsFor([['cod'], ['manual']])), true);
});
