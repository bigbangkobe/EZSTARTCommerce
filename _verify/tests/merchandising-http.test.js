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
const LOCALES = ['zh-CN', 'zh-HK', 'en'];
const DAY = 86_400_000;
const title = { 'zh-CN': '本月精选', 'zh-HK': '本月精選', en: 'Featured' };
/**
 * 首页陈列（M04 第三批）：
 * 1. 草稿保存不影响线上；发布才切换快照，撤下摘掉快照但保留草稿；
 * 2. 手工区块含不合格商品时**拒绝发布**，并在后台 issues 里给出具体原因；
 * 3. 动态区块在读取时重新复验资格：下架/未发布/市场不可售的商品立刻消失，并由后续候选补足；
 * 4. 手工区块的商品发布后失效时前台隐藏、后台保留配置并提示替换（不静默保留陈旧商品）；
 * 5. 发布同时推进内容发布标记，区块埋点能按新版本分组。
 */
test('merchandising publishes snapshots and re-checks product eligibility on every read', { timeout: 900_000 }, async () => {
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
    const sessionFor = async (permissions) => {
        const role = await db.adminRole.create({ data: { name: `role-${randomUUID()}`, kind: 'custom', permissionCodes: permissions } });
        const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@merch.test`, displayName: 'Staff',
                passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        const tokenCsrf = csrf(token, config);
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        const call = (method, path, body, opts = {}) => request(method, path, body, { Cookie: `ez_admin_session=${token}`, Origin: origin,
            'X-CSRF-Token': opts.csrf === undefined ? tokenCsrf : opts.csrf }, opts.schema ?? 'SuccessEnvelope');
        return { call };
    };
    const publicGet = (path, schema) => request('GET', path, undefined, {}, schema);
    const product = async (status, marketCodes, publishedAt, slug) => db.product.create({ data: { status, marketCodes, publishedAt,
            translations: { create: [{ locale: 'zh-HK', name: `商品 ${slug}`, slug }] },
            variants: { create: [{ sku: `${slug}-sku`, optionValues: {}, priceMinor: 10_000, currency: 'HKD', status: 'active',
                        inventory: { create: { onHand: 5, reserved: 0 } } }] } } });
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Merch Store', locales: LOCALES,
                defaultLocale: 'zh-HK', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
        await db.marketProfile.createMany({ data: [
                { marketCode: 'HK', enabled: true, reviewStatus: 'approved', eligibleProductIds: [] },
                { marketCode: 'MO', enabled: false, reviewStatus: 'pending', eligibleProductIds: [] }
            ] });
        const owner = await sessionFor(contracts.ownerPermissions);
        const writer = await sessionFor(['content.read', 'content.write']);
        const live = await product('active', ['HK'], new Date(Date.now() - DAY), 'live');
        const newer = await product('active', ['HK'], new Date(Date.now() - 3_600_000), 'newer');
        const future = await product('active', ['HK'], new Date(Date.now() + DAY), 'future');
        const draft = await product('draft', ['HK'], null, 'draft');
        const otherMarket = await product('active', ['MO'], new Date(Date.now() - DAY), 'other-market');
        // 1. 没配置过时给一个可编辑的空草稿（版本 1），而不是 404。
        const initial = await owner.call('GET', 'admin/merchandising/home');
        assert.equal(initial.status, 200);
        assert.equal(initial.body.data.version, 1);
        assert.deepEqual(initial.body.data.sections, []);
        assert.equal(initial.body.data.published, null);
        assert.equal((await owner.call('GET', 'admin/merchandising/about')).status, 422);
        // 2. 手工清单里混入不合格商品：保存允许（草稿可以慢慢改），但发布必须拒绝。
        const manual = await owner.call('PATCH', 'admin/merchandising/home', { expectedVersion: 1, sections: [{
                    sectionId: 'featured', type: 'product_grid', visible: true, position: 0, titleByLocale: title,
                    sortMode: 'manual', limit: 3, productIds: [live.id, future.id, draft.id], categoryIds: []
                }] });
        assert.equal(manual.status, 200);
        assert.equal(manual.body.data.version, 2);
        const reasons = new Map(manual.body.data.issues.map((issue) => [issue.productId, issue.reason]));
        assert.equal(reasons.get(future.id), 'PRODUCT_NOT_PUBLISHED');
        assert.equal(reasons.get(draft.id), 'PRODUCT_NOT_ACTIVE');
        assert.equal(reasons.has(live.id), false);
        assert.equal((await owner.call('POST', 'admin/merchandising/home/publish', { expectedVersion: 2 })).status, 422);
        // 3. 版本冲突：别人已经改过就必须刷新，不能覆盖。
        assert.equal((await owner.call('PATCH', 'admin/merchandising/home', { expectedVersion: 1, sections: [] })).status, 409);
        // 4. 三语标题缺一不可：陈列不能静默回退到另一种语言。
        const missingLocale = await owner.call('PATCH', 'admin/merchandising/home', { expectedVersion: 2,
            sections: [{ sectionId: 'featured', type: 'product_grid', visible: true, position: 0,
                    titleByLocale: { en: 'Featured' }, sortMode: 'newest', limit: 2, productIds: [], categoryIds: [] }] });
        assert.equal(missingLocale.status, 200);
        assert.equal((await owner.call('POST', 'admin/merchandising/home/publish', { expectedVersion: 3 })).status, 422);
        // 5. 动态区块：只给标题与规则，发布成功，快照替换线上（此前没有线上版本）。
        const dynamic = await owner.call('PATCH', 'admin/merchandising/home', { expectedVersion: 3,
            sections: [{ sectionId: 'featured', type: 'product_grid', visible: true, position: 0, titleByLocale: title,
                    sortMode: 'newest', limit: 2, productIds: [], categoryIds: [] }] });
        assert.equal(dynamic.status, 200);
        const published = await owner.call('POST', 'admin/merchandising/home/publish', { expectedVersion: 4, note: 'initial layout' });
        assert.equal(published.status, 200);
        assert.equal(published.body.data.status, 'published');
        assert.match(published.body.data.releaseToken, /^cr-\d+$/);
        assert.equal(published.body.data.versions.length, 1);
        const front = await publicGet('storefront/merchandising/home?locale=en&marketCode=HK', 'PublicMerchandisingEnvelope');
        assert.equal(front.status, 200);
        assert.equal(front.body.data.sections[0].title, 'Featured');
        // newest：新的在前；未发布、草稿、市场不可售的商品一个都不能出现。
        assert.deepEqual(front.body.data.sections[0].products.map((item) => item.id), [newer.id, live.id]);
        // 6. 读取时复验：下架一个商品，前台立刻消失且由后续候选补足，不留下空位。
        const third = await product('active', ['HK'], new Date(Date.now() - 2 * DAY), 'third');
        await db.product.update({ where: { id: newer.id }, data: { status: 'archived' } });
        const afterArchive = await publicGet('storefront/merchandising/home?locale=en&marketCode=HK', 'PublicMerchandisingEnvelope');
        assert.deepEqual(afterArchive.body.data.sections[0].products.map((item) => item.id), [live.id, third.id]);
        // 7. 手工区块：发布后商品失效时前台隐藏、后台保留配置并标出原因。
        const manualLive = await owner.call('PATCH', 'admin/merchandising/home', { expectedVersion: 5, sections: [{
                    sectionId: 'picks', type: 'product_grid', visible: true, position: 0, titleByLocale: title,
                    sortMode: 'manual', limit: 1, productIds: [live.id], categoryIds: []
                }] });
        assert.equal(manualLive.status, 200);
        assert.equal((await owner.call('POST', 'admin/merchandising/home/publish', { expectedVersion: 6 })).status, 200);
        await db.product.update({ where: { id: live.id }, data: { status: 'draft' } });
        const manualFront = await publicGet('storefront/merchandising/home?locale=zh-HK&marketCode=HK', 'PublicMerchandisingEnvelope');
        assert.equal(manualFront.status, 200);
        assert.deepEqual(manualFront.body.data.sections[0].products, []);
        const adminView = await owner.call('GET', 'admin/merchandising/home');
        assert.deepEqual(adminView.body.data.issues.map((issue) => issue.productId), [live.id]);
        assert.deepEqual(adminView.body.data.sections[0].productIds, [live.id]);
        // 8. 只有内容写权限的账号不能发布（发布是独立能力）。
        assert.equal((await writer.call('POST', 'admin/merchandising/home/publish', { expectedVersion: 7 })).status, 403);
        // 9. 撤下：前台回到 404（主题默认布局），草稿与历史版本保留。
        const withdrawn = await owner.call('POST', 'admin/merchandising/home/unpublish', { expectedVersion: 7, reason: '季節性調整' });
        assert.equal(withdrawn.status, 200);
        assert.equal(withdrawn.body.data.status, 'draft');
        assert.equal(withdrawn.body.data.published, null);
        assert.equal(withdrawn.body.data.sections.length, 1);
        assert.equal((await publicGet('storefront/merchandising/home?locale=en&marketCode=HK')).status, 404);
        // 10. 选择器：不合格商品带原因返回，后台才能禁用选项而不是等保存报错。
        const picker = await owner.call('GET', 'admin/merchandising/products?limit=50');
        assert.equal(picker.status, 200);
        const pick = new Map(picker.body.data.items.map((item) => [item.id, item.reason ?? item.reasons]));
        assert.deepEqual(pick.get(draft.id), ['PRODUCT_NOT_ACTIVE']);
        assert.deepEqual(pick.get(otherMarket.id), ['PRODUCT_MARKET_INELIGIBLE']);
        assert.deepEqual(pick.get(third.id), []);
    }
    finally {
        await app?.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
