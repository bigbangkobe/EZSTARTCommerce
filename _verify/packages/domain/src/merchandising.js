/**
 * 陈列版面纯规则层（M04 第三批）。
 *
 * 首页/分类/专题的陈列只有一条链路：草稿 sections → 发布快照 → 前台按快照渲染。
 * 这里只回答「版面长什么样、怎么校验、排序怎么稳定」，不碰数据库、不碰网络。
 *
 * 不变量（对应 docs/modules/M04_CONTENT_CMS.md 与开发规格 5.4）：
 * 1. 区块类型是服务端闭集：主题没注册的类型直接拒绝，不允许后台存下来后在前台静默失效。
 * 2. 手工排序（sortMode=manual）必须给商品清单；动态排序必须不残留手工清单，
 *    否则运营以为自己排的顺序生效，实际被规则覆盖。
 * 3. 展示上限先收敛再排序：动态规则永远有界，不会把整站商品拖进首页。
 * 4. 排序必须有稳定兜底（发布时间 → 商品 id），否则同价/同销量的位置每次刷新都在跳。
 * 5. 标题按语言分别填写；发布要求店铺已启用的每种语言齐全，不静默回退。
 */
export class MerchandisingRuleError extends Error {
    field;
    code;
    constructor(field, code = 'VALIDATION_ERROR') {
        super(field);
        this.field = field;
        this.code = code;
    }
}
function fail(field, code = 'VALIDATION_ERROR') { throw new MerchandisingRuleError(field, code); }
export const MERCHANDISING_SECTION_TYPES = ['product_grid'];
/** 动态排序口径见 5.4：新品、近 30 天已履约销量、价格升/降；manual 表示按商品清单顺序。 */
export const MERCHANDISING_SORT_MODES = ['manual', 'newest', 'fulfilled_sales_30d', 'price_asc', 'price_desc'];
export const MAX_MERCHANDISING_SECTIONS = 12;
export const MAX_GRID_PRODUCTS = 24;
export const MIN_GRID_LIMIT = 1;
export const MAX_GRID_LIMIT = 24;
const HOME_KEY = 'home';
const CATEGORY_KEY_PREFIX = 'category:';
const COLLECTION_KEY_PREFIX = 'collection:';
const SECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HOME_MERCHANDISING_REF = { kind: 'home', targetId: null, pageKey: HOME_KEY };
/** 分类版面的 key：后台路由、快照与数据行都用它，分类改名/改 slug 不影响已发布版面。 */
export function categoryMerchandisingKey(categoryId) {
    if (!UUID_PATTERN.test(categoryId))
        fail('pageKey');
    return `${CATEGORY_KEY_PREFIX}${categoryId.toLowerCase()}`;
}
export function categoryMerchandisingRef(categoryId) {
    return { kind: 'category', targetId: categoryId.toLowerCase(), pageKey: categoryMerchandisingKey(categoryId) };
}
/** 专题版面的 key：同样用 id 绑定，专题改 slug 时已发布版面不会失联。 */
export function collectionMerchandisingKey(collectionId) {
    if (!UUID_PATTERN.test(collectionId))
        fail('pageKey');
    return `${COLLECTION_KEY_PREFIX}${collectionId.toLowerCase()}`;
}
export function collectionMerchandisingRef(collectionId) {
    return { kind: 'collection', targetId: collectionId.toLowerCase(), pageKey: collectionMerchandisingKey(collectionId) };
}
/**
 * 解析版面 key。三类失败要分开：
 * - 格式不对（`category:` 后面不是 id）→ VALIDATION_ERROR；
 * - kind 未开放（例如 `product:` 这种还没有路由的作用域）→ MERCHANDISING_PAGE_UNKNOWN；
 * - kind 缺失（只写了 `home:` 之类）→ VALIDATION_ERROR。
 * 后台据此分别提示「改 key」还是「这个页面还没上线」，而不是统一说保存失败。
 */
export function parseMerchandisingPageKey(value) {
    if (typeof value !== 'string')
        fail('pageKey');
    if (value === HOME_KEY)
        return HOME_MERCHANDISING_REF;
    const separator = value.indexOf(':');
    if (separator <= 0 || separator === value.length - 1)
        fail('pageKey');
    const kind = value.slice(0, separator);
    const targetId = value.slice(separator + 1);
    if (kind !== 'category' && kind !== 'collection')
        fail('pageKey', 'MERCHANDISING_PAGE_UNKNOWN');
    if (!UUID_PATTERN.test(targetId))
        fail('pageKey');
    return kind === 'category' ? categoryMerchandisingRef(targetId) : collectionMerchandisingRef(targetId);
}
/** 后台可见文本：拒绝 HTML 标签与控制字符，长度收敛。 */
function plain(value, field, min, max) {
    if (typeof value !== 'string')
        fail(field);
    const text = value.trim();
    if (text.length < min || text.length > max)
        fail(field);
    if (/[<>]/.test(text) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text))
        fail(field);
    return text;
}
/**
 * 多语言标题：键必须在店铺已启用语言内，值逐条校验。
 * 草稿允许先写一部分（运营可以先写英文），发布时再要求补齐。
 */
function titleByLocale(value, locales) {
    if (value === undefined || value === null)
        return {};
    if (typeof value !== 'object' || Array.isArray(value))
        fail('titleByLocale');
    const source = value;
    const output = {};
    for (const [locale, text] of Object.entries(source)) {
        if (!locales.includes(locale))
            fail(`titleByLocale.${locale}`);
        if (typeof text === 'string' && text.trim() === '')
            continue;
        output[locale] = plain(text, `titleByLocale.${locale}`, 1, 80);
    }
    return output;
}
function uuidList(value, field, max) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value) || value.length > max)
        fail(field);
    const seen = new Set();
    return value.map((item, index) => {
        if (typeof item !== 'string' || !UUID_PATTERN.test(item))
            fail(`${field}[${index}]`);
        const id = item.toLowerCase();
        if (seen.has(id))
            fail(`${field}[${index}]`, 'MERCHANDISING_PRODUCT_DUPLICATE');
        seen.add(id);
        return id;
    });
}
/**
 * 版面区块校验：闭集类型 + 逐字段白名单 + 数组顺序即展示顺序（position 由服务端重排）。
 * visible=false 的区块保留配置但前台不渲染——运营可以先把区块藏起来再慢慢调。
 */
export function normalizeMerchandisingSections(input, locales) {
    if (!Array.isArray(input))
        fail('sections');
    if (input.length > MAX_MERCHANDISING_SECTIONS)
        fail('sections');
    const seen = new Set();
    return input.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
            fail(`sections[${index}]`);
        const section = raw;
        const allowed = ['sectionId', 'type', 'visible', 'position', 'titleByLocale', 'sortMode', 'limit', 'productIds',
            'categoryIds', 'collectionId'];
        for (const key of Object.keys(section))
            if (!allowed.includes(key))
                fail(`sections[${index}].${key}`);
        const sectionId = section['sectionId'];
        if (typeof sectionId !== 'string' || !SECTION_ID_PATTERN.test(sectionId))
            fail(`sections[${index}].sectionId`);
        if (seen.has(sectionId))
            fail(`sections[${index}].sectionId`, 'MERCHANDISING_SECTION_DUPLICATE');
        seen.add(sectionId);
        const type = section['type'];
        if (typeof type !== 'string' || !MERCHANDISING_SECTION_TYPES.includes(type)) {
            fail(`sections[${index}].type`, 'MERCHANDISING_SECTION_UNSUPPORTED');
        }
        if (typeof section['visible'] !== 'boolean')
            fail(`sections[${index}].visible`);
        const sortMode = section['sortMode'];
        if (typeof sortMode !== 'string' || !MERCHANDISING_SORT_MODES.includes(sortMode)) {
            fail(`sections[${index}].sortMode`, 'MERCHANDISING_SORT_UNSUPPORTED');
        }
        const limitRaw = section['limit'];
        const limit = typeof limitRaw === 'number' ? limitRaw : Number.NaN;
        if (!Number.isInteger(limit) || limit < MIN_GRID_LIMIT || limit > MAX_GRID_LIMIT)
            fail(`sections[${index}].limit`);
        const productIds = uuidList(section['productIds'], `sections[${index}].productIds`, MAX_GRID_PRODUCTS);
        const categoryIds = uuidList(section['categoryIds'], `sections[${index}].categoryIds`, 20);
        // 专题筛选只作用于动态排序的候选池（与分类筛选同层）；手工区块自己就是清单，不需要再筛。
        const collectionRaw = section['collectionId'];
        const collectionId = collectionRaw === undefined || collectionRaw === null || collectionRaw === ''
            ? null
            : (typeof collectionRaw === 'string' && UUID_PATTERN.test(collectionRaw))
                ? collectionRaw.toLowerCase() : fail(`sections[${index}].collectionId`);
        if (sortMode === 'manual') {
            // 手工排序：必须给商品清单；分类/专题筛选对手工顺序没有意义，一起拒绝。
            if (productIds.length === 0)
                fail(`sections[${index}].productIds`);
            if (categoryIds.length)
                fail(`sections[${index}].categoryIds`, 'MERCHANDISING_MODE_CONFLICT');
            if (collectionId)
                fail(`sections[${index}].collectionId`, 'MERCHANDISING_MODE_CONFLICT');
            if (productIds.length < limit)
                fail(`sections[${index}].limit`, 'MERCHANDISING_LIMIT_UNREACHABLE');
        }
        else if (productIds.length) {
            // 动态排序残留手工清单：清空而不是忽略，否则切换回手工时旧 id 会偷偷生效。
            fail(`sections[${index}].productIds`, 'MERCHANDISING_MODE_CONFLICT');
        }
        return { sectionId, type: type, visible: section['visible'], position: index,
            titleByLocale: titleByLocale(section['titleByLocale'], locales), sortMode: sortMode,
            limit, productIds, categoryIds, collectionId };
    });
}
/**
 * 发布前必须补齐：每个可见区块在店铺已启用的每种语言下都要有标题。
 * 标题是顾客看到的第一行字，缺一种语言就静默回退，等于线上少了一种语言。
 */
export function assertMerchandisingPublishable(sections, locales) {
    if (!sections.some(section => section.visible))
        fail('sections', 'MERCHANDISING_NO_VISIBLE_SECTION');
    for (const section of sections.filter(item => item.visible)) {
        for (const locale of locales) {
            if (!section.titleByLocale[locale])
                fail(`titleByLocale.${locale}`, 'MERCHANDISING_LOCALE_INCOMPLETE');
        }
    }
}
const time = (value) => value ? value.getTime() : 0;
/**
 * 动态排序。以 productId 作为最后一级比较，保证同值时顺序稳定：
 * 没有稳定兜底的「销量排序」会在每次刷新时换位置，运营和顾客都会觉得页面在抖。
 */
export function rankCandidates(candidates, sortMode) {
    const byId = (left, right) => left.productId.localeCompare(right.productId);
    const price = (value) => value.priceMinor === null ? Number.POSITIVE_INFINITY : value.priceMinor;
    const sorted = [...candidates];
    switch (sortMode) {
        case 'newest':
            return sorted.sort((left, right) => time(right.publishedAt) - time(left.publishedAt) || byId(left, right));
        case 'fulfilled_sales_30d':
            return sorted.sort((left, right) => right.unitsSold - left.unitsSold
                || time(right.publishedAt) - time(left.publishedAt) || byId(left, right));
        case 'price_asc':
            return sorted.sort((left, right) => price(left) - price(right) || byId(left, right));
        case 'price_desc':
            return sorted.sort((left, right) => {
                const leftPrice = price(left);
                const rightPrice = price(right);
                if (leftPrice === rightPrice)
                    return byId(left, right);
                // 「无价」永远排最后：价格倒序时不能把没有可售变体的商品顶到第一位。
                if (!Number.isFinite(leftPrice))
                    return 1;
                if (!Number.isFinite(rightPrice))
                    return -1;
                return rightPrice - leftPrice;
            });
        case 'manual':
            // 手工顺序由 productIds 决定，不参与规则排序。
            return sorted;
        default:
            return fail('sortMode', 'MERCHANDISING_SORT_UNSUPPORTED');
    }
}
export function merchandisingSnapshot(pageKey, version, sections, publishedAt) {
    return { pageKey, version, sections: structuredClone([...sections]), publishedAt: publishedAt.toISOString() };
}
/** 读取时再收敛一次上限：快照被手工改坏也不会把整站商品拖出来。 */
export function visibleLimit(section) {
    const limit = section.limit;
    return Number.isInteger(limit) ? Math.min(Math.max(limit, MIN_GRID_LIMIT), MAX_GRID_LIMIT) : MIN_GRID_LIMIT;
}
/** 区块标题：按语言取，缺失时退回默认语言，最后退回任意一种（快照不完整也不渲染空标题）。 */
export function sectionTitle(section, locale, defaultLocale) {
    return section.titleByLocale[locale] ?? section.titleByLocale[defaultLocale]
        ?? Object.values(section.titleByLocale)[0] ?? '';
}
