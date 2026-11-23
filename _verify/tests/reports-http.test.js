import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { csrf } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { memberNumber } from '../packages/domain/src/members.js';
import { REPORT_KEYS } from '../packages/domain/src/reports.js';
import { testPostgres } from './helpers/postgres.js';
test('reports: server-authoritative aggregates, permissions and controlled export', { timeout: 900_000 }, async (t) => {
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
        else if (schema)
            contracts.assert(schema, data);
        return { status: response.status, body: data, response };
    };
    /** 直接建会话并绑定指定权限，便于逐条验证 reports.view / reports.export 矩阵。 */
    const sessionFor = async (permissions) => {
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
        const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@reports.test`, displayName: 'Staff',
                passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        const tokenCsrf = csrf(token, config);
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        const call = (method, path, body, opts = {}) => request(method, path, body, {
            Cookie: `ez_admin_session=${token}`,
            Origin: opts.origin === undefined ? origin : opts.origin,
            'X-CSRF-Token': opts.csrf === undefined ? tokenCsrf : opts.csrf,
            ...(method !== 'GET' ? { 'Idempotency-Key': opts.key ?? randomUUID() } : {}),
        }, opts.schema ?? 'SuccessEnvelope');
        return { call, userId: user.id, token, csrf: tokenCsrf };
    };
    const FROM = '2026-11-01T00:00:00.000Z';
    const TO = '2026-11-08T00:00:00.000Z';
    const query = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&timezone=Asia%2FHong_Kong`;
    const contact = { email: 'buyer@example.com', phone: null, fullName: 'Buyer' };
    const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
        district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
    let variantId = '';
    let rateId = '';
    /** 造一笔落在区间内的订单：cart→quote→order→item，金额与状态可控。 */
    const makeOrder = async (opts = {}) => {
        const now = new Date(opts.placedAt ?? '2026-11-03T10:00:00.000Z');
        const total = opts.total ?? 23_000;
        const shipping = opts.shipping ?? 3_000;
        const subtotal = total - shipping;
        const currency = opts.currency ?? 'HKD';
        const cart = await db.guestCart.create({ data: { tokenDigest: digest(randomUUID()), status: 'converted',
                currency, expiresAt: new Date(now.getTime() + 86_400_000) } });
        const quote = await db.checkoutQuote.create({ data: { cartId: cart.id, status: 'consumed', version: 1,
                locale: 'en', marketCode: 'HK', currency, contact, shippingAddress: address, shippingMethodId: rateId,
                shippingMethodSnapshot: { code: 'STANDARD' }, subtotalMinor: subtotal, discountMinor: 0, shippingMinor: shipping,
                taxMinor: 0, totalMinor: total, ruleVersions: {}, warnings: [],
                policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }],
                expiresAt: new Date(now.getTime() + 900_000) } });
        const order = await db.shopOrder.create({ data: { publicOrderNumber: `EZ-20261103-${randomBytes(3).toString('hex').toUpperCase().slice(0, 6)}`,
                idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()), quoteId: quote.id, cartId: cart.id,
                orderStatus: opts.status ?? 'confirmed', paymentStatus: opts.paymentStatus ?? 'collected',
                currency, subtotalMinor: subtotal, discountMinor: 0, shippingMinor: shipping, taxMinor: 0, totalMinor: total,
                locale: 'en', marketCode: 'HK', contact, shippingAddress: address, shippingMethodSnapshot: { code: 'STANDARD' },
                paymentMethodCode: opts.method ?? 'cod', policyAcceptances: [], placedAt: now,
                ...(opts.status === 'cancelled' ? { cancelledAt: new Date(now.getTime() + 3_600_000),
                    cancelReasonCode: 'customer_request', cancelReason: 'test cancellation' } : {}) } });
        await db.orderItem.create({ data: { orderId: order.id, variantId, sku: opts.sku ?? 'SKU-R1', productName: 'Report Product',
                variantName: null, quantity: 2, unitPriceMinor: Math.floor(subtotal / 2), lineSubtotalMinor: subtotal,
                lineDiscountMinor: 0, lineTotalMinor: subtotal } });
        return order;
    };
    const makePayment = async (order, opts = {}) => db.payment.create({ data: {
            publicPaymentNumber: `PAY-20261103-${randomBytes(3).toString('hex').toUpperCase().slice(0, 6)}`, dedupeKey: `cod:${order.id}:${randomUUID()}`,
            orderId: order.id, providerCode: 'cod', environment: 'production', channel: opts.channel ?? 'cod',
            status: opts.status ?? 'collected', amountMinor: opts.amount ?? order.totalMinor,
            currency: opts.currency ?? order.currency, paidAt: new Date(opts.paidAt ?? '2026-11-03T11:00:00.000Z'),
            metadata: {}
        } });
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Report Store', locales: ['zh-CN', 'en'],
                defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
        // 商品/变体/库存与配送方式（订单与库存报表会用到）。
        const product = await db.product.create({ data: { status: 'active' } });
        const variant = await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-R1',
                optionValues: {}, priceMinor: 10_000, currency: 'HKD' } });
        variantId = variant.id;
        await db.inventoryItem.create({ data: { variantId, onHand: 100, reserved: 10 } });
        await db.inventoryThreshold.create({ data: { variantId, lowStockLevel: 20 } });
        const rate = await db.shippingRate.create({ data: { code: 'STD-R', nameByLocale: { en: 'Standard' },
                fixedFeeMinor: 3_000, currency: 'HKD' } });
        rateId = rate.id;
        // 三笔订单：两笔 HKD（一笔已收、一笔取消），一笔 USD（验证不跨币种相加）。
        const o1 = await makeOrder({ status: 'confirmed', paymentStatus: 'collected', total: 23_000, placedAt: '2026-11-03T10:00:00.000Z' });
        const o2 = await makeOrder({ status: 'cancelled', paymentStatus: 'cancelled', total: 15_000, placedAt: '2026-11-04T10:00:00.000Z', sku: 'SKU-R2' });
        const o3 = await makeOrder({ status: 'confirmed', paymentStatus: 'collected', total: 10_000, currency: 'USD', placedAt: '2026-11-05T10:00:00.000Z' });
        await makePayment(o1, { status: 'collected', amount: 23_000 });
        await makePayment(o3, { status: 'collected', amount: 10_000, currency: 'USD' });
        // 区间外的一笔收款：不应进入统计。
        await makePayment(o1, { status: 'collected', amount: 99_999, paidAt: '2026-10-31T10:00:00.000Z' });
        // 退款：区间内成功退款 5_000（HKD）。
        await db.refund.create({ data: { publicRefundNumber: `REF-20261103-${randomBytes(3).toString('hex').toUpperCase().slice(0, 6)}`,
                idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()), orderId: o1.id,
                paymentId: (await db.payment.findFirst({ where: { orderId: o1.id, amountMinor: 23_000 } })).id,
                channel: 'cod', providerCode: 'cod', environment: 'production', amountMinor: 5_000, currency: 'HKD',
                status: 'refunded', reason: 'test', requestedBy: randomUUID(),
                approvedBy: randomUUID(), approvedAt: new Date('2026-11-05T10:00:00.000Z'),
                executedBy: randomUUID(), executedAt: new Date('2026-11-06T10:00:00.000Z') } });
        // 券核销（区间内发放并核销）。
        const coupon = await db.coupon.create({ data: { code: 'REPORT10', discountType: 'fixed', discountValue: 1_000,
                currency: 'HKD', validFrom: new Date('2026-11-01T00:00:00.000Z'), validUntil: new Date('2026-11-30T00:00:00.000Z') } });
        await db.couponRedemption.create({ data: { couponId: coupon.id, orderId: o1.id, status: 'redeemed',
                discountMinor: 1_000, currency: 'HKD', codeSnapshot: 'REPORT10', ruleSnapshot: {}, dedupeKey: `redeem:${o1.id}`,
                reservedAt: new Date('2026-11-02T00:00:00.000Z'), redeemedAt: new Date('2026-11-03T12:00:00.000Z') } });
        // 会员：区间内注册，发放并兑换积分。
        const customer = await db.customer.create({ data: { displayName: 'Member', emailNormalized: `m-${randomUUID()}@x.test` } });
        const tier = await db.membershipTier.create({ data: { code: 'GOLD', nameByLocale: { en: 'Gold' }, rank: 1 } });
        const member = await db.memberProfile.create({ data: { customerId: customer.id,
                memberNo: memberNumber('20261118', randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()),
                tierId: tier.id, joinedAt: new Date('2026-11-02T00:00:00.000Z') } });
        await db.pointLedger.create({ data: { id: randomUUID(), memberId: member.id, deltaPoints: 100, balanceAfter: 100,
                entryType: 'earn', sourceType: 'order', reasonCode: 'earned', ruleVersion: 'loyalty-v1', idempotencyKey: randomUUID(),
                createdAt: new Date('2026-11-03T00:00:00.000Z') } });
        await db.pointLedger.create({ data: { id: randomUUID(), memberId: member.id, deltaPoints: -30, balanceAfter: 70,
                entryType: 'redeem', sourceType: 'order', reasonCode: 'redeemed', ruleVersion: 'loyalty-redeem-v1', idempotencyKey: randomUUID(),
                createdAt: new Date('2026-11-04T00:00:00.000Z') } });
        await db.orderMemberLink.create({ data: { orderId: o1.id, memberId: member.id } });
        const viewer = await sessionFor(['reports.view']);
        const exporter = await sessionFor(['reports.view', 'reports.export']);
        const nobody = await sessionFor(['catalog.read']);
        // 权限矩阵：只读能看报表不能导出；导出角色两者都可；无关权限两者皆拒。
        assert.equal((await viewer.call('GET', `admin/reports/sales_summary?${query}`)).status, 200);
        assert.equal((await viewer.call('POST', 'admin/report-exports', { reportKey: 'sales_summary', from: FROM, to: TO, timezone: 'Asia/Hong_Kong', format: 'csv' })).status, 403);
        assert.equal((await exporter.call('GET', `admin/reports/sales_summary?${query}`)).status, 200);
        assert.equal((await nobody.call('GET', `admin/reports/sales_summary?${query}`)).status, 403);
        assert.equal((await nobody.call('POST', 'admin/report-exports', { reportKey: 'sales_summary', from: FROM, to: TO, timezone: 'Asia/Hong_Kong', format: 'csv' })).status, 403);
        // CSRF / Origin 守卫。
        const badCsrf = await exporter.call('POST', 'admin/report-exports', { reportKey: 'sales_summary', from: FROM, to: TO, timezone: 'Asia/Hong_Kong', format: 'csv' }, { csrf: 'wrong-token-value' });
        assert.equal(badCsrf.status, 403);
        const badOrigin = await exporter.call('POST', 'admin/report-exports', { reportKey: 'sales_summary', from: FROM, to: TO, timezone: 'Asia/Hong_Kong', format: 'csv' }, { origin: 'https://evil.test' });
        assert.equal(badOrigin.status, 403);
        // 全部 8 个报表 key 都能查询，且返回口径版本、币种、覆盖率。
        for (const key of REPORT_KEYS) {
            const res = await viewer.call('GET', `admin/reports/${key}?${query}`, undefined, { schema: 'ReportEnvelope' });
            assert.equal(res.status, 200, key);
            assert.equal(res.body.data.reportKey, key);
            assert.equal(res.body.data.metricDefinitionVersion, '1.0');
            assert.ok(Array.isArray(res.body.data.currencies));
            assert.ok(Array.isArray(res.body.data.rows));
            assert.equal(typeof res.body.data.coverage.sourceOrderCount, 'number');
        }
        // 销售汇总：三笔订单；HKD 已收 23k、退款 5k、净 18k；USD 单独一行，不混加。
        const sales = await viewer.call('GET', `admin/reports/sales_summary?${query}`);
        assert.equal(sales.body.data.totals.orderCount, 3);
        assert.equal(sales.body.data.totals.cancelledOrderCount, 1);
        assert.equal(sales.body.data.totals.refundCount, 1);
        const hkd = sales.body.data.rows.find((r) => r.dimensions.currency === 'HKD' && r.metrics.placedMinor !== undefined);
        const usd = sales.body.data.rows.find((r) => r.dimensions.currency === 'USD' && r.metrics.placedMinor !== undefined);
        assert.equal(hkd.metrics.placedMinor, 38_000);
        assert.equal(hkd.metrics.collectedMinor, 23_000);
        assert.equal(hkd.metrics.refundedMinor, 5_000);
        assert.equal(hkd.metrics.netSalesMinor, 18_000);
        assert.equal(usd.metrics.placedMinor, 10_000);
        assert.equal(usd.metrics.collectedMinor, 10_000);
        // 市场/付款方式筛选生效。
        const codOnly = await viewer.call('GET', `admin/reports/orders_by_method?${query}&paymentMethodCode=cod`);
        assert.equal(codOnly.body.data.totals.orderCount, 3, '三笔都是 cod 方式');
        const usdMarket = await viewer.call('GET', `admin/reports/sales_summary?${query}&marketCode=US`);
        assert.equal(usdMarket.body.data.totals.orderCount, 0, '无美国市场订单');
        // 库存报表：可用 90、低库存阈值 20、无缺货。
        const inv = await viewer.call('GET', `admin/reports/inventory?${query}`);
        assert.equal(inv.body.data.totals.variantCount, 1);
        assert.equal(inv.body.data.totals.lowStockCount, 0);
        const stockRow = inv.body.data.rows.find((r) => r.dimensions.sku === 'SKU-R1');
        assert.equal(stockRow.metrics.available, 90);
        assert.equal(stockRow.metrics.lowStockLevel, 20);
        // 会员报表：注册 1、活跃 1、发放 100、兑换 30、等级 GOLD。
        const mem = await viewer.call('GET', `admin/reports/members?${query}`);
        assert.equal(mem.body.data.totals.registeredMembers, 1);
        assert.equal(mem.body.data.totals.pointsIssued, 100);
        assert.equal(mem.body.data.totals.pointsRedeemed, 30);
        assert.ok(mem.body.data.rows.some((r) => r.dimensions.tier === 'GOLD'));
        // 导出：创建→状态→下载；幂等键重放返回同一任务；xlsx 首期明确拒绝。
        const exportBody = { reportKey: 'sales_summary', from: FROM, to: TO, timezone: 'Asia/Hong_Kong', format: 'csv' };
        const idempotencyKey = randomUUID();
        const created = await exporter.call('POST', 'admin/report-exports', exportBody, { key: idempotencyKey, schema: 'ReportExportEnvelope' });
        assert.equal(created.status, 202);
        const exportId = created.body.data.id;
        assert.equal(created.body.data.status, 'completed');
        assert.match(created.body.data.downloadUrl, /\/download$/);
        const replay = await exporter.call('POST', 'admin/report-exports', exportBody, { key: idempotencyKey });
        assert.equal(replay.body.data.id, exportId, '幂等重放返回同一任务');
        const status = await exporter.call('GET', `admin/report-exports/${exportId}`, undefined, { schema: 'ReportExportEnvelope' });
        assert.equal(status.body.data.reportKey, 'sales_summary');
        const csv = await fetch(base + `/api/v1/admin/report-exports/${exportId}/download`, {
            headers: { Cookie: `ez_admin_session=${exporter.token}` }
        });
        assert.equal(csv.status, 200);
        assert.match(csv.headers.get('content-type'), /text\/csv/);
        const csvText = await csv.text();
        assert.ok(csvText.includes('sales_summary'));
        assert.ok(csvText.includes('Asia/Hong_Kong'));
        assert.ok(csvText.includes('metricDefinitionVersion') || csvText.includes('1.0'));
        // 无导出权限不能下载。
        assert.equal((await viewer.call('GET', `admin/report-exports/${exportId}/download`)).status, 403);
        // xlsx 首期不支持：契约允许但服务端明确拒绝，不静默生成伪装文件。
        const xlsx = await exporter.call('POST', 'admin/report-exports', { ...exportBody, format: 'xlsx' });
        assert.equal(xlsx.status, 422);
        t.diagnostic('reports: 全报表口径、权限矩阵、导出幂等与下载均通过');
    }
    finally {
        if (app)
            await app.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
