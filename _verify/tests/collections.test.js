import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionListable, collectionPath, CollectionRuleError, normalizeCollectionProducts, normalizeCollectionSlug, normalizeCollectionTranslations, } from '../packages/domain/src/collections.js';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const code = (fn) => {
    try {
        fn();
    }
    catch (error) {
        if (error instanceof CollectionRuleError)
            return error.code;
        throw error;
    }
    return 'NO_ERROR';
};
const translations = () => [
    { locale: 'zh-HK', name: '秋日選物', slug: 'autumn-picks', description: '店主精選' },
    { locale: 'zh-CN', name: '秋日选物', slug: 'autumn-picks-cn' },
    { locale: 'en', name: 'Autumn picks', slug: 'autumn-picks-en' },
];
/**
 * 专题规则（M04 第五批）：
 * 1. slug 是前台地址，只接受小写短横线形式；
 * 2. 草稿允许先不写 slug，但写了就必须合法；
 * 3. 商品清单顺序即展示顺序，重复直接拒绝而不是静默去重；
 * 4. 前台只列出「启用 + 有 slug + 有商品」的专题。
 */
test('collection slugs are url-safe and drafts may postpone them', () => {
    assert.equal(normalizeCollectionSlug(' autumn-picks '), 'autumn-picks');
    assert.equal(normalizeCollectionSlug('xmas2026'), 'xmas2026');
    for (const invalid of ['Autumn-Picks', 'autumn picks', 'autumn/picks', '-autumn', 'autumn-', 'a'.repeat(181)]) {
        assert.equal(code(() => normalizeCollectionSlug(invalid)), 'VALIDATION_ERROR', invalid);
    }
    // 草稿可以先只写名称：专题还没定 slug 时也能先建起来。
    const draft = normalizeCollectionTranslations([{ locale: 'zh-HK', name: '秋日選物' }]);
    assert.deepEqual(draft, [{ locale: 'zh-HK', name: '秋日選物', slug: null, description: null }]);
    // 但如果明确要求 slug（例如契约层要求），空值就是错误。
    assert.equal(code(() => normalizeCollectionTranslations([{ locale: 'zh-HK', name: '秋日選物' }], true)), 'VALIDATION_ERROR');
});
test('collection translations reject duplicates, unknown locales and markup', () => {
    const rows = normalizeCollectionTranslations(translations());
    assert.deepEqual(rows.map(row => row.locale), ['zh-HK', 'zh-CN', 'en']);
    assert.equal(rows[1]?.description, null);
    assert.equal(code(() => normalizeCollectionTranslations([...translations(), translations()[0]])), 'COLLECTION_LOCALE_DUPLICATE');
    assert.equal(code(() => normalizeCollectionTranslations([{ locale: 'ja', name: '秋' }])), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeCollectionTranslations([{ locale: 'en', name: '   ' }])), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeCollectionTranslations([])), 'VALIDATION_ERROR');
    // 控制字符会破坏前台排版与日志：保存时就拒绝，而不是等渲染出错。
    assert.equal(code(() => normalizeCollectionTranslations([{ locale: 'en', name: 'Autumn\u0001' }])), 'VALIDATION_ERROR');
});
test('collection products keep the curator order and reject duplicates', () => {
    assert.deepEqual(normalizeCollectionProducts([UUID_B, UUID_A]), [UUID_B, UUID_A]);
    assert.deepEqual(normalizeCollectionProducts(undefined), []);
    assert.deepEqual(normalizeCollectionProducts([UUID_A.toUpperCase()]), [UUID_A]);
    assert.equal(code(() => normalizeCollectionProducts([UUID_A, UUID_A])), 'COLLECTION_PRODUCT_DUPLICATE');
    assert.equal(code(() => normalizeCollectionProducts(['not-a-uuid'])), 'VALIDATION_ERROR');
    assert.equal(code(() => normalizeCollectionProducts('nope')), 'VALIDATION_ERROR');
});
test('collection paths match the storefront routes', () => {
    assert.equal(collectionPath('zh-HK', 'autumn-picks'), '/zh-HK/collections/autumn-picks');
    assert.equal(collectionPath('en', 'autumn-picks-en'), '/en/collections/autumn-picks-en');
    // slug 必须是前台路由能接收的形状，否则 301 目标自己就是 404。
    assert.equal(code(() => collectionPath('zh-HK', 'Autumn Picks')), 'VALIDATION_ERROR');
    assert.equal(code(() => collectionPath('zh-hk', 'autumn-picks')), 'VALIDATION_ERROR');
});
test('only listable collections reach the storefront index', () => {
    assert.equal(collectionListable({ enabled: true, slug: 'autumn-picks', productCount: 3 }), true);
    assert.equal(collectionListable({ enabled: false, slug: 'autumn-picks', productCount: 3 }), false);
    assert.equal(collectionListable({ enabled: true, slug: null, productCount: 3 }), false);
    // 空专题不进列表：点进去只有一个空页面，顾客会以为店铺坏了。
    assert.equal(collectionListable({ enabled: true, slug: 'autumn-picks', productCount: 0 }), false);
});
