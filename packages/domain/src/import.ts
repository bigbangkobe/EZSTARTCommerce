/**
 * 商品批量导入（M05）领域规则。
 *
 * 这一层只做「文本 → 可执行计划」的纯计算：CSV 解析、列映射、逐行校验、分组与动作判定。
 * 不碰数据库、不写文件、不发请求，因此可以脱离 PostgreSQL 单测——
 * 导入出错的地方绝大多数在数据形状上，这里必须能一条条钉住。
 *
 * 关键约定：
 * 1. 目标列名（IMPORT_TARGETS）与客户交付模板 `docs/01-产品文档/templates/products-import-template.csv`
 *    的 32 列表头一一对应；列名不同就靠 columnMapping 映射，不另外造第二套字段名。
 * 2. 一个 product_key 可以有多行（多规格），它们合并成一个商品；任一行不合格，整个商品拒绝，
 *    不允许「半个商品」落库。
 * 3. 本批不写库存、不下载图片：带了 stock_qty / image_urls 只给警告，不做假动作。
 *    库存要经 inventory.adjust、图片要经媒体三步上传，各有自己的权限与流水。
 */

import { normalizeSlug } from './catalog.js';

/** 与交付模板表头一致的闭集。`columnMapping` 的「值」只能取这些键。 */
export const IMPORT_TARGETS = [
  'product_key', 'base_sku', 'category_path', 'brand', 'market_codes',
  'name_zh_HK', 'slug_zh_HK', 'name_zh_CN', 'slug_zh_CN', 'name_en', 'slug_en',
  'short_zh_HK', 'short_zh_CN', 'short_en', 'desc_zh_HK', 'desc_zh_CN', 'desc_en',
  'variant_sku', 'option1_name', 'option1_value', 'option2_name', 'option2_value',
  'price_hkd', 'compare_at_hkd', 'currency', 'stock_qty', 'variant_status',
  'image_urls', 'alt_zh_HK', 'attr_1_name', 'attr_1_value', 'publish_now',
] as const;

export type ImportTarget = typeof IMPORT_TARGETS[number];

/** 字段键 → 各语言列的对应关系，用于把 name_zh_HK 之类拆成 locale 维度。 */
export const IMPORT_LOCALE_COLUMNS = {
  'zh-HK': { name: 'name_zh_HK', slug: 'slug_zh_HK', short: 'short_zh_HK', description: 'desc_zh_HK' },
  'zh-CN': { name: 'name_zh_CN', slug: 'slug_zh_CN', short: 'short_zh_CN', description: 'desc_zh_CN' },
  en: { name: 'name_en', slug: 'slug_en', short: 'short_en', description: 'desc_en' },
} as const;

export type ImportMode = 'create_or_update_by_sku' | 'create_only' | 'update_only';
export type ImportCommitMode = 'valid_rows' | 'atomic';
export type ImportStatus = 'uploaded' | 'validating' | 'ready' | 'processing'
  | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
export type RowAction = 'create' | 'update' | 'skip' | 'reject';

export const IMPORT_MODES: readonly ImportMode[] = ['create_or_update_by_sku', 'create_only', 'update_only'];
export const IMPORT_COMMIT_MODES: readonly ImportCommitMode[] = ['valid_rows', 'atomic'];

/** 单次导入上限：一次 5000 行以内是门店级目录的合理量级；超过应拆文件而不是拖垮事务。 */
export const MAX_IMPORT_ROWS = 5_000;
/** 导入文件大小上限（字节）。CSV 超过 10 MiB 通常是导出了整库。 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_CELL_LENGTH = 2_000;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRODUCT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export class ImportRuleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new ImportRuleError(code);
};

export interface FieldError { field: string; locale: string | null; code: string; message: string }
export interface CsvRow { rowNumber: number; cells: string[] }
export interface ParsedCsv { headers: string[]; rows: CsvRow[]; rowCount: number }

/**
 * RFC 4180 风格的 CSV 解析：引号包裹、`""` 转义、CRLF、BOM、字段内换行。
 * 不做类型推断——价格、布尔、枚举都由后面按字段各自解释，避免"看起来像数字就当数字"。
 */
export function parseCsv(text: string): ParsedCsv {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = []; let cell = ''; let quoted = false; let rowNumber = 1;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { cells.push(cell); cell = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      cells.push(cell);
      rows.push({ rowNumber, cells });
      cells = []; cell = ''; rowNumber += 1;
      continue;
    }
    cell += char;
  }
  if (quoted) fail('CSV_UNTERMINATED_QUOTE');
  // 末行没有换行时也要收尾；完全空白的行忽略，不计入行号对齐。
  if (cell.length > 0 || cells.length > 0) {
    cells.push(cell);
    if (cells.some(value => value.length > 0)) rows.push({ rowNumber, cells });
  }
  const header = rows.shift();
  if (!header || header.cells.length === 0) throw new ImportRuleError('CSV_HEADER_MISSING');
  const headers = header.cells.map(cell => cell.trim());
  if (headers.some(value => value.length === 0)) fail('CSV_HEADER_EMPTY');
  if (new Set(headers).size !== headers.length) fail('CSV_HEADER_DUPLICATE');
  if (headers.length > 64) fail('CSV_TOO_MANY_COLUMNS');
  for (const row of rows) {
    if (row.cells.length > headers.length + 8) fail('CSV_ROW_TOO_WIDE');
    if (row.cells.some(value => value.length > MAX_CELL_LENGTH)) fail('CSV_CELL_TOO_LONG');
  }
  return { headers, rows, rowCount: rows.length };
}

/**
 * 列映射校验：值必须是已知目标列，键必须是文件里真实存在的表头，目标列不得重复。
 * 返回「目标列 → 表头」的反向索引，逐行取值时按目标列名查找，不再关心表头叫什么。
 */
export function normalizeMapping(mapping: Readonly<Record<string, string>>, headers: readonly string[]): Map<ImportTarget, string> {
  const known = new Set<string>(IMPORT_TARGETS);
  const headerSet = new Set(headers);
  const result = new Map<ImportTarget, string>();
  for (const [header, target] of Object.entries(mapping)) {
    if (!headerSet.has(header)) fail('MAPPING_HEADER_UNKNOWN');
    if (!known.has(target)) fail('MAPPING_TARGET_UNKNOWN');
    if (result.has(target as ImportTarget)) fail('MAPPING_TARGET_DUPLICATE');
    result.set(target as ImportTarget, header);
  }
  const required: ImportTarget[] = ['product_key', 'variant_sku', 'price_hkd'];
  for (const target of required) if (!result.has(target)) fail('MAPPING_REQUIRED_MISSING');
  return result;
}

/** 金额一律按「元 + 两位小数」解析成最小单位整数：不接受科学计数、千分位与多余小数位。 */
export function parseMinorAmount(value: string, field: string): number {
  const text = value.trim();
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text)) fail(`INVALID_AMOUNT:${field}`);
  const [whole, fraction = ''] = text.split('.') as [string, string?];
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor < 0) fail(`INVALID_AMOUNT:${field}`);
  return minor;
}

function parseBoolean(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (!text.length) return null;
  if (['y', 'yes', 'true', '1'].includes(text)) return true;
  if (['n', 'no', 'false', '0'].includes(text)) return false;
  throw new ImportRuleError('INVALID_BOOLEAN');
}

export interface ImportVariantPlan {
  sku: string;
  optionValues: Record<string, string>;
  priceMinor: number;
  compareAtMinor: number | null;
  status: 'active' | 'inactive';
}

export interface ImportTranslationPlan {
  locale: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  description: string | null;
}

export interface ImportProductPlan {
  productKey: string;
  action: Exclude<RowAction, 'reject'>;
  existingProductId: string | null;
  baseSku: string | null;
  translations: ImportTranslationPlan[];
  variants: ImportVariantPlan[];
  categoryIds: string[];
  brandId: string | null;
  marketCodes: string[];
  publish: boolean;
  rowNumbers: number[];
}

export interface ImportRowReport {
  rowNumber: number;
  sku: string | null;
  action: RowAction;
  errors: FieldError[];
  warnings: string[];
}

export interface ImportPlan {
  rows: ImportRowReport[];
  products: ImportProductPlan[];
  counters: { totalRows: number; validRows: number; invalidRows: number; newCount: number; updateCount: number; skipCount: number };
}

export interface ImportLookups {
  /** sku → 该 sku 所属商品；用于判断 create / update / skip。 */
  existingBySku: ReadonlyMap<string, { productId: string }>;
  /** 分类路径（如 `家居器物/香薰`）→ 分类 id；按语言取当前语言的路径。 */
  categoryByPath: ReadonlyMap<string, string>;
  /** 品牌名 → 品牌 id。 */
  brandByName: ReadonlyMap<string, string>;
  /** 已建档且审核通过的市场代码。 */
  knownMarkets: ReadonlySet<string>;
}

export interface ImportPlanInput {
  csv: ParsedCsv;
  mapping: ReadonlyMap<ImportTarget, string>;
  modes: { mode: ImportMode; locales: readonly string[]; currency: string };
  lookups: ImportLookups;
}

const cell = (csv: ParsedCsv, row: CsvRow, mapping: ReadonlyMap<ImportTarget, string>, target: ImportTarget): string => {
  const header = mapping.get(target);
  if (header === undefined) return '';
  const index = csv.headers.indexOf(header);
  return index < 0 ? '' : (row.cells[index] ?? '').trim();
};

const errorOf = (field: string, code: string, message: string, locale: string | null = null): FieldError => ({ field, locale, code, message });

/**
 * slug 的规则只有一处定义：目录模块的 normalizeSlug（允许大小写混排与中文，禁止空白、`/`、首尾 `-`/`_`）。
 * 导入不能比后台编辑更严——否则客户按交付模板填的 `toBe-cup` 会被导入器判成非法，而手填后台却能存。
 */
function validSlug(value: string): boolean {
  try { normalizeSlug(value); return true; } catch { return false; }
}

/**
 * 由 CSV 生成执行计划。
 *
 * 分组规则：`product_key` 相同即同一商品，第一行决定商品级字段（名称/分类/品牌/市场/发布），
 * 后续行只贡献规格。商品级字段在后续行出现不同值时给警告而不是报错——模板通常是复制粘贴，
 * 报错只会让人逐行去改重复内容。
 */
export function buildImportPlan(input: ImportPlanInput): ImportPlan {
  const { csv, mapping, modes, lookups } = input;
  if (csv.rows.length === 0) fail('CSV_NO_DATA_ROWS');
  if (csv.rows.length > MAX_IMPORT_ROWS) fail('CSV_ROW_LIMIT');

  const reports = new Map<number, ImportRowReport>();
  const groups = new Map<string, { first: CsvRow; rows: CsvRow[] }>();
  const skuSeen = new Set<string>();
  const rejectRow = (row: CsvRow, sku: string | null, errors: FieldError[], warnings: string[] = []) =>
    reports.set(row.rowNumber, { rowNumber: row.rowNumber, sku, action: 'reject', errors, warnings });

  for (const row of csv.rows) {
    const productKey = cell(csv, row, mapping, 'product_key');
    const sku = cell(csv, row, mapping, 'variant_sku') || null;
    const errors: FieldError[] = [];
    const warnings: string[] = [];
    if (!productKey) errors.push(errorOf('product_key', 'REQUIRED', '缺少商品分组键 product_key'));
    else if (!PRODUCT_KEY.test(productKey)) errors.push(errorOf('product_key', 'INVALID_FORMAT', 'product_key 只允许字母数字与 . _ : -'));
    if (!sku) errors.push(errorOf('variant_sku', 'REQUIRED', '缺少规格编码 variant_sku'));
    else if (!SKU.test(sku)) errors.push(errorOf('variant_sku', 'INVALID_FORMAT', 'SKU 只允许字母数字与 . _ -，且不超过 64 位'));
    else if (skuSeen.has(sku)) errors.push(errorOf('variant_sku', 'DUPLICATE_SKU', `文件内重复的 SKU：${sku}`));
    if (sku) skuSeen.add(sku);
    if (!cell(csv, row, mapping, 'price_hkd')) errors.push(errorOf('price_hkd', 'REQUIRED', '缺少价格'));
    if (errors.length) { rejectRow(row, sku, errors, warnings); continue; }
    const group = groups.get(productKey);
    if (group) group.rows.push(row); else groups.set(productKey, { first: row, rows: [row] });
    // 校验其余列放到分组之后：商品级字段只需要第一行，规格级字段每行都要查。
  }

  const products: ImportProductPlan[] = [];
  for (const [productKey, group] of groups) {
    const errors: FieldError[] = [];
    const warnings: string[] = [];
    const translations: ImportTranslationPlan[] = [];
    const variants: ImportVariantPlan[] = [];
    const rowNumbers: number[] = [];
    const { mode, locales, currency } = modes;

    for (const row of group.rows) {
      rowNumbers.push(row.rowNumber);
      const sku = cell(csv, row, mapping, 'variant_sku');
      const rowErrors: FieldError[] = [];
      let priceMinor = 0;
      try { priceMinor = parseMinorAmount(cell(csv, row, mapping, 'price_hkd'), 'price_hkd'); }
      catch { rowErrors.push(errorOf('price_hkd', 'INVALID_AMOUNT', '价格必须是元，最多两位小数', null)); }
      const compareRaw = cell(csv, row, mapping, 'compare_at_hkd');
      let compareAtMinor: number | null = null;
      if (compareRaw) {
        try { compareAtMinor = parseMinorAmount(compareRaw, 'compare_at_hkd'); }
        catch { rowErrors.push(errorOf('compare_at_hkd', 'INVALID_AMOUNT', '划线价必须是元，最多两位小数', null)); }
      }
      const currencyCell = cell(csv, row, mapping, 'currency');
      if (currencyCell && currencyCell.toUpperCase() !== currency) {
        rowErrors.push(errorOf('currency', 'CURRENCY_MISMATCH', `币种必须等于店铺本位币 ${currency}`, null));
      }
      const variantStatus = cell(csv, row, mapping, 'variant_status').toLowerCase() || 'active';
      if (variantStatus !== 'active' && variantStatus !== 'inactive') {
        rowErrors.push(errorOf('variant_status', 'INVALID_STATUS', '规格状态只允许 active / inactive', null));
      }
      const stockRaw = cell(csv, row, mapping, 'stock_qty');
      if (stockRaw) {
        if (!/^\d{1,7}$/.test(stockRaw)) rowErrors.push(errorOf('stock_qty', 'INVALID_QUANTITY', '库存必须是非负整数', null));
        else warnings.push(`STOCK_NOT_IMPORTED:${stockRaw}`);
      }
      if (cell(csv, row, mapping, 'image_urls')) warnings.push('IMAGE_URL_NOT_IMPORTED');

      const optionValues: Record<string, string> = {};
      for (const index of [1, 2]) {
        const name = cell(csv, row, mapping, `option${index}_name` as ImportTarget);
        const value = cell(csv, row, mapping, `option${index}_value` as ImportTarget);
        if (name && value) optionValues[name] = value;
        else if (name && !value) rowErrors.push(errorOf(`option${index}_value`, 'REQUIRED', '选项名与选项值必须成对出现', null));
      }
      if (rowErrors.length) errors.push(...rowErrors);
      else variants.push({ sku, optionValues, priceMinor, compareAtMinor, status: variantStatus === 'inactive' ? 'inactive' : 'active' });

      // 商品级字段只看第一行；后续行重复且冲突时给警告。
      if (row.rowNumber !== group.first.rowNumber) {
        for (const locale of Object.keys(IMPORT_LOCALE_COLUMNS) as (keyof typeof IMPORT_LOCALE_COLUMNS)[]) {
          const column = IMPORT_LOCALE_COLUMNS[locale];
          if (cell(csv, row, mapping, column.name) && cell(csv, row, mapping, column.name) !== cell(csv, group.first, mapping, column.name)) {
            warnings.push(`ROW_FIELD_IGNORED:${locale}:name`);
          }
        }
      }
    }

    // 商品级字段取全组第一个非空值：模板常见只在一行填商品名/分类，不能因为第一行留空就整单失败。
    const pick = (target: ImportTarget): string => {
      for (const row of group.rows) { const value = cell(csv, row, mapping, target); if (value) return value; }
      return '';
    };
    for (const locale of locales) {
      const columns = (IMPORT_LOCALE_COLUMNS as Record<string, { name: ImportTarget; slug: ImportTarget; short: ImportTarget; description: ImportTarget }>)[locale];
      if (!columns) { errors.push(errorOf('localeSet', 'LOCALE_UNSUPPORTED', `不支持的语言 ${locale}`, locale)); continue; }
      const name = pick(columns.name);
      const slug = pick(columns.slug);
      if (!name) errors.push(errorOf(columns.name, 'REQUIRED', `语言 ${locale} 缺少商品名称`, locale));
      if (!slug) errors.push(errorOf(columns.slug, 'REQUIRED', `语言 ${locale} 缺少 slug`, locale));
      else if (!validSlug(slug)) errors.push(errorOf(columns.slug, 'INVALID_SLUG',
        'slug 不能含空白或 /，不能以 - / _ 开头或结尾，长度 1–180（与目录模块同一规则）', locale));
      if (name && slug) {
        translations.push({ locale, name, slug,
          shortDescription: pick(columns.short) || null,
          description: pick(columns.description) || null });
      }
    }

    const categoryIds: string[] = [];
    const categoryPath = pick('category_path');
    if (categoryPath) {
      const resolved = lookups.categoryByPath.get(categoryPath);
      if (!resolved) errors.push(errorOf('category_path', 'CATEGORY_UNKNOWN', `找不到分类路径：${categoryPath}`, null));
      else categoryIds.push(resolved);
    }

    let brandId: string | null = null;
    const brandName = pick('brand');
    if (brandName) {
      const resolved = lookups.brandByName.get(brandName);
      if (!resolved) errors.push(errorOf('brand', 'BRAND_UNKNOWN', `找不到品牌：${brandName}`, null));
      else brandId = resolved;
    }

    const marketCodes: string[] = [];
    const marketCell = pick('market_codes');
    if (!marketCell) errors.push(errorOf('market_codes', 'REQUIRED', '缺少可售市场 market_codes', null));
    for (const code of marketCell.split(/[,\s|]+/).map(part => part.trim().toUpperCase()).filter(Boolean)) {
      if (!lookups.knownMarkets.has(code)) errors.push(errorOf('market_codes', 'MARKET_UNKNOWN', `市场未建档或未审核：${code}`, null));
      else if (!marketCodes.includes(code)) marketCodes.push(code);
    }

    let publish = false;
    try { publish = parseBoolean(pick('publish_now')) ?? false; }
    catch { errors.push(errorOf('publish_now', 'INVALID_BOOLEAN', 'publish_now 只接受 Y/N', null)); }

    // 动作判定以商品内全部 SKU 决定：全部已存在才算 update，全部不存在才算 create，混合则按需处理。
    const existingIds = new Set(variants.map(variant => lookups.existingBySku.get(variant.sku)?.productId).filter((value): value is string => Boolean(value)));
    const allExist = variants.length > 0 && variants.every(variant => lookups.existingBySku.has(variant.sku));
    const noneExist = variants.every(variant => !lookups.existingBySku.has(variant.sku));
    let action: 'create' | 'update' | 'skip' = 'create';
    let existingProductId: string | null = null;
    if (existingIds.size > 1) errors.push(errorOf('variant_sku', 'SKU_CROSS_PRODUCT', '同一商品的规格已分属不同商品，导入不会自动合并', null));
    else if (allExist || existingIds.size === 1) {
      existingProductId = [...existingIds][0] ?? null;
      if (mode === 'create_only') action = 'skip';
      else action = 'update';
      if (!allExist) warnings.push('PARTIAL_UPDATE:新增规格将追加到既有商品');
    } else if (mode === 'update_only') action = 'skip';

    const reportAction: RowAction = errors.length ? 'reject' : action;
    if (errors.length) {
      for (const rowNumber of rowNumbers) {
        const existing = reports.get(rowNumber);
        const sku = existing?.sku ?? null;
        reports.set(rowNumber, { rowNumber, sku, action: 'reject', errors: existing?.errors.concat(errors) ?? errors, warnings });
      }
      continue;
    }
    for (const rowNumber of rowNumbers) {
      const existing = reports.get(rowNumber);
      reports.set(rowNumber, { rowNumber, sku: existing?.sku ?? null, action, errors: [], warnings: [...(existing?.warnings ?? []), ...warnings] });
    }
    if (action !== 'skip') {
      products.push({ productKey, action, existingProductId: action === 'update' ? existingProductId : null,
        baseSku: pick('base_sku') || null, translations, variants, categoryIds, brandId, marketCodes, publish, rowNumbers });
    }
  }

  const rows = [...reports.values()].sort((left, right) => left.rowNumber - right.rowNumber);
  const counters = {
    totalRows: csv.rows.length,
    validRows: rows.filter(row => row.action !== 'reject').length,
    invalidRows: rows.filter(row => row.action === 'reject').length,
    newCount: rows.filter(row => row.action === 'create').length,
    updateCount: rows.filter(row => row.action === 'update').length,
    skipCount: rows.filter(row => row.action === 'skip').length,
  };
  return { rows, products, counters };
}

/** 预览只回前 100 行：报告靠错误摘要，不靠把整份文件回传给浏览器。 */
export const IMPORT_PREVIEW_LIMIT = 100;
export function previewRows(plan: ImportPlan) {
  return plan.rows.slice(0, IMPORT_PREVIEW_LIMIT).map(row => ({
    rowNumber: row.rowNumber,
    sku: row.sku,
    action: row.action,
    errors: row.errors.slice(0, 20).map(error => ({ ...error, message: error.message.slice(0, 500), field: error.field.slice(0, 256),
      code: error.code.slice(0, 80), locale: error.locale === null ? null : error.locale.slice(0, 16) })),
    warnings: row.warnings.slice(0, 20),
  }));
}

/** 状态机：只允许前进或取消；completed 之后不再接受任何动作。 */
const TRANSITIONS: Record<ImportStatus, readonly ImportStatus[]> = {
  uploaded: ['validating', 'cancelled'],
  validating: ['ready', 'failed', 'cancelled'],
  ready: ['processing', 'cancelled'],
  processing: ['completed', 'completed_with_errors', 'failed'],
  completed: [],
  completed_with_errors: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ImportStatus, to: ImportStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ImportStatus, to: ImportStatus): void {
  if (!canTransition(from, to)) fail('IMPORT_STATE_CONFLICT');
}
