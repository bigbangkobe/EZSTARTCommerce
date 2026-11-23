/**
 * 购物车与结账（M06）纯规则层。
 *
 * 这里只做“能不能算、算得对不对”，不碰数据库、不发网络请求：
 * 数量、联系方式、地址、优惠码、运费、报价金额不变量、订单号与幂等指纹都在此收敛。
 * 金额一律整数最小货币单位；任何浮点数、负数或“总额 ≠ 分项之和”都会在这里被拒。
 */
export class CheckoutRuleError extends Error {
    field;
    code;
    constructor(field, code = 'VALIDATION_ERROR') {
        super(field);
        this.field = field;
        this.code = code;
    }
}
function fail(field, code) { throw new CheckoutRuleError(field, code); }
/** 与开发规格“结账单行数量 1–99”一致；购物车与报价共用同一边界。 */
export const MAX_CART_QUANTITY = 99;
/** 单个购物袋最多 50 行：防止一次请求把整本目录塞进报价快照。 */
export const MAX_CART_LINES = 50;
/** 报价默认 15 分钟有效；过期后必须重新报价，不能拿旧价下单。 */
export const QUOTE_TTL_SECONDS = 900;
export const MAX_ORDER_NOTE = 1_000;
const MAX_POLICY_ACCEPTANCES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+()\d][\d\s()+-]{4,31}$/;
const COUNTRY = /^[A-Z]{2}$/;
const ORDER_NUMBER = /^EZ-[0-9]{8}-[A-Z0-9]{6}$/;
export function isUuid(value) { return UUID.test(value); }
/** 数量必须是整数且在 1–99 内；字符串数字不接受，避免 "2" 与 2 在库存扣减上分叉。 */
export function normalizeQuantity(value) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_CART_QUANTITY)
        fail('quantity');
    return value;
}
function text(value, field, max, required = false) {
    if (value === undefined || value === null) {
        if (required)
            fail(field);
        return null;
    }
    if (typeof value !== 'string')
        fail(field);
    const trimmed = value.trim();
    if (!trimmed.length) {
        if (required)
            fail(field);
        return null;
    }
    if (trimmed.length > max)
        fail(field);
    return trimmed;
}
/**
 * 联系方式：邮箱与电话至少一个有效非空。
 * 只有空白字符不算“有”，两者都空时不能报价——订单通知必须有落点。
 */
export function normalizeContact(input) {
    const email = text(input.email, 'contact.email', 254);
    const phone = text(input.phone, 'contact.phone', 32);
    const fullName = text(input.fullName, 'contact.fullName', 120);
    if (email !== null && !EMAIL.test(email))
        fail('contact.email');
    if (phone !== null && !PHONE.test(phone))
        fail('contact.phone');
    if (email === null && phone === null)
        fail('contact');
    return { email, phone, fullName };
}
/** 地址只作为报价/订单快照保存，不做地理编码；国家码统一大写后校验两位字母。 */
export function normalizeAddress(input, required = true) {
    if (!input || typeof input !== 'object')
        fail('shippingAddress');
    const countryCode = input.countryCode;
    if (typeof countryCode !== 'string')
        fail('shippingAddress.countryCode');
    const normalizedCountry = countryCode.trim().toUpperCase();
    if (!COUNTRY.test(normalizedCountry))
        fail('shippingAddress.countryCode');
    const addressLine1 = text(input.addressLine1, 'shippingAddress.addressLine1', 200, required);
    if (required && addressLine1 === null)
        fail('shippingAddress.addressLine1');
    return {
        recipientName: text(input.recipientName, 'shippingAddress.recipientName', 120),
        phone: text(input.phone, 'shippingAddress.phone', 32),
        countryCode: normalizedCountry,
        regionCode: text(input.regionCode, 'shippingAddress.regionCode', 80),
        city: text(input.city, 'shippingAddress.city', 120),
        district: text(input.district, 'shippingAddress.district', 120),
        addressLine1: addressLine1 ?? '',
        addressLine2: text(input.addressLine2, 'shippingAddress.addressLine2', 200),
        postalCode: text(input.postalCode, 'shippingAddress.postalCode', 32),
    };
}
/** 优惠码 trim + uppercase；每单最多一个，空串按“未使用”处理。 */
export function normalizeCouponCode(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string')
        fail('couponCode');
    const code = value.trim().toUpperCase();
    if (!code.length)
        return null;
    if (code.length > 80 || /\s/.test(code))
        fail('couponCode');
    return code;
}
export function normalizePolicyAcceptances(items) {
    if (items === undefined)
        return [];
    if (!Array.isArray(items) || items.length > MAX_POLICY_ACCEPTANCES)
        fail('policyAcceptances');
    const seen = new Set();
    return items.map(item => {
        if (!item || typeof item !== 'object')
            fail('policyAcceptances');
        const key = text(item.policyKey, 'policyAcceptances.policyKey', 80, true);
        if (seen.has(key))
            fail('policyAcceptances'); // 同一政策只认一条，重复声明可能是绕过版本检查
        seen.add(key);
        if (item.accepted !== true)
            fail('policyAcceptances'); // 显式拒绝不能当作同意
        const version = text(item.version, 'policyAcceptances.version', 40, true);
        return { policyKey: key, version, accepted: true };
    });
}
/** 配送区是否覆盖地址：国家必须命中；区域码非空时还要求地址区域在列表内。 */
export function zoneCovers(zone, address) {
    if (!zone.countryCodes.includes(address.countryCode))
        return false;
    if (!zone.regionCodes.length)
        return true;
    return address.regionCode !== null && zone.regionCodes.includes(address.regionCode);
}
/**
 * 首期只支持固定运费与金额门槛免邮：
 * 小计达到免邮线时运费为 0，否则取固定费。费率币种必须与报价币种一致（服务层校验）。
 */
export function shippingFeeMinor(rate, subtotalMinor) {
    if (!Number.isInteger(subtotalMinor) || subtotalMinor < 0)
        fail('subtotalMinor');
    if (!Number.isInteger(rate.fixedFeeMinor) || rate.fixedFeeMinor < 0)
        fail('shippingMethodId');
    if (rate.freeAboveMinor !== null && (!Number.isInteger(rate.freeAboveMinor) || rate.freeAboveMinor < 0))
        fail('shippingMethodId');
    if (rate.freeAboveMinor !== null && subtotalMinor >= rate.freeAboveMinor)
        return 0;
    return rate.fixedFeeMinor;
}
/**
 * 报价金额不变量：分项都非负、折扣不超过小计、总额恰好等于分项之和。
 * 这条检查同时保护“服务端自己算错”的情况——算错也不能写进不可变快照。
 */
export function assertQuoteMath(amounts) {
    for (const field of ['subtotalMinor', 'discountMinor', 'shippingMinor', 'taxMinor', 'totalMinor']) {
        const value = amounts[field];
        if (!Number.isInteger(value) || value < 0)
            fail(field);
    }
    const pointsValue = amounts.pointsValueMinor ?? 0;
    if (!Number.isInteger(pointsValue) || pointsValue < 0)
        fail('pointsValueMinor');
    if (amounts.discountMinor > amounts.subtotalMinor)
        fail('discountMinor');
    if (pointsValue > amounts.subtotalMinor - amounts.discountMinor)
        fail('pointsValueMinor');
    const expected = amounts.subtotalMinor - amounts.discountMinor - pointsValue + amounts.shippingMinor + amounts.taxMinor;
    if (expected !== amounts.totalMinor)
        fail('totalMinor');
}
export function quoteExpiry(now) {
    return new Date(now.getTime() + QUOTE_TTL_SECONDS * 1_000);
}
/** 订单确认必须提交报价当前版本：报价被重新计算过就不能按旧版本下单。 */
export function assertQuoteVersion(storedVersion, confirmedVersion) {
    if (!Number.isInteger(confirmedVersion) || confirmedVersion < 1)
        fail('confirmedQuoteVersion');
    if (storedVersion !== confirmedVersion)
        fail('confirmedQuoteVersion', 'QUOTE_VERSION_CONFLICT');
}
export function assertQuoteActive(status, expiresAt, now) {
    if (status !== 'active')
        fail('quoteId', 'QUOTE_NOT_AVAILABLE');
    if (expiresAt.getTime() <= now.getTime())
        fail('quoteId', 'QUOTE_EXPIRED');
}
/** 对外订单号：日期 + 6 位随机后缀，便于人工沟通，不含顾客或金额信息。 */
export function publicOrderNumber(day, suffix) {
    if (!/^[0-9]{8}$/.test(day))
        fail('day');
    if (!/^[A-Z0-9]{6}$/.test(suffix))
        fail('suffix');
    const number = `EZ-${day}-${suffix}`;
    if (!ORDER_NUMBER.test(number))
        fail('orderNumber');
    return number;
}
/**
 * 幂等指纹只看“决定订单是什么”的字段，不看传输顺序或空白差异。
 * 同一 key 配不同指纹 = 客户端复用了 key，必须 409 而不是悄悄覆盖。
 */
export function orderRequestFingerprint(input) {
    return [input.quoteId.trim().toLowerCase(), String(input.confirmedQuoteVersion),
        input.paymentMethodCode.trim().toLowerCase(), input.customerNote ?? ''].join('\u0000');
}
