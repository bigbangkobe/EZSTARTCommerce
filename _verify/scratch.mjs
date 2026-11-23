import { buildImportPlan, normalizeMapping, parseCsv, IMPORT_TARGETS } from './packages/domain/src/import.js';
const HEADER = [...IMPORT_TARGETS];
const row = (v) => IMPORT_TARGETS.map(t => v[t] ?? '');
const quote = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
const csv = (rows) => [HEADER.map(quote).join(','), ...rows.map(c => c.map(quote).join(','))].join('\r\n');
const base = { product_key:'AROMA-001', base_sku:'AROMA-001', category_path:'香薰', market_codes:'HK',
  name_zh_HK:'檜木香薰蠟燭', slug_zh_HK:'hinoki-aroma-candle', name_zh_CN:'桧木香薰蜡烛', slug_zh_CN:'hinoki-aroma-candle',
  name_en:'Hinoki Aroma Candle', slug_en:'hinoki-aroma-candle', variant_sku:'AROMA-001-100',
  option1_name:'容量', option1_value:'100ml', price_hkd:'168.00', compare_at_hkd:'220.00', currency:'HKD',
  stock_qty:'40', variant_status:'active', publish_now:'Y' };
const content = csv([
  row({ ...base }),
  row({ ...base, variant_sku:'AROMA-001-200', option1_value:'200ml', price_hkd:'288.00', compare_at_hkd:'', stock_qty:'25' }),
  row({ ...base, product_key:'CUP-014', base_sku:'CUP-014', name_zh_HK:'砥部燒茶杯', slug_zh_HK:'toBe-cup',
    name_zh_CN:'砥部烧茶杯', slug_zh_CN:'toBe-cup', name_en:'ToBe Ware TeaCup', slug_en:'toBe-cup',
    variant_sku:'CUP-014-STD', option1_name:'款式', option1_value:'標準', price_hkd:'128.00', compare_at_hkd:'', stock_qty:'12', publish_now:'N' }),
]);
console.log('bytes', content.length);
const parsed = parseCsv(content);
console.log('header cols', parsed.headers.length, 'data rows', parsed.rowCount, 'rowNumbers', parsed.rows.map(r => r.rowNumber));
const mapping = normalizeMapping(Object.fromEntries(HEADER.map(h => [h, h])), parsed.headers);
const plan = buildImportPlan({ csv: parsed, mapping,
  lookups: { existingBySku: new Map(), categoryByPath: new Map([['香薰','cat-1']]), brandByName: new Map(), knownMarkets: new Set(['HK']) },
  modes: { mode:'create_or_update_by_sku', locales:['zh-HK','zh-CN','en'], currency:'HKD' } });
console.log('counters', JSON.stringify(plan.counters));
console.log('rejects', plan.rows.filter(r => r.action === 'reject').map(r => ({ row: r.rowNumber, codes: r.errors.map(e => e.code) })));
