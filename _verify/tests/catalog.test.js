import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCategoryParent, assertMarketSelection, assertPublishable, categoryPath, normalizeMedia, normalizeProductTranslations, normalizeSlug, normalizeVariants, publicationState, CatalogRuleError } from '../packages/domain/src/catalog.js';
const now = new Date('2026-11-16T00:00:00.000Z');
test('product translations require a URL-safe slug and unique locales', () => {
    const translations = normalizeProductTranslations([
        { locale: 'zh-CN', name: '  雪茄一號  ', slug: ' cigar-no-1 ', shortDescription: null },
        { locale: 'en', name: 'Cigar No.1', slug: 'cigar-no-1' },
    ]);
    assert.deepEqual(translations.map(item => [item.locale, item.name, item.slug]), [['zh-CN', '雪茄一號', 'cigar-no-1'], ['en', 'Cigar No.1', 'cigar-no-1']]);
    assert.equal(translations[0].description, null);
    assert.throws(() => normalizeProductTranslations([]), CatalogRuleError);
    assert.throws(() => normalizeProductTranslations([{ locale: 'zh-CN', name: 'A', slug: 'a' }, { locale: 'zh-CN', name: 'B', slug: 'b' }]), CatalogRuleError);
    assert.throws(() => normalizeProductTranslations([{ locale: 'fr', name: 'A', slug: 'a' }]), CatalogRuleError);
    assert.throws(() => normalizeProductTranslations([{ locale: 'en', name: ' ', slug: 'a' }]), CatalogRuleError);
    assert.throws(() => normalizeSlug('has space'), CatalogRuleError);
    assert.throws(() => normalizeSlug('-leading'), CatalogRuleError);
    assert.throws(() => normalizeSlug('a/b'), CatalogRuleError);
    assert.equal(normalizeSlug('ok-slug_1'), 'ok-slug_1');
});
test('variants enforce SKU shape, integer minor units and the single store currency', () => {
    const variants = normalizeVariants([
        { sku: 'SKU-1', optionValues: { size: '50ml' }, priceMinor: 12_800, compareAtMinor: null, currency: 'HKD' },
    ], 'HKD');
    assert.equal(variants[0].priceMinor, 12_800);
    assert.equal(variants[0].status, 'active');
    const base = { sku: 'SKU-2', optionValues: { size: '50ml' }, priceMinor: 100, currency: 'HKD' };
    assert.throws(() => normalizeVariants([{ ...base, currency: 'USD' }], 'HKD'), CatalogRuleError, '单币种店铺不允许其他币种');
    assert.throws(() => normalizeVariants([{ ...base, priceMinor: 1.5 }], 'HKD'), CatalogRuleError);
    assert.throws(() => normalizeVariants([{ ...base, priceMinor: -1 }], 'HKD'), CatalogRuleError);
    assert.throws(() => normalizeVariants([{ ...base, sku: '-bad' }], 'HKD'), CatalogRuleError);
    assert.throws(() => normalizeVariants([base, { ...base, priceMinor: 200 }], 'HKD'), CatalogRuleError, '同一次提交内 SKU 必须唯一');
    assert.throws(() => normalizeVariants([{ ...base, optionValues: {} }], 'HKD'), CatalogRuleError);
    assert.throws(() => normalizeVariants([], 'HKD'), CatalogRuleError);
});
test('publishing requires every enabled locale and at least one active variant', () => {
    const translations = ['zh-CN', 'zh-HK', 'en'].map(locale => ({ locale, name: `Name ${locale}`, slug: `slug-${locale}` }));
    const variants = [{ status: 'active' }];
    assert.doesNotThrow(() => assertPublishable({ translations, variants, enabledLocales: ['zh-CN', 'zh-HK', 'en'] }));
    assert.throws(() => assertPublishable({ translations: translations.slice(0, 2), variants, enabledLocales: ['zh-CN', 'zh-HK', 'en'] }), CatalogRuleError);
    assert.throws(() => assertPublishable({ translations, variants: [{ status: 'inactive' }], enabledLocales: ['en'] }), CatalogRuleError);
    // 只要求“已启用语言”，不必为未启用语言维护翻译。
    assert.doesNotThrow(() => assertPublishable({ translations: translations.slice(0, 1), variants, enabledLocales: ['zh-CN'] }));
});
test('publication state keeps scheduled products unsellable until their instant', () => {
    assert.equal(publicationState(new Date(now.getTime() + 60_000), now), 'scheduled');
    assert.equal(publicationState(new Date(now.getTime() - 60_000), now), 'active');
    assert.equal(publicationState(null, now), 'active');
});
test('market selection rejects unreviewed, disabled and non-eligible markets at publish time', () => {
    const markets = [
        { marketCode: 'HK', enabled: true, reviewStatus: 'approved', eligibleProductIds: [] },
        { marketCode: 'MO', enabled: false, reviewStatus: 'pending', eligibleProductIds: [] },
        { marketCode: 'TW', enabled: true, reviewStatus: 'approved', eligibleProductIds: ['other-product'] },
    ];
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    assert.doesNotThrow(() => assertMarketSelection(['HK'], markets, id));
    assert.throws(() => assertMarketSelection(['MO'], markets, id), CatalogRuleError);
    assert.throws(() => assertMarketSelection(['TW'], markets, id), CatalogRuleError, '不在市场可售清单内');
    assert.throws(() => assertMarketSelection(['HK', 'HK'], markets, id), CatalogRuleError);
    assert.throws(() => assertMarketSelection([], markets, id), CatalogRuleError);
});
test('category parents cannot form a cycle and unknown parents are rejected', () => {
    const rows = [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }];
    assert.doesNotThrow(() => assertCategoryParent(rows, 'a', null));
    assert.throws(() => assertCategoryParent(rows, 'a', 'c'), CatalogRuleError);
    assert.throws(() => assertCategoryParent(rows, 'b', 'b'), CatalogRuleError);
    assert.throws(() => assertCategoryParent(rows, null, 'missing'), CatalogRuleError);
});
test('media entries are position scoped and cannot repeat the same asset', () => {
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    assert.deepEqual(normalizeMedia([{ mediaId: id, position: 0, altByLocale: { en: 'Front' } }]), [{ mediaId: id, position: 0, altByLocale: { en: 'Front' } }]);
    assert.throws(() => normalizeMedia([{ mediaId: id, position: 0 }, { mediaId: id, position: 1 }]), CatalogRuleError);
    assert.throws(() => normalizeMedia([{ mediaId: 'nope', position: 0 }]), CatalogRuleError);
    assert.throws(() => normalizeMedia([{ mediaId: id, position: -1 }]), CatalogRuleError);
});
test('category paths are only built from slugs that can be expressed as a site path', () => {
    assert.equal(categoryPath('zh-HK', 'cigars'), '/zh-HK/categories/cigars');
    assert.equal(categoryPath('en', 'new-arrivals-2026'), '/en/categories/new-arrivals-2026');
    // 重定向表只接受站内 ASCII 路径：中文 slug 也能在前台访问，但登记成跳转永远不会命中，
    // 所以这里必须拒绝，让调用方选择「跳过登记」而不是写一条静默失效的记录。
    assert.throws(() => categoryPath('zh-HK', '雪茄'), CatalogRuleError);
    assert.throws(() => categoryPath('zh-HK', 'has space'), CatalogRuleError);
    assert.throws(() => categoryPath('zh-HK', 'cigars/extra'), CatalogRuleError);
    assert.throws(() => categoryPath('zh-hk', 'cigars'), CatalogRuleError);
    assert.throws(() => categoryPath('', 'cigars'), CatalogRuleError);
});
