import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf, totp } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';
test('orders: masked reads, cancel, address repricing, shipping and expired-hold sweep', { timeout: 300_000 }, async (t) => {
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const contracts = new IdentityContracts();
    const origin = 'https://shop.example.test';
    const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
        bootstrapToken: randomBytes(32).toString('base64url') };
    const identity = new IdentityService(db, config, contracts.ownerPermissions);
    const owner = { email: 'owner@orders.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
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
        else if (schema)
            contracts.assert(schema, data);
        return { status: response.status, body: data, response };
    };
    const ownerCall = (method, path, body, schema = 'SuccessEnvelope') => request(method, path, body, { Origin: origin, 'X-CSRF-Token': ownerCsrf }, schema);
    const resetLimits = () => db.identityRateLimit.deleteMany();
    /**
     * 直接建会话：测试要覆盖多种权限组合，逐条走邀请 + MFA 太慢。
     * CSRF 必须按真实派生规则算，否则写接口一律 403，测不出业务规则。
     * 写接口都要求 Idempotency-Key，helper 默认生成一个，重放场景显式传入同一个 key。
     */
    const sessionFor = async (permissions) => {
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
        const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@orders.test`, displayName: 'Staff',
                passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        const csrfToken = csrf(token, config);
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        const call = (method, path, body, schema = 'SuccessEnvelope', key) => request(method, path, body, { Origin: origin, 'X-CSRF-Token': csrfToken,
            ...(method === 'POST' ? { 'Idempotency-Key': key ?? randomUUID() } : {}),
            Cookie: `ez_admin_session=${token}` }, schema);
        const withVersion = async (path, body, version, key = randomUUID()) => {
            const response = await fetch(base + '/api/v1/' + path, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': csrfToken,
                    'If-Match': `"${version}"`, 'Idempotency-Key': key, Cookie: `ez_admin_session=${token}` },
                body: JSON.stringify(body) });
            const data = await response.json();
            if (response.status >= 400)
                contracts.assert('ErrorEnvelope', data);
            return { status: response.status, body: data };
        };
        return { call, withVersion, token };
    };
    let rateId = '';
    let variantId = '';
    const contact = { email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' };
    const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
        district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
    /** 订单直接落库：M06 的下单链路已有独立测试，这里只关心 M07 的履约动作。 */
    const makeOrder = async (options = {}) => {
        const quantity = options.quantity ?? 2;
        const subtotal = 10_000 * quantity;
        const now = new Date();
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
                shippingRateId: rateId, orderStatus: options.orderStatus ?? 'awaiting_confirmation',
                paymentStatus: options.paymentStatus ?? 'cod_due', currency: 'HKD', subtotalMinor: subtotal, discountMinor: 0,
                shippingMinor: 3_000, taxMinor: 0, totalMinor: subtotal + 3_000, locale: 'en', marketCode: 'HK', contact,
                shippingAddress: address, shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' },
                paymentMethodCode: 'cod', policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }], placedAt: now } });
        const item = await db.orderItem.create({ data: { orderId: order.id, variantId, sku: 'SKU-1', productName: 'Test Product',
                variantName: 'M', quantity, unitPriceMinor: 10_000, lineSubtotalMinor: subtotal, lineDiscountMinor: 0, lineTotalMinor: subtotal } });
        await db.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: null, toStatus: order.orderStatus,
                reason: 'order_placed', actorType: 'customer' } });
        await db.inventoryItem.update({ where: { variantId }, data: { reserved: { increment: quantity } } });
        const reservation = await db.inventoryReservation.create({ data: { orderId: order.id, variantId, quantity,
                expiresAt: new Date(Date.now() + (options.expiresInMs ?? 1_800_000)) } });
        return { order, item, reservation };
    };
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
        await db.storeConfig.create({ data: { id: 1, displayName: 'Orders Store', locales: ['zh-CN', 'zh-HK', 'en'],
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
        await db.inventoryItem.create({ data: { variantId, onHand: 10 } });
    }
    catch (error) {
        if (app)
            await app.close();
        await identity.onModuleDestroy().catch(() => { });
        await cluster.stop();
        throw error;
    }
    try {
        await t.test('order reads require orders.read and mask contact unless PII is granted', async () => {
            await resetLimits();
            const { order } = await makeOrder();
            const reader = await sessionFor(['orders.read']);
            const list = await reader.call('GET', 'admin/orders', undefined, 'OrderListEnvelope');
            assert.equal(list.status, 200);
            assert.equal(list.body.data.items.length, 1);
            assert.equal(list.body.data.items[0].contactMasked, 'b***@example.com');
            const detail = await reader.call('GET', `admin/orders/${order.id}`, undefined, 'OrderDetailEnvelope');
            assert.equal(detail.status, 200);
            assert.equal(detail.body.data.contact.email, 'b***@example.com');
            assert.equal(detail.body.data.contact.phone, '***4567');
            assert.equal(detail.body.data.lines[0].quantity, 2);
            assert.equal(detail.body.data.statusHistory.length, 1);
            assert.equal(detail.body.data.version, 1);
            // owner 拥有 customers.read_pii，能看到完整联系方式。
            const full = await ownerCall('GET', `admin/orders/${order.id}`, undefined, 'OrderDetailEnvelope');
            assert.equal(full.body.data.contact.email, 'buyer@example.com');
            // 没有会话一律 401；不存在的订单 404；非法分页 422。
            assert.equal((await request('GET', 'admin/orders', undefined, { Cookie: 'none=1' })).status, 401);
            assert.equal((await reader.call('GET', `admin/orders/${randomUUID()}`)).status, 404);
            assert.equal((await reader.call('GET', 'admin/orders?limit=0')).status, 422);
        });
        await t.test('cancel releases the hold once and replays the same idempotency key', async () => {
            await resetLimits();
            const { order } = await makeOrder();
            const support = await sessionFor(['orders.read', 'orders.cancel', 'orders.update', 'orders.address_change', 'shipments.manage']);
            const key = randomUUID();
            const body = { reasonCode: 'customer_request', reason: 'Customer changed their mind', expectedVersion: 1, customerNotified: true };
            const reservedBefore = (await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).reserved;
            const cancelled = await support.call('POST', `admin/orders/${order.id}/cancel`, body, 'OrderDetailEnvelope', key);
            assert.equal(cancelled.status, 200);
            assert.equal(cancelled.body.data.orderStatus, 'cancelled');
            assert.equal(cancelled.body.data.cancellation.reasonCode, 'customer_request');
            assert.equal(cancelled.body.data.cancellation.customerNotified, true);
            assert.equal(cancelled.body.data.version, 2);
            const inventory = await db.inventoryItem.findUniqueOrThrow({ where: { variantId } });
            assert.equal(inventory.reserved, reservedBefore - 2, '取消必须释放 reserved');
            assert.equal((await db.inventoryReservation.findFirstOrThrow({ where: { orderId: order.id } })).status, 'released');
            // 同 key 同 body 返回同一张订单，不重复写事件。
            const replay = await support.call('POST', `admin/orders/${order.id}/cancel`, body, 'OrderDetailEnvelope', key);
            assert.equal(replay.status, 200);
            assert.equal(replay.body.data.version, 2);
            assert.equal(await db.orderStatusEvent.count({ where: { orderId: order.id, toStatus: 'cancelled' } }), 1);
            assert.equal(await db.orderAction.count({ where: { orderId: order.id } }), 1);
            // 同 key 不同 body 是冲突，不是“再取消一次”。
            assert.equal((await support.call('POST', `admin/orders/${order.id}/cancel`, { ...body, reason: 'Different reason' }, 'SuccessEnvelope', key)).status, 409);
            // 已取消的订单不能再取消。
            assert.equal((await support.call('POST', `admin/orders/${order.id}/cancel`, { ...body, expectedVersion: 2 })).status, 409);
            // 版本过期也必须拒绝。
            const stale = await makeOrder();
            assert.equal((await support.call('POST', `admin/orders/${stale.order.id}/cancel`, { reason: 'Stale version', expectedVersion: 2 })).status, 409);
            // 只有 orders.read 的角色不能取消。
            const reader = await sessionFor(['orders.read']);
            assert.equal((await reader.call('POST', `admin/orders/${stale.order.id}/cancel`, { reason: 'No permission', expectedVersion: 1 })).status, 403);
        });
        await t.test('address change reprices shipping and demands confirmation when the total moves', async () => {
            await resetLimits();
            const { order } = await makeOrder();
            const support = await sessionFor(['orders.read', 'orders.cancel', 'orders.update', 'orders.address_change', 'shipments.manage']);
            const key = randomUUID();
            const body = { expectedVersion: 1, address: { ...address, addressLine1: '2 New Road' }, customerConfirmationRef: 'call-2026-11-16' };
            // 运费没变：不需要顾客确认。
            const unchanged = await support.call('POST', `admin/orders/${order.id}/address-change`, body, 'OrderDetailEnvelope', key);
            assert.equal(unchanged.status, 200);
            assert.equal(unchanged.body.data.shippingMinor, 3_000);
            assert.equal(unchanged.body.data.totalMinor, 23_000);
            assert.equal(unchanged.body.data.addressSnapshot.addressLine1, '2 New Road');
            assert.equal(unchanged.body.data.version, 2);
            // 后台改了费率后改址：运费差额必须由顾客确认，否则 422。
            await db.shippingRate.update({ where: { id: rateId }, data: { fixedFeeMinor: 4_500 } });
            const moved = { expectedVersion: 2, address: { ...address, addressLine1: '3 Third Road' } };
            const rejected = await support.call('POST', `admin/orders/${order.id}/address-change`, moved);
            assert.equal(rejected.status, 422);
            assert.equal(rejected.body.error.code, 'CUSTOMER_CONFIRMATION_REQUIRED');
            const repriced = await support.call('POST', `admin/orders/${order.id}/address-change`, { ...moved, customerConfirmationRef: 'call-2026-11-16' }, 'OrderDetailEnvelope');
            assert.equal(repriced.status, 200);
            assert.equal(repriced.body.data.shippingMinor, 4_500);
            assert.equal(repriced.body.data.totalMinor, 24_500);
            assert.equal(repriced.body.data.version, 3);
            const history = await db.orderAddressChange.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
            assert.equal(history.length, 2);
            assert.equal(history[1].shippingMinorBefore, 3_000);
            assert.equal(history[1].shippingMinorAfter, 4_500);
            assert.equal(history[1].customerConfirmationRef, 'call-2026-11-16');
            // 新地址不在任何配送区内：不静默换方法，直接 409。
            const uncovered = await support.call('POST', `admin/orders/${order.id}/address-change`, { expectedVersion: 3, address: { ...address, countryCode: 'MO' }, customerConfirmationRef: 'x' });
            assert.equal(uncovered.status, 409);
            assert.equal(uncovered.body.error.code, 'SHIPPING_UNAVAILABLE');
            // 同 key 重放返回当前状态，不重复写改址历史。
            const replay = await support.call('POST', `admin/orders/${order.id}/address-change`, body, 'OrderDetailEnvelope', key);
            assert.equal(replay.status, 200);
            assert.equal(replay.body.data.version, 3);
            assert.equal(await db.orderAddressChange.count({ where: { orderId: order.id } }), 2);
            await db.shippingRate.update({ where: { id: rateId }, data: { fixedFeeMinor: 3_000 } });
        });
        await t.test('internal notes validate length and permission', async () => {
            await resetLimits();
            const { order } = await makeOrder();
            const support = await sessionFor(['orders.read', 'orders.update']);
            const created = await support.call('POST', `admin/orders/${order.id}/notes`, { note: '  Call before delivery  ' });
            assert.equal(created.status, 201);
            assert.equal(created.body.data.note, 'Call before delivery');
            assert.equal((await support.call('POST', `admin/orders/${order.id}/notes`, { note: '   ' })).status, 422);
            assert.equal((await support.call('POST', `admin/orders/${randomUUID()}/notes`, { note: 'ghost' })).status, 404);
            const reader = await sessionFor(['orders.read']);
            assert.equal((await reader.call('POST', `admin/orders/${order.id}/notes`, { note: 'nope' })).status, 403);
        });
        await t.test('shipments split the order, dispatch commits stock and delivery completes it', async () => {
            await resetLimits();
            const { order, item } = await makeOrder({ quantity: 2 });
            const support = await sessionFor(['orders.read', 'orders.update', 'orders.address_change', 'shipments.manage']);
            const stockBefore = await db.inventoryItem.findUniqueOrThrow({ where: { variantId } });
            assert.equal((await support.call('POST', `admin/orders/${order.id}/shipments`, { items: [{ orderItemId: item.id, quantity: 3 }] })).status, 422);
            const first = await support.call('POST', `admin/orders/${order.id}/shipments`, { items: [{ orderItemId: item.id, quantity: 1 }], carrierCode: 'SF', trackingNumber: 'SF123' });
            assert.equal(first.status, 201);
            assert.equal(first.body.data.status, 'created');
            assert.equal(first.body.data.items[0].quantity, 1);
            // 累计只允许 2 件，已分配 1 件后再要 2 件必须拒绝。
            assert.equal((await support.call('POST', `admin/orders/${order.id}/shipments`, { items: [{ orderItemId: item.id, quantity: 2 }] })).status, 409);
            const dispatchBody = { dispatchedAt: new Date().toISOString(), trackingNumber: 'SF123' };
            // 缺少 If-Match：handler 直接 422，不会误以为“版本 1”。
            assert.equal((await support.call('POST', `admin/shipments/${first.body.data.id}/dispatch`, dispatchBody)).status, 422);
            const sent = await support.withVersion(`admin/shipments/${first.body.data.id}/dispatch`, dispatchBody, 1);
            assert.equal(sent.status, 200);
            assert.equal(sent.body.data.status, 'dispatched');
            const afterDispatch = await db.inventoryItem.findUniqueOrThrow({ where: { variantId } });
            assert.equal(afterDispatch.onHand, 9, '发货必须真正扣减 onHand');
            assert.equal(afterDispatch.reserved, stockBefore.reserved - 1, '只释放本包裹对应的预留');
            assert.equal((await db.shopOrder.findUniqueOrThrow({ where: { id: order.id } })).orderStatus, 'partially_shipped');
            // 新 key 再发一次是状态冲突；同一包裹不能重复发货。
            assert.equal((await support.withVersion(`admin/shipments/${first.body.data.id}/dispatch`, dispatchBody, 2)).status, 409);
            const second = await support.call('POST', `admin/orders/${order.id}/shipments`, { items: [{ orderItemId: item.id, quantity: 1 }] });
            assert.equal(second.status, 201);
            assert.equal((await support.call('POST', `admin/shipments/${second.body.data.id}/deliver`, { deliveredAt: new Date().toISOString() })).status, 409, '未发货不能签收');
            const delivered = await support.call('POST', `admin/shipments/${first.body.data.id}/deliver`, { deliveredAt: new Date().toISOString(), evidenceRef: 'POD-1' });
            assert.equal(delivered.status, 200);
            let current = await db.shopOrder.findUniqueOrThrow({ where: { id: order.id } });
            assert.equal(current.orderStatus, 'partially_shipped');
            assert.equal(current.fulfillmentStatus, 'partially_fulfilled');
            const sentSecond = await support.withVersion(`admin/shipments/${second.body.data.id}/dispatch`, { dispatchedAt: new Date().toISOString() }, 1);
            assert.equal(sentSecond.status, 200);
            current = await db.shopOrder.findUniqueOrThrow({ where: { id: order.id } });
            assert.equal(current.orderStatus, 'shipped');
            assert.equal(current.fulfillmentStatus, 'fulfilled');
            assert.equal((await support.call('POST', `admin/shipments/${second.body.data.id}/deliver`, { deliveredAt: new Date().toISOString() })).status, 200);
            current = await db.shopOrder.findUniqueOrThrow({ where: { id: order.id } });
            assert.equal(current.orderStatus, 'completed');
            assert.equal(current.fulfillmentStatus, 'delivered');
            // 签收不等于收款：COD 仍是待收。
            assert.equal(current.paymentStatus, 'cod_due');
            const stock = await db.inventoryItem.findUniqueOrThrow({ where: { variantId } });
            assert.equal(stock.onHand, 8);
            // 其他测试的订单仍持有预留，这里只断言本订单的两件已全部释放。
            assert.equal(stock.reserved, stockBefore.reserved - 2);
            // 已完成订单不能再改址。
            assert.equal((await support.call('POST', `admin/orders/${order.id}/address-change`, { expectedVersion: current.version, address: { ...address, addressLine1: 'late' }, customerConfirmationRef: 'late' })).status, 409);
            const reader = await sessionFor(['orders.read']);
            assert.equal((await reader.call('POST', `admin/orders/${order.id}/shipments`, { items: [{ orderItemId: item.id, quantity: 1 }] })).status, 403);
        });
        await t.test('expired holds are released and unconfirmed orders cancelled by the sweep', async () => {
            await resetLimits();
            // 前面的子测试已在共享 SKU 上发货扣减过 onHand；先补足两件现货，否则 reserved 增量会撞上
            // InventoryItem 的 CHECK（reserved <= onHand）。
            await db.inventoryItem.update({ where: { variantId }, data: { onHand: { increment: 2 } } });
            const { order } = await makeOrder({ quantity: 2, expiresInMs: -60_000 });
            const orders = app.get('ORDERS');
            const reservedBefore = (await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).reserved;
            const first = await orders.releaseExpiredReservations();
            assert.equal(first.cancelled, 1);
            assert.equal(first.released, 1);
            assert.equal((await db.inventoryReservation.findFirstOrThrow({ where: { orderId: order.id } })).status, 'released');
            const swept = await db.shopOrder.findUniqueOrThrow({ where: { id: order.id } });
            assert.equal(swept.orderStatus, 'cancelled');
            assert.equal(swept.cancelReasonCode, 'reservation_expired');
            assert.ok(swept.cancelledAt);
            const event = await db.orderStatusEvent.findFirstOrThrow({ where: { orderId: order.id, toStatus: 'cancelled' } });
            assert.equal(event.actorType, 'system');
            assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).reserved, reservedBefore - 2);
            // 再跑一次没有任何变化：清理是幂等的。
            const second = await orders.releaseExpiredReservations();
            assert.equal(second.cancelled, 0);
            assert.equal(second.released, 0);
        });
        // 本机 node --test 会把子测试折叠成 1 项；用最终状态兜底，确认它们真的执行过。
        assert.equal(await db.shopOrder.count({ where: { orderStatus: 'completed' } }), 1);
        assert.equal(await db.shopOrder.count({ where: { cancelReasonCode: 'reservation_expired' } }), 1);
        // 本机 node --test 会把子测试折叠成 1 项；用最终状态兜底，确认它们真的执行过。
        assert.equal(await db.shopOrder.count({ where: { orderStatus: 'completed' } }), 1);
        assert.equal(await db.shopOrder.count({ where: { cancelReasonCode: 'reservation_expired' } }), 1);
    }
    finally {
        if (app)
            await app.close();
        await identity.onModuleDestroy().catch(() => { });
        await cluster.stop();
    }
});
