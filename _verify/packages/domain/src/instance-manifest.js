/**
 * 实例配置源纯规则层（配置化前台与交付体系重做方案 P3）。
 *
 * 一份 instance.yaml 同时驱动部署参数、前台主题与业务规则，取代重复的人工录入。
 * 这里只回答「manifest 长什么样、怎么校验、哪些项阻断上线」，
 * 不碰数据库、不碰网络、不碰文件系统、不碰 YAML 解析（由 scripts 层负责读入）。
 *
 * 不变量（与 theme.ts / store.ts 同一纪律）：
 * 1. 字段闭集：市场语言、字体预设、首页区块、功能开关全部是注册表闭集，
 *    未登记的值在校验阶段就被拒绝，不允许流转到部署环节静默失效。
 * 2. 复用既有规则：语言/时区/市场码/功能开关复用 store.ts，视觉 tokens/区块复用 theme.ts，
 *    不另起一套枚举，避免 manifest 与运行时规则漂移。
 * 3. 校验不吞错：任何非法字段抛带字段码的 InstanceManifestError，绝不静默修正。
 * 4. 上线阻断独立于结构校验：结构合法 ≠ 可上线；交易/合规相关未签字项单独列为阻断。
 *    结构校验通过只是「格式对」，上线阻断检查通过才是「可以发布」。
 * 5. 版本固定：只接受受支持的 schemaVersion，未来升级显式迁移，不猜。
 */
import { THEME_SECTION_TYPES, FONT_PRESETS } from './theme.js';
import { SUPPORTED_LOCALES, FEATURE_FLAGS, normalizeMarketCode, isValidTimezone } from './store.js';
export class InstanceManifestError extends Error {
    field;
    code;
    constructor(field, code = 'MANIFEST_VALIDATION_ERROR') {
        super(field);
        this.field = field;
        this.code = code;
    }
}
function fail(field, code = 'MANIFEST_VALIDATION_ERROR') {
    throw new InstanceManifestError(field, code);
}
/** 目前支持的 manifest schema 版本；升级须显式迁移，不静默兼容。 */
export const SUPPORTED_SCHEMA_VERSIONS = [1];
/** 币种用 ISO 4217 三位大写字母；这里只校验形状，具体币种是否开通由后台市场档案决定。 */
const CURRENCY = /^[A-Z]{3}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const INSTANCE_ID = /^[a-z][a-z0-9-]{1,48}$/;
const LOCALE_SET = SUPPORTED_LOCALES;
const SECTION_SET = THEME_SECTION_TYPES;
const FONT_SET = FONT_PRESETS;
const FLAG_SET = FEATURE_FLAGS;
/** 上线阻断项清单：与 CLIENT_LAUNCH_INPUTS「上线阻断项」逐项对应。 */
export const LAUNCH_BLOCKERS = [
    'marketProductReview', // 市场/商品审查
    'paymentAccount', // 支付账户获批
    'shippingPricing', // 配送计费口径
    'taxInvoicePolicy', // 税费/发票口径
    'privacyOwner', // 隐私政策与资料请求责任人
    'adminAccount', // 管理员账号与 MFA
    'domainHttps', // 生产域名/HTTPS/索引策略
    'emailNotification', // 邮件通知
    'backupRestoreDrill', // 备份恢复演练
    'orderRefundDrill', // 生产订单与退款演练
];
const obj = (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(field);
    return value;
};
const str = (value, field, max = 200) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        fail(field);
    return value.trim();
};
const optStr = (value, field, max = 200) => {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string' || value.length > max)
        fail(field);
    return value;
};
const bool = (value, field) => {
    if (typeof value !== 'boolean')
        fail(field);
    return value;
};
const num = (value, field, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        fail(field);
    return value;
};
const strArray = (value, field, pattern, max = 32) => {
    if (!Array.isArray(value) || value.length > max)
        fail(field);
    return value.map((v, i) => {
        if (typeof v !== 'string' || !v.trim())
            fail(`${field}[${i}]`);
        if (pattern && !pattern.test(v))
            fail(`${field}[${i}]`);
        return v;
    });
};
const color = (value, field) => {
    if (typeof value !== 'string' || !HEX_COLOR.test(value))
        fail(field, 'MANIFEST_COLOR_INVALID');
    return value.toLowerCase();
};
function normalizeIdentity(value) {
    const r = obj(value, 'instance');
    const id = str(r.id, 'instance.id', 48);
    if (!INSTANCE_ID.test(id))
        fail('instance.id');
    const market = normalizeMarketCode(str(r.market, 'instance.market', 16));
    const currency = str(r.currency, 'instance.currency', 3);
    if (!CURRENCY.test(currency))
        fail('instance.currency');
    const timezone = str(r.timezone, 'instance.timezone', 100);
    if (!isValidTimezone(timezone))
        fail('instance.timezone', 'MANIFEST_TIMEZONE_INVALID');
    const locales = strArray(r.locales, 'instance.locales');
    for (const l of locales)
        if (!LOCALE_SET.includes(l))
            fail('instance.locales', 'MANIFEST_LOCALE_UNSUPPORTED');
    if (new Set(locales).size !== locales.length)
        fail('instance.locales', 'MANIFEST_LOCALE_DUPLICATE');
    const defaultLocale = str(r.defaultLocale, 'instance.defaultLocale', 16);
    if (!LOCALE_SET.includes(defaultLocale) || !locales.includes(defaultLocale))
        fail('instance.defaultLocale');
    const domain = str(r.domain, 'instance.domain', 253);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
        fail('instance.domain');
    return { id, domain, market, currency, timezone, locales, defaultLocale };
}
function normalizeBrand(value) {
    const r = obj(value, 'brand');
    const brand = { name: str(r.name, 'brand.name', 60) };
    for (const key of ['brandLatin', 'tagline', 'logo', 'favicon', 'whatsapp', 'whatsappGreeting']) {
        const v = optStr(r[key], `brand.${key}`, key === 'tagline' || key === 'whatsappGreeting' ? 200 : 60);
        if (v !== undefined)
            brand[key] = v;
    }
    return brand;
}
function normalizeTheme(value) {
    const r = obj(value, 'theme');
    const fontPair = str(r.fontPair, 'theme.fontPair', 40);
    if (!FONT_SET.includes(fontPair))
        fail('theme.fontPair', 'MANIFEST_FONT_UNSUPPORTED');
    return {
        primaryColor: color(r.primaryColor, 'theme.primaryColor'),
        inkColor: color(r.inkColor, 'theme.inkColor'),
        paperColor: color(r.paperColor, 'theme.paperColor'),
        fontPair,
        radius: num(r.radius, 'theme.radius', 0, 64),
    };
}
function normalizeStorefront(value) {
    const r = obj(value, 'storefront');
    if (!Array.isArray(r.homeSections) || r.homeSections.length > 12)
        fail('storefront.homeSections');
    const seen = new Set();
    const homeSections = r.homeSections.map((item, i) => {
        const s = obj(item, `storefront.homeSections[${i}]`);
        const type = str(s.type, `storefront.homeSections[${i}].type`, 40);
        if (!SECTION_SET.includes(type))
            fail(`storefront.homeSections[${i}].type`, 'MANIFEST_SECTION_UNSUPPORTED');
        if (seen.has(type))
            fail(`storefront.homeSections[${i}].type`, 'MANIFEST_SECTION_DUPLICATE');
        seen.add(type);
        const ref = { type };
        if (s.params !== undefined) {
            const p = obj(s.params, `storefront.homeSections[${i}].params`);
            const clean = {};
            for (const [key, v] of Object.entries(p)) {
                if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key))
                    fail(`storefront.homeSections[${i}].params.${key}`);
                if (typeof v === 'string' && v.length <= 200)
                    clean[key] = v;
                else if (typeof v === 'number' && Number.isFinite(v))
                    clean[key] = v;
                else if (typeof v === 'boolean')
                    clean[key] = v;
                else
                    fail(`storefront.homeSections[${i}].params.${key}`);
            }
            ref.params = clean;
        }
        return ref;
    });
    const navigation = strArray(r.navigation, 'storefront.navigation', /^[a-z][a-z0-9-]{0,31}$/, 16);
    return { homeSections, navigation };
}
function normalizeBusiness(value) {
    const r = obj(value, 'business');
    const payment = strArray(r.payment, 'business.payment', /^[a-z][a-z0-9_]{0,31}$/, 16);
    const ship = obj(r.shipping, 'business.shipping');
    const regions = strArray(ship.regions, 'business.shipping.regions', /^[A-Z0-9-]{2,16}$/, 32);
    const freeThreshold = num(ship.freeThreshold, 'business.shipping.freeThreshold', 0);
    const feat = obj(r.features, 'business.features');
    const features = {};
    for (const [key, v] of Object.entries(feat)) {
        if (!FLAG_SET.includes(key))
            fail(`business.features.${key}`, 'MANIFEST_FEATURE_UNSUPPORTED');
        features[key] = bool(v, `business.features.${key}`);
    }
    return { payment, shipping: { regions, freeThreshold }, features };
}
function normalizeCompliance(value) {
    const r = obj(value, 'compliance');
    const url = str(r.privacyPolicyUrl, 'compliance.privacyPolicyUrl', 500);
    if (!/^https?:\/\//.test(url))
        fail('compliance.privacyPolicyUrl');
    const signoffsRaw = obj(r.signoffs, 'compliance.signoffs');
    const signoffs = {};
    for (const [key, v] of Object.entries(signoffsRaw)) {
        if (!LAUNCH_BLOCKERS.includes(key))
            fail(`compliance.signoffs.${key}`, 'MANIFEST_BLOCKER_UNKNOWN');
        signoffs[key] = bool(v, `compliance.signoffs.${key}`);
    }
    return {
        privacyPolicyUrl: url,
        ageGateRequired: bool(r.ageGateRequired, 'compliance.ageGateRequired'),
        dataRetentionDays: num(r.dataRetentionDays, 'compliance.dataRetentionDays', 1, 36500),
        signoffs,
    };
}
function normalizeDeploy(value) {
    const r = obj(value, 'deploy');
    const cloud = obj(r.cloud, 'deploy.cloud');
    const backup = obj(r.backup, 'deploy.backup');
    const frequency = str(backup.frequency, 'deploy.backup.frequency', 20);
    if (!['hourly', 'daily', 'weekly'].includes(frequency))
        fail('deploy.backup.frequency', 'MANIFEST_BACKUP_FREQUENCY_INVALID');
    return {
        cloud: { provider: str(cloud.provider, 'deploy.cloud.provider', 40), region: str(cloud.region, 'deploy.cloud.region', 60) },
        backup: { frequency, retentionDays: num(backup.retentionDays, 'deploy.backup.retentionDays', 1, 3650) },
    };
}
/** 校验并归一化整份 manifest。任何非法字段抛 InstanceManifestError，绝不静默修正。 */
export function normalizeInstanceManifest(input) {
    const r = obj(input, 'manifest');
    // 版本号先做类型/范围校验，再做闭集检查：未知版本给专门错误码，便于上层提示迁移路径。
    const version = num(r.schemaVersion, 'schemaVersion', 1, Number.MAX_SAFE_INTEGER);
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(version))
        fail('schemaVersion', 'MANIFEST_VERSION_UNSUPPORTED');
    return {
        schemaVersion: version,
        instance: normalizeIdentity(r.instance),
        brand: normalizeBrand(r.brand),
        theme: normalizeTheme(r.theme),
        storefront: normalizeStorefront(r.storefront),
        business: normalizeBusiness(r.business),
        compliance: normalizeCompliance(r.compliance),
        deploy: normalizeDeploy(r.deploy),
    };
}
/** 列出全部上线阻断项的签字状态；未列出的阻断项一律视为未签字。 */
export function launchBlockerStatus(manifest) {
    return LAUNCH_BLOCKERS.map((key) => ({ key, signed: manifest.compliance.signoffs[key] === true }));
}
/** 未签字的阻断项；为空才允许进入生产发布。 */
export function unsignedBlockers(manifest) {
    return launchBlockerStatus(manifest).filter((s) => !s.signed).map((s) => s.key);
}
export function canLaunch(manifest) {
    return unsignedBlockers(manifest).length === 0;
}
