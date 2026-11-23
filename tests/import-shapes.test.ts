import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import {
  buildImportPlan, normalizeMapping, parseCsv, previewRows, IMPORT_TARGETS,
} from '../packages/domain/src/import.js';

/**
 * 导入响应体的契约形状（不需要数据库）。
 *
 * HTTP 集成用例在本机跑不起来（沙箱不能启动 embedded postgres），而"响应字段与
 * OpenAPI schema 不匹配"是最容易在联调时才炸的一类错误。这里直接拿真域的 previewRows()
 * 输出对 `ImportPreviewEnvelope` 做 AJV 校验，把字段名、必填项、null 与长度约束钉住。
 */
const contracts = new IdentityContracts();
const HEADER = [...IMPORT_TARGETS];

const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const row = (values: Record<string, string>) => IMPORT_TARGETS.map(target => values[target] ?? '');
const csvOf = (rows: string[][]) => [HEADER.map(quote).join(','), ...rows.map(cells => cells.map(quote).join(','))].join('\n');

const base = {
  product_key: 'AROMA-001', market_codes: 'HK', brand: 'Norse',
  name_zh_HK: '檜木香薰蠟燭', slug_zh_HK: 'hinoki-aroma-candle',
  name_zh_CN: '桧木香薰蜡烛', slug_zh_CN: 'hinoki-aroma-candle',
  name_en: 'Hinoki Aroma Candle', slug_en: 'hinoki-aroma-candle',
  variant_sku: 'AROMA-001-100', price_hkd: '168.00', currency: 'HKD', stock_qty: '40',
};

const plan = (rows: string[][]) => {
  const csv = parseCsv(csvOf(rows));
  const mapping = normalizeMapping(Object.fromEntries(HEADER.map(header => [header, header])), csv.headers);
  return buildImportPlan({ csv, mapping,
    lookups: { existingBySku: new Map(), categoryByPath: new Map([['香薰', 'cat-1']]),
      brandByName: new Map([['Norse', 'brand-1']]), knownMarkets: new Set(['HK']) },
    modes: { mode: 'create_or_update_by_sku', locales: ['zh-HK', 'zh-CN', 'en'], currency: 'HKD' } });
};

const preview = (rows: string[][]) => {
  const result = plan(rows);
  return { data: {
    jobId: '3f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    fileSha256: 'a'.repeat(64),
    mappingVersion: 1,
    totalRows: result.counters.totalRows,
    validRows: result.counters.validRows,
    invalidRows: result.counters.invalidRows,
    newCount: result.counters.newCount,
    updateCount: result.counters.updateCount,
    skipCount: result.counters.skipCount,
    previewRows: previewRows(result),
  }, meta: { requestId: 'req-1' } };
};

test('a clean preview matches ImportPreviewEnvelope exactly', () => {
  const envelope = preview([row(base), row({ ...base, variant_sku: 'AROMA-001-200', price_hkd: '288.00' })]);
  assert.doesNotThrow(() => contracts.assert('ImportPreviewEnvelope', envelope));
  assert.equal(envelope.data.previewRows.length, 2);
  assert.equal(envelope.data.previewRows[0]!.action, 'create');
  // 契约里 errors/warnings 都是必填数组：干净行也必须给空数组，不能省略字段。
  assert.deepEqual(envelope.data.previewRows[0]!.errors, []);
  assert.ok(Array.isArray(envelope.data.previewRows[0]!.warnings));
});

test('rejected rows carry contract-shaped FieldError objects', () => {
  const envelope = preview([row({ ...base, name_en: '', slug_en: '', category_path: '不存在的分类', brand: '无此品牌', market_codes: 'TW' })]);
  assert.doesNotThrow(() => contracts.assert('ImportPreviewEnvelope', envelope));
  const rejected = envelope.data.previewRows[0]!;
  assert.equal(rejected.action, 'reject');
  assert.ok(rejected.errors.length >= 3);
  for (const error of rejected.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'field', 'locale', 'message']);
    assert.equal(typeof error.code, 'string');
  }
  assert.equal(envelope.data.invalidRows, 1);
  assert.equal(envelope.data.validRows, 0);
});

test('warnings stay inside the contract length limit', () => {
  // 500 字符是契约给 warnings 的上限；这里用一条正常警告确认没有额外字段。
  const envelope = preview([row({ ...base, image_urls: 'https://x.test/a.jpg', stock_qty: '7' })]);
  assert.doesNotThrow(() => contracts.assert('ImportPreviewEnvelope', envelope));
  const warnings = envelope.data.previewRows[0]!.warnings;
  assert.ok(warnings.every(warning => warning.length <= 500));
});

test('the preview payload refuses extra fields the contract forbids', () => {
  const envelope: Record<string, unknown> = preview([row(base)]);
  const data = envelope['data'] as Record<string, unknown>;
  data['leakedInternalField'] = 'x';
  assert.throws(() => contracts.assert('ImportPreviewEnvelope', envelope));
});
