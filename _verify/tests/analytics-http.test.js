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
test('analytics: consent-gated ingest, idempotency and server-authoritative funnel', { timeout: 900_000 }, async () => {
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
    /** 建一个真实购物袋，返回 cart token（用于 cookie）与前台 csrf。 */
    const makeCart = async () => {
        const token = randomBytes(32).toString('base64url');
        const cart = await db.guestCart.create({ data: { tokenDigest: digest(token), status: 'active',
                currency: 'HKD', expiresAt: new Date(Date.now() + 3_600_000) } });
        return { token, cartCsrf: randomBytes(32).toString('base64url'), cart };
    };
    /** 上报事件：带双提交 CSRF 与可选 cart cookie。csrfHeader 与 cookie 值可分别指定，用于验证 CSRF 拒绝。 */
    const ingest = (cart, events, opts = {}) => {
        const cookieValue = opts.csrfCookie === undefined ? cart.cartCsrf : opts.csrfCookie;
        const headerValue = opts.csrfHeader === undefined ? cookieValue : opts.csrfHeader;
        const cookies = [`ez_cart_csrf=${cookieValue}`, ...(opts.withCart === false ? [] : [`ez_guest_cart=${cart.token}`])];
        return request('POST', 'storefront/analytics/events', { events }, { Cookie: cookies.join('; '), 'X-CSRF-Token': headerValue });
    };
    const event = (sessionId, eventName, overrides = {}) => ({
        eventId: randomUUID(), sessionId, eventName, occurredAt: new Date().toISOString(),
        schemaVersion: '1.0', consentState: 'granted', pageKey: 'home',
        ...(eventName === 'view_item' || eventName === 'add_to_cart' ? { variantId: 'var-1' } : {}),
        ...overrides,
    });
    /** 管理员会话（报表需要 reports.view）。 */
    const sessionFor = async (permissions) => {
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
        const user = await db.adminUser.create({ data: { email: `u-${randomUUID()}@analytics.test`, displayName: 'Staff',
                passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        const tokenCsrf = csrf(token, config);
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        const call = (path) => request('GET', path, undefined, {
            Cookie: `ez_admin_session=${token}`, Origin: origin,
        });
        return { call };
    };
    const FROM = new Date(Date.now() - 86_400_000).toISOString();
    const TO = new Date(Date.now() + 86_400_000).toISOString();
    const query = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&timezone=Asia%2FHong_Kong`;
    let rateId = '';
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Analytics Store', locales: ['zh-CN', 'en'],
                defaultLocale: 'en', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
        const rate = await db.shippingRate.create({ data: { code: 'STD-A', nameByLocale: { en: 'Standard' },
                fixedFeeMinor: 0, currency: 'HKD' } });
        rateId = rate.id;
        const cart = await makeCart();
        // 1) 开关默认关闭：采集被拒，不落库。
        const disabled = await ingest(cart, [event('sess_default_off_0001', 'page_view')]);
        assert.equal(disabled.status, 403);
        assert.equal(disabled.body.error.code, 'ANALYTICS_DISABLED');
        assert.equal(await db.analyticsEvent.count(), 0);
        // 打开开关。
        await db.storeConfig.update({ where: { id: 1 }, data: { featureFlags: { analyticsEnabled: true } } });
        // 2) CSRF 校验：请求头与 cookie 不符 → 403；缺少请求头 → 403。
        assert.equal((await ingest(cart, [event('sess_bad_csrf_00001', 'page_view')], { csrfCookie: cart.cartCsrf, csrfHeader: 'y'.repeat(43) })).status, 403);
        assert.equal((await ingest(cart, [event('sess_bad_csrf_00002', 'page_view')], { csrfCookie: cart.cartCsrf, csrfHeader: '' })).status, 403);
        // 无 cart cookie 也能采集页面浏览（cartId 留空），但仍需正确 CSRF。
        assert.equal((await ingest(cart, [event('sess_no_cart_00001', 'page_view')], { withCart: false })).status, 202);
        // 3) 采集成功 + 幂等：同一 eventId 重放不二次写入。
        const e1 = event('sess_bucket_A_00001', 'page_view');
        const first = await ingest(cart, [e1]);
        assert.equal(first.status, 202);
        assert.equal(first.body.data.accepted, 1);
        const replay = await ingest(cart, [e1]);
        assert.equal(replay.status, 202);
        assert.equal(replay.body.data.accepted, 0);
        assert.equal(replay.body.data.duplicates, 1);
        // 精确按 eventId 校验：只有 e1 这一条，重放没有二次写入。
        assert.equal(await db.analyticsEvent.count({ where: { eventId: e1.eventId } }), 1);
        // 会话应已关联 cartId（服务端读 cookie 解析）。
        const sessionA = await db.analyticsSession.findUnique({ where: { sessionId: 'sess_bucket_A_00001' } });
        assert.ok(sessionA);
        assert.equal(sessionA.cartId, cart.cart.id);
        // 4) 漏斗五步：先清空前面的探测事件，再造 20+ 会话让小样本保护不触发（每步 >= 20 才显示转化率）。
        await db.analyticsEvent.deleteMany({});
        await db.analyticsSession.deleteMany({});
        const sessions = Array.from({ length: 22 }, (_, i) => `sess_funnel_${String(i).padStart(12, '0')}`);
        // 每个会话用独立购物袋，这样 cartId 才能区分不同会话的 purchase 归因。
        for (const sid of sessions) {
            const userCart = await makeCart();
            const events = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout'].map(name => event(sid, name));
            const r = await ingest(userCart, events);
            assert.equal(r.status, 202, JSON.stringify(r.body));
        }
        // 给其中 10 个会话对应的 cart 造成功订单（purchase 由服务端归因，不采信浏览器事件）。
        for (let i = 0; i < 10; i += 1) {
            const sid = sessions[i];
            const s = await db.analyticsSession.findUnique({ where: { sessionId: sid } });
            assert.ok(s?.cartId);
            const quote = await db.checkoutQuote.create({ data: { cartId: s.cartId, status: 'consumed', version: 1,
                    locale: 'en', marketCode: 'HK', currency: 'HKD', contact: {}, shippingAddress: {}, shippingMethodId: rateId,
                    shippingMethodSnapshot: {}, subtotalMinor: 1000, discountMinor: 0, shippingMinor: 0, taxMinor: 0, totalMinor: 1000,
                    ruleVersions: {}, warnings: [], policyAcceptances: [], expiresAt: new Date(Date.now() + 900_000) } });
            await db.shopOrder.create({ data: { publicOrderNumber: `EZ-20261118-${randomBytes(3).toString('hex').toUpperCase().slice(0, 6)}`,
                    idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()), quoteId: quote.id, cartId: s.cartId,
                    orderStatus: 'confirmed', paymentStatus: 'collected', currency: 'HKD', subtotalMinor: 1000, discountMinor: 0,
                    shippingMinor: 0, taxMinor: 0, totalMinor: 1000, locale: 'en', marketCode: 'HK', contact: {},
                    shippingAddress: {}, shippingMethodSnapshot: {}, paymentMethodCode: 'cod', policyAcceptances: [],
                    placedAt: new Date() } });
        }
        // 浏览器 purchase 事件：契约层拒绝（422）。
        const purchaseAttempt = await ingest(cart, [event('sess_funnel_000000000000', 'purchase')]);
        assert.equal(purchaseAttempt.status, 422);
        // 5) 漏斗报表：权限 + 五步聚合 + purchase 权威。
        const nobody = await request('GET', `admin/reports/funnel?${query}`, undefined, { Origin: origin });
        assert.equal(nobody.status, 401);
        const viewer = await sessionFor(['reports.view']);
        const report = await viewer.call(`admin/reports/funnel?${query}`);
        assert.equal(report.status, 200, JSON.stringify(report.body));
        const result = report.body.data;
        assert.equal(result.reportKey, 'funnel');
        assert.match(result.metricDefinitionVersion, /^\d+\.\d+$/);
        const byStep = new Map(result.rows.map((r) => [r.dimensions.step, r.metrics.sessions]));
        assert.equal(byStep.get('访问'), 22, JSON.stringify(result.rows));
        assert.equal(byStep.get('商品浏览'), 22);
        assert.equal(byStep.get('加入购物车'), 22);
        assert.equal(byStep.get('开始结账'), 22);
        // purchase 只有 10（服务端订单归因），且不等于浏览器上报数。
        assert.equal(byStep.get('成功下单'), 10);
        // 大样本下转化率应展示，且是数字。
        const purchaseRow = result.rows.find((r) => r.dimensions.step === '成功下单');
        assert.equal(typeof purchaseRow.metrics.stepRate, 'number');
        assert.equal(purchaseRow.metrics.stepRate, Math.round((10 / 22) * 10000) / 100);
        // 6) 同意门控：denied 事件不进漏斗（会话同意态更新但事件不计）。
        const before = (await db.analyticsEvent.count());
        const denied = await ingest(cart, [event('sess_denied_00000001', 'page_view', { consentState: 'denied' })]);
        assert.equal(denied.status, 202);
        assert.equal(await db.analyticsEvent.count(), before + 1); // 落库可审计
        const after = await viewer.call(`admin/reports/funnel?${query}`);
        assert.equal(after.body.data.totals.sessions, result.totals.sessions); // 但不进指标
    }
    finally {
        if (app)
            await app.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
