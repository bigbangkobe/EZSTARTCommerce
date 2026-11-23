import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertTransition, buildImportPlan, canTransition, IMPORT_TARGETS, ImportRuleError, normalizeMapping,
  parseCsv, parseMinorAmount, previewRows, type ImportLookups,
} from '../packages/domain/src/import.js';

const HEADER = [...IMPORT_TARGETS].join(',');

/** 与交付模板同构的一张表：列名就是目标列名，映射为恒等映射。 */
const identityMapping = () => new Map(IMPORT_TARGETS.map(target => [target, target] as const));

const lookups = (overrides: Partial<ImportLookups> = {}): ImportLookups => ({
  existingBySku: new Map(),
  categoryByPath: new Map([['家居器物/香薰', 'cat-aroma'], ['家居器物/器物', 'cat-cup']]),
  brandByName: new Map([['Norse', 'brand-1']]),
  knownMarkets: new Set(['HK']),
  ...overrides,
});

/** 32 列的一行；只填用得到的列，其余留空。 */
function row(values: Record<string, string>): string[] {
  return IMPORT_TARGETS.map(target => values[target] ?? '');
}

function csvOf(rows: string[][], headers: string[] = [...IMPORT_TARGETS]): string {
  const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [headers.map(quote).join(','), ...rows.map(cells => cells.map(quote).join(','))].join('\r\n');
}

const plan = (rows: string[][], options: { mode?: 'create_or_update_by_sku' | 'create_only' | 'update_only'; lookups?: ImportLookups } = {}) => {
  const csv = parseCsv(csvOf(rows));
  return buildImportPlan({
    csv, mapping: identityMapping(), lookups: options.lookups ?? lookups(),
    modes: { mode: options.mode ?? 'create_or_update_by_sku', locales: ['zh-HK', 'zh-CN', 'en'], currency: 'HKD' },
  });
};

const base = {
  product_key: 'AROMA-001', base_sku: 'AROMA-001', category_path: '家居器物/香薰', market_codes: 'HK',
  name_zh_HK: '檜木香薰蠟燭', slug_zh_HK: 'hinoki-aroma-candle',
  name_zh_CN: '桧木香薰蜡烛', slug_zh_CN: 'hinoki-aroma-candle',
  name_en: 'Hinoki Aroma Candle', slug_en: 'hinoki-aroma-candle',
  variant_sku: 'AROMA-001-100', price_hkd: '168.00', currency: 'HKD', variant_status: 'active',
};

test('csv parsing keeps quotes, escapes, BOM and CRLF intact', () => {
  const text = '\ufeffa,b,c\r\n1,"x,y",3\r\n4,"he said ""hi""",6\r\n';
  const parsed = parseCsv(text);
  assert.deepEqual(parsed.headers, ['a', 'b', 'c']);
  assert.equal(parsed.rowCount, 2);
  assert.deepEqual(parsed.rows[0]!.cells, ['1', 'x,y', '3']);
  assert.deepEqual(parsed.rows[1]!.cells, ['4', 'he said "hi"', '6']);
  // 行号从表头之后起算，报错时能直接对回 Excel 行。
  assert.deepEqual(parsed.rows.map(entry => entry.rowNumber), [2, 3]);
});

test('csv parsing rejects structural faults before any row is validated', () => {
  assert.throws(() => parseCsv(''), (error: unknown) => error instanceof ImportRuleError && error.code === 'CSV_HEADER_MISSING');
  assert.throws(() => parseCsv('a,a\n1,2\n'), (error: unknown) => error instanceof ImportRuleError && error.code === 'CSV_HEADER_DUPLICATE');
  assert.throws(() => parseCsv('a,b\n"1,2\n'), (error: unknown) => error instanceof ImportRuleError && error.code === 'CSV_UNTERMINATED_QUOTE');
});

test('column mapping must reference known headers and known targets exactly once', () => {
  assert.throws(() => normalizeMapping({ '商品名': 'name_zh_HK' }, ['商品名']), (error: unknown) => error instanceof ImportRuleError && error.code === 'MAPPING_REQUIRED_MISSING');
  assert.throws(() => normalizeMapping({ 'x': 'nope', product_key: 'product_key', variant_sku: 'variant_sku', price_hkd: 'price_hkd' }, ['x', 'product_key', 'variant_sku', 'price_hkd']),
    (error: unknown) => error instanceof ImportRuleError && error.code === 'MAPPING_TARGET_UNKNOWN');
  assert.throws(() => normalizeMapping({ 'x': 'product_key', y: 'product_key', variant_sku: 'variant_sku', price_hkd: 'price_hkd' }, ['x', 'y', 'variant_sku', 'price_hkd']),
    (error: unknown) => error instanceof ImportRuleError && error.code === 'MAPPING_TARGET_DUPLICATE');
  const mapping = normalizeMapping({ '商品名': 'name_en', 'p': 'product_key', 's': 'variant_sku', 'price': 'price_hkd' }, ['商品名', 'p', 's', 'price']);
  assert.equal(mapping.get('name_en'), '商品名');
});

test('amounts are parsed into integer minor units and nothing else', () => {
  assert.equal(parseMinorAmount('168.00', 'price'), 16_800);
  assert.equal(parseMinorAmount('288', 'price'), 28_800);
  assert.equal(parseMinorAmount('0.5', 'price'), 50);
  for (const bad of ['1.999', '1,680', '1e3', '-1', '', 'abc', '168.000']) {
    assert.throws(() => parseMinorAmount(bad, 'price'), (error: unknown) => error instanceof ImportRuleError, `应拒绝 ${bad}`);
  }
});

test('two rows of one product merge into one plan with two variants', () => {
  const result = plan([
    row({ ...base }),
    row({ ...base, variant_sku: 'AROMA-001-200', price_hkd: '288.00', compare_at_hkd: '320.00' }),
  ]);
  assert.deepEqual(result.counters, { totalRows: 2, validRows: 2, invalidRows: 0, newCount: 2, updateCount: 0, skipCount: 0 });
  assert.equal(result.products.length, 1);
  const product = result.products[0]!;
  assert.equal(product.action, 'create');
  assert.equal(product.variants.length, 2);
  assert.equal(product.variants[0]!.priceMinor, 16_800);
  assert.equal(product.variants[1]!.compareAtMinor, 32_000);
  assert.deepEqual(product.translations.map(item => item.locale), ['zh-HK', 'zh-CN', 'en']);
  assert.deepEqual(product.categoryIds, ['cat-aroma']);
  assert.deepEqual(product.marketCodes, ['HK']);
  assert.deepEqual(product.rowNumbers, [2, 3]);
});

test('images and stock produce warnings, not silent success', () => {
  const result = plan([row({ ...base, stock_qty: '40', image_urls: 'https://x.test/a.jpg' })]);
  assert.equal(result.counters.validRows, 1);
  assert.deepEqual(result.rows[0]!.warnings.sort(), ['IMAGE_URL_NOT_IMPORTED', 'STOCK_NOT_IMPORTED:40']);
});

test('a product missing an enabled locale is rejected on every one of its rows', () => {
  const result = plan([
    row({ ...base, name_en: '', slug_en: '' }),
    row({ ...base, name_en: '', slug_en: '', variant_sku: 'AROMA-001-200' }),
  ]);
  assert.equal(result.products.length, 0);
  assert.equal(result.counters.invalidRows, 2);
  const codes = result.rows.flatMap(entry => entry.errors.map(error => error.code));
  assert.ok(codes.includes('REQUIRED'));
  // 商品级错误要落在该商品的每一行上，否则操作员只改一行仍会失败。
  assert.ok(result.rows.every(entry => entry.action === 'reject'));
});

test('product-level fields come from the first non-empty row of the group', () => {
  const result = plan([
    row({ ...base, name_en: '', slug_en: '' }),
    row({ ...base, variant_sku: 'AROMA-001-200' }),
  ]);
  assert.equal(result.products.length, 1);
  const en = result.products[0]!.translations.find(entry => entry.locale === 'en');
  assert.equal(en?.name, 'Hinoki Aroma Candle');
  assert.equal(en?.slug, 'hinoki-aroma-candle');
});

test('slug validation matches the catalog rule, not a stricter one', () => {
  // 交付模板里的示例 slug 就是 `toBe-cup`（大小写混排）：导入不能把它判成非法。
  const mixed = plan([row({ ...base, slug_zh_HK: 'toBe-cup', product_key: 'CUP-014', variant_sku: 'CUP-014-STD' })]);
  assert.equal(mixed.counters.invalidRows, 0);
  assert.equal(mixed.products[0]!.translations[0]!.slug, 'toBe-cup');

  // 目录规则允许中文 slug（前台按百分号编码访问）：导入同样放行。
  const chinese = plan([row({ ...base, slug_zh_HK: '香薰蠟燭', product_key: 'X-1', variant_sku: 'X-1' })]);
  assert.equal(chinese.counters.invalidRows, 0);

  for (const bad of ['has space', 'path/segment', '-leading', 'trailing_']) {
    const rejected = plan([row({ ...base, slug_zh_HK: bad })]);
    assert.equal(rejected.counters.invalidRows, 1, `应拒绝 ${bad}`);
    assert.ok(rejected.rows[0]!.errors.some(error => error.code === 'INVALID_SLUG'), `${bad} 应报 INVALID_SLUG`);
  }
});

test('sku shape, currency and unknown references are rejected with row-level codes', () => {
  const bad = plan([row({ ...base, variant_sku: '含中文SKU' })]);
  assert.equal(bad.counters.invalidRows, 1);
  assert.ok(bad.rows[0]!.errors.some(error => error.code === 'INVALID_FORMAT'));

  const currency = plan([row({ ...base, currency: 'USD' })]);
  assert.ok(currency.rows[0]!.errors.some(error => error.code === 'CURRENCY_MISMATCH'));

  const unknown = plan([row({ ...base, category_path: '不存在/分类', brand: '无此品牌', market_codes: 'HK,TW' })]);
  const codes = unknown.rows[0]!.errors.map(error => error.code);
  assert.deepEqual(codes.sort(), ['BRAND_UNKNOWN', 'CATEGORY_UNKNOWN', 'MARKET_UNKNOWN']);
});

test('duplicate sku inside one file is rejected instead of silently overwriting', () => {
  const result = plan([row({ ...base }), row({ ...base, product_key: 'AROMA-002' })]);
  assert.equal(result.counters.invalidRows, 1);
  assert.ok(result.rows.some(entry => entry.errors.some(error => error.code === 'DUPLICATE_SKU')));
});

test('mode decides create, update and skip against existing skus', () => {
  const existing = new Map([['AROMA-001-100', { productId: 'product-1' }]]);
  const update = plan([row({ ...base })], { lookups: lookups({ existingBySku: existing }) });
  assert.equal(update.products[0]!.action, 'update');
  assert.equal(update.products[0]!.existingProductId, 'product-1');

  const createOnly = plan([row({ ...base })], { mode: 'create_only', lookups: lookups({ existingBySku: existing }) });
  assert.equal(createOnly.products.length, 0);
  assert.equal(createOnly.counters.skipCount, 1);

  const updateOnly = plan([row({ ...base })], { mode: 'update_only' });
  assert.equal(updateOnly.products.length, 0);
  assert.equal(updateOnly.counters.skipCount, 1);
});

test('preview rows are capped and carry the contract fields', () => {
  const result = plan([row({ ...base })]);
  const preview = previewRows(result);
  assert.equal(preview.length, 1);
  assert.deepEqual(Object.keys(preview[0]!).sort(), ['action', 'errors', 'rowNumber', 'sku', 'warnings']);
  assert.equal(preview[0]!.rowNumber, 2);
  assert.equal(preview[0]!.action, 'create');
});

test('state machine only moves forward and allows cancelling early states', () => {
  assert.equal(canTransition('uploaded', 'validating'), true);
  assert.equal(canTransition('ready', 'processing'), true);
  assert.equal(canTransition('processing', 'completed_with_errors'), true);
  assert.equal(canTransition('completed', 'processing'), false);
  assert.equal(canTransition('cancelled', 'ready'), false);
  assert.throws(() => assertTransition('completed', 'processing'), (error: unknown) => error instanceof ImportRuleError && error.code === 'IMPORT_STATE_CONFLICT');
});

test('mapping decouples client headers from canonical target columns', () => {
  const headers = ['商品名', '别名', '分组', 'SKU', '价格', '市场'];
  const cells = ['檜木香薰蠟燭', 'hinoki-aroma-candle', 'AROMA-001', 'AROMA-001-100', '168.00', 'HK'];
  const csv = parseCsv(`${headers.join(',')}\n${cells.join(',')}\n`);
  const mapping = normalizeMapping({
    '商品名': 'name_zh_HK', '别名': 'slug_zh_HK', '分组': 'product_key',
    'SKU': 'variant_sku', '价格': 'price_hkd', '市场': 'market_codes',
  }, headers);
  const result = buildImportPlan({ csv, mapping, lookups: lookups(), modes: { mode: 'create_or_update_by_sku', locales: ['zh-HK'], currency: 'HKD' } });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]!.translations[0]!.name, '檜木香薰蠟燭');
  assert.equal(result.products[0]!.translations[0]!.slug, 'hinoki-aroma-candle');
  assert.equal(result.products[0]!.variants[0]!.priceMinor, 16_800);
});
