import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf, totp } from '../apps/api/src/identity/crypto.js';
import { PaymentsService } from '../apps/api/src/payments/service.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';
test('payments: redacted configuration, dispatch-gated COD collection and a single ledger entry', { timeout: 300_000 }, async (t) => {
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const contracts = new IdentityContracts();
    const origin = 'https://shop.example.test';
    const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
        bootstrapToken: randomBytes(32).toString('base64url') };
    const identity = new IdentityService(db, config, contracts.ownerPermissions);
    const owner = { email: 'owner@payments.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
    let app;
    let base = '';
    const jar = new Map();
    let ownerCsrf = '';
    const request = async (method, path, body, headers, schema) => {
        const response = await fetch(base + '/api/v1/' + path, { method,
            headers: { 'Content-Type': 'application/json',
                Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        for (const value of response.headers.getSetCookie()) {
            const pair = value.split(';', 1)[0];
            const index = pair.indexOf('=');
            const key = pair.slice(0, index);
            const token = pair.slice(index + 1);
            if (token)
                jar.set(key, token);
            else
                jar.delete(key);
        }
        const data = response.status === 204 ? null : await response.json();
        if (response.status >= 400)
            contracts.assert('ErrorEnvelope', data);
        else if (schema && data !== null)
            contracts.assert(schema, data);
        return { status: response.status, body: data, response };
    };
    const ownerCall = (method, path, body, schema = 'SuccessEnvelope', extra = {}) => request(method, path, body, { Origin: origin, 'X-CSRF-Token': ownerCsrf, ...extra }, schema);
    const resetLimits = () => db.identityRateLimit.deleteMany();
    /** 按权限组合直接建会话：逐条走邀请 + MFA 太慢，且这里只关心权限矩阵。 */
    const sessionFor = async (permissions) => {
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
        const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@payments.test`, displayName: 'Staff',
                passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        const csrfToken = csrf(token, config);
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        const call = (method, path, body, schema = 'SuccessEnvelope', opts = {}) => request(method, path, body, { Origin: origin, 'X-CSRF-Token': csrfToken,
            ...(method !== 'GET' ? { 'Idempotency-Key': opts.key ?? randomUUID() } : {}),
            ...(opts.ifMatch ? { 'If-Match': opts.ifMatch } : {}), Cookie: `ez_admin_session=${token}` }, schema);
        return { call, token, csrfToken };
    };
    let rateId = '';
    let variantId = '';
    const contact = { email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' };
    const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
        district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
    /** 订单直接落库：M06 的下单链路有独立测试，这里只关心付款规则。 */
    const makeOrder = async (options = {}) => {
        const quantity = options.quantity ?? 2;
        const subtotal = 10_000 * quantity;
        const now = new Date();
        const methodCode = options.paymentMethodCode ?? 'cod';
        const cart = await db.guestCart.create({ data: { tokenDigest: digest(randomBytes(32).toString('hex')),
                status: 'converted', currency: 'HKD', expiresAt: new Date(now.getTime() + 86_400_000) } });
        const quote = await db.checkoutQuote.create({ data: { cartId: cart.id, status: 'consumed', version: 1,
                locale: 'en', marketCode: 'HK', currency: 'HKD', contact, shippingAddress: address, shippingMethodId: rateId,
                shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard', estimatedMinDays: 1, estimatedMaxDays: 3,
                    fixedFeeMinor: 3_000, freeAboveMinor: 50_000 },
                subtotalMinor: subtotal, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: subtotal + 3_000,
                ruleVersions: { price: 'catalog.v1', promotion: 'none', shipping: 'rate:1', tax: null }, warnings: [],
                policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }],
                expiresAt: new Date(now.getTime() + 900_000) } });
        const order = await db.shopOrder.create({ data: { publicOrderNumber: `EZ-20261116-${randomBytes(3).toString('hex').toUpperCase()}`,
                idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()), quoteId: quote.id, cartId: cart.id,
                shippingRateId: rateId, orderStatus: 'awaiting_confirmation',
                paymentStatus: methodCode === 'cod' ? 'cod_due' : 'created', currency: 'HKD', subtotalMinor: subtotal,
                discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: subtotal + 3_000, locale: 'en', marketCode: 'HK',
                contact, shippingAddress: address, shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' },
                paymentMethodCode: methodCode, policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }], placedAt: now } });
        const item = await db.orderItem.create({ data: { orderId: order.id, variantId, sku: 'SKU-1', productName: 'Test Product',
                variantName: 'M', quantity, unitPriceMinor: 10_000, lineSubtotalMinor: subtotal, lineDiscountMinor: 0, lineTotalMinor: subtotal } });
        await db.inventoryItem.update({ where: { variantId }, data: { reserved: { increment: quantity } } });
        await db.inventoryReservation.create({ data: { orderId: order.id, variantId, quantity,
                expiresAt: new Date(Date.now() + 1_800_000) } });
        if (options.dispatched) {
            // Shipment 的 CHECK 要求状态与发货时间同时成立：先建「已创建」，再连同时间一起置为已发货。
            const shipment = await db.shipment.create({ data: { orderId: order.id, status: 'created',
                    carrierCode: 'SF' } });
            await db.shipmentItem.create({ data: { shipmentId: shipment.id, orderItemId: item.id, quantity } });
            await db.shipment.update({ where: { id: shipment.id }, data: { status: 'dispatched', dispatchedAt: new Date() } });
        }
        return { order, item };
    };
    const total = (quantity) => 10_000 * quantity + 3_000;
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        const bootstrap = await request('POST', 'admin/auth/bootstrap', owner, { Origin: origin, 'X-Bootstrap-Token': config.bootstrapToken });
        assert.equal(bootstrap.status, 202);
        const challengeId = bootstrap.body.data.challengeId;
        const enrollment = await request('POST', 'admin/auth/mfa/enrollments', { challengeId }, { Origin: origin });
        const confirmed = await request('POST', 'admin/auth/mfa/enrollments/confirm', { challengeId,
            enrollmentId: enrollment.body.data.enrollmentId,
            code: totp(enrollment.body.data.totpSecret, owner.email).generate() }, { Origin: origin });
        assert.equal(confirmed.status, 200);
        ownerCsrf = confirmed.body.data.session.csrfToken;
        await db.storeConfig.create({ data: { id: 1, displayName: 'Payments Store', locales: ['zh-CN', 'zh-HK', 'en'],
                defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
        const zone = await db.shippingZone.create({ data: { code: 'HK', nameByLocale: { en: 'Hong Kong' },
                countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true } });
        rateId = (await db.shippingRate.create({ data: { code: 'STANDARD', nameByLocale: { en: 'Standard' },
                fixedFeeMinor: 3_000, freeAboveMinor: 50_000, currency: 'HKD', estimatedMinDays: 1, estimatedMaxDays: 3,
                codEnabled: true, enabled: true, zones: { create: [{ zoneId: zone.id }] } } })).id;
        const product = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
                translations: { create: [{ locale: 'en', name: 'Test Product', slug: 'test-product' }] } } });
        variantId = (await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-1',
                optionValues: { size: 'M' }, priceMinor: 10_000, currency: 'HKD' } })).id;
        await db.inventoryItem.create({ data: { variantId, onHand: 50 } });
    }
    catch (error) {
        if (app)
            await app.close();
        await identity.onModuleDestroy().catch(() => { });
        await cluster.stop();
        throw error;
    }
    try {
        await t.test('payment methods default to COD, gate enabling on approval and never echo credentials', async () => {
            await resetLimits();
            const reader = await sessionFor(['payments.read']);
            assert.equal((await reader.call('GET', 'admin/payment-methods')).status, 403);
            const list = await ownerCall('GET', 'admin/payment-methods', undefined, 'PaymentMethodListEnvelope');
            assert.equal(list.status, 200);
            const cod = list.body.data.items.find((item) => item.providerCode === 'cod');
            const manual = list.body.data.items.find((item) => item.providerCode === 'manual_bank_transfer');
            assert.equal(cod.enabled, true, '货到付款线下收款无需服务商批准，默认启用');
            assert.equal(cod.approvalStatus, 'approved');
            assert.equal(manual.enabled, false);
            assert.equal(manual.approvalStatus, 'unapproved');
            // 响应里不能出现凭证引用字段，连 null 也不给。
            assert.equal('secretRef' in cod, false);
            assert.equal(JSON.stringify(list.body).includes('secret://'), false);
            const patch = (body, ifMatch) => ownerCall('PATCH', 'admin/payment-methods', body, 'PaymentMethodEnvelope', ifMatch ? { 'If-Match': ifMatch } : {});
            const base = { providerCode: 'manual_bank_transfer', environment: 'production', enabled: true };
            // 没有版本号就没有“改的是哪一版”，直接 422。
            assert.equal((await patch({ ...base, approvalReference: 'ticket-1' })).status, 422);
            // 启用必须有批准依据。
            assert.equal((await patch(base, '"1"')).status, 422);
            // 真实密钥形状不能进库。
            assert.equal((await patch({ ...base, approvalReference: 'ticket-1', secretRef: 'sk_live_51H8' }, '"1"')).status, 422);
            const enabled = await patch({ ...base, approvalReference: `ticket-${randomUUID()}`, secretRef: 'secret://prod/bank',
                publicConfig: { accountSummary: 'Bank: 012-345-678' } }, `"${manual.version}"`);
            assert.equal(enabled.status, 200);
            assert.equal(enabled.body.data.enabled, true);
            assert.equal(enabled.body.data.secretConfigured, true);
            assert.match(enabled.body.data.secretFingerprint, /^[0-9a-f]{16}$/);
            assert.equal('secretRef' in enabled.body.data, false);
            assert.equal(enabled.body.data.publicConfig.accountSummary, 'Bank: 012-345-678');
            assert.equal(enabled.response.headers.get('etag'), `"${manual.version + 1}"`);
            // 旧版本再改一次必须冲突，而不是覆盖别人的修改。
            assert.equal((await patch({ ...base, approvalReference: 'ticket-2' }, `"${manual.version}"`)).status, 409);
            const reread = await ownerCall('GET', 'admin/payment-methods', undefined, 'PaymentMethodListEnvelope');
            assert.equal(reread.body.data.items.find((item) => item.providerCode === 'manual_bank_transfer')
                .secretFingerprint, enabled.body.data.secretFingerprint);
        });
        await t.test('COD money is only recorded after dispatch, exactly once, in the order currency', async () => {
            await resetLimits();
            const collector = await sessionFor(['payments.collect', 'orders.read', 'orders.cancel']);
            const { order } = await makeOrder({ quantity: 2 });
            const body = { outcome: 'collected', amountMinor: total(2), occurredAt: new Date().toISOString(),
                reference: 'COD-778', expectedVersion: 1 };
            // 没有发货就不该有钱到手。
            const early = await collector.call('POST', `admin/orders/${order.id}/payment-result`, body, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"1"' });
            assert.equal(early.status, 409);
            assert.equal(early.body.error.code, 'ORDER_NOT_SHIPPED');
            await db.shipment.create({ data: { orderId: order.id, status: 'dispatched', dispatchedAt: new Date(), carrierCode: 'SF' } });
            // 少收一分钱也不行。
            const wrong = await collector.call('POST', `admin/orders/${order.id}/payment-result`, { ...body, amountMinor: total(2) - 1 }, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"1"' });
            assert.equal(wrong.status, 422);
            assert.equal(wrong.body.error.code, 'PAYMENT_AMOUNT_MISMATCH');
            // 版本过期同样拒绝：登记的是“我看到的那一版”。
            const stale = await collector.call('POST', `admin/orders/${order.id}/payment-result`, body, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"7"' });
            assert.equal(stale.status, 409);
            assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
            const key = randomUUID();
            const collected = await collector.call('POST', `admin/orders/${order.id}/payment-result`, body, 'PaymentResultEnvelope', { key, ifMatch: '"1"' });
            assert.equal(collected.status, 200);
            assert.equal(collected.body.data.orderPaymentStatus, 'collected');
            assert.equal(collected.body.data.orderVersion, 2);
            assert.equal(collected.body.data.payment.status, 'collected');
            assert.equal(collected.body.data.payment.amountMinor, total(2));
            assert.equal(collected.body.data.payment.reference, 'COD-778');
            assert.equal(collected.body.data.payment.events.length, 1);
            assert.equal(collected.body.data.payment.events[0].fromStatus, 'pending');
            assert.equal((await db.shopOrder.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus, 'collected');
            // 同键重放返回同一笔流水，不产生第二条入账。
            const replay = await collector.call('POST', `admin/orders/${order.id}/payment-result`, body, 'PaymentResultEnvelope', { key, ifMatch: '"1"' });
            assert.equal(replay.status, 200);
            assert.equal(replay.body.data.payment.id, collected.body.data.payment.id);
            assert.equal(replay.body.data.payment.events.length, 1);
            assert.equal(await db.payment.count({ where: { orderId: order.id } }), 1);
            assert.equal(await db.paymentEvent.count({ where: { orderId: order.id } }), 1);
            // 同键不同内容、再收一次，都必须拒绝。
            assert.equal((await collector.call('POST', `admin/orders/${order.id}/payment-result`, { ...body, reference: 'other' }, 'SuccessEnvelope', { key, ifMatch: '"1"' })).status, 409);
            const again = await collector.call('POST', `admin/orders/${order.id}/payment-result`, { ...body, occurredAt: new Date().toISOString() }, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"2"' });
            assert.equal(again.status, 409);
            assert.equal(again.body.error.code, 'PAYMENT_STATE_CONFLICT');
            // 台账可按订单与状态筛选，详情带事件；非法状态与不存在的流水给出明确错误。
            const ledger = await ownerCall('GET', `admin/payments?status=collected&orderId=${order.id}`, undefined, 'PaymentListEnvelope');
            assert.equal(ledger.status, 200);
            assert.equal(ledger.body.data.items.length, 1);
            assert.equal(ledger.body.data.items[0].publicOrderNumber, order.publicOrderNumber);
            assert.equal((await ownerCall('GET', `admin/payments/${collected.body.data.payment.id}`, undefined, 'PaymentEnvelope'))
                .body.data.events.length, 1);
            assert.equal((await ownerCall('GET', 'admin/payments?status=refunded')).status, 422);
            assert.equal((await ownerCall('GET', `admin/payments/${randomUUID()}`)).status, 404);
            // 只有 payments.read 的账号不能登记收款。
            const readOnly = await sessionFor(['payments.read']);
            assert.equal((await readOnly.call('POST', `admin/orders/${order.id}/payment-result`, { ...body, expectedVersion: 2 }, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"2"' })).status, 403);
            // 已收款订单不能靠取消接口清账。
            const cancel = await collector.call('POST', `admin/orders/${order.id}/cancel`, { reason: 'Wants money back', expectedVersion: 2 }, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"2"' });
            assert.equal(cancel.status, 409);
            assert.equal(cancel.body.error.code, 'PAID_ORDER_REQUIRES_REFUND');
        });
        await t.test('rejections need a reason and manual transfers may be collected before dispatch', async () => {
            await resetLimits();
            const collector = await sessionFor(['payments.collect', 'orders.read']);
            const codOrder = await makeOrder({ quantity: 1, dispatched: true });
            const reject = { outcome: 'rejected', amountMinor: total(1), occurredAt: new Date().toISOString(), expectedVersion: 1 };
            const noReason = await collector.call('POST', `admin/orders/${codOrder.order.id}/payment-result`, reject, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"1"' });
            assert.equal(noReason.status, 422);
            assert.equal(noReason.body.error.code, 'REASON_REQUIRED');
            const rejected = await collector.call('POST', `admin/orders/${codOrder.order.id}/payment-result`, { ...reject, reason: 'Customer refused the parcel' }, 'PaymentResultEnvelope', { key: randomUUID(), ifMatch: '"1"' });
            assert.equal(rejected.status, 200);
            assert.equal(rejected.body.data.payment.status, 'rejected');
            assert.equal(rejected.body.data.payment.failureCode, 'customer_rejected');
            assert.equal(rejected.body.data.orderPaymentStatus, 'rejected');
            // 拒收是终态：再改成退回没有业务含义，属于售后流程。
            assert.equal((await collector.call('POST', `admin/orders/${codOrder.order.id}/payment-result`, { outcome: 'returned', amountMinor: total(1), occurredAt: new Date().toISOString(), reason: 'returned later',
                expectedVersion: 2 }, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"2"' })).status, 409);
            // 人工转账可以先到账（钱先到、货后发），再按退回登记。
            const manualOrder = await makeOrder({ paymentMethodCode: 'manual_bank_transfer', quantity: 3 });
            const paid = await collector.call('POST', `admin/orders/${manualOrder.order.id}/payment-result`, { outcome: 'succeeded', amountMinor: total(3), occurredAt: new Date().toISOString(), reference: 'TRX-991',
                expectedVersion: 1 }, 'PaymentResultEnvelope', { key: randomUUID(), ifMatch: '"1"' });
            assert.equal(paid.status, 200);
            assert.equal(paid.body.data.payment.status, 'succeeded');
            assert.equal(paid.body.data.orderPaymentStatus, 'succeeded');
            assert.ok(paid.body.data.payment.paidAt);
            const returned = await collector.call('POST', `admin/orders/${manualOrder.order.id}/payment-result`, { outcome: 'returned', amountMinor: total(3), occurredAt: new Date().toISOString(), reason: 'Order cancelled, money returned',
                expectedVersion: 2 }, 'PaymentResultEnvelope', { key: randomUUID(), ifMatch: '"2"' });
            assert.equal(returned.status, 200);
            assert.equal(returned.body.data.payment.status, 'returned');
            assert.equal(returned.body.data.payment.paidAt !== null, true, '退回不能抹掉曾经到账的事实');
            assert.ok(returned.body.data.payment.returnedAt);
            assert.equal(returned.body.data.orderPaymentStatus, 'returned');
            // 付款时间不能早于下单时间。
            const backdated = await makeOrder({ quantity: 1 });
            const past = new Date(Date.now() - 86_400_000 * 30).toISOString();
            const early = await collector.call('POST', `admin/orders/${backdated.order.id}/payment-result`, { outcome: 'collected', amountMinor: total(1), occurredAt: past, expectedVersion: 1 }, 'SuccessEnvelope', { key: randomUUID(), ifMatch: '"1"' });
            assert.equal(early.status, 422);
            assert.equal(early.body.error.code, 'PAYMENT_TIME_INVALID');
        });
        await t.test('disabling a method takes effect at checkout and is refused while money is in flight', async () => {
            await resetLimits();
            await ownerCall('GET', 'admin/payment-methods');
            const row = await db.paymentMethodConfig.findUniqueOrThrow({ where: { providerCode_environment: { providerCode: 'cod', environment: 'production' } } });
            const payments = new PaymentsService(identity);
            // 还有待收流水时不能停用：停了之后这笔钱没有渠道认领。
            const inFlight = await makeOrder({ quantity: 1 });
            await db.payment.create({ data: { publicPaymentNumber: `PAY-20261116-${randomBytes(3).toString('hex').toUpperCase()}`,
                    dedupeKey: `cod:${inFlight.order.id}`, orderId: inFlight.order.id, methodConfigId: row.id, providerCode: 'cod',
                    environment: 'production', channel: 'cod', status: 'pending', amountMinor: total(1), currency: 'HKD', metadata: {} } });
            assert.equal((await ownerCall('PATCH', 'admin/payment-methods', { providerCode: 'cod', environment: 'production',
                enabled: false }, 'SuccessEnvelope', { 'If-Match': `"${row.version}"` })).status, 409);
            await db.payment.updateMany({ where: { orderId: inFlight.order.id }, data: { status: 'collected', paidAt: new Date() } });
            const disabled = await ownerCall('PATCH', 'admin/payment-methods', { providerCode: 'cod', environment: 'production',
                enabled: false }, 'PaymentMethodEnvelope', { 'If-Match': `"${row.version}"` });
            assert.equal(disabled.status, 200);
            assert.equal(disabled.body.data.enabled, false);
            // 停用后结账直接拒绝：不能再借配送方式的 codEnabled 打开 COD。
            await assert.rejects(db.$transaction(tx => payments.resolveCheckout(tx, 'cod', true)), (error) => error.code === 'PAYMENT_METHOD_UNAVAILABLE');
            await db.paymentMethodConfig.update({ where: { id: row.id }, data: { enabled: true } });
            assert.equal((await db.$transaction(tx => payments.resolveCheckout(tx, 'cod', true))).definition.code, 'cod');
            assert.equal((await db.$transaction(tx => payments.resolveCheckout(tx, 'manual_bank_transfer', true))).definition.channel, 'manual', '已批准的人工转账可以结账使用');
        });
        // 兜底断言：子测试被跳过时这里必须失败，而不是静默“通过”。
        assert.ok(await db.payment.count({ where: { status: 'collected' } }) >= 1);
        assert.ok(await db.payment.count({ where: { status: 'returned' } }) >= 1);
        assert.equal((await db.paymentMethodConfig.findUniqueOrThrow({ where: { providerCode_environment: { providerCode: 'manual_bank_transfer', environment: 'production' } } })).enabled, true);
        // 兜底断言：子测试被跳过时这里必须失败，而不是静默“通过”。
        assert.ok(await db.payment.count({ where: { status: 'collected' } }) >= 1);
        assert.ok(await db.payment.count({ where: { status: 'returned' } }) >= 1);
        assert.equal((await db.paymentMethodConfig.findUniqueOrThrow({ where: { providerCode_environment: { providerCode: 'manual_bank_transfer', environment: 'production' } } })).enabled, true);
    }
    finally {
        if (app)
            await app.close();
        await identity.onModuleDestroy().catch(() => { });
        await cluster.stop();
    }
});
