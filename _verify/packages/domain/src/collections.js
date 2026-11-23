/**
 * 专题（Collection）纯规则层（M04 第五批）。
 *
 * 专题是运营挑选的一组商品的策展位，和分类不是一回事：一个商品可以同时在多个专题里，
 * 专题也可以跨分类。这里只回答「专题长什么样、地址怎么拼、什么算合法」，
 * 不碰数据库、不碰网络。
 *
 * 不变量：
 * 1. slug 是前台地址（/collections/<slug>）的唯一来源，必须是小写短横线形式，
 *    不允许空格、斜杠、大小写混写——否则一半链接会被浏览器编码成别的地址。
 * 2. 同一专题每种语言只有一行；同一语言下 slug 全局唯一（DB 唯一约束兜底）。
 * 3. 商品清单是「有序集合」：顺序决定前台展示顺序，重复项直接拒绝而不是静默去重
 *    （静默去重会让运营以为排了两次，实际只出现一次）。
 * 4. 允许先建空专题：草稿阶段可以先写名称，商品后补；前台不列出没有商品的专题。
 */
import { SUPPORTED_LOCALES } from './store.js';
export class CollectionRuleError extends Error {
    field;
    code;
    constructor(field, code = 'VALIDATION_ERROR') {
        super(field);
        this.field = field;
        this.code = code;
    }
}
function fail(field, code = 'VALIDATION_ERROR') { throw new CollectionRuleError(field, code); }
const LOCALE_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/;
/** 前台路由直接吃 slug，因此只接受小写字母数字与单个短横线连接。 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_COLLECTION_PRODUCTS = 200;
export const MAX_COLLECTION_NAME = 160;
export const MAX_COLLECTION_SLUG = 180;
export const MAX_COLLECTION_DESCRIPTION = 3_000;
export const COLLECTIONS_PATH = '/collections';
/** 前台地址：语言前缀 + /collections/ + slug，必须与前台路由、301 登记保持一致。 */
export function collectionPath(locale, slug) {
    if (!LOCALE_PATTERN.test(locale))
        fail('locale');
    if (!SLUG_PATTERN.test(slug) || slug.length > MAX_COLLECTION_SLUG)
        fail('slug');
    return `/${locale}${COLLECTIONS_PATH}/${slug}`;
}
export function normalizeCollectionSlug(value, field = 'slug') {
    if (typeof value !== 'string')
        fail(field);
    const slug = value.trim();
    if (slug.length < 1 || slug.length > MAX_COLLECTION_SLUG || !SLUG_PATTERN.test(slug))
        fail(field);
    return slug;
}
function optionalText(value, field, max) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string')
        fail(field);
    const text = value.trim();
    if (text.length > max)
        fail(field);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text))
        fail(field);
    return text.length ? text : null;
}
/**
 * 三语翻译校验：草稿允许 slug 暂时为空（先写名称），但也只允许「空」——
 * 写了一半的非法 slug（带空格、大写）会在保存时就被拒绝，不等到前台 404 才发现。
 */
export function normalizeCollectionTranslations(input, requireSlug = false) {
    if (!Array.isArray(input) || input.length === 0)
        fail('translations');
    const seen = new Set();
    return input.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
            fail(`translations[${index}]`);
        const row = raw;
        const locale = row['locale'];
        // 语言必须是店铺支持的语言：写一个 'ja' 进来只会得到一条谁也读不到的翻译。
        if (typeof locale !== 'string' || !LOCALE_PATTERN.test(locale)
            || !SUPPORTED_LOCALES.includes(locale))
            fail(`translations[${index}].locale`);
        if (seen.has(locale))
            fail(`translations[${index}].locale`, 'COLLECTION_LOCALE_DUPLICATE');
        seen.add(locale);
        const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
        if (name.length < 1 || name.length > MAX_COLLECTION_NAME)
            fail(`translations[${index}].name`);
        // 专题名会直接出现在前台标题与导航里：标签/控制字符不是文案，是排版事故或注入入口。
        if (/[<>]/.test(name) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(name)) {
            fail(`translations[${index}].name`);
        }
        const rawSlug = row['slug'];
        const slug = rawSlug === undefined || rawSlug === null || rawSlug === ''
            ? (requireSlug ? fail(`translations[${index}].slug`) : null)
            : normalizeCollectionSlug(rawSlug, `translations[${index}].slug`);
        return { locale, name, slug, description: optionalText(row['description'], `translations[${index}].description`, MAX_COLLECTION_DESCRIPTION) };
    });
}
/** 商品清单：顺序即展示顺序；重复 id 明确拒绝（不静默去重）。 */
export function normalizeCollectionProducts(input) {
    if (input === undefined || input === null)
        return [];
    if (!Array.isArray(input) || input.length > MAX_COLLECTION_PRODUCTS)
        fail('productIds');
    const seen = new Set();
    return input.map((item, index) => {
        if (typeof item !== 'string' || !UUID_PATTERN.test(item))
            fail(`productIds[${index}]`);
        const id = item.toLowerCase();
        if (seen.has(id))
            fail(`productIds[${index}]`, 'COLLECTION_PRODUCT_DUPLICATE');
        seen.add(id);
        return id;
    });
}
/**
 * 前台可见性：启用 + 当前语言有 slug + 至少有一件关联商品。
 * 空专题不列出——顾客点进一个空页面只会以为店铺坏了。
 */
export function collectionListable(collection) {
    return collection.enabled && !!collection.slug && collection.productCount > 0;
}
