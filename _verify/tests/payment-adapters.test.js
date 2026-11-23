import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockPaymentAdapter } from '../apps/api/src/payments/adapters/mock.js';
import { adapterCodes, adapterFor } from '../apps/api/src/payments/adapters/registry.js';
import { createSecretResolver, SecretResolverError, } from '../apps/api/src/payments/adapters/secret-resolver.js';
import { PaymentAdapterError, } from '../packages/domain/src/payment-adapter.js';
const code = (fn) => {
    try {
        fn();
    }
    catch (error) {
        if (error instanceof PaymentAdapterError || error instanceof SecretResolverError)
            return error.code;
        throw error;
    }
    return 'NO_ERROR';
};
const asyncCode = async (fn) => {
    try {
        await fn();
    }
    catch (error) {
        if (error instanceof PaymentAdapterError || error instanceof SecretResolverError)
            return error.code;
        throw error;
    }
    return 'NO_ERROR';
};
const ctx = (over = {}) => ({
    providerCode: 'mock',
    environment: 'sandbox',
    credentials: { apiKey: 'test_api_key_1234', webhookSecret: 'test_webhook_secret_1234' },
    publicConfig: { providerAccountRef: 'MOCK-MERCHANT-1', checkoutBase: 'https://sandbox.invalid/mock-pay' },
    ...over,
});
const input = (over = {}) => ({
    paymentNumber: 'PAY-20261120-ABC123',
    orderNumber: 'SO-20261120-0001',
    amountMinor: 12000,
    currency: 'HKD',
    returnUrl: 'https://mrinhk.com/checkout/return',
    notifyUrl: 'https://mrinhk.com/webhooks/payments/mock',
    locale: 'zh-HK',
    ...over,
});
// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
test('registry: mock is routable in sandbox and refused in production', () => {
    assert.ok(adapterCodes('sandbox').includes('mock'));
    assert.equal(adapterCodes('production').includes('mock'), false);
    assert.ok(adapterFor('mock', 'sandbox'));
    assert.equal(code(() => adapterFor('mock', 'production')), 'ADAPTER_SANDBOX_ONLY');
});
test('registry: unregistered provider cannot be resolved', () => {
    assert.equal(code(() => adapterFor('alipay_direct', 'sandbox')), 'ADAPTER_NOT_REGISTERED');
});
// ---------------------------------------------------------------------------
// Mock adapter: create / query / refund
// ---------------------------------------------------------------------------
test('mock: createPayment is idempotent per payment number', async () => {
    const adapter = new MockPaymentAdapter();
    const first = await adapter.createPayment(ctx(), input());
    const second = await adapter.createPayment(ctx(), input());
    assert.equal(first.status, 'pending');
    assert.equal(second.providerTransactionId, first.providerTransactionId);
    assert.match(first.providerTransactionId, /^mock_[0-9a-f]{18}$/);
    assert.match(first.redirectUrl ?? '', /^https:\/\/sandbox\.invalid\/mock-pay\?ref=mock_/);
});
test('mock: query returns unknown for an unseen transaction instead of failing', async () => {
    const adapter = new MockPaymentAdapter();
    const result = await adapter.queryPayment(ctx(), 'mock_deadbeef');
    assert.equal(result.status, 'unknown');
    assert.equal(result.amountMinor, null);
    assert.equal(result.rawStatus, 'NOT_FOUND');
});
test('mock: state advances only through simulate or webhook', async () => {
    const adapter = new MockPaymentAdapter();
    const created = await adapter.createPayment(ctx(), input());
    assert.equal((await adapter.queryPayment(ctx(), created.providerTransactionId)).status, 'pending');
    adapter.simulatePaid('PAY-20261120-ABC123');
    const after = await adapter.queryPayment(ctx(), created.providerTransactionId);
    assert.equal(after.status, 'succeeded');
    assert.equal(after.amountMinor, 12000);
    assert.equal(after.currency, 'HKD');
});
test('mock: refund respects captured amount and currency', async () => {
    const adapter = new MockPaymentAdapter();
    const created = await adapter.createPayment(ctx(), input());
    const base = {
        refundNumber: 'RF-20261120-000001',
        providerTransactionId: created.providerTransactionId,
        amountMinor: 5000,
        currency: 'HKD',
        reason: null,
    };
    // 未收款不能退
    assert.equal(await asyncCode(() => adapter.refund(ctx(), base)), 'REFUND_NOT_SETTLED');
    adapter.simulatePaid('PAY-20261120-ABC123');
    assert.equal(await asyncCode(() => adapter.refund(ctx(), { ...base, currency: 'USD' })), 'REFUND_CURRENCY_MISMATCH');
    assert.equal(await asyncCode(() => adapter.refund(ctx(), { ...base, amountMinor: 12001 })), 'REFUND_EXCEEDS_CAPTURED');
    const partial = await adapter.refund(ctx(), base);
    assert.equal(partial.status, 'succeeded');
    assert.equal(partial.amountMinor, 5000);
    // 同一退款单号重试必须拿回同一笔，而不是再退一次。
    const replay = await adapter.refund(ctx(), base);
    assert.equal(replay.providerRefundId, partial.providerRefundId);
    assert.equal(replay.status, 'succeeded');
    // 换单号退剩余额度可以，累计超额不行
    const second = { ...base, refundNumber: 'RF-20261120-000002' };
    assert.equal(await asyncCode(() => adapter.refund(ctx(), { ...second, amountMinor: 7001 })), 'REFUND_EXCEEDS_CAPTURED');
    const rest = await adapter.refund(ctx(), { ...second, amountMinor: 7000 });
    assert.equal(rest.status, 'succeeded');
    assert.notEqual(rest.providerRefundId, partial.providerRefundId);
    // 回查能拿到结论；不存在的渠道退款单号返回 pending，不猜成功也不猜失败。
    const queried = await adapter.queryRefund(ctx(), rest.providerRefundId);
    assert.equal(queried.status, 'succeeded');
    assert.equal(queried.amountMinor, 7000);
    assert.equal((await adapter.queryRefund(ctx(), 'mockr_unknown')).status, 'pending');
});
test('mock: testConnection reports missing credentials without leaking values', async () => {
    const adapter = new MockPaymentAdapter();
    const ok = await adapter.testConnection(ctx());
    assert.equal(ok.ok, true);
    const missingKey = await adapter.testConnection(ctx({ credentials: {} }));
    assert.equal(missingKey.ok, false);
    assert.doesNotMatch(missingKey.detail, /test_api_key/);
    const missingMerchant = await adapter.testConnection(ctx({ publicConfig: {} }));
    assert.equal(missingMerchant.ok, false);
});
// ---------------------------------------------------------------------------
// Mock adapter: webhook signature
// ---------------------------------------------------------------------------
const webhookBody = (over = {}) => JSON.stringify({
    providerTransactionId: 'mock_abcdef012345678901',
    paymentNumber: 'PAY-20261120-ABC123',
    status: 'succeeded',
    amountMinor: 12000,
    currency: 'HKD',
    eventId: 'evt_1',
    occurredAt: '2026-11-20T10:00:00.000Z',
    ...over,
});
test('mock: webhook accepts a correctly signed body', async () => {
    const adapter = new MockPaymentAdapter();
    const raw = webhookBody();
    const signed = adapter.signWebhook('test_webhook_secret_1234', raw);
    const event = await adapter.verifyWebhook(ctx(), {
        'x-mock-signature': signed.signature,
        'x-mock-timestamp': signed.timestamp,
    }, Buffer.from(raw, 'utf8'));
    assert.equal(event.status, 'succeeded');
    assert.equal(event.amountMinor, 12000);
    assert.equal(event.eventId, 'evt_1');
});
test('mock: webhook rejects tampered body, wrong secret and expired timestamp', async () => {
    const adapter = new MockPaymentAdapter();
    const raw = webhookBody();
    const signed = adapter.signWebhook('test_webhook_secret_1234', raw);
    const headers = { 'x-mock-signature': signed.signature, 'x-mock-timestamp': signed.timestamp };
    // 改一个字节，签名就必须失效
    const tampered = Buffer.from(webhookBody({ amountMinor: 999999 }), 'utf8');
    assert.equal(await asyncCode(() => adapter.verifyWebhook(ctx(), headers, tampered)), 'WEBHOOK_SIGNATURE_INVALID');
    const wrongSecret = adapter.signWebhook('another_secret_value', raw);
    assert.equal(await asyncCode(() => adapter.verifyWebhook(ctx(), {
        'x-mock-signature': wrongSecret.signature, 'x-mock-timestamp': wrongSecret.timestamp,
    }, Buffer.from(raw, 'utf8'))), 'WEBHOOK_SIGNATURE_INVALID');
    const stale = adapter.signWebhook('test_webhook_secret_1234', raw, new Date(Date.now() - 400_000));
    assert.equal(await asyncCode(() => adapter.verifyWebhook(ctx(), {
        'x-mock-signature': stale.signature, 'x-mock-timestamp': stale.timestamp,
    }, Buffer.from(raw, 'utf8'))), 'WEBHOOK_TIMESTAMP_EXPIRED');
    assert.equal(await asyncCode(() => adapter.verifyWebhook(ctx(), {}, Buffer.from(raw, 'utf8'))), 'WEBHOOK_SIGNATURE_MISSING');
});
test('mock: webhook rejects unrecognised status instead of guessing', async () => {
    const adapter = new MockPaymentAdapter();
    const raw = webhookBody({ status: 'SOMETHING_NEW' });
    const signed = adapter.signWebhook('test_webhook_secret_1234', raw);
    assert.equal(await asyncCode(() => adapter.verifyWebhook(ctx(), {
        'x-mock-signature': signed.signature, 'x-mock-timestamp': signed.timestamp,
    }, Buffer.from(raw, 'utf8'))), 'WEBHOOK_STATUS_UNRECOGNISED');
});
// ---------------------------------------------------------------------------
// Secret resolver
// ---------------------------------------------------------------------------
const env = (values) => (name) => values[name];
test('secret-resolver: resolves env payload and caches within TTL', async () => {
    let reads = 0;
    const resolver = createSecretResolver({
        environment: 'sandbox',
        readEnv: name => { reads += 1; return name === 'PAY_KEY' ? '{"apiKey":"k12345678","webhookSecret":"w12345678"}' : undefined; },
    });
    const first = await resolver.resolve('secret://env/PAY_KEY');
    const second = await resolver.resolve('secret://env/PAY_KEY');
    assert.equal(first.apiKey, 'k12345678');
    assert.deepEqual(second, first);
    assert.equal(reads, 1);
});
test('secret-resolver: cache expires and invalidate forces refetch', async () => {
    let now = 0;
    let reads = 0;
    const resolver = createSecretResolver({
        environment: 'sandbox',
        ttlMs: 1000,
        now: () => now,
        readEnv: () => { reads += 1; return '{"apiKey":"k12345678"}'; },
    });
    await resolver.resolve('secret://env/A');
    now = 500;
    await resolver.resolve('secret://env/A');
    assert.equal(reads, 1);
    now = 1500;
    await resolver.resolve('secret://env/A');
    assert.equal(reads, 2);
    resolver.invalidate('secret://env/A');
    await resolver.resolve('secret://env/A');
    assert.equal(reads, 3);
});
test('secret-resolver: malformed payloads fail loudly, never silently empty', async () => {
    const resolver = createSecretResolver({
        environment: 'sandbox',
        readEnv: name => ({
            RAW: 'not-json',
            ARR: '[1,2]',
            EMPTY: '{}',
            NUM: '{"apiKey":123}',
        }[name]),
    });
    assert.equal(await asyncCode(() => resolver.resolve('secret://env/RAW')), 'SECRET_VALUE_NOT_JSON');
    assert.equal(await asyncCode(() => resolver.resolve('secret://env/ARR')), 'SECRET_VALUE_NOT_OBJECT');
    assert.equal(await asyncCode(() => resolver.resolve('secret://env/EMPTY')), 'SECRET_VALUE_EMPTY');
    assert.equal(await asyncCode(() => resolver.resolve('secret://env/NUM')), 'SECRET_VALUE_NOT_STRING');
    assert.equal(await asyncCode(() => resolver.resolve('secret://env/MISSING')), 'SECRET_NOT_FOUND');
});
test('secret-resolver: production refuses env and file schemes before touching anything', async () => {
    const resolver = createSecretResolver({
        environment: 'production',
        readEnv: () => '{"apiKey":"k12345678"}',
        readFile: async () => '{"apiKey":"k12345678"}',
    });
    assert.equal(await asyncCode(() => resolver.resolve('secret://env/PAY')), 'SECRET_SCHEME_NOT_ALLOWED_IN_PRODUCTION');
    assert.equal(await asyncCode(() => resolver.resolve('secret://file/etc/pay')), 'SECRET_SCHEME_NOT_ALLOWED_IN_PRODUCTION');
});
test('secret-resolver: file scheme reads and parses a mounted secret', async () => {
    const seen = [];
    const resolver = createSecretResolver({
        environment: 'sandbox',
        readFile: async (path) => { seen.push(path); return '{"apiKey":"file_key_1234"}'; },
    });
    const value = await resolver.resolve('secret://file/run/secrets/pay');
    assert.equal(value.apiKey, 'file_key_1234');
    assert.deepEqual(seen, ['run/secrets/pay']);
});
test('secret-resolver: aws-sm reports unavailable SDK instead of crashing', async () => {
    const resolver = createSecretResolver({ environment: 'sandbox' });
    // 本仓库未安装 @aws-sdk/client-secrets-manager：必须给出可诊断的错误码。
    const result = await asyncCode(() => resolver.resolve('secret://aws-sm/ezstart/mrinhk/payment/gateway'));
    assert.equal(result, 'SECRET_PROVIDER_UNAVAILABLE');
});
