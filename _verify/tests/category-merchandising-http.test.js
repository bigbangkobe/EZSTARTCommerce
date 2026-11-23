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
 * 分类页陈列（M04 第四批）：
 * 1. 版面按分类 id 绑定：改 slug 不会让已发布版面失联，未知/格式错误的 key 分别报错；
 * 2. 分类版面的候选池被限制在该分类内——动态区块即使不选分类，也不能把别的分类商品端上来；
 * 3. 手工位只能选本分类商品（保存即拒），不是等前台静默隐藏；
 * 4. 没发布版面时分类页返回平铺商品，页面不会因为运营还没排版而空白；
 * 5. 发布后商品被移出分类/下架，前台立刻隐藏并由后续候选补足。
 */
test('category merchandising is bound by id and scoped to the category catalogue', { timeout: 900_000 }, async () => {
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
        return (method, path, body, opts = {}) => request(method, path, body, { Cookie: `ez_admin_session=${token}`, Origin: origin, 'X-CSRF-Token': tokenCsrf }, opts.schema ?? 'SuccessEnvelope');
    };
    const publicGet = (path, schema) => request('GET', path, undefined, {}, schema);
    const product = async (slug, publishedAt = new Date(Date.now() - DAY), status = 'active') => db.product.create({ data: { status, marketCodes: ['HK'], publishedAt,
            translations: { create: [{ locale: 'zh-HK', name: `商品 ${slug}`, slug }, { locale: 'en', name: `Item ${slug}`, slug: `${slug}-en` }] },
            variants: { create: [{ sku: `${slug}-sku`, optionValues: {}, priceMinor: 10_000, currency: 'HKD', status: 'active',
                        inventory: { create: { onHand: 5, reserved: 0 } } }] } } });
    const category = async (slug, name, enabled = true) => db.category.create({ data: { enabled, position: 0,
            translations: { create: [{ locale: 'zh-HK', name, slug }, { locale: 'en', name: `${name} EN`, slug: `${slug}-en` }] } } });
    const link = (productId, categoryId) => db.productCategory.create({ data: { productId, categoryId } });
    try {
        await identity.initialize();
        app = await createApp(identity);
        await app.listen(0, '127.0.0.1');
        base = await app.getUrl();
        await db.storeConfig.create({ data: { id: 1, displayName: 'Category Store', locales: LOCALES,
                defaultLocale: 'zh-HK', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: {} } });
        await db.marketProfile.create({ data: { marketCode: 'HK', enabled: true, reviewStatus: 'approved', eligibleProductIds: [] } });
        const owner = await sessionFor(contracts.ownerPermissions);
        const writer = await sessionFor(['content.read', 'content.write']);
        const cigars = await category('cigars', '雪茄');
        const teas = await category('teas', '茶葉');
        const hidden = await category('hidden', '暫停分類', false);
        const cigarA = await product('cigar-a');
        const cigarB = await product('cigar-b', new Date(Date.now() - 2 * DAY));
        const cigarSoon = await product('cigar-soon', new Date(Date.now() + DAY));
        const teaOnly = await product('tea-only');
        await link(cigarA.id, cigars.id);
        await link(cigarB.id, cigars.id);
        await link(cigarSoon.id, cigars.id);
        await link(teaOnly.id, teas.id);
        // 1. 页面选择器：首页永远在列，分类只列启用中的，未配置时状态是 none。
        const listing = await owner('GET', 'admin/merchandising/pages');
        assert.equal(listing.status, 200);
        const entries = new Map(listing.body.data.items.map((item) => [item.pageKey, item]));
        assert.equal(entries.size, 3);
        assert.equal(entries.get('home').status, 'none');
        assert.equal(entries.get(`category:${cigars.id}`).name, '雪茄');
        assert.equal(entries.get(`category:${cigars.id}`).status, 'none');
        assert.equal(entries.has(`category:${hidden.id}`), false);
        // 2. key 的三种失败要能区分：格式错 422、kind 未开放 422、分类不存在 404。
        assert.equal((await owner('GET', 'admin/merchandising/category:not-a-uuid')).status, 422);
        assert.equal((await owner('GET', 'admin/merchandising/collection:summer')).status, 422);
        assert.equal((await owner('GET', `admin/merchandising/category:${randomUUID()}`)).status, 404);
        // 3. 分类版面初始为空草稿，kind 正确。
        const key = `category:${cigars.id}`;
        const initial = await owner('GET', `admin/merchandising/${key}`);
        assert.equal(initial.status, 200);
        assert.equal(initial.body.data.kind, 'category');
        assert.equal(initial.body.data.targetId, cigars.id);
        assert.equal(initial.body.data.version, 1);
        // 4. 手工位选了别的分类商品：保存就拒（不能等发布才报错，更不能前台静默隐藏）。
        const outOfScope = await owner('PATCH', `admin/merchandising/${key}`, { expectedVersion: 1, sections: [{
                    sectionId: 'picks', type: 'product_grid', visible: true, position: 0, titleByLocale: title,
                    sortMode: 'manual', limit: 1, productIds: [teaOnly.id], categoryIds: []
                }] });
        assert.equal(outOfScope.status, 422);
        assert.equal(outOfScope.body.error.code, 'MERCHANDISING_PRODUCT_OUT_OF_SCOPE');
        // 5. 商品选择器带 categoryId 时只列本分类商品（已下架/未到发布时间的仍然在列表里，带原因）。
        const picker = await owner('GET', `admin/merchandising/products?limit=50&categoryId=${cigars.id}`);
        assert.equal(picker.status, 200);
        const pickIds = picker.body.data.items.map((item) => item.id).sort();
        assert.deepEqual(pickIds, [cigarA.id, cigarB.id, cigarSoon.id].sort());
        // 6. 动态区块不选分类：候选仍被页面级分类收窄（不能把茶葉端上雪茄页）。
        const saved = await owner('PATCH', `admin/merchandising/${key}`, { expectedVersion: 1, sections: [{
                    sectionId: 'featured', type: 'product_grid', visible: true, position: 0, titleByLocale: title,
                    sortMode: 'newest', limit: 3, productIds: [], categoryIds: []
                }] });
        assert.equal(saved.status, 200);
        const published = await owner('POST', `admin/merchandising/${key}/publish`, { expectedVersion: saved.body.data.version });
        assert.equal(published.status, 200);
        assert.match(published.body.data.releaseToken, /^cr-\d+$/);
        assert.equal(published.body.data.published.version, saved.body.data.version + 1);
        const front = await publicGet('storefront/categories/cigars?locale=zh-HK&marketCode=HK', 'PublicCategoryEnvelope');
        assert.equal(front.status, 200);
        assert.equal(front.body.data.category.slug, 'cigars');
        assert.equal(front.body.data.category.name, '雪茄');
        assert.equal(front.body.data.layout.sections.length, 1);
        // 只有已发布且在分类内的两件（cigar-soon 未到发布时间，tea-only 不在分类里）。
        assert.deepEqual(front.body.data.layout.sections[0].products.map((item) => item.id), [cigarA.id, cigarB.id]);
        assert.deepEqual(front.body.data.products, []);
        assert.match(front.body.data.contentRelease, /^cr-\d+$/);
        assert.deepEqual(front.body.data.alternates.map((item) => item.locale).sort(), ['en', 'zh-HK']);
        // 7. 分类页英文地址解析到同一实体（slug 按语言各自唯一）。
        const english = await publicGet('storefront/categories/cigars-en?locale=en&marketCode=HK', 'PublicCategoryEnvelope');
        assert.equal(english.status, 200);
        assert.equal(english.body.data.category.name, '雪茄 EN');
        // 8. 停用分类、未知 slug 都不对外提供。
        assert.equal((await publicGet('storefront/categories/hidden?locale=zh-HK&marketCode=HK')).status, 404);
        assert.equal((await publicGet('storefront/categories/nope?locale=zh-HK&marketCode=HK')).status, 404);
        // 9. 发布后商品被移出分类：立刻从前台消失，由分类内后续候选补足。
        await db.productCategory.delete({ where: { productId_categoryId: { productId: cigarA.id, categoryId: cigars.id } } });
        const afterMove = await publicGet('storefront/categories/cigars?locale=zh-HK&marketCode=HK', 'PublicCategoryEnvelope');
        assert.deepEqual(afterMove.body.data.layout.sections[0].products.map((item) => item.id), [cigarB.id]);
        // 10. 撤下分类版面：分类页退回平铺商品（不是 404，也不是空白页）。
        const withdrawn = await owner('POST', `admin/merchandising/${key}/unpublish`, { expectedVersion: published.body.data.version, reason: '重新排版' });
        assert.equal(withdrawn.status, 200);
        const fallback = await publicGet('storefront/categories/cigars?locale=zh-HK&marketCode=HK', 'PublicCategoryEnvelope');
        assert.equal(fallback.status, 200);
        assert.equal(fallback.body.data.layout, null);
        assert.deepEqual(fallback.body.data.products.map((item) => item.id), [cigarB.id]);
        // 11. 发布是独立权限：只有内容写权限的账号不能把分类版面推上线。
        assert.equal((await writer('POST', `admin/merchandising/${key}/publish`, { expectedVersion: withdrawn.body.data.version })).status, 403);
        // 12. 首页版面不受影响：分类版面不会顺带把首页打开。
        assert.equal((await publicGet('storefront/merchandising/home?locale=zh-HK&marketCode=HK')).status, 404);
    }
    finally {
        await app?.close();
        await db.$disconnect();
        await cluster.stop();
    }
});
