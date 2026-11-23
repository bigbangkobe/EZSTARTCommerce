/**
 * 付款（M08）领域规则。
 *
 * 与其它领域模块一样，这里只有判定与规范化，不碰数据库。三条底线：
 * 1. 金额只认订单总额：少收、多收、跨币种一律拒绝，不做“四舍五入对上了”。
 * 2. 状态只能沿渠道允许的方向走：已收不能回到待收，未知不能被人工改成失败。
 * 3. 数据库只存凭证引用，引用必须是 URI 形状；明文密钥根本不进这条链路。
 */
export class PaymentRuleError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
/**
 * 声明式抛出：用函数声明（而不是箭头常量）才能让 TypeScript 认出“这里之后不可达”，
 * 分支里的类型收窄才不会退化成 unknown。
 */
function fail(code) {
    throw new PaymentRuleError(code);
}
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/**
 * 已接入的支付方式白名单。新增服务商必须先在这里登记渠道类型与凭证要求，
 * 否则 PATCH /admin/payment-methods 会直接拒绝，避免配置出一个没有适配器的空壳渠道。
 *
 * `mock` 是支付适配器的联调通道，只在 sandbox 可用；它存在的意义是让
 * 创建支付→回调→退款整条链路在没有真实收单账号时也能被测试覆盖。
 */
export const providers = [
    { code: 'cod', channel: 'cod', label: 'Cash on delivery', requiresSecret: false },
    { code: 'manual_bank_transfer', channel: 'manual', label: 'Manual bank transfer', requiresSecret: false },
    { code: 'mock', channel: 'online', label: 'Mock gateway (sandbox only)', requiresSecret: false, sandboxOnly: true },
];
export function provider(code) {
    const found = providers.find(entry => entry.code === code);
    if (!found)
        fail('UNSUPPORTED_PAYMENT_PROVIDER');
    return found;
}
// ---------------------------------------------------------------------------
// 商品级收款渠道约束
// ---------------------------------------------------------------------------
/** 商品可配置的收款渠道全集；顺序即后台展示顺序。 */
export const PRODUCT_PAYMENT_CHANNELS = ['cod', 'manual', 'online'];
/**
 * 归一化商品的「允许收款渠道」。
 *
 * 空数组 = 不限，交给店铺默认（存量商品与未关心此事的商品都不受影响）。
 * 只在商品上表达「不许什么」，不在商品上表达「怎么收款」——具体怎么收仍由
 * 站点级支付方式配置决定，商品不能绕过审批开关私自开出一条收款通道。
 */
export function normalizeAllowedChannels(input) {
    if (input === undefined || input === null)
        return [];
    if (!Array.isArray(input))
        fail('VALIDATION_ERROR');
    if (input.length > PRODUCT_PAYMENT_CHANNELS.length)
        fail('VALIDATION_ERROR');
    const output = [];
    for (const entry of input) {
        if (typeof entry !== 'string' || !PRODUCT_PAYMENT_CHANNELS.includes(entry)) {
            fail('UNSUPPORTED_PAYMENT_PROVIDER');
        }
        if (!output.includes(entry))
            output.push(entry);
    }
    return output;
}
/**
 * 一单可用渠道 = 各商品允许集合的交集（空集合视为全集）。
 *
 * 这就是「整单按最严格」：只要有一件商品要求先付款，整单就不能货到付款，
 * 顾客仍可一次下单，只是可选方式被收窄——比逼顾客拆单更符合直觉。
 * 交集为空（一件只许 COD、另一件只许转账）时返回空集合，由调用方明确拒绝，
 * 不静默降级成某一种方式。
 */
export function availableChannelsFor(products) {
    let allowed = new Set(PRODUCT_PAYMENT_CHANNELS);
    for (const channels of products) {
        if (!channels.length)
            continue;
        allowed = new Set([...allowed].filter(channel => channels.includes(channel)));
    }
    return allowed;
}
/** 整单必须先收款才能发货：可用渠道里没有货到付款。 */
export function requiresPrepayment(available) {
    return !available.has('cod');
}
/** 每个渠道可以登记的结果：COD 没有“授权成功/渠道失败”，线上支付没有“拒收”。 */
const CHANNEL_OUTCOMES = {
    cod: ['collected', 'rejected', 'returned'],
    manual: ['collected', 'succeeded', 'cancelled', 'returned'],
    // failed 只对线上渠道开放：渠道侧拒绝、风控拦截、卡被拒都属于这一类，
    // 与 cancelled（用户主动取消）分开记，否则失败率统计会失真。
    online: ['succeeded', 'cancelled', 'returned', 'failed'],
};
/**
 * 状态机：只允许前进。`unknown` 没有人工出口——渠道没给结论时，
 * 后台不能把它改成失败或成功，必须先由服务端查询或回调给出结论。
 */
const TRANSITIONS = {
    pending: { collected: 'collected', succeeded: 'succeeded', rejected: 'rejected', cancelled: 'cancelled', failed: 'failed' },
    authorized: { collected: 'collected', succeeded: 'succeeded', cancelled: 'cancelled', failed: 'failed' },
    collected: { returned: 'returned' },
    succeeded: { returned: 'returned' },
    unknown: {},
};
export function nextPaymentStatus(current, outcome, channel) {
    const allowed = CHANNEL_OUTCOMES[channel];
    if (!allowed)
        fail('UNSUPPORTED_PAYMENT_PROVIDER');
    if (!allowed.includes(outcome))
        fail('PAYMENT_OUTCOME_NOT_ALLOWED');
    if (current === 'unknown')
        fail('PAYMENT_STATUS_UNKNOWN_REQUIRES_PROVIDER');
    const next = TRANSITIONS[current]?.[outcome];
    if (!next)
        fail('PAYMENT_STATE_CONFLICT');
    return next;
}
/**
 * 渠道结论收敛：`unknown` 只有渠道能给出结论，所以只有这条路径允许离开 unknown。
 *
 * 与 `nextPaymentStatus` 的区别是**谁在调用**，不是能走到哪一步：
 * 人工接口一律用 `nextPaymentStatus`，它会把 unknown 挡住；
 * 回调与对账用这个函数，因为它们带来的正是渠道结论。
 */
export function nextPaymentStatusFromProvider(current, outcome, channel) {
    if (current !== 'unknown')
        return nextPaymentStatus(current, outcome, channel);
    const allowed = CHANNEL_OUTCOMES[channel];
    if (!allowed)
        fail('UNSUPPORTED_PAYMENT_PROVIDER');
    if (!allowed.includes(outcome))
        fail('PAYMENT_OUTCOME_NOT_ALLOWED');
    // unknown 只可能收敛到终局，不存在"退回 unknown"或再停在中间态。
    if (outcome === 'succeeded' || outcome === 'collected')
        return 'succeeded';
    if (outcome === 'cancelled')
        return 'cancelled';
    if (outcome === 'rejected')
        return 'failed';
    if (outcome === 'returned')
        return 'returned';
    fail('PAYMENT_STATE_CONFLICT');
}
/** 订单上的付款状态：由台账状态投影而来，不单独维护一套。 */ export function orderPaymentStatusFor(status) {
    switch (status) {
        case 'collected': return 'collected';
        case 'succeeded': return 'succeeded';
        case 'rejected': return 'rejected';
        case 'returned': return 'returned';
        case 'cancelled': return 'cancelled';
        case 'failed': return 'failed';
        default: return 'processing';
    }
}
function optionalText(value, max, field) {
    if (value === undefined || value === null)
        return null;
    const text = value.trim();
    if (!text.length)
        return null;
    if (text.length > max || CONTROL.test(text))
        fail(field);
    return text;
}
/** 收款/拒收/退回/渠道失败登记入参。四种失败都必须写原因——钱去哪了要能解释。 */
export function normalizeOutcome(input, now = new Date()) {
    const outcome = input.outcome;
    if (typeof outcome !== 'string' || !['collected', 'succeeded', 'rejected', 'cancelled', 'returned', 'failed'].includes(outcome)) {
        fail('VALIDATION_ERROR');
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1)
        fail('VALIDATION_ERROR');
    if (typeof input.occurredAt !== 'string' || input.occurredAt.length > 40)
        fail('VALIDATION_ERROR');
    const occurredAt = new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime()))
        fail('VALIDATION_ERROR');
    // 未来时间会被用来伪造“早就收到了”，只给一分钟时钟偏差。
    if (occurredAt.getTime() > now.getTime() + 60_000)
        fail('VALIDATION_ERROR');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
        fail('VALIDATION_ERROR');
    if (input.reference !== undefined && input.reference !== null && typeof input.reference !== 'string')
        fail('VALIDATION_ERROR');
    if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string')
        fail('VALIDATION_ERROR');
    const reason = optionalText(input.reason, 1_000, 'VALIDATION_ERROR');
    if ((outcome === 'rejected' || outcome === 'returned' || outcome === 'failed') && !reason)
        fail('REASON_REQUIRED');
    return {
        outcome: outcome,
        amountMinor: input.amountMinor,
        occurredAt,
        reference: optionalText(input.reference, 200, 'VALIDATION_ERROR'),
        reason,
        expectedVersion: input.expectedVersion,
    };
}
/** 金额必须与台账、订单总额、订单币种同时一致；三项任一不符就不入账。 */
export function assertPaymentAmount(input) {
    if (input.currency !== input.orderCurrency)
        fail('PAYMENT_CURRENCY_MISMATCH');
    if (input.paymentAmountMinor !== input.orderTotalMinor)
        fail('PAYMENT_AMOUNT_MISMATCH');
    if (input.amountMinor !== input.orderTotalMinor)
        fail('PAYMENT_AMOUNT_MISMATCH');
}
/** 已取消的订单不再收钱；收款时间不能早于下单时间。 */
export function assertCollectable(order, occurredAt) {
    if (order.orderStatus === 'cancelled')
        fail('ORDER_ALREADY_CANCELLED');
    if (occurredAt.getTime() < order.placedAt.getTime())
        fail('PAYMENT_TIME_INVALID');
}
/** 货到付款是先交货再收钱：包裹没有离开仓库前不登记收款/拒收。 */
export function assertCodRequiresDispatch(channel, outcome, dispatched) {
    if (channel !== 'cod')
        return;
    if (outcome === 'returned' && dispatched)
        return;
    if (!dispatched)
        fail('ORDER_NOT_SHIPPED');
}
/** If-Match 语义的版本核对；与订单模块保持同一套错误码。 */
export function assertVersion(expected, actual) {
    if (!Number.isSafeInteger(expected) || expected < 1)
        fail('VALIDATION_ERROR');
    if (expected !== actual)
        fail('VERSION_CONFLICT');
}
/**
 * publicConfig 只接受显式白名单字段：这里放什么都不允许出现密钥形状的值。
 * `checkoutBase` 是收银台域名，会出现在跳转地址里，属公开信息——适配器要读它，
 * 不让配就等于把收银台地址写死在代码里。
 */
const PUBLIC_CONFIG_KEYS = ['accountSummary', 'instructions', 'defaultCurrency', 'providerAccountRef',
    'checkoutBase'];
const SECRET_REF = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._:/-]{1,200}$/;
export function normalizeMethodPatch(input, existing) {
    if (typeof input.providerCode !== 'string')
        fail('VALIDATION_ERROR');
    const definition = provider(input.providerCode);
    if (input.environment !== 'sandbox' && input.environment !== 'production')
        fail('VALIDATION_ERROR');
    // 沙箱专用渠道不能出现在生产配置里：假支付混进真实订单等于资损。
    if (definition.sandboxOnly && input.environment === 'production')
        fail('PAYMENT_PROVIDER_SANDBOX_ONLY');
    if (typeof input.enabled !== 'boolean')
        fail('VALIDATION_ERROR');
    const displayName = input.displayName === undefined
        ? existing?.displayName ?? definition.label
        : optionalText(input.displayName, 80, 'VALIDATION_ERROR');
    if (!displayName)
        fail('VALIDATION_ERROR');
    // 未提交批准依据表示“沿用原值”，显式传 null 表示撤销批准（同时必须停用）。
    const approvalReference = input.approvalReference === undefined
        ? existing?.approvalReference ?? null
        : optionalText(input.approvalReference, 200, 'VALIDATION_ERROR');
    // 凭证只收引用：`secret://prod/gateway` 可以，`sk_live_...` 这种真实密钥形状直接拒。
    let secretRef;
    if (input.secretRef === undefined)
        secretRef = existing?.secretRef ?? null;
    else if (input.secretRef === null)
        secretRef = null;
    else {
        const value = optionalText(input.secretRef, 256, 'SECRET_REFERENCE_INVALID');
        if (!value || !SECRET_REF.test(value))
            fail('SECRET_REFERENCE_INVALID');
        secretRef = value;
    }
    if (definition.requiresSecret && input.enabled && !secretRef)
        fail('PAYMENT_CREDENTIAL_REQUIRED');
    const publicConfig = input.publicConfig === undefined ? existing?.publicConfig ?? {} : normalizePublicConfig(input.publicConfig);
    return { providerCode: definition.code, environment: input.environment, displayName, enabled: input.enabled,
        approvalReference, publicConfig, secretRef };
}
export function normalizePublicConfig(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        fail('VALIDATION_ERROR');
    const entries = Object.entries(value);
    if (entries.length > 8)
        fail('VALIDATION_ERROR');
    const output = {};
    for (const [key, entry] of entries) {
        if (!PUBLIC_CONFIG_KEYS.includes(key))
            fail('PUBLIC_CONFIG_KEY_NOT_ALLOWED');
        if (typeof entry !== 'string')
            fail('VALIDATION_ERROR');
        const text = entry.trim();
        if (!text.length || text.length > 200 || CONTROL.test(text))
            fail('VALIDATION_ERROR');
        output[key] = text;
    }
    return output;
}
/** 启用即对外承诺可收款：没有批准依据就不能打开。 */
export function assertEnableAllowed(input) {
    if (!input.enabled)
        return;
    if (!input.approvalReference)
        fail('PAYMENT_APPROVAL_REQUIRED');
}
/** 台账号：PAY-YYYYMMDD-XXXXXX，日期按店铺时区由调用方算好。 */
export function paymentNumber(day, suffix) {
    if (!/^\d{8}$/.test(day))
        fail('VALIDATION_ERROR');
    if (!/^[A-Z0-9]{6}$/.test(suffix))
        fail('VALIDATION_ERROR');
    return `PAY-${day}-${suffix}`;
}
