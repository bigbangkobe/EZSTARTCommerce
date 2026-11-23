/**
 * 顾客与会员（M10 第一批）纯规则层。
 *
 * 只回答“能不能发、能不能验、能不能改”，不碰数据库与网络：
 * 邮箱规范化、OTP 限速与尝试预算、挑战响应形状（统一提示，不泄露会员是否存在）、
 * 会员号、会话期限、顾客资料与会员状态迁移都在这里收敛。
 * 验证码与邮箱摘要一律用实例密钥 HMAC，本文件的函数接受密钥参数而不自己持有。
 */
import { createHash, createHmac, randomInt } from 'node:crypto';
export class MemberRuleError extends Error {
    field;
    code;
    constructor(field, code = 'VALIDATION_ERROR') {
        super(field);
        this.field = field;
        this.code = code;
    }
}
function fail(field, code) { throw new MemberRuleError(field, code); }
/** 与开发规格一致：验证码 10 分钟、60 秒重发冷却、每小时 5 次、5 次错误后作废、会话 12 小时。 */
export const memberPolicy = Object.freeze({
    otpTtlSeconds: 600,
    otpResendSeconds: 60,
    otpRequestsPerHour: 5,
    otpVerifyAttempts: 5,
    sessionSeconds: 43_200,
});
export const MEMBER_STATUSES = ['active', 'suspended', 'closed'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+()\d][\d\s()+-]{4,31}$/;
const MEMBER_NO = /^MB-[0-9]{8}-[A-Z0-9]{6}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 80;
/** 邮箱按小写、去首尾空白后存储；规范化后仍不像邮箱就拒绝，不猜。 */
export function normalizeMemberEmail(value) {
    if (typeof value !== 'string')
        fail('email');
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 3 || normalized.length > 254 || !EMAIL.test(normalized))
        fail('email');
    return normalized;
}
export function memberHmac(key, material) {
    return createHmac('sha256', key).update(material).digest('hex');
}
/** 挑战表里只存邮箱 HMAC：限速按摘要分组，管理员与日志都看不到原邮箱。 */
export function otpEmailDigest(key, instanceId, email) {
    return memberHmac(key, `${instanceId}:member-otp-email:${email}`);
}
/** 验证码摘要绑定挑战行：同一串码在不同挑战里摘要不同，泄露一行也推不出别的。 */
export function otpCodeDigest(key, instanceId, challengeId, code) {
    return memberHmac(key, `${instanceId}:member-otp-code:${challengeId}:${code}`);
}
/** 六位数字码，允许前导零；生成后只加密投递，不在响应与日志中出现。 */
export function otpCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
export function sessionTokenDigest(token) {
    return createHash('sha256').update(token).digest('hex');
}
/**
 * 统一响应：无论邮箱是否已登记会员，字段与状态完全一致。
 * challengeId 只是关联句柄，不是认证凭据。
 */
export function otpChallengeView(challengeId, expiresAt, now) {
    const remaining = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000));
    return {
        challengeId,
        challengeAccepted: true,
        resendAfterSeconds: memberPolicy.otpResendSeconds,
        expiresInSeconds: remaining,
    };
}
/** 同一邮箱每小时最多 5 次、两次之间至少 60 秒；限速对已登记与未登记地址一视同仁。 */
export function assertOtpRequestAllowed(recent, now) {
    const hourAgo = now.getTime() - 3_600_000;
    const withinHour = recent.filter(item => item.createdAt.getTime() > hourAgo);
    if (withinHour.length >= memberPolicy.otpRequestsPerHour)
        fail('email', 'OTP_RATE_LIMITED');
    let newest = null;
    for (const item of withinHour)
        if (!newest || item.createdAt > newest)
            newest = item.createdAt;
    if (newest && now.getTime() - newest.getTime() < memberPolicy.otpResendSeconds * 1_000)
        fail('email', 'OTP_RESEND_TOO_SOON');
}
/**
 * 验证前置条件：过期、已用、已失败、尝试用尽的挑战都不能再验。
 * 过期与不可用分开报，但对外都是 401，调用方不应依赖具体原因。
 */
export function assertOtpVerifiable(row, now) {
    if (row.status === 'pending' && row.expiresAt.getTime() <= now.getTime())
        fail('code', 'OTP_EXPIRED');
    if (row.status !== 'pending')
        fail('code', 'OTP_NOT_AVAILABLE');
    if (row.attempts >= row.maxAttempts)
        fail('code', 'OTP_ATTEMPTS_EXHAUSTED');
}
/** 错误一次的后果：累计尝试数，达到上限即作废（必须重新申请，不能无限试）。 */
export function nextOtpFailure(attempts, maxAttempts) {
    const next = attempts + 1;
    return { attempts: next, status: next >= maxAttempts ? 'failed' : 'pending' };
}
/** 对外会员号：MB-日期-6 位后缀。与订单号同形制，便于人工核对，不含任何顾客信息。 */
export function memberNumber(day, suffix) {
    if (!/^[0-9]{8}$/.test(day))
        fail('day');
    if (!/^[A-Z0-9]{6}$/.test(suffix))
        fail('suffix');
    const number = `MB-${day}-${suffix}`;
    if (!MEMBER_NO.test(number))
        fail('memberNo');
    return number;
}
export function memberSessionExpiry(now) {
    return new Date(now.getTime() + memberPolicy.sessionSeconds * 1_000);
}
/** 会员首次加入时没有姓名：用邮箱本地部分做初始显示名，后续可在后台更正。 */
export function defaultDisplayName(email) {
    const local = email.split('@')[0] ?? '';
    const cleaned = local.replace(CONTROL, '').trim();
    return (cleaned.length ? cleaned : 'Member').slice(0, 120);
}
function optionalText(value, field, max) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string')
        fail(field);
    const trimmed = value.trim();
    if (!trimmed.length)
        return null;
    if (trimmed.length > max)
        fail(field);
    if (CONTROL.test(trimmed))
        fail(field);
    return trimmed;
}
/**
 * 顾客写入只接受契约列出的字段；未出现的键不写，出现的键做规范化。
 * 邮箱为空与“不修改邮箱”是两件事：前者写 null，后者不写。
 */
export function normalizeCustomerInput(body) {
    const input = {};
    if ('displayName' in body) {
        const name = optionalText(body['displayName'], 'displayName', 120);
        if (name === null)
            fail('displayName');
        input.displayName = name;
    }
    if ('email' in body)
        input.email = body['email'] === null ? null : normalizeMemberEmail(body['email']);
    if ('phone' in body) {
        const phone = optionalText(body['phone'], 'phone', 32);
        if (phone !== null && !PHONE.test(phone))
            fail('phone');
        input.phone = phone;
    }
    if ('tags' in body) {
        const tags = body['tags'];
        if (!Array.isArray(tags) || tags.length > MAX_TAGS)
            fail('tags');
        const normalized = tags.map(tag => optionalText(tag, 'tags', MAX_TAG_LENGTH));
        if (normalized.some(tag => tag === null))
            fail('tags');
        const values = normalized;
        if (new Set(values.map(tag => tag.toLowerCase())).size !== values.length)
            fail('tags');
        input.tags = values;
    }
    if ('internalNote' in body)
        input.internalNote = optionalText(body['internalNote'], 'internalNote', 1_000);
    return input;
}
export function assertNonEmptyPatch(body) {
    const known = ['displayName', 'email', 'phone', 'tags', 'internalNote'];
    if (!known.some(key => key in body))
        fail('body');
}
export function normalizeMemberStatus(value) {
    if (typeof value !== 'string' || !MEMBER_STATUSES.includes(value))
        fail('status');
    return value;
}
/** closed 是终态：关闭的会员不能被“重新激活”，需要店主按例外流程处理。 */
export function assertMemberStatusTransition(from, to) {
    if (from === 'closed' && to !== 'closed')
        fail('status', 'MEMBER_CLOSED');
}
export function normalizeMemberPatch(body) {
    const reason = optionalText(body['reason'], 'reason', 1_000);
    if (reason === null)
        fail('reason');
    const patch = { reason, tierRequested: 'tierId' in body && body['tierId'] !== null };
    if ('status' in body)
        patch.status = normalizeMemberStatus(body['status']);
    if (!('status' in body) && !('tierId' in body))
        fail('body');
    return patch;
}
