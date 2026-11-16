import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { StorefrontService } from '../apps/api/src/storefront/service.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';

const DAY = 86_400_000;

/**
 * 前台只读目录的过滤规则全部在查询里表达，因此直接对真实数据库断言：
 * 草稿、未来发布、非可售市场、市场可售清单之外的商品都不能出现在结果里。
 */
test('storefront reads only published, market-eligible data', { timeout: 120_000 }, async () => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  try {
    await db.storeConfig.create({ data: { id: 1, displayName: 'EZSTART', locales: ['zh-CN', 'zh-HK', 'en'],
      defaultLocale: 'zh-CN', baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong',
      featureFlags: { guestCheckout: true, onlinePayment: false } } });
    await db.marketProfile.createMany({ data: [
      { marketCode: 'HK', enabled: true, reviewStatus: 'approved', eligibleProductIds: [] },
      { marketCode: 'MO', enabled: true, reviewStatus: 'pending', eligibleProductIds: [] },
      { marketCode: 'TW', enabled: true, reviewStatus: 'approved', reviewValidUntil: new Date(Date.now() + 30 * DAY), eligibleProductIds: [] },
    ] });

    const enabledCategory = await db.category.create({ data: { position: 0, translations: { create: [
      { locale: 'zh-CN', name: '雪茄', slug: 'cigars' }, { locale: 'en', name: 'Cigars', slug: 'cigars-en' }] } } });
    await db.category.create({ data: { position: 1, enabled: false, translations: { create: [{ locale: 'en', name: 'Hidden', slug: 'hidden' }] } } });

    const media = await db.mediaAsset.create({ data: { objectKey: 'media/2026/11/' + randomUUID() + '.png', contentType: 'image/png',
      sizeBytes: 10, sha256: 'a'.repeat(64), width: 10, height: 10, originalFileName: 'a.png', status: 'ready' } });
    const secondMedia = await db.mediaAsset.create({ data: { objectKey: 'media/2026/11/' + randomUUID() + '.png', contentType: 'image/png',
      sizeBytes: 10, sha256: 'b'.repeat(64), width: 10, height: 10, originalFileName: 'b.png', status: 'ready' } });

    const product = (id: string, status: string, marketCodes: string[], publishedAt: Date | null,
      translations: { locale: string; name: string; slug: string }[]) => ({
      id, status, marketCodes, publishedAt, translations: { create: translations },
    });
    const live = randomUUID();
    await db.product.create({ data: { ...product(live, 'active', ['HK', 'TW'], new Date(Date.now() - DAY), [
      { locale: 'zh-CN', name: '雪茄一號', slug: 'cigar-1' }, { locale: 'zh-HK', name: '雪茄一號', slug: 'cigar-1-hk' },
      { locale: 'en', name: 'Cigar No.1', slug: 'cigar-1-en' }]),
      variants: { create: [{ sku: 'SKU-1', optionValues: { size: '50ml' }, priceMinor: 12_800, compareAtMinor: 15_000,
        currency: 'HKD', status: 'active', inventory: { create: { onHand: 5, reserved: 2 } } }] },
      media: { create: [{ mediaId: media.id, position: 1, altByLocale: { en: 'Front' } }, { mediaId: secondMedia.id, position: 0 }] },
      categories: { create: [{ categoryId: enabledCategory.id }] },
    } });
    const draft = randomUUID();
    await db.product.create({ data: product(draft, 'draft', ['HK'], null, [{ locale: 'en', name: 'Draft', slug: 'draft-only' }]) });
    const scheduled = randomUUID();
    await db.product.create({ data: product(scheduled, 'active', ['HK'], new Date(Date.now() + DAY),
      [{ locale: 'en', name: 'Later', slug: 'later-only' }]) });
    const otherMarket = randomUUID();
    await db.product.create({ data: product(otherMarket, 'active', ['MO'], new Date(Date.now() - DAY),
      [{ locale: 'en', name: 'Macau only', slug: 'macau-only' }]) });
    const notEligible = randomUUID();
    await db.product.create({ data: product(notEligible, 'active', ['TW'], new Date(Date.now() - DAY),
      [{ locale: 'en', name: 'Unlisted', slug: 'unlisted' }]) });
    const soldOut = randomUUID();
    await db.product.create({ data: { ...product(soldOut, 'active', ['HK'], new Date(Date.now() - DAY),
      [{ locale: 'en', name: 'Gone', slug: 'gone' }]),
      variants: { create: [{ sku: 'SKU-OUT', optionValues: { size: '10ml' }, priceMinor: 100, currency: 'HKD',
        status: 'active', inventory: { create: { onHand: 1, reserved: 1 } } }] } } });
    // 市场可售清单为空表示“该市场不限制”；显式列清单时只放行清单内商品。
    await db.marketProfile.update({ where: { marketCode: 'TW' },
      data: { eligibleProductIds: [live] } });

    const identity = new IdentityService(db, { instanceId: randomUUID(), allowedOrigin: 'https://shop.example.test',
      encryptionKey: randomBytes(32) }, []);
    const storefront = new StorefrontService(identity);

    const config = await storefront.config(null, null);
    assert.deepEqual({ market: config.market, locale: config.locale, currency: config.currency },
      { market: { marketCode: 'HK' }, locale: 'zh-CN', currency: 'HKD' });
    assert.equal(config.features['guestCheckout'], true);
    assert.equal(config.features['onlinePayment'], false);
    // 未审核的市场没有可售数据：前台看不到市场信息，而不是回退到别的市场。
    assert.equal((await storefront.config('en', 'MO')).market, null);
    await assert.rejects(storefront.config('fr', null), (error: Error & { status?: number }) => error.status === 422);
    await assert.rejects(storefront.config(null, 'ZZ'), (error: Error & { status?: number }) => error.status === 422);

    const list = await storefront.listProducts(null, null, 25, null, null);
    assert.deepEqual(list.items.map(item => item.id).sort(), [live, soldOut].sort());
    const item = list.items.find(entry => entry.id === live)!;
    assert.equal(item.slug, 'cigar-1');
    assert.equal(item.name, '雪茄一號');
    assert.equal(item.inStock, true);
    assert.equal(item.displayStockState, 'available');
    assert.equal(item.variants[0]!.available, 3);
    assert.equal(item.variants[0]!.compareAtMinor, 15_000);
    // 图片按 position 升序，且只暴露媒体引用，不暴露对象 key。
    assert.deepEqual(item.media.map(entry => entry.position), [0, 1]);
    assert.ok(!JSON.stringify(item).includes('media/2026'));

    const english = (await storefront.listProducts('en', 'HK', 25, null, null)).items.find(entry => entry.id === live)!;
    assert.deepEqual([english.slug, english.name], ['cigar-1-en', 'Cigar No.1']);

    assert.deepEqual((await storefront.listProducts('zh-CN', 'TW', 25, null, null)).items.map(entry => entry.id), [live],
      '审核通过的市场只返回清单内商品');
    assert.deepEqual((await storefront.listProducts('zh-CN', 'MO', 25, null, null)).items, [], '未审核市场不返回商品');
    assert.deepEqual((await storefront.listProducts('en', 'HK', 25, null, 'no-such-product')).items, []);
    assert.deepEqual((await storefront.listProducts('en', 'HK', 25, null, 'Cigar')).items.map(entry => entry.id), [live]);

    const firstPage = await storefront.listProducts('en', 'HK', 1, null, null);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.items.length, 1);
    const nextPage = await storefront.listProducts('en', 'HK', 1, firstPage.nextCursor, null);
    assert.deepEqual(nextPage.items.map(entry => entry.id), [live, soldOut].filter(id => id !== firstPage.items[0]!.id));

    // 用英文 slug 请求中文前台时按当前语言回退，而不是返回 404。
    const detail = await storefront.getProduct('cigar-1-en', 'zh-CN', null);
    assert.deepEqual([detail.id, detail.name], [live, '雪茄一號']);
    for (const slug of ['draft-only', 'later-only', 'unlisted']) {
      await assert.rejects(storefront.getProduct(slug, 'en', 'HK'), (error: Error & { status?: number }) => error.status === 404, slug);
    }
    await assert.rejects(storefront.getProduct('macau-only', 'en', 'MO'), (error: Error & { status?: number }) => error.status === 404);

    const categories = await storefront.listCategories('en');
    assert.deepEqual(categories.items.map(entry => [entry.slug, entry.name]), [['cigars-en', 'Cigars']]);

    const out = (await storefront.listProducts('en', 'HK', 25, null, 'Gone')).items[0]!;
    assert.deepEqual([out.inStock, out.displayStockState, out.variants[0]!.available], [false, 'sold_out', 0]);

    // 读取本身不写库：前台接口是只读的。
    const before = await db.auditLog.count();
    await storefront.listProducts('en', 'HK', 25, null, null);
    assert.equal(await db.auditLog.count(), before);

    // 路由层同样要验证：没有会话、没有 Origin 头也应能读到公开数据。
    const app = await createApp(identity);
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const products = await fetch(`${base}/api/v1/storefront/products?locale=en&marketCode=HK`);
      assert.equal(products.status, 200);
      const body = await products.json() as { data: { items: { id: string }[] } };
      assert.deepEqual(body.data.items.map(entry => entry.id).sort(), [live, soldOut].sort());
      assert.equal((await fetch(`${base}/api/v1/storefront/config`)).status, 200);
      assert.equal((await fetch(`${base}/api/v1/storefront/categories?locale=en`)).status, 200);
      assert.equal((await fetch(`${base}/api/v1/storefront/products/cigar-1-en`)).status, 200);
      assert.equal((await fetch(`${base}/api/v1/storefront/products/draft-only`)).status, 404);
      assert.equal((await fetch(`${base}/api/v1/storefront/products?locale=fr`)).status, 422);
    } finally { await app.close(); }
  } finally {
    await db.$disconnect();
    await cluster.stop();
  }
});
