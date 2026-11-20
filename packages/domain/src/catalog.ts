/**
 * 商品目录（M03）纯规则层：翻译完整性、SKU/价格约束、发布门禁与分类成环检查。
 *
 * 金额一律是“最小货币单位的非负整数”，币种必须等于店铺本位币（首期单币种）。
 * 发布门禁按店铺已启用语言逐项校验，缺任一语言的名称/slug 就拒绝发布，
 * 不允许静默回退到其他语言。
 */

import { SUPPORTED_LOCALES } from './store.js';

export class CatalogRuleError extends Error {
  constructor(readonly field: string) { super(field); }
}

const fail = (field: string): never => { throw new CatalogRuleError(field); };
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LabelTranslationInput { locale: string; name: string; slug?: string | null; description?: string | null }
export interface ProductTranslationInput extends LabelTranslationInput {
  shortDescription?: string | null; seoTitle?: string | null; seoDescription?: string | null;
}
export interface AttributeInput { attributeCode: string; value: string | number | boolean }
export interface MediaInput { mediaId: string; position: number; altByLocale?: Record<string, string> }
export interface VariantInput { sku: string; optionValues: Record<string, string>; priceMinor: number; compareAtMinor?: number | null;
  currency: string; status?: 'active' | 'inactive' }

export interface MarketRule { marketCode: string; enabled: boolean; reviewStatus: string; eligibleProductIds: readonly string[] }

export function normalizeSlug(value: string, field = 'slug'): string {
  const slug = value.trim();
  if (slug.length < 1 || slug.length > 180 || /[\s/]/.test(slug) || /^[-_]|[-_]$/.test(slug)) fail(field);
  return slug;
}

/**
 * 分类的公开地址：`/{locale}/categories/{slug}`，必须与前台路由一致。
 *
 * 只接受能表达成站内路径的 slug（`[a-z0-9-]`）：重定向登记表只存 `[A-Za-z0-9._~/-]` 的路径，
 * 含中文或空格的 slug 即使登记了也永远不会命中，属于「保存成功但静默失效」。
 * 因此这里严格校验、由调用方决定「登记不了就跳过」而不是造一条坏记录。
 */
export function categoryPath(locale: string, slug: string): string {
  if (typeof locale !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) fail('locale');
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail('slug');
  return `/${locale}/categories/${slug}`;
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 160) fail('name');
  return name;
}

function optionalText(value: string | null | undefined, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = value.trim();
  if (text.length > max) fail(field);
  return text.length === 0 ? null : text;
}

function assertLocale(locale: string): string {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) fail('locale');
  return locale;
}

export function normalizeLabelTranslations(input: readonly LabelTranslationInput[], requireSlug: boolean) {
  if (!input.length) fail('translations');
  const seen = new Set<string>();
  return input.map(translation => {
    const locale = assertLocale(translation.locale);
    if (seen.has(locale)) fail('translations');
    seen.add(locale);
    return { locale, name: normalizeName(translation.name),
      slug: translation.slug ? normalizeSlug(translation.slug) : requireSlug ? fail('slug') : null,
      description: optionalText(translation.description, 'description', 50_000) };
  });
}

export function normalizeProductTranslations(input: readonly ProductTranslationInput[]) {
  if (!input.length) fail('translations');
  const seen = new Set<string>();
  return input.map(translation => {
    const locale = assertLocale(translation.locale);
    if (seen.has(locale)) fail('translations');
    seen.add(locale);
    return { locale, name: normalizeName(translation.name), slug: normalizeSlug(translation.slug ?? ''),
      shortDescription: optionalText(translation.shortDescription, 'shortDescription', 320),
      description: optionalText(translation.description, 'description', 50_000),
      seoTitle: optionalText(translation.seoTitle, 'seoTitle', 70),
      seoDescription: optionalText(translation.seoDescription, 'seoDescription', 320) };
  });
}

export function normalizeVariants(input: readonly VariantInput[], baseCurrency: string) {
  if (!input.length) fail('variants');
  const seen = new Set<string>();
  return input.map(variant => {
    const sku = variant.sku.trim();
    if (!SKU.test(sku)) fail('sku');
    if (seen.has(sku)) fail('variants');
    seen.add(sku);
    const options = Object.entries(variant.optionValues ?? {});
    if (options.length < 1 || options.length > 20) fail('optionValues');
    for (const [key, value] of options) {
      if (key.trim().length < 1 || key.length > 60 || typeof value !== 'string' || value.trim().length < 1 || value.length > 100) fail('optionValues');
    }
    if (!Number.isSafeInteger(variant.priceMinor) || variant.priceMinor < 0) fail('priceMinor');
    const compareAtMinor = variant.compareAtMinor ?? null;
    if (compareAtMinor !== null && (!Number.isSafeInteger(compareAtMinor) || compareAtMinor < 0)) fail('compareAtMinor');
    if (!/^[A-Z]{3}$/.test(variant.currency) || variant.currency !== baseCurrency) fail('currency');
    if (variant.status !== undefined && variant.status !== 'active' && variant.status !== 'inactive') fail('status');
    return { sku, optionValues: Object.fromEntries(options), priceMinor: variant.priceMinor, compareAtMinor,
      currency: variant.currency, status: variant.status ?? 'active' as const };
  });
}

export function normalizeAttributes(input: readonly AttributeInput[]) {
  const seen = new Set<string>();
  return input.map(attribute => {
    const code = attribute.attributeCode.trim();
    if (code.length < 1 || code.length > 80 || seen.has(code)) fail('attributes');
    seen.add(code);
    const value = String(attribute.value).trim();
    if (value.length > 200) fail('attributes');
    return { code, value };
  });
}

export function normalizeMedia(input: readonly MediaInput[], productId?: string) {
  const seen = new Set<string>();
  return input.map(item => {
    if (!UUID.test(item.mediaId) || seen.has(item.mediaId)) fail('media');
    seen.add(item.mediaId);
    if (!Number.isSafeInteger(item.position) || item.position < 0) fail('media');
    const altByLocale: Record<string, string> = {};
    for (const [locale, text] of Object.entries(item.altByLocale ?? {})) {
      assertLocale(locale);
      if (typeof text !== 'string' || text.length > 300) fail('altByLocale');
      altByLocale[locale] = text;
    }
    return { mediaId: item.mediaId, position: item.position, altByLocale, ...(productId ? { productId } : {}) };
  });
}

/** 发布门禁：每一种启用语言都必须有完整翻译，且至少一个可售规格。 */
export function assertPublishable(input: { translations: readonly { locale: string; name: string; slug: string }[];
  variants: readonly { status: string }[]; enabledLocales: readonly string[] }): void {
  const available = new Set(input.translations.filter(item => item.name.trim() && item.slug.trim()).map(item => item.locale));
  for (const locale of input.enabledLocales) if (!available.has(locale)) fail('translations');
  if (!input.variants.some(variant => variant.status === 'active')) fail('variants');
}

/** 定时发布返回 scheduled，但商品状态在到期前仍保持 draft（不提前可售）。 */
export function publicationState(publishedAt: Date | null, now: Date): 'active' | 'scheduled' {
  return publishedAt && publishedAt.getTime() > now.getTime() ? 'scheduled' : 'active';
}

export function assertMarketSelection(codes: readonly string[], markets: readonly MarketRule[], productId: string): void {
  if (!codes.length) fail('marketCodes');
  if (new Set(codes).size !== codes.length) fail('marketCodes');
  const byCode = new Map(markets.map(market => [market.marketCode, market]));
  for (const code of codes) {
    const market = byCode.get(code) ?? fail('marketCodes');
    if (!market.enabled || market.reviewStatus !== 'approved') fail('marketCodes');
    // 市场配置了可售清单时，未列入的商品不得发布到该市场。
    if (market.eligibleProductIds.length > 0 && !market.eligibleProductIds.includes(productId)) fail('marketCodes');
  }
}

/** 分类树成环检查：沿父链上溯，遇到自身或超过深度上限即拒绝。 */
export function assertCategoryParent(rows: readonly { id: string; parentId: string | null }[], id: string | null, parentId: string | null): void {
  if (parentId === null) return;
  if (id !== null && parentId === id) fail('parentId');
  const byId = new Map(rows.map(row => [row.id, row.parentId]));
  if (!byId.has(parentId)) fail('parentId');
  let cursor: string | null = parentId; let depth = 0;
  while (cursor) {
    if (cursor === id) fail('parentId');
    if (++depth > rows.length) fail('parentId');
    cursor = byId.get(cursor) ?? null;
  }
}
