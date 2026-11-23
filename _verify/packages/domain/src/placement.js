/**
 * 区块陈列效果分析（M14 P1）纯规则层。
 *
 * 只回答四件事：区块/发布版本的标识怎么校验、加购归因怎么取舍、
 * 退款怎么分摊到订单行、采集覆盖状态怎么判定。不碰数据库、不碰网络。
 *
 * 安全与口径不变量（对应 docs/modules/M14_REPORTS.md 的 D 段）：
 * 1. 归因只用匿名 interaction_id 关联加购与订单行，绝不按邮箱/电话/客户 ID 匹配。
 * 2. 一个订单行只归因给一个区块：取**下单前 24 小时内最后一次**有效区块交互；
 *    更早的、未来的、跨购物袋的交互一律不归因。
 * 3. 净实收只算商品行金额：lineTotalMinor 已含订单级优惠按行分摊（结账时写入），
 *    排除配送费/税费/支付手续费；退款按订单行金额比例分摊，分币余数按固定行序分配。
 * 4. 曝光/点击的会话去重键是 sessionId+pageKey+sectionKey，避免滚动重复计数。
 * 5. 覆盖状态区分「无前台访问」「埋点未采集」「采集正常」，不把未知当 0 曝光。
 */
export class PlacementRuleError extends Error {
    field;
    code;
    constructor(field, code = 'VALIDATION_ERROR') {
        super(field);
        this.field = field;
        this.code = code;
    }
}
function fail(field, code = 'VALIDATION_ERROR') { throw new PlacementRuleError(field, code); }
/** 区块报表口径版本：归因窗口/退款分摊/覆盖判定变了必须升版本。 */
export const PLACEMENT_METRIC_VERSION = '1.0';
/** 归因规则版本：写进归因行，便于事后解释「当时按什么规则归的」。 */
export const PLACEMENT_RULE_VERSION = 'placement:1.0';
/** 归因窗口：下单前 24 小时内的最后一次区块交互。 */
export const PLACEMENT_ATTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 曝光会话低于此值时阶段转化率不展示（"数据不足"）。 */
export const PLACEMENT_MIN_IMPRESSION_SESSIONS = 20;
/** 事件时钟容差：超过 30 天的 occurredAt 视为脏数据，不参与归因。 */
const MAX_SKEW_MS = 30 * 86_400_000;
/** 稳定区块键：形如 home.hero / plp.category.1；跨发布版本不许改。 */
export const SECTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
/** 区块实例 ID：页面 + 区块的一次具体呈现，允许冒号分隔，仍禁止 URL/HTML 字符。 */
export const SECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** 展示位/发布版本标识：短标识，禁止空格与路径字符。 */
export const PLACEMENT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const PLACEMENT_ENVIRONMENTS = ['production', 'preview', 'staff', 'sandbox'];
export const PLACEMENT_TRAFFIC_CLASSES = ['human', 'suspected_bot'];
function token(value, field, pattern, max) {
    if (typeof value !== 'string' || value.length < 1 || value.length > max)
        fail(field);
    if (!pattern.test(value))
        fail(field);
    return value;
}
function optionalToken(value, field, pattern, max) {
    if (value === undefined || value === null || value === '')
        return null;
    return token(value, field, pattern, max);
}
export function assertSectionKey(value) {
    return token(value, 'sectionKey', SECTION_KEY_PATTERN, 64);
}
export function assertSectionId(value) {
    return token(value, 'sectionId', SECTION_ID_PATTERN, 128);
}
export function assertPlacementId(value) {
    return optionalToken(value, 'placementId', PLACEMENT_TOKEN_PATTERN, 64);
}
export function assertPublishVersionId(value) {
    return token(value, 'publishVersionId', PLACEMENT_TOKEN_PATTERN, 64);
}
/** interaction_id 与 sessionId 同形态：随机高熵串，禁止邮箱/URL 字符。 */
export function assertInteractionId(value) {
    if (typeof value !== 'string' || value.length < 16 || value.length > 128)
        fail('interactionId');
    if (!/^[A-Za-z0-9_-]+$/.test(value))
        fail('interactionId');
    return value;
}
export function assertEnvironment(value) {
    if (typeof value !== 'string' || !PLACEMENT_ENVIRONMENTS.includes(value))
        fail('environment');
    return value;
}
export function assertTrafficClass(value) {
    if (typeof value !== 'string' || !PLACEMENT_TRAFFIC_CLASSES.includes(value))
        fail('trafficClass');
    return value;
}
/**
 * 加购归因入参规范化。
 *
 * 只接受明示同意（granted）的归因：未同意时返回 null，加购照常成功但不写归因——
 * 未获同意的追踪不得进入陈列指标，也不能靠加购接口绕过同意门槛。
 */
export function normalizeCartAttribution(raw, now = new Date()) {
    if (raw === undefined || raw === null)
        return null;
    if (typeof raw !== 'object' || Array.isArray(raw))
        fail('attribution');
    const value = raw;
    if (value['consentState'] !== 'granted')
        return null;
    const occurredAt = value['occurredAt'];
    let at = now;
    if (occurredAt !== undefined && occurredAt !== null) {
        if (typeof occurredAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(occurredAt))
            fail('occurredAt');
        const parsed = new Date(occurredAt);
        if (Number.isNaN(parsed.getTime()))
            fail('occurredAt');
        if (Math.abs(parsed.getTime() - now.getTime()) > MAX_SKEW_MS)
            fail('occurredAt');
        at = parsed;
    }
    return {
        sectionId: assertSectionId(value['sectionId']),
        sectionKey: assertSectionKey(value['sectionKey']),
        placementId: assertPlacementId(value['placementId']),
        publishVersionId: assertPublishVersionId(value['publishVersionId']),
        interactionId: assertInteractionId(value['interactionId']),
        pageKey: optionalToken(value['pageKey'], 'pageKey', /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, 128),
        sessionId: value['sessionId'] === undefined || value['sessionId'] === null ? null
            : (typeof value['sessionId'] === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value['sessionId'])
                ? value['sessionId'] : fail('sessionId')),
        consentState: 'granted',
        occurredAt: at,
    };
}
/** 归因窗口：交互必须发生在下单前 24 小时内，未来时间不算有效交互。 */
export function attributionWithinWindow(interactedAt, orderedAt) {
    const delta = orderedAt.getTime() - interactedAt.getTime();
    return delta >= 0 && delta <= PLACEMENT_ATTRIBUTION_WINDOW_MS;
}
/**
 * 同一订单行候选归因的取舍：取窗口内**最后一次**交互。
 * 时间相同按 id 稳定排序，保证同一批数据每次结果一致。
 */
export function pickAttribution(candidates, orderedAt) {
    const eligible = candidates.filter(candidate => attributionWithinWindow(candidate.occurredAt, orderedAt));
    if (!eligible.length)
        return null;
    const [latest] = [...eligible].sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || left.id.localeCompare(right.id));
    return latest ?? null;
}
/**
 * 退款按订单行金额比例分摊；分币余数按固定行序（传入顺序）逐行补 1 分。
 * 没有任何行金额时全部落到第一行，绝不凭空丢弃退款金额。
 */
export function allocateRefund(orderItems, refundMinor) {
    const allocation = new Map();
    if (!orderItems.length)
        return allocation;
    if (!Number.isSafeInteger(refundMinor) || refundMinor <= 0) {
        for (const item of orderItems)
            allocation.set(item.id, 0);
        return allocation;
    }
    const total = orderItems.reduce((sum, item) => sum + Math.max(0, item.lineTotalMinor), 0);
    if (total <= 0) {
        const [first] = orderItems;
        for (const item of orderItems)
            allocation.set(item.id, 0);
        if (first)
            allocation.set(first.id, refundMinor);
        return allocation;
    }
    let assigned = 0;
    for (const item of orderItems) {
        const share = Math.floor(refundMinor * Math.max(0, item.lineTotalMinor) / total);
        allocation.set(item.id, share);
        assigned += share;
    }
    let remainder = refundMinor - assigned;
    for (const item of orderItems) {
        if (remainder <= 0)
            break;
        allocation.set(item.id, (allocation.get(item.id) ?? 0) + 1);
        remainder -= 1;
    }
    return allocation;
}
/** 订单行净实收：行金额（已含订单级优惠分摊）减该行成功退款分摊，不为负。 */
export function netRevenueMinor(lineTotalMinor, refundMinor) {
    if (!Number.isSafeInteger(lineTotalMinor) || !Number.isSafeInteger(refundMinor))
        fail('amountMinor');
    return Math.max(0, lineTotalMinor - Math.max(0, refundMinor));
}
/** 曝光会话去重键：同一会话在同一页面的同一区块只计一次曝光。 */
export function impressionKey(sessionId, pageKey, sectionKey) {
    return `${sessionId}\u0000${pageKey ?? ''}\u0000${sectionKey}`;
}
/**
 * 覆盖状态判定：
 * - 区间内没有任何页面访问 → no_traffic（没有前台流量，不能判定埋点故障）；
 * - 有访问但没有任何区块事件 → tracking_missing（主题未接入标准埋点）；
 * - 只有点击没有曝光 → partial（曝光观察器未生效/被拦截）；
 * - 最近区块事件早于区间结束 48 小时 → stale（采集中断）；
 * - 否则 ok。
 */
export function placementCoverage(input) {
    if (input.pageViewSessions <= 0) {
        return { status: 'no_traffic', note: '该时段没有前台访问会话，无法判定区块埋点是否正常。' };
    }
    if (input.sectionEvents <= 0) {
        return { status: 'tracking_missing', note: '有前台访问但没有任何区块事件：当前主题可能未接入标准区块埋点。' };
    }
    if (input.impressionSessions <= 0) {
        return { status: 'partial', note: '只收到区块点击、没有曝光事件：曝光观察器可能未生效或被拦截。' };
    }
    const staleBefore = input.to.getTime() - 48 * 60 * 60 * 1000;
    if (input.lastSectionEventAt && input.lastSectionEventAt.getTime() < staleBefore) {
        return { status: 'stale', note: '最近一条区块事件早于区间结束 48 小时，采集可能已中断。' };
    }
    return { status: 'ok', note: '区块埋点采集正常。' };
}
/** 阶段转化率：分母是曝光会话；不足 20 个曝光会话时返回 null（数据不足）。 */
export function placementRatio(numerator, denominator) {
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator))
        return null;
    if (denominator < PLACEMENT_MIN_IMPRESSION_SESSIONS || denominator <= 0)
        return null;
    return Math.round((numerator / denominator) * 10_000) / 100;
}
