/**
 * 对账任务端到端：丢掉回调的支付、卡在 processing 的退款都必须在没有人工介入时收敛。
 *
 * 这是"线上支付上线后不炸"的关键一环：回调只在渠道愿意重试时才到，
 * 而进程重启、网络单向不通、渠道重试耗尽都会让台账永远停在中间态。
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { adapterFor } from '../apps/api/src/payments/adapters/registry.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';
const CREDENTIALS = JSON.stringify({ apiKey: 'test_api_key_1234', webhookSecret: 'test_webhook_secret_1234' });
const JOB_TOKEN = 'job_token_for_tests_0123456789abcdef';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
test('reconcile job converges dropped webhooks and stuck refunds', { timeout: 300_000 }, async (t) => {
    process.env.PAYMENTS_ENVIRONMENT = 'sandbox';
    t.after(() => { delete process.env.PAYMENTS_ENVIRONMENT; });
    process.env.PAYMENTS_BASE_URL = 'https://shop.example.test';
    process.env.MOCK_PAYMENT_SECRET = CREDENTIALS;
    process.env.INTERNAL_JOB_TOKEN = JOB_TOKEN;
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const contracts = new IdentityContracts();
    const origin = 'https://shop.example.test';
    const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
        bootstrapToken: randomBytes(32).toString('base64url') };
    const identity = new IdentityService(db, config, contracts.ownerPermissions);
    let app;
    let base = '';
    const post = async (path, body, headers = {}) => {
        const response = await fetch(base + '/api/v1/' + path, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    let methodConfigId = '';
    let rateId = '';
    const contact = { email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' };
    const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null,
        city: 'Hong Kong', district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
    /** 造一笔"已发起但回调丢了"的线上支付：渠道侧已成功，台账仍是 pending。 */
    const makeDroppedPayment = async () => {
        const now = new Date();
        const cartToken = randomBytes(32).toString('base64url');
        const cartCsrf = randomBytes(32).toString('base64url');
        const headers = { Origin: origin, 'X-CSRF-Token': cartCsrf,
            Cookie: `ez_guest_cart=${cartToken}; ez_cart_csrf=${cartCsrf}` };
        const cart = await db.guestCart.create({ data: { tokenDigest: sha256(cartToken), status: 'converted',
                currency: 'HKD', expiresAt: new Date(now.getTime() + 86_400_000) } });
        const quote = await db.checkoutQuote.create({ data: { cartId: cart.id, status: 'consumed', version: 1,
                locale: 'en', marketCode: 'HK', currency: 'HKD', contact, shippingAddress: address, shippingMethodId: rateId,
                shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' }, subtotalMinor: 20_000, discountMinor: 0,
                shippingMinor: 3_000, taxMinor: 0, totalMinor: 23_000,
                ruleVersions: { price: 'catalog.v1', promotion: 'none', shipping: 'rate:1', tax: null }, warnings: [],
                policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }],
                expiresAt: new Date(now.getTime() + 900_000) } });
        const order = await db.shopOrder.create({ data: {
                publicOrderNumber: `EZ-20261120-${randomBytes(3).toString('hex').toUpperCase()}`,
                idempotencyKey: randomUUID(), requestDigest: sha256(randomUUID()), quoteId: quote.id, cartId: cart.id,
                shippingRateId: rateId, orderStatus: 'awaiting_confirmation', paymentStatus: 'created', currency: 'HKD',
                subtotalMinor: 20_000, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: 23_000,
                locale: 'en', marketCode: 'HK', contact, shippingAddress: address,
                shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' }, paymentMethodCode: 'mock',
                policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }], placedAt: now
            } });
        const payment = await db.payment.create({ data: { publicPaymentNumber: `PAY-20261120-${randomBytes(3).toString('hex').toUpperCase()}`, dedupeKey: `mock:${order.id}`,
                orderId: order.id, methodConfigId, providerCode: 'mock', environment: 'sandbox', channel: 'online',
                status: 'pending', amountMinor: 23_000, currency: 'HKD', metadata: {} } });
        const intent = await post(`storefront/checkout/orders/${order.id}/pay`, {}, headers);
        assert.equal(intent.status, 200, JSON.stringify(intent.body));
        const providerTransactionId = intent.body.data.providerTransactionId;
        // 渠道侧已收款，但我们**不发回调**：模拟回调丢失。
        adapterFor('mock', 'sandbox').simulatePaid(payment.publicPaymentNumber);
        // 台账必须"足够旧"才会被扫到；把创建时间往前挪 30 分钟。
        const old = new Date(now.getTime() - 30 * 60_000);
        await db.payment.update({ where: { id: payment.id }, data: { createdAt: old } });
        return { order, payment, providerTransactionId };
    };
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Reconcile Store', locales: ['en'],
                defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
        const zone = await db.shippingZone.create({ data: { code: 'HK', nameByLocale: { en: 'Hong Kong' },
                countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true } });
        rateId = (await db.shippingRate.create({ data: { code: 'STANDARD', nameByLocale: { en: 'Standard' },
                fixedFeeMinor: 3_000, freeAboveMinor: 50_000, currency: 'HKD', estimatedMinDays: 1, estimatedMaxDays: 3,
                enabled: true, codEnabled: false, zones: { create: [{ zoneId: zone.id }] } } })).id;
        methodConfigId = (await db.paymentMethodConfig.create({ data: { providerCode: 'mock',
                environment: 'sandbox', displayName: 'Mock gateway', enabled: true, approvalReference: 'test-approval',
                approvedAt: new Date(), publicConfig: { providerAccountRef: 'MOCK-MERCHANT-1',
                    checkoutBase: 'https://sandbox.invalid/mock-pay' }, secretRef: 'secret://env/MOCK_PAYMENT_SECRET',
                connectionStatus: 'ok', lastCheckedAt: new Date() } })).id;
        // ---- 1. 令牌不对：401，且什么都不改 ---------------------------------------
        const dropped = await makeDroppedPayment();
        const denied = await post('internal/jobs/reconcile', {}, { 'x-job-token': 'wrong-token-wrong-token-wrong' });
        assert.equal(denied.status, 401);
        assert.equal((await db.payment.findUniqueOrThrow({ where: { id: dropped.payment.id } })).status, 'pending');
        // ---- 2. 正常跑一次：pending → succeeded ----------------------------------
        const run = await post('internal/jobs/reconcile', { olderThanMinutes: 5 }, { 'x-job-token': JOB_TOKEN });
        assert.equal(run.status, 200, JSON.stringify(run.body));
        const report = run.body.data;
        assert.ok(report.payments.scanned >= 1);
        assert.equal(report.payments.converged, 1);
        assert.equal(report.errors.length, 0);
        const settled = await db.payment.findUniqueOrThrow({ where: { id: dropped.payment.id } });
        assert.equal(settled.status, 'succeeded');
        assert.ok(settled.paidAt);
        const settledOrder = await db.shopOrder.findUniqueOrThrow({ where: { id: dropped.order.id } });
        assert.equal(settledOrder.paymentStatus, 'succeeded');
        assert.equal(await db.paymentEvent.count({ where: { paymentId: dropped.payment.id, source: 'system' } }), 1);
        // ---- 3. 再跑一次：不重复入账 ----------------------------------------------
        const again = await post('internal/jobs/reconcile', { olderThanMinutes: 5 }, { 'x-job-token': JOB_TOKEN });
        assert.equal(again.status, 200);
        assert.equal(again.body.data.payments.converged, 0);
        assert.equal(await db.paymentEvent.count({ where: { paymentId: dropped.payment.id } }), 1);
        // ---- 4. 卡在 processing 的退款：能查到的收敛，查不到的保持原状 ------------
        const now = new Date();
        const old = new Date(now.getTime() - 30 * 60_000);
        const seeded = await adapterFor('mock', 'sandbox').refund({ providerCode: 'mock', environment: 'sandbox', credentials: JSON.parse(CREDENTIALS), publicConfig: {} }, { refundNumber: 'REF-SEED-0001', providerTransactionId: dropped.providerTransactionId,
            amountMinor: 5_000, currency: 'HKD', reason: null });
        const refundRow = async (externalRefundId, amountMinor) => db.refund.create({ data: {
                publicRefundNumber: `REF-20261120-${randomBytes(3).toString('hex').toUpperCase()}`,
                idempotencyKey: randomUUID(), requestDigest: sha256(randomUUID()), orderId: dropped.order.id,
                paymentId: dropped.payment.id, channel: 'online', providerCode: 'mock', environment: 'sandbox',
                amountMinor, currency: 'HKD', status: 'processing', reason: 'partial refund',
                requestedBy: randomUUID(), approvedBy: randomUUID(), approvedAt: old,
                externalRefundId, createdAt: old
            } });
        const recoverable = await refundRow(seeded.providerRefundId, 5_000);
        const orphan = await refundRow('mockr_settled_elsewhere', 1_000);
        const sweep = await post('internal/jobs/reconcile', { olderThanMinutes: 5, limit: 100 }, { 'x-job-token': JOB_TOKEN });
        assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
        assert.equal(sweep.body.data.refunds.scanned, 2);
        assert.equal((await db.refund.findUniqueOrThrow({ where: { id: recoverable.id } })).status, 'refunded');
        // 渠道查不到这个自造单号 → 保持 processing，不猜成功也不猜失败。
        assert.equal((await db.refund.findUniqueOrThrow({ where: { id: orphan.id } })).status, 'processing');
        // ---- 5. 未配置令牌时端点整体关闭 ------------------------------------------
        delete process.env.INTERNAL_JOB_TOKEN;
        const disabled = await post('internal/jobs/reconcile', {}, { 'x-job-token': JOB_TOKEN });
        assert.equal(disabled.status, 503);
        assert.equal(disabled.body.error.code, 'JOB_ENDPOINT_DISABLED');
    }
    finally {
        await app?.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
