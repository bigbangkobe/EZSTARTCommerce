import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REPORT_KEYS, REPORT_METRIC_VERSION, REPORT_MIN_SAMPLE, REPORT_MAX_RANGE_DAYS,
  assertReportKey, assertReportFormat, assertTimezone, assertInstant, normalizeReportFilters,
  localDay, within, sumMinor, ratio, smallSampleRatio, averageMinor, RowAccumulator, csvCell, csvDocument, exportPreamble,
  ReportRuleError,
} from '../packages/domain/src/reports.js';

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-08T00:00:00.000Z';

test('reports: report keys and formats are closed sets', () => {
  assert.equal(REPORT_KEYS.length, 9);
  assert.equal(new Set(REPORT_KEYS).size, 9);
  assert.ok(REPORT_KEYS.includes('funnel'));
  for (const key of REPORT_KEYS) assert.equal(assertReportKey(key), key);
  assert.throws(() => assertReportKey('drop_all_tables'), ReportRuleError);
  assert.throws(() => assertReportKey('sales'), ReportRuleError);
  assert.throws(() => assertReportKey(42), ReportRuleError);
  assert.equal(assertReportFormat('csv'), 'csv');
  assert.throws(() => assertReportFormat('xlsx'), ReportRuleError);
  assert.match(REPORT_METRIC_VERSION, /^[0-9]+\.[0-9]+$/);
});

test('reports: timezone must be a real IANA zone and instants must carry offsets', () => {
  assert.equal(assertTimezone('Asia/Hong_Kong'), 'Asia/Hong_Kong');
  assert.equal(assertTimezone('UTC'), 'UTC');
  for (const bad of ['Not/AZone', '', 42, 'GMT+8']) assert.throws(() => assertTimezone(bad), ReportRuleError);
  const parsed = assertInstant('2026-11-01T08:00:00+08:00', 'from');
  assert.equal(parsed.toISOString(), '2026-11-01T00:00:00.000Z');
  for (const bad of ['2026-11-01', '2026-11-01T00:00:00', 'not-a-date']) assert.throws(() => assertInstant(bad, 'from'), ReportRuleError);
});

test('reports: filters are normalized with optional dimensions and range guards', () => {
  const { filters, from, to } = normalizeReportFilters({ from: FROM, to: TO, timezone: 'Asia/Hong_Kong' });
  assert.equal(filters.from, FROM);
  assert.equal(filters.to, TO);
  assert.equal(filters.timezone, 'Asia/Hong_Kong');
  assert.equal(filters.marketCode, null);
  assert.equal(filters.paymentMethodCode, null);
  assert.equal(filters.locale, null);
  assert.equal(filters.deviceClass, null);
  assert.equal(filters.source, null);
  assert.equal(filters.groupBy, null);
  assert.equal(from.toISOString(), FROM);
  assert.equal(to.toISOString(), TO);

  const withDims = normalizeReportFilters({ from: FROM, to: TO, timezone: 'UTC', marketCode: 'HK', paymentMethodCode: 'cod',
    locale: 'zh-HK', deviceClass: 'mobile', source: 'newsletter', groupBy: 'device' });
  assert.equal(withDims.filters.marketCode, 'HK');
  assert.equal(withDims.filters.paymentMethodCode, 'cod');
  assert.equal(withDims.filters.locale, 'zh-HK');
  assert.equal(withDims.filters.deviceClass, 'mobile');
  assert.equal(withDims.filters.source, 'newsletter');
  assert.equal(withDims.filters.groupBy, 'device');
  // 漏斗维度闭集：非法设备类/分组维度拒绝。
  assert.throws(() => normalizeReportFilters({ from: FROM, to: TO, timezone: 'UTC', deviceClass: 'smartwatch' }), ReportRuleError);
  assert.throws(() => normalizeReportFilters({ from: FROM, to: TO, timezone: 'UTC', groupBy: 'email' }), ReportRuleError);

  // 空串当作未筛选；非法代码格式拒绝；from >= to 与超长跨度拒绝。
  assert.equal(normalizeReportFilters({ from: FROM, to: TO, timezone: 'UTC', marketCode: '' }).filters.marketCode, null);
  assert.throws(() => normalizeReportFilters({ from: FROM, to: TO, timezone: 'UTC', marketCode: 'a@b.com' }), ReportRuleError);
  assert.throws(() => normalizeReportFilters({ from: TO, to: FROM, timezone: 'UTC' }), ReportRuleError);
  const tooLong = new Date(new Date(FROM).getTime() + (REPORT_MAX_RANGE_DAYS + 1) * 86_400_000).toISOString();
  assert.throws(() => normalizeReportFilters({ from: FROM, to: tooLong, timezone: 'UTC' }), ReportRuleError);
});

test('reports: local day grouping survives timezone offsets and half-open ranges', () => {
  // 同一 UTC 时刻在香港是 11-02，在纽约还是 11-01——日归属必须跟随店铺时区。
  const instant = new Date('2026-11-01T17:00:00.000Z');
  assert.equal(localDay('Asia/Hong_Kong', instant), '2026-11-02');
  assert.equal(localDay('America/New_York', instant), '2026-11-01');
  const from = new Date(FROM), to = new Date(TO);
  assert.equal(within(from, from, to), true, 'from 包含');
  assert.equal(within(new Date(new Date(TO).getTime() - 1), from, to), true, 'to 前一毫秒包含');
  assert.equal(within(to, from, to), false, 'to 不含');
  assert.equal(within(null, from, to), false);
});

test('reports: money arithmetic stays integer and ratios respect small-sample guard', () => {
  assert.equal(sumMinor([1_000, 2_350, -500]), 2_850);
  assert.throws(() => sumMinor([1.5]), ReportRuleError);
  assert.equal(averageMinor(5_000, 3), 1_666);
  assert.equal(averageMinor(5_000, 0), null);
  assert.equal(ratio(150, 200), 75, '经营聚合比率不受小样本约束');
  assert.equal(ratio(1, 4), 25);
  assert.equal(ratio(0, 0), null);
  // 小样本保护只用于可能被反推个体的陈列/漏斗场景。
  assert.equal(smallSampleRatio(1, 4, 4), null, '样本小于阈值不展示');
  assert.equal(smallSampleRatio(150, 200, 200), 75);
  assert.equal(smallSampleRatio(1, 4, REPORT_MIN_SAMPLE), 25);
});

test('reports: row accumulator merges dimensions in stable insertion order', () => {
  const acc = new RowAccumulator();
  acc.add({ status: 'completed', currency: 'HKD' }, { orderCount: 1, placedMinor: 1_000 });
  acc.add({ status: 'completed', currency: 'HKD' }, { orderCount: 2, placedMinor: 2_000 });
  acc.add({ status: 'cancelled', currency: 'HKD' }, { orderCount: 1, placedMinor: 500 });
  const rows = acc.list();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.dimensions, { status: 'completed', currency: 'HKD' });
  assert.equal(rows[0]!.metrics.orderCount, 3);
  assert.equal(rows[0]!.metrics.placedMinor, 3_000);
  assert.equal(rows[1]!.metrics.orderCount, 1);
});

test('reports: CSV escapes formula injection, quotes and newlines', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(1_000), '1000');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvCell('+CMD'), "'+CMD");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  const doc = csvDocument([['a', 'b'], ['x', 'y']]);
  assert.ok(doc.startsWith('\ufeff'));
  assert.ok(doc.includes('\r\n'));
  assert.ok(doc.endsWith('\r\n'));
});

test('reports: export preamble records filters, timezone, currency and definition version', () => {
  const { filters } = normalizeReportFilters({ from: FROM, to: TO, timezone: 'Asia/Hong_Kong', marketCode: 'HK' });
  const lines = exportPreamble(filters, 'sales_summary', ['HKD'], '2026-11-18T00:00:00.000Z', 'complete');
  const flat = lines.map(line => line.join('|')).join('\n');
  assert.match(flat, /sales_summary/);
  assert.match(flat, /Asia\/Hong_Kong/);
  assert.match(flat, /HKD/);
  assert.match(flat, new RegExp(REPORT_METRIC_VERSION));
  assert.match(flat, /marketCode/);
  assert.match(flat, /complete/);
});
