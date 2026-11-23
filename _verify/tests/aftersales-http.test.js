import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';
test('aftersales: cancellable cases, four-eyes refunds and return restock gated on inspection', { timeout: 300_000 }, async (t) => {
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const contracts = new IdentityContracts();
    const origin = 'https://shop.example.test';
    const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32),
        bootstrapToken: randomBytes(32).toString('base64url') };
    const identity = new IdentityService(db, config, contracts.ownerPermissions);
    let app;
    let base = '';
    const request = async (method, path, body, headers, schema) => {
        const response = await fetch(base + '/api/v1/' + path, { method,
            headers: { 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = response.status === 204 ? null : await response.json();
        if (response.status >= 400)
            contracts.assert('ErrorEnvelope', data);
        else if (schema && data !== null)
            contracts.assert(schema, data);
        return { status: response.status, body: data };
    };
    const resetLimits = () => db.identityRateLimit.deleteMany();
    /** 按权限组合直接建会话：这里只关心权限矩阵，邀请 + MFA 的细枝末节有独立测试。 */
    const sessionFor = async (permissions) => {
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
        const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@aftersales.test`, displayName: 'Staff',
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
        return { call, userId: user.id, token };
    };
    let rateId = '';
    let variantId = '';
    const contact = { email: 'buyer@example.com', phone: '+85291234567', fullName: 'Buyer' };
    const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
        district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
    const makeOrder = async (options = {}) => {
        const quantity = options.quantity ?? 2;
        const subtotal = 10_000 * quantity;
        const now = new Date();
        const cart = await db.guestCart.create({ data: { tokenDigest: digest(randomBytes(32).toString('hex')),
                status: 'converted', currency: 'HKD', expiresAt: new Date(now.getTime() + 86_400_000) } });
        const quote = await db.checkoutQuote.create({ data: { cartId: cart.id, status: 'consumed', version: 1,
                locale: 'en', marketCode: 'HK', currency: 'HKD', contact, shippingAddress: address, shippingMethodId: rateId,
                shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' }, subtotalMinor: subtotal, discountMinor: 0,
                shippingMinor: 3_000, taxMinor: 0, totalMinor: subtotal + 3_000,
                ruleVersions: { price: 'catalog.v1', promotion: 'none', shipping: 'rate:1', tax: null }, warnings: [],
                policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }],
                expiresAt: new Date(now.getTime() + 900_000) } });
        const order = await db.shopOrder.create({ data: {
                publicOrderNumber: `EZ-20261116-${randomBytes(3).toString('hex').toUpperCase()}`, idempotencyKey: randomUUID(),
                requestDigest: digest(randomUUID()), quoteId: quote.id, cartId: cart.id, shippingRateId: rateId,
                orderStatus: 'awaiting_confirmation', paymentStatus: options.paid ? 'collected' : 'cod_due', currency: 'HKD',
                subtotalMinor: subtotal, discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: subtotal + 3_000,
                locale: 'en', marketCode: 'HK', contact, shippingAddress: address,
                shippingMethodSnapshot: { code: 'STANDARD', name: 'Standard' }, paymentMethodCode: 'manual_bank_transfer',
                policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }], placedAt: now
            } });
        const item = await db.orderItem.create({ data: { orderId: order.id, variantId, sku: 'SKU-1',
                productName: 'Test Product', variantName: 'M', quantity, unitPriceMinor: 10_000, lineSubtotalMinor: subtotal,
                lineDiscountMinor: 0, lineTotalMinor: subtotal } });
        await db.inventoryItem.update({ where: { variantId }, data: { reserved: { increment: quantity } } });
        await db.inventoryReservation.create({ data: { orderId: order.id, variantId, quantity,
                expiresAt: new Date(Date.now() + 1_800_000) } });
        if (options.paid) {
            await db.payment.create({ data: { publicPaymentNumber: `PAY-20261116-${randomBytes(3).toString('hex').toUpperCase()}`,
                    dedupeKey: `manual_bank_transfer:${order.id}`, orderId: order.id, providerCode: 'manual_bank_transfer',
                    environment: 'production', channel: 'manual', status: 'collected', amountMinor: subtotal + 3_000,
                    currency: 'HKD', paidAt: now, metadata: { source: 'test' } } });
        }
        return { order, item };
    };
    const total = (quantity) => 10_000 * quantity + 3_000;
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Aftersales Store', locales: ['zh-CN', 'zh-HK', 'en'],
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
        await t.test('cancellation cases cancel unshipped orders and refuse paid ones', async () => {
            await resetLimits();
            const agent = await sessionFor(['aftersales.read', 'aftersales.manage', 'aftersales.approve']);
            const reader = await sessionFor(['aftersales.read']);
            const unpaid = await makeOrder();
            const body = { orderId: unpaid.order.id, caseType: 'cancel', items: [{ orderItemId: unpaid.item.id, quantity: 2 }],
                reason: 'Customer changed their mind', reasonCode: 'customer_request' };
            // 只有读权限的账号不能建案件。
            assert.equal((await reader.call('POST', 'admin/after-sales', body)).status, 403);
            const key = randomUUID();
            const created = await agent.call('POST', 'admin/after-sales', body, 'AfterSalesCaseEnvelope', { key });
            assert.equal(created.status, 201);
            assert.match(created.body.data.publicCaseNumber, /^AS-[0-9]{8}-[A-Z0-9]{6}$/);
            assert.equal(created.body.data.status, 'submitted');
            assert.equal(created.body.data.items[0].requestedQuantity, 2);
            // 同键重放返回同一个案件，不会建出第二件。
            const replay = await agent.call('POST', 'admin/after-sales', body, 'AfterSalesCaseEnvelope', { key });
            assert.equal(replay.body.data.id, created.body.data.id);
            assert.equal(await db.afterSalesCase.count({ where: { orderId: unpaid.order.id } }), 1);
            // 没有版本号就没有“批的是哪一版”。
            assert.equal((await agent.call('POST', `admin/after-sales/${created.body.data.id}/approve`, { reason: 'Approved' })).status, 422);
            const approved = await agent.call('POST', `admin/after-sales/${created.body.data.id}/approve`, { reason: 'Approved', reasonCode: 'customer_request' }, 'AfterSalesCaseEnvelope', { ifMatch: `"${created.body.data.version}"` });
            assert.equal(approved.status, 200);
            assert.equal(approved.body.data.status, 'completed', '取消类批准即结案');
            assert.ok(approved.body.data.closedAt);
            const cancelled = await db.shopOrder.findUniqueOrThrow({ where: { id: unpaid.order.id } });
            assert.equal(cancelled.orderStatus, 'cancelled');
            assert.equal(cancelled.cancelReasonCode, 'customer_request');
            const reservation = await db.inventoryReservation.findFirstOrThrow({ where: { orderId: unpaid.order.id } });
            assert.equal(reservation.status, 'released');
            // 已收款订单不能靠取消案件清账，必须走退款。
            const paid = await makeOrder({ paid: true });
            const blocked = await agent.call('POST', 'admin/after-sales', { orderId: paid.order.id, caseType: 'cancel',
                items: [{ orderItemId: paid.item.id, quantity: 1 }], reason: 'Wants money back' });
            assert.equal(blocked.status, 409);
            assert.equal(blocked.body.error.code, 'PAID_ORDER_REQUIRES_REFUND');
        });
        await t.test('refunds need settled money, a second approver and a payout reference', async () => {
            await resetLimits();
            const requester = await sessionFor(['aftersales.read', 'aftersales.manage', 'refunds.create', 'payments.read']);
            const approver = await sessionFor(['aftersales.read', 'aftersales.approve', 'refund.approve', 'refund.execute']);
            const executor = await sessionFor(['payments.read', 'refund.execute']);
            const paid = await makeOrder({ quantity: 2, paid: true });
            const created = await requester.call('POST', 'admin/after-sales', { orderId: paid.order.id, caseType: 'return',
                items: [{ orderItemId: paid.item.id, quantity: 2 }], reason: 'Arrived damaged', requestedRefundMinor: 20_000 }, 'AfterSalesCaseEnvelope');
            assert.equal(created.status, 201);
            const caseId = created.body.data.id;
            // 未批准的案件不能退款。
            const early = await requester.call('POST', `admin/after-sales/${caseId}/refund`, { amountMinor: 5_000, currency: 'HKD', reason: 'damaged' }, 'RefundEnvelope');
            assert.equal(early.status, 409);
            assert.equal(early.body.error.code, 'CASE_NOT_APPROVED');
            const approved = await approver.call('POST', `admin/after-sales/${caseId}/approve`, { reason: 'Approved replacement', reasonCode: null }, 'AfterSalesCaseEnvelope', { ifMatch: `"${created.body.data.version}"` });
            assert.equal(approved.status, 200);
            assert.equal(approved.body.data.status, 'approved');
            assert.equal(approved.body.data.approvedRefundMinor, 20_000);
            assert.equal(approved.body.data.items[0].approvedQuantity, 2);
            // 超过可退余额的申请直接被拒（实收 23,000，案件批准 20,000）。
            const over = await requester.call('POST', `admin/after-sales/${caseId}/refund`, { amountMinor: 20_001, currency: 'HKD', reason: 'greedy' }, 'RefundEnvelope');
            assert.equal(over.status, 409);
            assert.equal(over.body.error.code, 'REFUND_EXCEEDS_BALANCE');
            const key = randomUUID();
            const refund = await requester.call('POST', `admin/after-sales/${caseId}/refund`, { amountMinor: 10_000, currency: 'HKD', reason: 'Partial damage refund', reasonCode: null }, 'RefundEnvelope', { key });
            assert.equal(refund.status, 201);
            assert.match(refund.body.data.publicRefundNumber, /^REF-[0-9]{8}-[A-Z0-9]{6}$/);
            assert.equal(refund.body.data.status, 'requested');
            assert.equal(refund.body.data.channel, 'manual');
            assert.equal(refund.body.data.events.length, 1);
            const refundId = refund.body.data.id;
            // 同键重放返回同一笔退款，不同内容冲突。
            const replay = await requester.call('POST', `admin/after-sales/${caseId}/refund`, { amountMinor: 10_000, currency: 'HKD', reason: 'Partial damage refund', reasonCode: null }, 'RefundEnvelope', { key });
            assert.equal(replay.body.data.id, refundId);
            assert.equal((await requester.call('POST', `admin/after-sales/${caseId}/refund`, { amountMinor: 9_000, currency: 'HKD', reason: 'Partial damage refund' }, 'RefundEnvelope', { key })).status, 409);
            assert.equal(await db.refund.count({ where: { orderId: paid.order.id } }), 1);
            // 申请人不能自己批自己的退款。用独立订单：这笔退款会一直挂在途，
            // 若挂在同订单上会把后面「可退余额」断言压低 1,000。
            const selfApproval = await sessionFor(['refunds.create', 'refund.approve']);
            const selfOrder = await makeOrder({ paid: true });
            const selfCreated = await selfApproval.call('POST', 'admin/refunds', { orderId: selfOrder.order.id,
                paymentId: (await db.payment.findFirstOrThrow({ where: { orderId: selfOrder.order.id } })).id,
                amountMinor: 1_000, currency: 'HKD', reasonCode: null, reason: 'self' }, 'RefundEnvelope');
            assert.equal(selfCreated.status, 201);
            assert.equal((await selfApproval.call('POST', `admin/refunds/${selfCreated.body.data.id}/approve`, { reason: 'self approve' })).status, 403);
            // 没有退款执行权限的账号不能执行。
            assert.equal((await requester.call('POST', `admin/refunds/${refundId}/execute`, { reason: 'should fail', reference: 'X' })).status, 403);
            const approvedRefund = await approver.call('POST', `admin/refunds/${refundId}/approve`, { reason: 'Approved by finance' }, 'RefundEnvelope');
            assert.equal(approvedRefund.status, 200);
            assert.equal(approvedRefund.body.data.status, 'approved');
            assert.ok(approvedRefund.body.data.approvedAt);
            // 重复批准不再产生第二次状态变更。
            assert.equal((await approver.call('POST', `admin/refunds/${refundId}/approve`, { reason: 'again' })).status, 409);
            // 线下退款必须有凭据号：没有凭据的“已退款”无法对账。
            assert.equal((await executor.call('POST', `admin/refunds/${refundId}/execute`, { reason: 'Paid out' })).status, 422);
            const executed = await executor.call('POST', `admin/refunds/${refundId}/execute`, { reason: 'Paid out in cash', reference: 'PAYOUT-778', occurredAt: new Date().toISOString() }, 'RefundEnvelope');
            assert.equal(executed.status, 200);
            assert.equal(executed.body.data.status, 'refunded');
            assert.equal(executed.body.data.reference, 'PAYOUT-778');
            assert.equal(executed.body.data.externalRefundId, 'PAYOUT-778');
            assert.ok(executed.body.data.executedAt);
            assert.equal(executed.body.data.events.length, 3);
            // 案件还没退满批准金额，状态仍是 refund_pending。
            const afterPartial = await requester.call('GET', `admin/after-sales/${caseId}`, undefined, 'AfterSalesCaseEnvelope');
            assert.equal(afterPartial.body.data.status, 'refund_pending');
            assert.equal(afterPartial.body.data.refundedMinor, 10_000);
            assert.equal(afterPartial.body.data.refundableMinor, 13_000, '实收 23,000 减去已退 10,000');
            // 把剩余批准金额退完后案件自动进入 refunded。
            const second = await requester.call('POST', `admin/after-sales/${caseId}/refund`, { amountMinor: 10_000, currency: 'HKD', reason: 'Rest of the damage refund' }, 'RefundEnvelope');
            assert.equal(second.status, 201);
            await approver.call('POST', `admin/refunds/${second.body.data.id}/approve`, { reason: 'Approved' }, 'RefundEnvelope');
            const settled = await executor.call('POST', `admin/refunds/${second.body.data.id}/execute`, { reason: 'Paid out', reference: 'PAYOUT-779' }, 'RefundEnvelope');
            assert.equal(settled.status, 200);
            const afterFull = await requester.call('GET', `admin/after-sales/${caseId}`, undefined, 'AfterSalesCaseEnvelope');
            assert.equal(afterFull.body.data.status, 'refunded');
            // 案件批准金额已用尽，再退一分都不行。
            const exhausted = await requester.call('POST', `admin/after-sales/${caseId}/refund`, { amountMinor: 1, currency: 'HKD', reason: 'one more' }, 'RefundEnvelope');
            assert.equal(exhausted.status, 409);
            // 已退款案件可以关闭；还有在途退款时不允许关。
            const closeEarly = await requester.call('POST', `admin/after-sales/${caseId}/close`, { reason: 'done' }, 'AfterSalesCaseEnvelope', { ifMatch: `"${afterFull.body.data.version}"` });
            assert.equal(closeEarly.status, 200);
            assert.equal(closeEarly.body.data.status, 'completed');
            const list = await requester.call('GET', `admin/after-sales?orderId=${paid.order.id}`, undefined, 'AfterSalesCaseListEnvelope');
            assert.equal(list.body.data.items.length, 1);
            assert.equal(list.body.data.items[0].publicCaseNumber, created.body.data.publicCaseNumber);
            const refundList = await requester.call('GET', `admin/refunds?orderId=${paid.order.id}`, undefined, 'RefundListEnvelope');
            assert.equal(refundList.body.data.items.length, 2);
            assert.equal((await requester.call('GET', `admin/refunds/${refundId}`, undefined, 'RefundEnvelope'))
                .body.data.events.length, 3);
            assert.equal((await requester.call('GET', 'admin/after-sales?status=refunded', undefined, 'AfterSalesCaseListEnvelope')).status, 200);
            assert.equal((await requester.call('GET', 'admin/after-sales?status=paid')).status, 422);
        });
        await t.test('unpaid COD orders have nothing to refund', async () => {
            await resetLimits();
            const agent = await sessionFor(['aftersales.read', 'aftersales.manage', 'aftersales.approve', 'refunds.create']);
            const unpaid = await makeOrder();
            const created = await agent.call('POST', 'admin/after-sales', { orderId: unpaid.order.id, caseType: 'refund',
                items: [{ orderItemId: unpaid.item.id, quantity: 1 }], reason: 'Wants a refund' }, 'AfterSalesCaseEnvelope');
            const approved = await agent.call('POST', `admin/after-sales/${created.body.data.id}/approve`, { reason: 'Approved' }, 'AfterSalesCaseEnvelope', { ifMatch: `"${created.body.data.version}"` });
            assert.equal(approved.status, 200);
            // 没有已收款流水：不能虚构一笔退款出来。
            const refund = await agent.call('POST', `admin/after-sales/${created.body.data.id}/refund`, { amountMinor: 1_000, currency: 'HKD', reason: 'nothing paid' }, 'RefundEnvelope');
            assert.equal(refund.status, 422);
            assert.equal(refund.body.error.code, 'NOTHING_TO_REFUND');
            assert.equal(await db.refund.count({ where: { orderId: unpaid.order.id } }), 0);
        });
        await t.test('returned goods only reach sellable stock after inspection', async () => {
            await resetLimits();
            const agent = await sessionFor(['aftersales.read', 'aftersales.manage', 'aftersales.approve', 'aftersales.inspect']);
            const paid = await makeOrder({ quantity: 2, paid: true });
            const stockBefore = (await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).onHand;
            const created = await agent.call('POST', 'admin/after-sales', { orderId: paid.order.id, caseType: 'return',
                items: [{ orderItemId: paid.item.id, quantity: 2 }], reason: 'Wrong size' }, 'AfterSalesCaseEnvelope');
            const caseId = created.body.data.id;
            // 未批准不能登记退货物流。
            assert.equal((await agent.call('POST', `admin/after-sales/${caseId}/return-shipment`, { trackingNumber: 'SF123' })).status, 409);
            const approved = await agent.call('POST', `admin/after-sales/${caseId}/approve`, { reason: 'Approved' }, 'AfterSalesCaseEnvelope', { ifMatch: `"${created.body.data.version}"` });
            const shipment = await agent.call('POST', `admin/after-sales/${caseId}/return-shipment`, { carrierCode: 'SF', trackingNumber: 'SF123456789', shippedAt: new Date().toISOString() }, 'AfterSalesCaseEnvelope');
            assert.equal(shipment.status, 201);
            assert.equal(shipment.body.data.status, 'return_in_transit');
            assert.equal(shipment.body.data.returns[0].trackingNumber, 'SF123456789');
            const receipt = await agent.call('POST', `admin/after-sales/${caseId}/receive-return`, { receivedAt: new Date().toISOString(), reference: 'RCV-1', items: [{ orderItemId: paid.item.id, quantity: 2 }] }, 'AfterSalesCaseEnvelope');
            assert.equal(receipt.status, 200);
            assert.equal(receipt.body.data.status, 'received_inspection');
            assert.equal(receipt.body.data.returns[0].status, 'received');
            // 收货不等于可卖：库存还没动。
            assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).onHand, stockBefore);
            const overInspect = await agent.call('POST', `admin/after-sales/${caseId}/inspect`, { reason: 'Checked', items: [{ orderItemId: paid.item.id, quantity: 3, disposition: 'sellable' }] }, 'AfterSalesCaseEnvelope');
            assert.equal(overInspect.status, 409);
            assert.equal(overInspect.body.error.code, 'INSPECTION_QUANTITY_EXCEEDED');
            const inspected = await agent.call('POST', `admin/after-sales/${caseId}/inspect`, { reason: 'One resellable, one damaged',
                items: [{ orderItemId: paid.item.id, quantity: 1, disposition: 'sellable', note: 'Seal intact' },
                    { orderItemId: paid.item.id, quantity: 1, disposition: 'damaged', note: 'Scratched' }] }, 'AfterSalesCaseEnvelope');
            assert.equal(inspected.status, 200);
            assert.equal(inspected.body.data.inspections.length, 2);
            assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).onHand, stockBefore + 1, '只有 sellable 的一件回到可售库存');
            const movements = await db.inventoryMovement.findMany({ where: { caseId } });
            assert.equal(movements.length, 2);
            assert.deepEqual(movements.map(move => [move.type, move.stockDelta]).sort(), [['return_damaged', 0], ['return_restock', 1]]);
            // 同一批货再质检一次必须被挡住，库存不能加两遍。
            const again = await agent.call('POST', `admin/after-sales/${caseId}/inspect`, { reason: 'double check', items: [{ orderItemId: paid.item.id, quantity: 1, disposition: 'sellable' }] }, 'AfterSalesCaseEnvelope');
            assert.equal(again.status, 409);
            assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { variantId } })).onHand, stockBefore + 1);
            // 有在途退款时不允许关案。
            const refund = await sessionFor(['refunds.create']);
            const requested = await refund.call('POST', `admin/after-sales/${caseId}/refund`, { amountMinor: 5_000, currency: 'HKD', reason: 'partial' }, 'RefundEnvelope');
            assert.equal(requested.status, 201);
            // 申请退款已经把案件推进到 refund_pending（version 也 +1），关案必须基于最新版本。
            const freshCase = await agent.call('GET', `admin/after-sales/${caseId}`, undefined, 'AfterSalesCaseEnvelope');
            const closeBlocked = await agent.call('POST', `admin/after-sales/${caseId}/close`, { reason: 'done' }, 'AfterSalesCaseEnvelope', { ifMatch: `"${freshCase.body.data.version}"` });
            assert.equal(closeBlocked.status, 409);
            assert.equal(closeBlocked.body.error.code, 'REFUND_IN_PROGRESS');
        });
        // 兜底断言：子测试被跳过时这里必须失败，而不是静默“通过”。
        assert.ok(await db.refund.count({ where: { status: 'refunded' } }) >= 2);
        assert.ok(await db.inventoryMovement.count({ where: { type: 'return_restock' } }) >= 1);
        assert.equal((await db.afterSalesCase.findFirstOrThrow({ where: { caseType: 'cancel' } })).status, 'completed');
    }
    finally {
        if (app)
            await app.close();
        await identity.onModuleDestroy().catch(() => { });
        await cluster.stop();
    }
});
