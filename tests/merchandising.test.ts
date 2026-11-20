import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertMerchandisingPublishable, categoryMerchandisingKey, collectionMerchandisingKey, MerchandisingRuleError, merchandisingSnapshot,
  parseMerchandisingPageKey,
  normalizeMerchandisingSections, rankCandidates, sectionTitle, visibleLimit, type MerchandisingSection,
} from '../packages/domain/src/merchandising.js';

const LOCALES = ['zh-CN', 'zh-HK', 'en'];
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

const section = (overrides: Record<string, unknown> = {}) => ({
  sectionId: 'featured', type: 'product_grid', visible: true, position: 0,
  titleByLocale: { 'zh-HK': '本月精選', 'zh-CN': '本月精选', en: 'Featured' },
  sortMode: 'manual', limit: 2, productIds: [UUID_A, UUID_B], categoryIds: [], ...overrides,
});

const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    if (error instanceof MerchandisingRuleError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

/**
 * 陈列规则（M04 第三批）：版面只接受闭集类型与已实现排序；
 * 手工顺序与动态规则互斥；发布要求三语标题齐全；排序同值必须稳定。
 */
test('merchandising sections stay inside the registered registry', () => {
  const sections = normalizeMerchandisingSections([section(), section({ sectionId: 'new-arrivals', sortMode: 'newest',
    productIds: [], position: 99, categoryIds: [UUID_C] })], LOCALES);
  // position 由数组顺序决定：后台传什么都不能让两个区块争同一位置。
  assert.deepEqual(sections.map(item => item.position), [0, 1]);
  assert.equal(sections[1]?.sortMode, 'newest');
  assert.deepEqual(sections[1]?.categoryIds, [UUID_C]);
  // 未注册类型、未实现排序必须被拒绝，而不是存下来后前台静默失效。
  assert.equal(code(() => normalizeMerchandisingSections([section({ type: 'custom_html' })], LOCALES)), 'MERCHANDISING_SECTION_UNSUPPORTED');
  assert.equal(code(() => normalizeMerchandisingSections([section({ sortMode: 'random' })], LOCALES)), 'MERCHANDISING_SORT_UNSUPPORTED');
  // 专题筛选只对动态排序有意义：手工区块自己就是清单，加专题筛选属于配置冲突。
  assert.equal(code(() => normalizeMerchandisingSections([section({ collectionId: UUID_C })], LOCALES)), 'MERCHANDISING_MODE_CONFLICT');
  assert.equal(code(() => normalizeMerchandisingSections([section({ sortMode: 'newest', productIds: [], collectionId: 'summer' })], LOCALES)),
    'VALIDATION_ERROR');
  assert.equal(code(() => normalizeMerchandisingSections([section(), section()], LOCALES)), 'MERCHANDISING_SECTION_DUPLICATE');
  assert.equal(code(() => normalizeMerchandisingSections([section({ script: 'alert(1)' })], LOCALES)), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeMerchandisingSections([section({ limit: 0 })], LOCALES)), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeMerchandisingSections([section({ limit: 25 })], LOCALES)), 'VALIDATION_ERROR');
});

test('manual and dynamic modes cannot be mixed and manual order must be complete', () => {
  // 手工：必须给清单，且清单不能少于展示位（否则区块永远填不满）。
  assert.equal(code(() => normalizeMerchandisingSections([section({ productIds: [] })], LOCALES)), 'VALIDATION_ERROR');
  assert.equal(code(() => normalizeMerchandisingSections([section({ limit: 3 })], LOCALES)), 'MERCHANDISING_LIMIT_UNREACHABLE');
  // 手工 + 分类筛选没有意义，直接拒绝而不是悄悄忽略。
  assert.equal(code(() => normalizeMerchandisingSections([section({ categoryIds: [UUID_C] })], LOCALES)), 'MERCHANDISING_MODE_CONFLICT');
  // 动态：残留手工清单会让人以为顺序生效，必须拒绝。
  assert.equal(code(() => normalizeMerchandisingSections([section({ sortMode: 'price_asc' })], LOCALES)), 'MERCHANDISING_MODE_CONFLICT');
  assert.equal(code(() => normalizeMerchandisingSections([section({ productIds: [UUID_A, UUID_A] })], LOCALES)),
    'MERCHANDISING_PRODUCT_DUPLICATE');
  const dynamic = normalizeMerchandisingSections([section({ sortMode: 'price_asc', productIds: [] })], LOCALES);
  assert.deepEqual(dynamic[0]?.productIds, []);
});

test('publishing requires every enabled locale and at least one visible section', () => {
  const complete = normalizeMerchandisingSections([section()], LOCALES);
  assert.doesNotThrow(() => assertMerchandisingPublishable(complete, LOCALES));
  const missing = normalizeMerchandisingSections([section({ titleByLocale: { 'zh-HK': '本月精選' } })], LOCALES);
  assert.equal(code(() => assertMerchandisingPublishable(missing, LOCALES)), 'MERCHANDISING_LOCALE_INCOMPLETE');
  const hidden = normalizeMerchandisingSections([section({ visible: false })], LOCALES);
  assert.equal(code(() => assertMerchandisingPublishable(hidden, LOCALES)), 'MERCHANDISING_NO_VISIBLE_SECTION');
  // 标题里有 HTML 标签 = 注入入口，后台不是任意代码编辑器。
  assert.equal(code(() => normalizeMerchandisingSections([section({ titleByLocale: { 'zh-HK': '<b>精選</b>' } })], LOCALES)),
    'VALIDATION_ERROR');
});

test('dynamic ranking is bounded and stable for equal values', () => {
  const price = (productId: string, priceMinor: number | null) => ({ productId, publishedAt: new Date('2026-01-01'), priceMinor, unitsSold: 0 });
  const asc = rankCandidates([price(UUID_A, 200), price(UUID_B, null), price(UUID_C, 100)], 'price_asc');
  assert.deepEqual(asc.map(item => item.productId), [UUID_C, UUID_A, UUID_B]);
  // 价格倒序时「没有可售变体」仍然排最后，不能因为没有价格反而顶到第一位。
  const desc = rankCandidates([price(UUID_A, 200), price(UUID_B, null), price(UUID_C, 200)], 'price_desc');
  assert.deepEqual(desc.map(item => item.productId), [UUID_A, UUID_C, UUID_B]);

  const sales = [
    { productId: UUID_B, publishedAt: new Date('2026-02-01'), priceMinor: 100, unitsSold: 5 },
    { productId: UUID_A, publishedAt: new Date('2026-01-01'), priceMinor: 100, unitsSold: 5 },
    { productId: UUID_C, publishedAt: new Date('2026-03-01'), priceMinor: 100, unitsSold: 9 },
  ];
  const ranked = rankCandidates(sales, 'fulfilled_sales_30d');
  // 销量同值时先比发布时间（新者优先），再比商品 id：顺序不会因请求次数变化。
  assert.deepEqual(ranked.map(item => item.productId), [UUID_C, UUID_B, UUID_A]);
  assert.deepEqual(rankCandidates(sales, 'fulfilled_sales_30d').map(item => item.productId),
    rankCandidates([...sales].reverse(), 'fulfilled_sales_30d').map(item => item.productId));

  const fresh = rankCandidates([
    { productId: UUID_A, publishedAt: new Date('2026-01-01'), priceMinor: 100, unitsSold: 0 },
    { productId: UUID_B, publishedAt: new Date('2026-06-01'), priceMinor: 100, unitsSold: 0 },
  ], 'newest');
  assert.equal(fresh[0]?.productId, UUID_B);
});

test('snapshots are immutable copies and reads re-clamp the display limit', () => {
  const sections = normalizeMerchandisingSections([section()], LOCALES) as MerchandisingSection[];
  const snapshot = merchandisingSnapshot('home', 4, sections, new Date('2026-11-19T00:00:00Z'));
  sections[0]!.productIds.push(UUID_C);
  // 发布后再改草稿对象不能影响快照：线上陈列只能通过新版本切换。
  assert.deepEqual(snapshot.sections[0]?.productIds, [UUID_A, UUID_B]);
  assert.equal(snapshot.version, 4);
  assert.equal(visibleLimit({ ...sections[0]!, limit: 999 }), 24);
  assert.equal(sectionTitle(sections[0]!, 'en', 'zh-HK'), 'Featured');
  assert.equal(sectionTitle(sections[0]!, 'ja', 'zh-HK'), '本月精選');
});

test('page keys are a closed set', () => {
  // 版面作用域：首页固定；分类按 id 绑定（改 slug 不会让已发布版面失联）。
  assert.deepEqual(parseMerchandisingPageKey('home'), { kind: 'home', targetId: null, pageKey: 'home' });
  const categoryId = '6f1c2b24-6f2a-4c1e-9a3e-2f7f7b6d1c11';
  assert.deepEqual(parseMerchandisingPageKey(`category:${categoryId}`),
    { kind: 'category', targetId: categoryId, pageKey: `category:${categoryId}` });
  assert.equal(categoryMerchandisingKey(categoryId.toUpperCase()), `category:${categoryId}`);
  // 分类与专题都用 id 绑定；专题已上线，只有真正未开放的作用域才报 PAGE_UNKNOWN。
  const collectionId = '9b2d3c44-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
  assert.deepEqual(parseMerchandisingPageKey(`collection:${collectionId}`),
    { kind: 'collection', targetId: collectionId, pageKey: `collection:${collectionId}` });
  assert.equal(collectionMerchandisingKey(collectionId.toUpperCase()), `collection:${collectionId}`);
  assert.equal(code(() => parseMerchandisingPageKey('collection:summer')), 'VALIDATION_ERROR');
  assert.equal(code(() => parseMerchandisingPageKey('product:abc')), 'MERCHANDISING_PAGE_UNKNOWN');
  assert.equal(code(() => parseMerchandisingPageKey('category:cigars')), 'VALIDATION_ERROR');
  assert.equal(code(() => parseMerchandisingPageKey('category:')), 'VALIDATION_ERROR');
  assert.equal(code(() => parseMerchandisingPageKey('')), 'VALIDATION_ERROR');
});
