export class PaymentAdapterError extends Error {
    code;
    field;
    constructor(code, field) {
        super(field ? `${code}:${field}` : code);
        this.code = code;
        this.field = field;
        this.name = 'PaymentAdapterError';
    }
}
function fail(code, field) {
    throw new PaymentAdapterError(code, field);
}
export const ADAPTER_STATUSES = [
    'pending', 'authorized', 'succeeded', 'failed', 'cancelled', 'unknown',
];
/**
 * 常见渠道状态别名。新增渠道时优先用第二参数传自己的映射表，
 * 不要往这里堆——这张表只收"跨渠道通用"的叫法。
 */
const STATUS_ALIASES = {
    pending: 'pending',
    processing: 'pending',
    created: 'pending',
    initiated: 'pending',
    awaiting_payment: 'pending',
    requires_action: 'pending',
    authorized: 'authorized',
    requires_capture: 'authorized',
    success: 'succeeded',
    succeeded: 'succeeded',
    paid: 'succeeded',
    captured: 'succeeded',
    completed: 'succeeded',
    trade_success: 'succeeded',
    failed: 'failed',
    failure: 'failed',
    declined: 'failed',
    rejected: 'failed',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    expired: 'cancelled',
    voided: 'cancelled',
    unknown: 'unknown',
};
/**
 * 渠道状态归一化。**永不抛错**：无法识别时返回 unknown。
 * 理由：渠道新增状态不应让回调 5xx，否则会触发重试风暴；
 * 记 unknown + 告警 + 定时查询收敛，是唯一安全的降级路径。
 */
export function normalizeAdapterStatus(raw, extra) {
    if (typeof raw !== 'string')
        return 'unknown';
    const key = raw.trim().toLowerCase();
    if (!key.length || key.length > 64)
        return 'unknown';
    if (extra && Object.prototype.hasOwnProperty.call(extra, key)) {
        return extra[key];
    }
    return STATUS_ALIASES[key] ?? 'unknown';
}
/** 只有 succeeded 能推进为已收款；其余状态由调用方按状态机处理。 */
export function isSettled(status) {
    return status === 'succeeded';
}
// ---------------------------------------------------------------------------
// 幂等键
// ---------------------------------------------------------------------------
const PROVIDER_CODE = /^[a-z][a-z0-9_]{1,40}$/;
const EVENT_ID = /^[A-Za-z0-9._:@-]{1,120}$/;
/**
 * 回调幂等键：`provider:eventId`，直接作为 PaymentEvent.dedupeKey。
 * 渠道不给 eventId 时，调用方必须用 (单号+状态+时间戳) 派生，不允许留空——
 * 空键会让唯一约束失效，重复回调就会重复入账。
 */
export function webhookEventKey(providerCode, eventId) {
    if (typeof providerCode !== 'string' || !PROVIDER_CODE.test(providerCode)) {
        fail('WEBHOOK_PROVIDER_INVALID', 'providerCode');
    }
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
        fail('WEBHOOK_EVENT_ID_INVALID', 'eventId');
    }
    return `${providerCode}:${eventId}`;
}
/** 渠道缺 eventId 时的兜底派生：同单同状态同秒视为同一事件。 */
export function derivedEventId(providerTransactionId, status, occurredAt) {
    if (!EVENT_ID.test(providerTransactionId))
        fail('WEBHOOK_EVENT_ID_INVALID', 'providerTransactionId');
    if (Number.isNaN(occurredAt.getTime()))
        fail('WEBHOOK_EVENT_ID_INVALID', 'occurredAt');
    const stamp = occurredAt.toISOString().replace(/[-:.]/g, '').slice(0, 15);
    return `${providerTransactionId}.${status}.${stamp}`;
}
/**
 * 回调金额校验。缺金额、缺币种、不一致，全部拒绝推进状态。
 * 宁可人工对账，也不能凭一条没有金额的回调把钱记进来。
 */
export function assertWebhookAmount(input) {
    const { amountMinor, currency, expectedAmountMinor, expectedCurrency } = input;
    if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor < 1) {
        fail('WEBHOOK_AMOUNT_MISSING', 'amountMinor');
    }
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
        fail('WEBHOOK_CURRENCY_INVALID', 'currency');
    }
    if (currency !== expectedCurrency)
        fail('WEBHOOK_CURRENCY_MISMATCH', 'currency');
    if (amountMinor !== expectedAmountMinor)
        fail('WEBHOOK_AMOUNT_MISMATCH', 'amountMinor');
}
export const SECRET_SCHEMES = ['aws-sm', 'ssm', 'env', 'file'];
const SECRET_REF = /^secret:\/\/(aws-sm|ssm|env|file)\/([A-Za-z0-9._/-]{1,200})$/;
/**
 * 解析 `secret://<scheme>/<name>`。
 * 比 payments.ts 里那条更严格：scheme 必须落在四种之内，否则无法解析就等于无法收款。
 */
export function secretRefTarget(ref) {
    if (typeof ref !== 'string')
        fail('SECRET_REFERENCE_INVALID', 'secretRef');
    const match = SECRET_REF.exec(ref.trim());
    if (!match)
        fail('SECRET_REFERENCE_INVALID', 'secretRef');
    return { scheme: match[1], name: match[2] };
}
/**
 * 生产环境只允许走云密钥服务。
 * env 会被 `docker inspect` 看到，file 会进备份包——两者在单机生产都等于明文。
 */
export function assertSecretSchemeAllowed(scheme, environment) {
    if (environment !== 'production')
        return;
    if (scheme === 'env' || scheme === 'file')
        fail('SECRET_SCHEME_NOT_ALLOWED_IN_PRODUCTION', 'secretRef');
}
// ---------------------------------------------------------------------------
// 收银台可见性
// ---------------------------------------------------------------------------
/**
 * 前台是否展示该支付方式。三道门：启用、连接已验证、环境匹配。
 * 配错凭据时最坏结果是"看不见"，不是"下单必失败"。
 */
export function checkoutVisible(input) {
    if (!input.enabled)
        return false;
    // 数据库约束只认 unverified / ok / failed；只有 ok 才允许前台展示。
    if (input.connectionStatus !== 'ok')
        return false;
    return input.environment === input.requestEnvironment;
}
// ---------------------------------------------------------------------------
// 创建支付入参
// ---------------------------------------------------------------------------
const PAYMENT_NUMBER = /^PAY-\d{8}-[A-Z0-9]{6}$/;
const CURRENCY = /^[A-Z]{3}$/;
function assertUrl(value, field, requireHttps) {
    if (typeof value !== 'string' || value.length > 500)
        fail('URL_INVALID', field);
    let parsed = null;
    try {
        parsed = new URL(value);
    }
    catch {
        fail('URL_INVALID', field);
    }
    if (!parsed)
        fail('URL_INVALID', field);
    if (parsed.protocol !== 'https:' && (requireHttps || parsed.protocol !== 'http:')) {
        fail('URL_INVALID', field);
    }
    if (!parsed.hostname)
        fail('URL_INVALID', field);
    return value;
}
export function assertCreatePaymentInput(input, environment) {
    const { paymentNumber, orderNumber, amountMinor, currency, returnUrl, notifyUrl, locale } = input;
    if (typeof paymentNumber !== 'string' || !PAYMENT_NUMBER.test(paymentNumber)) {
        fail('PAYMENT_NUMBER_INVALID', 'paymentNumber');
    }
    if (typeof orderNumber !== 'string' || !orderNumber.trim().length || orderNumber.length > 64) {
        fail('ORDER_NUMBER_INVALID', 'orderNumber');
    }
    // 金额只认正整数分：0 元单不该走线上支付，负数就是攻击。
    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 1) {
        fail('AMOUNT_INVALID', 'amountMinor');
    }
    if (typeof currency !== 'string' || !CURRENCY.test(currency))
        fail('CURRENCY_INVALID', 'currency');
    // 生产必须 https：回调地址走明文等于把订单信息裸奔在公网。
    const https = environment === 'production';
    const checkedReturn = assertUrl(returnUrl, 'returnUrl', https);
    const checkedNotify = assertUrl(notifyUrl, 'notifyUrl', https);
    if (typeof locale !== 'string' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(locale)) {
        fail('LOCALE_INVALID', 'locale');
    }
    return {
        paymentNumber,
        orderNumber: orderNumber.trim(),
        amountMinor,
        currency,
        returnUrl: checkedReturn,
        notifyUrl: checkedNotify,
        locale,
    };
}
/**
 * 退款入参校验。三条硬约束：
 * 1. `refundNumber` 是渠道侧幂等键，必须是内部退款单号——用随机值重试就会退两次钱。
 * 2. 金额只认正整数分，且必须由调用方从台账读取，不接受任何外部传入。
 * 3. 必须有渠道交易号：没有它就没法定位要退哪一笔，宁可 422 也不能"试试看"。
 */
export function assertRefundInput(input) {
    const { refundNumber, providerTransactionId, amountMinor, currency, reason } = input;
    if (typeof refundNumber !== 'string' || !refundNumber.trim().length || refundNumber.length > 64) {
        fail('REFUND_NUMBER_INVALID', 'refundNumber');
    }
    if (typeof providerTransactionId !== 'string' || !providerTransactionId.trim().length
        || providerTransactionId.length > 128) {
        fail('PROVIDER_TRANSACTION_REQUIRED', 'providerTransactionId');
    }
    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 1) {
        fail('AMOUNT_INVALID', 'amountMinor');
    }
    if (typeof currency !== 'string' || !CURRENCY.test(currency))
        fail('CURRENCY_INVALID', 'currency');
    const text = typeof reason === 'string' ? reason.trim() : null;
    if (text !== null && text.length > 500)
        fail('REFUND_REASON_TOO_LONG', 'reason');
    return {
        refundNumber: refundNumber.trim(),
        providerTransactionId: providerTransactionId.trim(),
        amountMinor,
        currency,
        reason: text && text.length ? text : null,
    };
}
// ---------------------------------------------------------------------------
// metadata 防泄漏
// ---------------------------------------------------------------------------
/** 常见密钥形状：Stripe、AWS Access Key、PEM 私钥头、Bearer Token。 */
const SECRET_SHAPES = [
    /sk_(live|test)_[A-Za-z0-9]{8,}/,
    /pk_(live|test)_[A-Za-z0-9]{8,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+[A-Za-z0-9._-]{20,}/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];
export function containsSecretShape(value) {
    return SECRET_SHAPES.some(pattern => pattern.test(value));
}
/**
 * 落库/落日志前调用。递归检查字符串，命中即拒绝。
 * 这是最后一道闸：适配器作者不该被信任"我不会写错"。
 */
export function assertNoSecretShape(value, path = 'metadata', depth = 0) {
    if (depth > 6)
        fail('METADATA_TOO_DEEP', path);
    if (typeof value === 'string') {
        if (containsSecretShape(value))
            fail('METADATA_CONTAINS_SECRET', path);
        return;
    }
    if (value === null || typeof value !== 'object')
        return;
    if (Array.isArray(value)) {
        if (value.length > 200)
            fail('METADATA_TOO_LARGE', path);
        value.forEach((entry, index) => assertNoSecretShape(entry, `${path}[${index}]`, depth + 1));
        return;
    }
    const entries = Object.entries(value);
    if (entries.length > 50)
        fail('METADATA_TOO_LARGE', path);
    for (const [key, entry] of entries) {
        if (/secret|password|token|privatekey|apikey/i.test(key))
            fail('METADATA_FORBIDDEN_KEY', `${path}.${key}`);
        assertNoSecretShape(entry, `${path}.${key}`, depth + 1);
    }
}
