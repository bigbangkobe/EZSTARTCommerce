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
 * 专题（M04 第五批）：
 * 1. 专题是跨分类的策展位：商品顺序由运营编排，前台平铺时按这个顺序；
 * 2. 改 slug 自动为旧地址登记 301，停用/删除时把指向它的跳转一起摘掉；
 * 3. 专题版面按 id 绑定，页面级范围把候选锁在本专题内，跨专题筛选保存即拒；
 * 4. 停用的专题前台 404，列表也不再出现——重新启用不需要重排商品。
 */
test('collections are curated product sets with slug redirects and scoped layouts', { timeout: 900_000 }, async () => {
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
        const user = await db.adminUser.create({ data: { email: `user-${randomUUID()}@collection.test`, displayName: 'Staff',
                passwordHash: 'x', status: 'active', locale: 'en', mfaRequired: false } });
        await db.adminUserRole.create({ data: { userId: user.id, roleId: role.id } });
        const token = randomBytes(32).toString('base64url');
        const tokenCsrf = csrf(token, config);
        await db.adminSession.create({ data: { userId: user.id, tokenDigest: digest(token), mfaVerified: true,
                lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 3_600_000),
                absoluteExpiresAt: new Date(Date.now() + 3_600_000) } });
        return (method, path, body, opts = {}) => request(method, path, body, { Cookie: `ez_admin_session=${token}`, Origin: origin, 'X-CSRF-Token': tokenCsrf,
            ...(opts.version !== undefined ? { 'If-Match': `"${opts.version}"` } : {}) }, opts.schema ?? (method === 'DELETE' ? undefined : 'SuccessEnvelope'));
    };
    const publicGet = (path, schema) => request('GET', path, undefined, {}, schema);
    const product = async (slug, publishedAt = new Date(Date.now() - DAY), status = 'active') => db.product.create({ data: { status, marketCodes: ['HK'], publishedAt,
            translations: { create: [{ locale: 'zh-HK', name: `商品 ${slug}`, slug }, { locale: 'en', name: `Item ${slug}`, slug: `${slug}-en` }] },
            variants: { create: [{ sku: `${slug}-sku`, optionValues: {}, priceMinor: 10_000, currency: 'HKD', status: 'active',
                        inventory: { create: { onHand: 5, reserved: 0 } } }] } } });
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Collection Store', locales: LOCALES,
                defaultLocale: 'zh-HK', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
        await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved', eligibleProductIds: [] } });
        const owner = await sessionFor(contracts.ownerPermissions);
        const [first, second, third] = [await product('first'), await product('second'), await product('third')];
        // 1. 新建专题：三语名称 + 首语 slug + 商品顺序（故意与创建时间相反，验证顺序来自编排）。
        const created = await owner('POST', 'admin/collections', { position: 1, enabled: true,
            translations: [
                { locale: 'zh-HK', name: '秋日選物', slug: 'autumn-picks', description: '店主精選' },
                { locale: 'zh-CN', name: '秋日选物', slug: 'autumn-picks-cn' },
                { locale: 'en', name: 'Autumn picks', slug: 'autumn-picks-en' },
            ], productIds: [second.id, first.id] }, { schema: 'CollectionEnvelope' });
        assert.equal(created.status, 201);
        const collection = created.body.data;
        assert.equal(collection.version, 1);
        assert.deepEqual(collection.productIds, [second.id, first.id]);
        assert.equal(collection.productCount, 2);
        // 2. slug 冲突：同一语言下不能有两个专题占同一个地址。
        const clash = await owner('POST', 'admin/collections', { translations: [{ locale: 'zh-HK', name: '重複', slug: 'autumn-picks' }] });
        assert.equal(clash.status, 409);
        assert.equal(clash.body.error.code, 'SLUG_TAKEN');
        // 3. 前台列表与详情：没有版面时按编排顺序平铺，且带各语言地址。
        const listed = await publicGet('storefront/collections?locale=zh-HK&marketCode=HK', 'PublicCollectionListEnvelope');
        assert.equal(listed.status, 200);
        const summary = listed.body.data.items.find((item) => item.id === collection.id);
        assert.equal(summary.slug, 'autumn-picks');
        assert.equal(summary.productCount, 2);
        assert.deepEqual(summary.alternates.map((item) => item.locale).sort(), ['en', 'zh-CN', 'zh-HK']);
        const detail = await publicGet('storefront/collections/autumn-picks?locale=zh-HK&marketCode=HK', 'PublicCollectionEnvelope');
        assert.equal(detail.status, 200);
        assert.equal(detail.body.data.collection.name, '秋日選物');
        assert.equal(detail.body.data.layout, null);
        assert.deepEqual(detail.body.data.products.map((item) => item.id), [second.id, first.id]);
        assert.match(detail.body.data.contentRelease, /^cr-\d+$/);
        // 4. 改 slug：旧地址必须登记 301（专题地址会出现在分享链接与印刷物料里）。
        const renamed = await owner('PATCH', `admin/collections/${collection.id}`, { translations: [
                { locale: 'zh-HK', name: '秋日選物', slug: 'autumn-edit', description: '店主精選' },
                { locale: 'zh-CN', name: '秋日选物', slug: 'autumn-picks-cn' },
                { locale: 'en', name: 'Autumn picks', slug: 'autumn-picks-en' },
            ] }, { version: collection.version, schema: 'CollectionEnvelope' });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.body.data.version, collection.version + 1);
        const redirect = await publicGet('storefront/redirect?path=%2Fzh-HK%2Fcollections%2Fautumn-picks');
        assert.equal(redirect.status, 200);
        assert.equal(redirect.body.data.redirect.toPath, '/zh-HK/collections/autumn-edit');
        assert.equal(redirect.body.data.redirect.statusCode, 301);
        // 5. 版本冲突：拿旧版本号改配置要被拒绝（避免覆盖别人的改动）。
        const stale = await owner('PATCH', `admin/collections/${collection.id}`, { position: 2 }, { version: collection.version });
        assert.equal(stale.status, 409);
        // 6. 页面选择器与商品选择器都要能看到专题，并且选择器按专题收窄。
        const pages = await owner('GET', 'admin/merchandising/pages');
        const entry = pages.body.data.items.find((item) => item.pageKey === `collection:${collection.id}`);
        assert.equal(entry.kind, 'collection');
        assert.equal(entry.name, '秋日選物');
        assert.equal(entry.status, 'none');
        const picker = await owner('GET', `admin/merchandising/products?limit=50&collectionId=${collection.id}`);
        assert.deepEqual(picker.body.data.items.map((item) => item.id).sort(), [first.id, second.id].sort());
        // 7. 专题版面：手工位选了专题外商品 → 保存即拒。
        const key = `collection:${collection.id}`;
        const outOfScope = await owner('PATCH', `admin/merchandising/${key}`, { expectedVersion: 1, sections: [{
                    sectionId: 'picks', type: 'product_grid', visible: true, position: 0, titleByLocale: title,
                    sortMode: 'manual', limit: 1, productIds: [third.id], categoryIds: []
                }] });
        assert.equal(outOfScope.status, 422);
        assert.equal(outOfScope.body.error.code, 'MERCHANDISING_PRODUCT_OUT_OF_SCOPE');
        // 8. 在专题 A 的版面里筛专题 B：交集必然为空，保存时就拒绝。
        const other = await owner('POST', 'admin/collections', { translations: [
                { locale: 'zh-HK', name: '冬季選物', slug: 'winter-picks' }
            ], productIds: [third.id] }, { schema: 'CollectionEnvelope' });
        const wrongScope = await owner('PATCH', `admin/merchandising/${key}`, { expectedVersion: 1, sections: [{
                    sectionId: 'picks', type: 'product_grid', visible: true, position: 0, titleByLocale: title,
                    sortMode: 'newest', limit: 3, productIds: [], categoryIds: [], collectionId: other.body.data.id
                }] });
        assert.equal(wrongScope.status, 422);
        assert.equal(wrongScope.body.error.code, 'MERCHANDISING_COLLECTION_OUT_OF_SCOPE');
        // 9. 动态区块不写专题筛选：候选仍被页面级范围收窄（third 属于另一个专题）。
        const saved = await owner('PATCH', `admin/merchandising/${key}`, { expectedVersion: 1, sections: [{
                    sectionId: 'featured', type: 'product_grid', visible: true, position: 0, titleByLocale: title,
                    sortMode: 'newest', limit: 4, productIds: [], categoryIds: []
                }] });
        assert.equal(saved.status, 200);
        const published = await owner('POST', `admin/merchandising/${key}/publish`, { expectedVersion: saved.body.data.version });
        assert.equal(published.status, 200);
        const scoped = await publicGet('storefront/collections/autumn-edit?locale=zh-HK&marketCode=HK', 'PublicCollectionEnvelope');
        assert.equal(scoped.body.data.layout.sections.length, 1);
        assert.deepEqual(scoped.body.data.layout.sections[0].products.map((item) => item.id).sort(), [first.id, second.id].sort());
        assert.deepEqual(scoped.body.data.products, []);
        // 10. 停用专题：前台 404、列表不再出现，指向它的 301 一起清掉（不能把访客送进 404）。
        const disabled = await owner('PATCH', `admin/collections/${collection.id}`, { enabled: false }, { version: renamed.body.data.version, schema: 'CollectionEnvelope' });
        assert.equal(disabled.status, 200);
        assert.equal((await publicGet('storefront/collections/autumn-edit?locale=zh-HK&marketCode=HK')).status, 404);
        const afterDisable = await publicGet('storefront/collections?locale=zh-HK&marketCode=HK', 'PublicCollectionListEnvelope');
        assert.equal(afterDisable.body.data.items.some((item) => item.id === collection.id), false);
        const dropped = await publicGet('storefront/redirect?path=%2Fzh-HK%2Fcollections%2Fautumn-picks');
        assert.equal(dropped.body.data.redirect, null);
        // 11. 只读账号可以看专题，但没有写权限（专题沿用内容域权限）。
        const reader = await sessionFor(['content.read']);
        assert.equal((await reader('GET', 'admin/collections')).status, 200);
        assert.equal((await reader('POST', 'admin/collections', { translations: [{ locale: 'zh-HK', name: '新專題' }] })).status, 403);
        // 12. 删除专题：204，之后 404；商品本身不受影响。
        assert.equal((await owner('DELETE', `admin/collections/${other.body.data.id}`)).status, 204);
        assert.equal((await owner('GET', `admin/collections/${other.body.data.id}`)).status, 404);
        assert.equal((await db.product.findUnique({ where: { id: third.id } }))?.id, third.id);
    }
    finally {
        await app?.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
