import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';
test('placement: section events, server-side cart/order attribution and net revenue report', { timeout: 900_000 }, async () => {
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
        return { status: response.status, body: data };
    };
    const makeCart = async () => {
        const token = randomBytes(32).toString('base64url');
        const cart = await db.guestCart.create({ data: { tokenDigest: digest(token), status: 'active',
                currency: 'HKD', expiresAt: new Date(Date.now() + 3_600_000) } });
        return { token, cartCsrf: randomBytes(32).toString('base64url'), cart };
    };
    const cookieHeader = (cart) => `ez_guest_cart=${cart.token}; ez_cart_csrf=${cart.cartCsrf}`;
    const ingest = (cart, events) => request('POST', 'storefront/analytics/events', { events }, { Cookie: cookieHeader(cart), 'X-CSRF-Token': cart.cartCsrf });
    const front = (cart, method, path, body, schema) => request(method, path, body, { Cookie: cookieHeader(cart), 'X-CSRF-Token': cart.cartCsrf, Origin: origin,
        ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) }, schema);
    const event = (sessionId, eventName, overrides = {}) => ({
        eventId: randomUUID(), sessionId, eventName, occurredAt: new Date().toISOString(),
        schemaVersion: '1.0', consentState: 'granted', pageKey: 'home',
        ...(eventName === 'view_item' || eventName === 'add_to_cart' ? { variantId: 'var-1' } : {}),
        ...overrides,
    });
    const sessionFor = async (permissions) => {
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
        const user = await db.adminUser.create({ data: { email: `u-${randomUUID()}@placement.test`, displayName: 'Staff',
                passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        return (path) => request('GET', path, undefined, { Cookie: `ez_admin_session=${token}`, Origin: origin });
    };
    const FROM = new Date(Date.now() - 86_400_000).toISOString();
    const TO = new Date(Date.now() + 86_400_000).toISOString();
    const query = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&timezone=Asia%2FHong_Kong`;
    const address = { recipientName: 'Buyer', phone: null, countryCode: 'HK', regionCode: null, city: 'Hong Kong',
        district: null, addressLine1: '1 Queen Road', addressLine2: null, postalCode: null };
    const contact = { email: 'buyer@example.com', phone: null, fullName: 'Buyer' };
    let variantId = '';
    let rateId = '';
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Placement Store', locales: ['zh-CN', 'en'],
                defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: { analyticsEnabled: true } } });
        await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved' } });
        const product = await db.product.create({ data: { status: 'active', marketCodes: ['HK'],
                translations: { create: [{ locale: 'en', name: 'Placement Product', slug: 'placement-product' }] } } });
        variantId = (await db.productVariant.create({ data: { productId: product.id, sku: 'SKU-P1',
                optionValues: {}, priceMinor: 10_000, currency: 'HKD' } })).id;
        await db.inventoryItem.create({ data: { variantId, onHand: 10 } });
        const zone = await db.shippingZone.create({ data: { code: 'HK', nameByLocale: { en: 'Hong Kong' },
                countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true } });
        rateId = (await db.shippingRate.create({ data: { code: 'STD-P', nameByLocale: { en: 'Standard' },
                fixedFeeMinor: 0, currency: 'HKD', codEnabled: true, enabled: true,
                zones: { create: [{ zoneId: zone.id }] } } })).id;
        const cart = await makeCart();
        const session = 'sess_placement_hero_0001';
        // 1) 21 个会话看到首页 hero，另有 5 个会话看到推荐位。
        const heroEvents = [];
        for (let i = 0; i < 21; i += 1) {
            const sid = i === 0 ? session : `sess_hero_${String(i).padStart(12, '0')}`;
            heroEvents.push(event(sid, 'section_impression', { sectionId: 'home:hero', sectionKey: 'home.hero',
                publishVersionId: 'rel-2026-11', placementId: 'hero-main' }));
        }
        for (let i = 0; i < 5; i += 1) {
            heroEvents.push(event(`sess_products_${String(i).padStart(10, '0')}`, 'section_impression', { sectionId: 'home:products', sectionKey: 'home.products', publishVersionId: 'rel-2026-11' }));
        }
        // 预览环境与疑似机器人不得进入指标（保留原始事件供审计）。
        heroEvents.push(event('sess_preview_000000001', 'section_impression', { sectionId: 'home:hero',
            sectionKey: 'home.hero', publishVersionId: 'rel-2026-11', environment: 'preview' }));
        heroEvents.push(event('sess_bot_000000000001', 'section_impression', { sectionId: 'home:hero',
            sectionKey: 'home.hero', publishVersionId: 'rel-2026-11', trafficClass: 'suspected_bot' }));
        // 页面访问事件用于区分「无前台访问」与「埋点未采集」。
        heroEvents.push(event(session, 'page_view'));
        heroEvents.push(event('sess_hero_000000000001', 'page_view'));
        heroEvents.push(event('sess_products_0000000000', 'page_view'));
        const ingested = await ingest(cart, heroEvents);
        assert.equal(ingested.status, 202, JSON.stringify(ingested.body));
        assert.equal(ingested.body.data.accepted, 31);
        // 2) 点击事件：hero 3 次（带商品），推荐位 2 次。
        const clicks = [
            event(session, 'section_click', { sectionId: 'home:hero', sectionKey: 'home.hero',
                publishVersionId: 'rel-2026-11', variantId, interactionId: 'int_hero_000000000000001' }),
            event('sess_hero_000000000001', 'section_click', { sectionId: 'home:hero', sectionKey: 'home.hero',
                publishVersionId: 'rel-2026-11', variantId, interactionId: 'int_hero_000000000000002' }),
            event('sess_hero_000000000002', 'section_click', { sectionId: 'home:hero', sectionKey: 'home.hero',
                publishVersionId: 'rel-2026-11' }),
            event('sess_products_0000000000', 'section_click', { sectionId: 'home:products', sectionKey: 'home.products',
                publishVersionId: 'rel-2026-11' }),
            event('sess_products_0000000001', 'section_click', { sectionId: 'home:products', sectionKey: 'home.products',
                publishVersionId: 'rel-2026-11' }),
        ];
        assert.equal((await ingest(cart, clicks)).status, 202);
        // 3) 加购归因：未同意的归因不落库；非法区块键 422；合法归因落库一行。
        const denied = await front(cart, 'POST', 'storefront/cart/items', { variantId, quantity: 1,
            attribution: { sectionId: 'home:hero', sectionKey: 'home.hero', publishVersionId: 'rel-2026-11',
                interactionId: 'int_denied_000000000001', consentState: 'denied' } });
        assert.equal(denied.status, 200);
        assert.equal(await db.placementAttribution.count(), 0, '未同意的归因不得落库');
        const invalid = await front(cart, 'POST', 'storefront/cart/items', { variantId, quantity: 1,
            attribution: { sectionId: 'home:hero', sectionKey: 'https://x/?q=1', publishVersionId: 'rel-2026-11',
                interactionId: 'int_invalid_00000000001', consentState: 'granted' } });
        assert.equal(invalid.status, 422);
        const added = await front(cart, 'POST', 'storefront/cart/items', { variantId, quantity: 2,
            attribution: { sectionId: 'home:hero', sectionKey: 'home.hero', placementId: 'hero-main',
                publishVersionId: 'rel-2026-11', interactionId: 'int_hero_000000000000001',
                pageKey: 'home', sessionId: session, consentState: 'granted', occurredAt: new Date().toISOString() } });
        assert.equal(added.status, 200, JSON.stringify(added.body));
        const touch = await db.placementAttribution.findFirst();
        assert.ok(touch);
        assert.equal(touch.sectionKey, 'home.hero');
        assert.equal(touch.deviceClass, null, '会话未上报设备时为 unknown，而不是伪造');
        assert.equal(touch.orderItemId, null);
        // 4) 下单：报价 → 提交订单，归因绑定到订单行。
        const quoted = await front(cart, 'POST', 'storefront/checkout/quote', { cartId: cart.cart.id, locale: 'en',
            marketCode: 'HK', contact, shippingAddress: address, shippingMethodId: rateId, couponCode: null,
            policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }] }, 'QuoteEnvelope');
        assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
        const quote = quoted.body.data;
        const order = await front(cart, 'POST', 'storefront/checkout/orders', { quoteId: quote.quoteId,
            confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope');
        assert.equal(order.status, 201, JSON.stringify(order.body));
        const attributed = await db.placementAttribution.findFirst();
        assert.equal(attributed.orderItemId !== null, true, '下单后归因必须绑定到订单行');
        assert.equal(attributed.attributedAt !== null, true);
        const orderItem = await db.orderItem.findFirst({ where: { orderId: order.body.data.orderId } });
        assert.equal(attributed.orderItemId, orderItem.id);
        // 未同意的加购仍计入购物袋（1 件），归因加购再加 2 件，订单行共 3 件。
        assert.equal(orderItem.quantity, 3);
        assert.equal(orderItem.lineTotalMinor, 30_000);
        // 收款：COD 登记为已收，才计入净实收。
        await db.payment.updateMany({ where: { orderId: order.body.data.orderId },
            data: { status: 'collected', paidAt: new Date() } });
        // 退款：一条关联售后明细分摊到该订单行的成功退款。
        const founder = await db.adminUser.create({ data: { email: `refund-${randomUUID()}@placement.test`,
                displayName: 'Refund Staff', passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        const refundCase = await db.afterSalesCase.create({ data: {
                publicCaseNumber: `AS-20261118-${randomBytes(3).toString('hex').toUpperCase().slice(0, 6)}`,
                orderId: order.body.data.orderId, caseType: 'refund', status: 'approved', reason: 'test',
                requestedRefundMinor: 10_000, approvedRefundMinor: 10_000, approvedAt: new Date(), approvedBy: founder.id,
                items: { create: [{ orderItemId: orderItem.id, requestedQuantity: 1, approvedQuantity: 1, amountMinor: 10_000 }] }
            } });
        const payment = await db.payment.findFirst({ where: { orderId: order.body.data.orderId } });
        await db.refund.create({ data: { publicRefundNumber: `REF-20261118-${randomBytes(3).toString('hex').toUpperCase().slice(0, 6)}`,
                idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()), orderId: order.body.data.orderId,
                paymentId: payment.id, caseId: refundCase.id, channel: 'cod', providerCode: 'cod', environment: 'production',
                amountMinor: 10_000, currency: 'HKD', status: 'refunded', reason: 'test',
                requestedBy: founder.id, approvedBy: founder.id, approvedAt: new Date(),
                executedBy: founder.id, executedAt: new Date() } });
        // 5) 报表：权限边界 + 区块聚合 + 阶段转化 + 净实收。
        const anonymous = await request('GET', `admin/reports/placement?${query}`, undefined, { Origin: origin });
        assert.equal(anonymous.status, 401);
        const viewer = await sessionFor(['reports.view']);
        const report = await viewer(`admin/reports/placement?${query}`);
        assert.equal(report.status, 200, JSON.stringify(report.body));
        const result = report.body.data;
        assert.equal(result.reportKey, 'placement');
        assert.match(result.metricDefinitionVersion, /^\d+\.\d+$/);
        assert.equal(result.totals.impressionSessions, 26, '预览/机器人事件不计入曝光会话');
        assert.equal(result.totals.clicks, 5);
        assert.equal(result.totals.addToCarts, 1);
        assert.equal(result.totals.orderCount, 1);
        assert.equal(result.totals.netRevenueMinor, 20_000, '行金额 30000 - 退款分摊 10000');
        assert.equal(result.coverage.complete, true, result.coverage.note);
        const hero = result.rows.find((row) => row.dimensions.sectionKey === 'home.hero');
        assert.ok(hero, JSON.stringify(result.rows));
        assert.equal(hero.metrics.impressionSessions, 21);
        assert.equal(hero.metrics.clicks, 3);
        assert.equal(hero.metrics.clickSessions, 3);
        assert.equal(hero.metrics.addToCarts, 1);
        assert.equal(hero.metrics.orderCount, 1);
        assert.equal(hero.metrics.netRevenueMinor, 20_000);
        assert.equal(hero.metrics.refundMinor, 10_000);
        assert.equal(hero.metrics.clickRate, Math.round((3 / 21) * 10_000) / 100);
        assert.equal(hero.metrics.insufficientSample, undefined);
        assert.equal(hero.dimensions.currency, 'HKD');
        // 按发布版本分组：同一版本号下合并各区块。
        const byVersion = await viewer(`admin/reports/placement?${query}&groupBy=version`);
        assert.equal(byVersion.status, 200);
        const versionRow = byVersion.body.data.rows.find((row) => row.dimensions.version === 'rel-2026-11');
        assert.ok(versionRow);
        assert.equal(versionRow.metrics.impressionSessions, 26);
        // 区块筛选：只返回 hero。
        const filtered = await viewer(`admin/reports/placement?${query}&sectionKey=home.hero`);
        assert.equal(filtered.status, 200);
        assert.equal(filtered.body.data.rows.length, 1);
        assert.equal(filtered.body.data.totals.impressionSessions, 21);
        assert.equal((await viewer(`admin/reports/placement?${query}&sectionKey=https%3A%2F%2Fx%2F%3Fq%3D1`)).status, 422);
        // 6) 超过 24 小时的交互不归因：新造一条过期归因，下单后仍保持未绑定。
        const oldCart = await makeCart();
        await db.placementAttribution.create({ data: { cartId: oldCart.cart.id, variantId, sectionId: 'home:about',
                sectionKey: 'home.about', publishVersionId: 'rel-2026-11', interactionId: 'int_stale_0000000000001',
                pageKey: 'home', consentState: 'granted', ruleVersion: 'placement:1.0',
                addedAt: new Date(Date.now() - 30 * 3_600_000) } });
        await front(oldCart, 'POST', 'storefront/cart/items', { variantId, quantity: 1 });
        const staleQuote = await front(oldCart, 'POST', 'storefront/checkout/quote', { cartId: oldCart.cart.id,
            locale: 'en', marketCode: 'HK', contact, shippingAddress: address, shippingMethodId: rateId,
            couponCode: null, policyAcceptances: [{ policyKey: 'terms', version: '1', accepted: true }] }, 'QuoteEnvelope');
        assert.equal(staleQuote.status, 200, JSON.stringify(staleQuote.body));
        const staleOrder = await front(oldCart, 'POST', 'storefront/checkout/orders', { quoteId: staleQuote.body.data.quoteId,
            confirmedQuoteVersion: 1, paymentMethodCode: 'cod' }, 'OrderCreatedEnvelope');
        assert.equal(staleOrder.status, 201, JSON.stringify(staleOrder.body));
        const staleTouch = await db.placementAttribution.findFirst({ where: { interactionId: 'int_stale_0000000000001' } });
        assert.equal(staleTouch.orderItemId, null, '超过 24 小时的交互不得归因');
    }
    finally {
        if (app)
            await app.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
