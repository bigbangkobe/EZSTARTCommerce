// 商品批量导入的纯函数层：CSV 解析 → 归一化草稿 → POST /api/v1/admin/products 请求体。
//
// 为什么单独一层：M05「商品导入与导出」目前只有规格和 CSV 模板，没有实现代码
// （docs/03-开发文档/IMPLEMENTATION_PROGRESS.md 明确「导入（M05）尚未实现」）。
// 在真正的 ImportJob 落地前，用这层把表格转成目录 API 的请求体，脚本负责登录/写入/回读。
// 这层不碰网络、不发请求，方便 --plan 离线校验，也方便以后被 M05 复用。
//
// 字段口径完全对齐 packages/contracts/openapi.yaml：
//   ProductWriteRequest = ProductFields & required[categoryIds, marketCodes, translations, variants]

/** 无选项商品的兜底规格（ProductVariantInput.optionValues 至少 1 个键）。 */
export const DEFAULT_OPTION = { 規格: '標準' };

/** 商品语言列：列名同时兼容模板写法 name_zh_HK 与连字符写法 name_zh-HK。 */
const LOCALE_COLUMNS = {
  'zh-HK': { name: ['name_zh_HK', 'name_zh-HK', 'name_zh_hk'], slug: ['slug_zh_HK', 'slug_zh-HK', 'slug_zh_hk'],
    short: ['short_zh_HK', 'short_zh-HK'], description: ['desc_zh_HK', 'desc_zh-HK'] },
  'zh-CN': { name: ['name_zh_CN', 'name_zh-CN', 'name_zh_cn'], slug: ['slug_zh_CN', 'slug_zh-CN', 'slug_zh_cn'],
    short: ['short_zh_CN', 'short_zh-CN'], description: ['desc_zh_CN', 'desc_zh-CN'] },
  en: { name: ['name_en', 'name_En'], slug: ['slug_en', 'slug_En'], short: ['short_en'], description: ['desc_en'] },
};

export const TEMPLATE_COLUMNS = ['product_key', 'base_sku', 'category_path', 'brand', 'market_codes',
  'name_zh_HK', 'slug_zh_HK', 'name_zh_CN', 'slug_zh_CN', 'name_en', 'slug_en',
  'short_zh_HK', 'short_zh_CN', 'short_en', 'desc_zh_HK', 'desc_zh_CN', 'desc_en',
  'variant_sku', 'option1_name', 'option1_value', 'option2_name', 'option2_value',
  'price_hkd', 'compare_at_hkd', 'currency', 'stock_qty', 'variant_status', 'image_urls', 'alt_zh_HK',
  'attr_1_name', 'attr_1_value', 'publish_now'];

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC4180 解析：支持引号包裹、引号内逗号/换行、"" 转义、CRLF 与 Excel 的 UTF-8 BOM。
 * 返回 { header[], rows: Record<string,string>[] }，空行跳过。
 */
export function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/, '');
  const table = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else { field += char; }
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') { continue; }
    if (char === '\n') { row.push(field); table.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); table.push(row); }

  const nonEmpty = table.filter(cells => cells.some(cell => cell.trim() !== ''));
  if (!nonEmpty.length) return { header: [], rows: [], ragged: [] };
  const header = nonEmpty[0].map(cell => cell.trim());
  // 列数不一致几乎都是引号没闭合导致的整体错位，必须报出来而不是静默错位导入
  const ragged = [];
  const rows = nonEmpty.slice(1).map((cells, index) => {
    if (cells.length !== header.length) {
      ragged.push({ line: index + 2, expected: header.length, actual: cells.length });
    }
    const record = {};
    header.forEach((key, position) => { record[key] = (cells[position] ?? '').trim(); });
    return record;
  });
  return { header, rows, ragged };
}

function pick(record, names) {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

/** 价格（元）转最小单位（分）。空值返回 null，非法值抛错由调用方汇总。 */
export function toMinor(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).replace(/[,\s]/g, '').replace(/^HK\$|\$|元$/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error(`${label} 不是合法金额：${value}`);
  return Math.round(Number(raw) * 100);
}

function splitList(value) {
  return String(value ?? '').split(/[;,|]/).map(item => item.trim()).filter(Boolean);
}

function splitPath(value) {
  return String(value ?? '').split('/').map(item => item.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/**
 * 按 product_key 归并行 → 商品草稿。同一商品的多行代表多个规格（variant_sku）。
 * 商品级字段取组内第一个非空值，方便表格里重复单元格留空。
 */
export function groupProducts(rows, { defaultMarket = null, defaultCurrency = 'HKD', defaultOption = DEFAULT_OPTION } = {}) {
  const groups = new Map();
  for (const record of rows) {
    const key = (record.product_key || record.base_sku || record.variant_sku || '').trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const drafts = [];
  for (const [key, records] of groups) {
    const first = records.find(record => record.base_sku || record.category_path || record.name_zh_HK) ?? records[0];
    const translations = [];
    for (const [locale, columns] of Object.entries(LOCALE_COLUMNS)) {
      const name = pick(first, columns.name);
      const slug = pick(first, columns.slug);
      if (!name && !slug) continue;
      translations.push({
        locale, name, slug,
        shortDescription: pick(first, columns.short) || null,
        description: pick(first, columns.description) || null,
      });
    }

    const attributes = [];
    const attributeCodes = Object.keys(first).filter(column => /^attr_\d+_name$/.test(column)).sort();
    for (const column of attributeCodes) {
      const code = first[column]?.trim();
      const value = first[column.replace('_name', '_value')]?.trim();
      if (!code) continue;
      // 同一属性在多行里给了不同值 = 表格错误，交给校验层报出来
      const existing = attributes.find(item => item.attributeCode === code);
      if (existing && value && existing.value !== value) existing.conflict = true;
      if (!existing) attributes.push({ attributeCode: code, value: value ?? '' });
    }

    const variants = [];
    for (const record of records) {
      const sku = (record.variant_sku || record.base_sku || '').trim();
      if (!sku) continue;
      const optionValues = {};
      for (const index of [1, 2, 3, 4]) {
        const optionName = record[`option${index}_name`]?.trim();
        const optionValue = record[`option${index}_value`]?.trim();
        if (optionName && optionValue) optionValues[optionName] = optionValue;
      }
      variants.push({
        sku,
        optionValues: Object.keys(optionValues).length ? optionValues : { ...defaultOption },
        priceMinor: record.price_hkd ?? '',
        compareAtMinor: record.compare_at_hkd ?? '',
        currency: (record.currency || defaultCurrency).toUpperCase(),
        status: (record.variant_status || 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active',
        stock: record.stock_qty ?? '',
      });
    }

    drafts.push({
      key,
      baseSku: (first.base_sku || key).trim(),
      brand: first.brand?.trim() || null,
      categoryPath: splitPath(first.category_path),
      marketCodes: splitList(first.market_codes).length ? splitList(first.market_codes)
        : (defaultMarket ? [defaultMarket] : []),
      taxClassRef: first.tax_class_ref?.trim() || null,
      allowedChannels: splitList(first.allowed_channels),
      translations,
      variants,
      attributes: attributes.map(({ attributeCode, value }) => ({ attributeCode, value })),
      attributeConflicts: attributes.filter(item => item.conflict).map(item => item.attributeCode),
      images: splitList(first.image_urls),
      publish: String(first.publish_now || '').toUpperCase() === 'Y',
    });
  }
  return drafts;
}

/** JSON 输入：直接给 API 形状（或 CSV 草稿形状）的数组，补默认值后与 CSV 走同一套校验。 */
export function groupFromJson(items, { defaultMarket = null, defaultCurrency = 'HKD' } = {}) {
  return items.map((item, index) => {
    const translations = (item.translations ?? []).map(translation => ({
      locale: translation.locale,
      name: translation.name ?? '',
      slug: translation.slug ?? '',
      shortDescription: translation.shortDescription ?? null,
      description: translation.description ?? null,
    }));
    const variants = (item.variants ?? []).map(variant => ({
      sku: variant.sku ?? '',
      optionValues: variant.optionValues && Object.keys(variant.optionValues).length ? variant.optionValues : { ...DEFAULT_OPTION },
      // JSON 里允许直接给 priceMinor（分），也容忍给 price（元）
      priceMinor: variant.priceMinor ?? variant.price ?? '',
      compareAtMinor: variant.compareAtMinor ?? variant.compareAtPrice ?? '',
      currency: (variant.currency || defaultCurrency).toUpperCase(),
      status: variant.status === 'inactive' ? 'inactive' : 'active',
      stock: variant.stock ?? item.stock ?? '',
    }));
    return {
      key: item.key ?? item.baseSku ?? `row-${index + 1}`,
      baseSku: item.baseSku ?? item.key ?? null,
      brand: item.brand ?? null,
      categoryPath: item.categoryPath ?? splitPath(item.category_path ?? ''),
      marketCodes: item.marketCodes ?? (defaultMarket ? [defaultMarket] : []),
      taxClassRef: item.taxClassRef ?? null,
      allowedChannels: item.allowedPaymentChannels ?? item.allowedChannels ?? [],
      translations, variants,
      attributes: (item.attributes ?? []).map(attribute => ({ attributeCode: attribute.attributeCode ?? attribute.code,
        value: String(attribute.value ?? '') })),
      attributeConflicts: [],
      images: item.imageUrls ?? [],
      publish: item.publish === true || String(item.publish_now ?? '').toUpperCase() === 'Y',
    };
  });
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 行级校验，返回错误字符串数组。完全不写库、不联网，--plan 与真实执行共用同一套规则。
 * 这里只覆盖目录 API 会 422 的硬规则中能离线判断的部分（字段格式/必填/重复），
 * 分类与市场的存在性要登录后才能判断，留给执行阶段。
 */
export function validateDrafts(drafts, { currency = 'HKD', locales = ['zh-CN', 'zh-HK', 'en'], fillMissingLocale = false } = {}) {
  const report = [];
  const seenSku = new Map();
  const seenSlug = new Map();

  for (const draft of drafts) {
    const errors = [];
    const warnings = [];

    if (!draft.categoryPath.length) errors.push('category_path 为空：目录规则要求 categoryIds 至少一个');
    if (!draft.marketCodes.length) errors.push('market_codes 为空且未给 --market');
    if (!draft.translations.length) errors.push('缺少任何语言的名字/ slug');
    if (!draft.variants.length) errors.push('缺少 variant_sku，至少需要一个规格');

    for (const translation of draft.translations) {
      if (!translation.name) errors.push(`${translation.locale} 缺少名字`);
      if (!translation.slug) errors.push(`${translation.locale} 缺少 slug`);
      else if (!SLUG_PATTERN.test(translation.slug)) errors.push(`${translation.locale} slug 不合法：${translation.slug}`);
      if (!['zh-CN', 'zh-HK', 'en'].includes(translation.locale)) errors.push(`不支持的语言：${translation.locale}`);
      if (translation.name.length > 160) errors.push(`${translation.locale} 名字超过 160 字`);
      if ((translation.shortDescription ?? '').length > 320) errors.push(`${translation.locale} 卖点超过 320 字`);
      if ((translation.description ?? '').length > 50_000) errors.push(`${translation.locale} 描述超过 50000 字`);
      const previous = seenSlug.get(translation.slug);
      if (previous && previous !== draft.key) errors.push(`slug 与 ${previous} 重复：${translation.slug}`);
      if (translation.slug) seenSlug.set(translation.slug, draft.key);
    }

    const missingLocales = locales.filter(locale => !draft.translations.some(item => item.name && item.slug
      && item.locale === locale));
    if (missingLocales.length) {
      const message = `缺少启用语言翻译：${missingLocales.join(', ')}`;
      if (draft.publish && !fillMissingLocale) errors.push(`${message}（发布门禁要求每种启用语言都有名字+slug）`);
      else warnings.push(message);
    }

    for (const variant of draft.variants) {
      if (!SKU_PATTERN.test(variant.sku)) errors.push(`SKU 不合法：${variant.sku}`);
      const previous = seenSku.get(variant.sku);
      if (previous) errors.push(`SKU 重复：${variant.sku}（已出现在 ${previous}）`);
      else seenSku.set(variant.sku, draft.key);

      let priceMinor = null;
      try { priceMinor = toMinor(variant.priceMinor, `${variant.sku} 价格`); }
      catch (error) { errors.push(error.message); }
      if (priceMinor === null) errors.push(`${variant.sku} 缺价格 price_hkd`);

      try {
        const compareAt = toMinor(variant.compareAtMinor, `${variant.sku} 划线价`);
        if (compareAt !== null && priceMinor !== null && compareAt < priceMinor) {
          warnings.push(`${variant.sku} 划线价低于售价`);
        }
      } catch (error) { errors.push(error.message); }

      if (!CURRENCY_PATTERN.test(variant.currency)) errors.push(`${variant.sku} 币种不合法：${variant.currency}`);
      else if (variant.currency !== currency) {
        errors.push(`${variant.sku} 币种 ${variant.currency} 与店铺基准币 ${currency} 不一致（目录规则要求相同）`);
      }

      const options = Object.entries(variant.optionValues);
      if (!options.length) errors.push(`${variant.sku} 缺 option_values`);
      if (options.length > 20) errors.push(`${variant.sku} 选项超过 20 个`);
      for (const [key, value] of options) {
        if (key.length < 1 || key.length > 60) errors.push(`${variant.sku} 选项名长度不合法：${key}`);
        if (!value || value.length > 100) errors.push(`${variant.sku} 选项值长度不合法：${value}`);
      }

      if (variant.stock !== '' && variant.stock !== undefined && variant.stock !== null) {
        if (!/^-?\d+$/.test(String(variant.stock))) errors.push(`${variant.sku} stock_qty 不是整数：${variant.stock}`);
      }
    }

    for (const attribute of draft.attributes) {
      if (!attribute.attributeCode) errors.push('attr_N_name 为空');
      else if (attribute.attributeCode.length > 80) errors.push(`属性名超过 80 字：${attribute.attributeCode}`);
      if (attribute.value.length > 200) errors.push(`属性值超过 200 字：${attribute.attributeCode}`);
    }
    for (const code of draft.attributeConflicts ?? []) {
      errors.push(`属性 ${code} 在同商品不同行里给了不同值`);
    }

    if (draft.images.length) warnings.push(`image_urls 未导入（${draft.images.length} 张）：媒体上传需先走 media 上传接口换 mediaId`);

    report.push({ key: draft.key, errors, warnings });
  }
  return report;
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

/**
 * 草稿 → POST /api/v1/admin/products 的 body。
 * ctx: { currency, categoryIds(UUID[]), marketCodes(string[]), fillMissingLocale, fallbackLocale }
 */
export function toProductBody(draft, ctx) {
  const { currency, categoryIds, marketCodes, fillMissingLocale = false, fallbackLocale = 'zh-HK' } = ctx;

  let translations = draft.translations.map(translation => ({
    locale: translation.locale,
    name: translation.name,
    slug: translation.slug,
    shortDescription: translation.shortDescription ?? null,
    description: translation.description ?? null,
  }));

  if (fillMissingLocale) {
    const have = new Set(translations.map(item => item.locale));
    const source = translations.find(item => item.locale === fallbackLocale) ?? translations[0];
    for (const locale of ctx.locales ?? []) {
      if (have.has(locale) || !source) continue;
      translations.push({ ...source, locale });
    }
    // 发布门禁按启用语言逐个校验，顺序不影响结果
    translations = translations.sort((a, b) => a.locale.localeCompare(b.locale));
  }

  const body = {
    baseSku: draft.baseSku || null,
    categoryIds,
    marketCodes,
    translations,
    variants: draft.variants.map(variant => ({
      sku: variant.sku,
      optionValues: variant.optionValues,
      priceMinor: toMinor(variant.priceMinor, `${variant.sku} 价格`) ?? 0,
      compareAtMinor: toMinor(variant.compareAtMinor, `${variant.sku} 划线价`),
      currency,
      status: variant.status,
    })),
    // 契约里 media/attributes 可选，但显式给空数组能避免调用方误以为字段被忽略
    media: [],
    attributes: draft.attributes.map(attribute => ({ attributeCode: attribute.attributeCode, value: attribute.value })),
  };
  if (draft.taxClassRef) body.taxClassRef = draft.taxClassRef;
  if (ctx.brandId) body.brandId = ctx.brandId;
  if (draft.allowedChannels?.length) body.allowedPaymentChannels = draft.allowedChannels;
  return body;
}

/** 汇总每个草稿的规格库存目标（负值按 0 处理），供执行阶段补库存。 */
export function stockTargets(draft) {
  return draft.variants
    .map(variant => ({ sku: variant.sku, target: Math.max(0, Number.parseInt(variant.stock || '0', 10) || 0) }))
    .filter(item => item.target > 0);
}
