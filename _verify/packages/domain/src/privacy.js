/**
 * 顾客资料请求（隐私请求）的纯规则。
 *
 * 这套规则的核心不是「怎么处理」，而是「什么时候不许处理」：
 * 1. 未核验身份的请求不得进入 approved/completed——否则就是凭一封邮件导出别人的资料。
 * 2. 状态只能按固定方向前进，终态不可回退；「完成」必须留下完成时间与决定原因。
 * 3. 到期是受理时的快照（受理时间 + 店铺口径天数），逾期只影响提醒与排序，不会自动变成已完成。
 * 4. 删除/匿名化完成时必须记下保留例外依据：订单、支付、售后等交易事实不随请求消失。
 */
export class PrivacyRuleError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'PrivacyRuleError';
    }
}
export const PRIVACY_RULE_VERSION = 'privacy-v1';
export const PRIVACY_REQUEST_TYPES = ['access', 'export', 'correct', 'withdraw_marketing', 'delete', 'anonymize'];
export const PRIVACY_SOURCE_CHANNELS = ['email', 'phone', 'admin', 'storefront'];
/** received：已受理；verified：身份已核验；approved：已批准待处置；needs_information：等顾客补材料。 */
export const PRIVACY_STATUSES = ['received', 'verified', 'approved', 'needs_information', 'rejected', 'completed'];
export const PRIVACY_DECISIONS = ['approved', 'rejected', 'needs_information', 'completed'];
const MAX_SCOPE_ITEMS = 20;
const MAX_SCOPE_LENGTH = 80;
const MAX_REF_LENGTH = 200;
const MAX_REASON_LENGTH = 1_000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(code) { throw new PrivacyRuleError(code); }
function text(value, code, max) {
    if (typeof value !== 'string')
        fail(code);
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > max)
        fail(code);
    return trimmed;
}
function optionalText(value, code, max) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string')
        fail(code);
    const trimmed = value.trim();
    if (trimmed.length > max)
        fail(code);
    return trimmed.length ? trimmed : null;
}
function timestamp(value, code) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime()))
            fail(code);
        return value;
    }
    if (typeof value !== 'string')
        fail(code);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        fail(code);
    return parsed;
}
export function normalizePrivacyRequestInput(body) {
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const requestType = input.requestType;
    if (typeof requestType !== 'string' || !PRIVACY_REQUEST_TYPES.includes(requestType)) {
        fail('PRIVACY_REQUEST_TYPE_INVALID');
    }
    const sourceChannel = input.sourceChannel;
    if (typeof sourceChannel !== 'string' || !PRIVACY_SOURCE_CHANNELS.includes(sourceChannel)) {
        fail('PRIVACY_SOURCE_CHANNEL_INVALID');
    }
    const scope = input.scope;
    if (!Array.isArray(scope))
        fail('PRIVACY_SCOPE_INVALID');
    if (scope.length > MAX_SCOPE_ITEMS)
        fail('PRIVACY_SCOPE_INVALID');
    const items = [];
    for (const item of scope) {
        const trimmed = text(item, 'PRIVACY_SCOPE_INVALID', MAX_SCOPE_LENGTH);
        if (!items.includes(trimmed))
            items.push(trimmed);
    }
    return { requestType: requestType, sourceChannel: sourceChannel,
        customerRef: optionalText(input.customerRef, 'PRIVACY_CUSTOMER_REF_INVALID', MAX_REF_LENGTH), scope: items };
}
/** 受理日按 UTC 取，与会员号同口径：单号里的日期只是给人看的分组，不承载时区语义。 */
export function privacyDay(now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
        fail('PRIVACY_TIME_INVALID');
    return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}
export function privacyRequestNumber(day, sequence) {
    if (!/^[0-9]{8}$/.test(day))
        fail('PRIVACY_NUMBER_INVALID');
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9_999)
        fail('PRIVACY_NUMBER_INVALID');
    return `PR-${day}-${String(sequence).padStart(4, '0')}`;
}
export function normalizeDueDays(value) {
    if (!Number.isInteger(value) || value < 1 || value > 365)
        fail('PRIVACY_DUE_DAYS_INVALID');
    return value;
}
/** 到期时间是受理时的快照：之后改口径只影响新受理的请求。 */
export function dueAtFrom(receivedAt, dueDays) {
    if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime()))
        fail('PRIVACY_TIME_INVALID');
    return new Date(receivedAt.getTime() + normalizeDueDays(dueDays) * DAY_MS);
}
/** 逾期天数：未到期返回 0。向下取整，所以「昨天到期」是逾期 1 天。 */
export function overdueDays(dueAt, now) {
    if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime()))
        fail('PRIVACY_TIME_INVALID');
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
        fail('PRIVACY_TIME_INVALID');
    const elapsed = now.getTime() - dueAt.getTime();
    return elapsed <= 0 ? 0 : Math.floor(elapsed / DAY_MS) || 1;
}
// ---- 状态机 -----------------------------------------------------------------
const TRANSITIONS = {
    // 未核验也能直接拒绝（明显是骚扰或与本店无关），但拒绝不是处置，不接触任何资料。
    received: ['verified', 'rejected'],
    verified: ['approved', 'rejected', 'needs_information', 'completed'],
    // 人还是那个人，补的是材料不是身份：收到补充后直接决定，不重新核验。
    needs_information: ['approved', 'rejected', 'completed'],
    approved: ['completed'],
    rejected: [],
    completed: [],
};
export function canTransition(from, to) {
    return TRANSITIONS[from]?.includes(to) ?? false;
}
export function assertPrivacyTransition(from, to) {
    if (!PRIVACY_STATUSES.includes(from))
        fail('PRIVACY_STATUS_INVALID');
    if (!PRIVACY_STATUSES.includes(to))
        fail('PRIVACY_STATUS_INVALID');
    if (!canTransition(from, to))
        fail('PRIVACY_STATUS_CONFLICT');
}
export function decisionStatus(decision) {
    if (!PRIVACY_DECISIONS.includes(decision))
        fail('PRIVACY_DECISION_INVALID');
    return decision;
}
export function isTerminal(status) {
    return status === 'rejected' || status === 'completed';
}
/** 进入处置阶段的两个状态：都要求先核验身份。 */
export function requiresVerifiedIdentity(status) {
    return status === 'approved' || status === 'completed';
}
/** 核验只记录「核验通过」；核验不通过走决定 rejected，避免把「查无此人」写进核验记录。 */
export function normalizePrivacyVerification(body) {
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
    return { verificationMethod: text(input.verificationMethod, 'PRIVACY_VERIFICATION_INVALID', 80),
        evidenceRef: text(input.evidenceRef, 'PRIVACY_VERIFICATION_INVALID', MAX_REF_LENGTH),
        reason: text(input.reason, 'PRIVACY_VERIFICATION_INVALID', MAX_REASON_LENGTH) };
}
/** 完成删除/匿名化必须记下保留例外：交易事实不随请求消失，依据要能指出来。 */
export const RETENTION_REQUIRED_TYPES = ['delete', 'anonymize'];
/** 只有查阅与导出请求会产出工件；删除、退订等请求生成快照等于多留一份副本。 */
export const PRIVACY_EXPORT_REQUEST_TYPES = ['access', 'export'];
export const PRIVACY_DISPOSITION_RULE_VERSION = 'privacy-disposition-v1';
export const PRIVACY_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
export const MARKETING_CONSENT_CHANNELS = ['email', 'sms', 'phone', 'push'];
export function assertExportAllowed(requestType) {
    if (!PRIVACY_EXPORT_REQUEST_TYPES.includes(requestType))
        fail('PRIVACY_EXPORT_NOT_ALLOWED');
}
/** 匿名名保留可追溯的前缀，但不再包含邮箱本地部分、电话或顾客自填姓名。 */
export function anonymizedDisplayName(customerId) {
    if (typeof customerId !== 'string' || !UUID.test(customerId))
        fail('PRIVACY_CUSTOMER_REQUIRED');
    return `Anonymized ${customerId.slice(0, 8)}`;
}
export function normalizePrivacyDecision(body, requestType) {
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const decision = input.decision;
    if (typeof decision !== 'string' || !PRIVACY_DECISIONS.includes(decision))
        fail('PRIVACY_DECISION_INVALID');
    const reason = text(input.reason, 'PRIVACY_DECISION_INVALID', MAX_REASON_LENGTH);
    const retentionExceptionRef = optionalText(input.retentionExceptionRef, 'PRIVACY_DECISION_INVALID', MAX_REF_LENGTH);
    const rawExport = input.exportJobId;
    let exportJobId = null;
    if (rawExport !== undefined && rawExport !== null) {
        if (typeof rawExport !== 'string' || !UUID.test(rawExport))
            fail('PRIVACY_DECISION_INVALID');
        exportJobId = rawExport;
    }
    if (decision === 'completed' && RETENTION_REQUIRED_TYPES.includes(requestType) && !retentionExceptionRef) {
        fail('PRIVACY_RETENTION_EXCEPTION_REQUIRED');
    }
    return { decision: decision, reason, retentionExceptionRef, exportJobId };
}
/** 改负责人或延期必须说明理由：队列上的每个日期变化都要能回答「谁改的、为什么」。 */
export function normalizePrivacyUpdate(body) {
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const hasOwner = Object.prototype.hasOwnProperty.call(input, 'ownerId');
    const hasDue = Object.prototype.hasOwnProperty.call(input, 'dueAt');
    if (!hasOwner && !hasDue)
        fail('EMPTY_PATCH');
    let ownerId;
    if (hasOwner) {
        const raw = input.ownerId;
        if (raw === null)
            ownerId = null;
        else if (typeof raw === 'string' && UUID.test(raw))
            ownerId = raw;
        else
            fail('PRIVACY_OWNER_INVALID');
    }
    const dueAt = hasDue ? timestamp(input.dueAt, 'PRIVACY_DUE_AT_INVALID') : undefined;
    return { ownerId, dueAt, reason: text(input.reason, 'PRIVACY_UPDATE_REASON_REQUIRED', MAX_REASON_LENGTH) };
}
/** 延期只能往后、且不超过一年：把到期日改到过去等于伪造逾期记录。 */
export function assertDueAtExtension(dueAt, receivedAt) {
    const limit = receivedAt.getTime() + 366 * DAY_MS;
    if (dueAt.getTime() <= receivedAt.getTime() || dueAt.getTime() > limit)
        fail('PRIVACY_DUE_AT_INVALID');
}
