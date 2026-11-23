import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { assertMemberStatusTransition, assertNonEmptyPatch, assertOtpRequestAllowed, assertOtpVerifiable, defaultDisplayName, MemberRuleError, memberNumber, memberPolicy, memberSessionExpiry, nextOtpFailure, normalizeCustomerInput, normalizeMemberEmail, normalizeMemberPatch, otpChallengeView, otpCode, otpCodeDigest, otpEmailDigest, sessionTokenDigest, } from '../packages/domain/src/members.js';
function rejects(fn, code = 'VALIDATION_ERROR') {
    assert.throws(fn, (error) => error instanceof MemberRuleError && error.code === code);
}
const key = randomBytes(32);
const instance = 'instance-1';
test('emails are trimmed and lowercased so one address cannot become two customers', () => {
    assert.equal(normalizeMemberEmail('  Buyer@Example.COM '), 'buyer@example.com');
    for (const value of ['', ' ', 'no-at-sign', 'a@b', 'a@b.c', 'a b@example.com', 'a@exa mple.com', `${'a'.repeat(250)}@example.com`,
        null, undefined, 42]) {
        rejects(() => normalizeMemberEmail(value));
    }
    // 长度上限按规范化后的值判断，前后空白不占用额度。
    assert.equal(normalizeMemberEmail(`${'  '}${'a'.repeat(240)}@example.com`).length, 252);
});
test('email and code digests are stable per instance and bound to the challenge row', () => {
    const email = 'buyer@example.com';
    assert.equal(otpEmailDigest(key, instance, email), otpEmailDigest(key, instance, email));
    assert.match(otpEmailDigest(key, instance, email), /^[0-9a-f]{64}$/);
    // 换实例、换邮箱、换密钥都得到不同摘要：跨库比对无法还原同一地址。
    assert.notEqual(otpEmailDigest(key, instance, email), otpEmailDigest(key, 'instance-2', email));
    assert.notEqual(otpEmailDigest(key, instance, email), otpEmailDigest(key, instance, 'other@example.com'));
    assert.notEqual(otpEmailDigest(key, instance, email), otpEmailDigest(randomBytes(32), instance, email));
    // 同一个六位码在不同挑战里的摘要不同：泄露一行推不出另一行。
    const code = '123456';
    assert.notEqual(otpCodeDigest(key, instance, 'challenge-a', code), otpCodeDigest(key, instance, 'challenge-b', code));
    assert.notEqual(otpCodeDigest(key, instance, 'challenge-a', code), otpCodeDigest(key, instance, 'challenge-a', '123457'));
});
test('codes are six digits and keep leading zeros', () => {
    for (let i = 0; i < 200; i += 1)
        assert.match(otpCode(), /^\d{6}$/);
});
test('session token digests are one-way and collision-free for distinct tokens', () => {
    const first = randomBytes(32).toString('base64url');
    assert.match(sessionTokenDigest(first), /^[0-9a-f]{64}$/);
    assert.notEqual(sessionTokenDigest(first), first);
    assert.notEqual(sessionTokenDigest(first), sessionTokenDigest(randomBytes(32).toString('base64url')));
});
test('the challenge response never reveals whether the address is registered', () => {
    const now = new Date('2026-11-17T00:00:00.000Z');
    const view = otpChallengeView('0b8f8c0e-5c1a-4a0a-9c0a-6f1a2b3c4d5e', new Date(now.getTime() + 600_000), now);
    assert.deepEqual(Object.keys(view).sort(), ['challengeAccepted', 'challengeId', 'expiresInSeconds', 'resendAfterSeconds']);
    assert.equal(view.challengeAccepted, true);
    assert.equal(view.expiresInSeconds, 600);
    assert.equal(JSON.stringify(view).includes('@'), false);
});
test('a mailbox may request five codes an hour with sixty seconds between them', () => {
    const now = new Date('2026-11-17T12:00:00.000Z');
    const minutesAgo = (minutes) => ({ createdAt: new Date(now.getTime() - minutes * 60_000) });
    assert.doesNotThrow(() => assertOtpRequestAllowed([], now));
    // 冷却期内：即使总量没到上限也拒绝。
    rejects(() => assertOtpRequestAllowed([minutesAgo(0.5)], now), 'OTP_RESEND_TOO_SOON');
    assert.doesNotThrow(() => assertOtpRequestAllowed([minutesAgo(1)], now));
    // 窗口滑动：只统计最近一小时；四小时前的申请不再占额度。
    rejects(() => assertOtpRequestAllowed([minutesAgo(59), minutesAgo(50), minutesAgo(40), minutesAgo(30), minutesAgo(20)], now), 'OTP_RATE_LIMITED');
    assert.doesNotThrow(() => assertOtpRequestAllowed([minutesAgo(240), minutesAgo(180), minutesAgo(120), minutesAgo(70)], now));
});
test('expired, consumed and exhausted challenges cannot be verified', () => {
    const now = new Date('2026-11-17T12:00:00.000Z');
    const live = { status: 'pending', attempts: 0, maxAttempts: 5, expiresAt: new Date(now.getTime() + 60_000) };
    assert.doesNotThrow(() => assertOtpVerifiable(live, now));
    rejects(() => assertOtpVerifiable({ ...live, expiresAt: new Date(now.getTime() - 1) }, now), 'OTP_EXPIRED');
    for (const status of ['consumed', 'expired', 'failed']) {
        rejects(() => assertOtpVerifiable({ ...live, status }, now), 'OTP_NOT_AVAILABLE');
    }
    rejects(() => assertOtpVerifiable({ ...live, attempts: 5 }, now), 'OTP_ATTEMPTS_EXHAUSTED');
});
test('attempt budget is spent one code at a time and the fifth failure retires the challenge', () => {
    assert.deepEqual(nextOtpFailure(0, 5), { attempts: 1, status: 'pending' });
    assert.deepEqual(nextOtpFailure(3, 5), { attempts: 4, status: 'pending' });
    assert.deepEqual(nextOtpFailure(4, 5), { attempts: 5, status: 'failed' });
    assert.deepEqual(nextOtpFailure(5, 5), { attempts: 6, status: 'failed' });
});
test('member numbers carry a date and suffix but no customer data', () => {
    assert.equal(memberNumber('20261117', 'A1B2C3'), 'MB-20261117-A1B2C3');
    rejects(() => memberNumber('2026-11-17', 'A1B2C3'));
    rejects(() => memberNumber('20261117', 'a1b2c3'));
    rejects(() => memberNumber('20261117', 'A1B2C'));
});
test('member sessions last twelve hours from the issuing clock', () => {
    const now = new Date('2026-11-17T00:00:00.000Z');
    assert.equal(memberSessionExpiry(now).toISOString(), '2026-11-17T12:00:00.000Z');
    assert.equal(memberPolicy.sessionSeconds, 43_200);
});
test('first-time members get a display name derived from the mailbox local part', () => {
    assert.equal(defaultDisplayName('mei.wong@example.com'), 'mei.wong');
    assert.equal(defaultDisplayName('@example.com'), 'Member');
    assert.equal(defaultDisplayName(`${'a'.repeat(200)}@example.com`).length, 120);
    // 控制字符不能进入展示名，否则后台表格与邮件标题会被换行打断。
    assert.equal(defaultDisplayName('me\u0000i@example.com'), 'mei');
});
test('customer writes distinguish "clear this field" from "leave it alone"', () => {
    assert.deepEqual(normalizeCustomerInput({ displayName: ' Mei ', phone: ' +852 1234 5678 ' }), { displayName: 'Mei', phone: '+852 1234 5678' });
    // email: null 明确清空；缺省键表示不修改。
    assert.deepEqual(normalizeCustomerInput({ email: null }), { email: null });
    assert.deepEqual(normalizeCustomerInput({}), {});
    assert.deepEqual(normalizeCustomerInput({ email: 'Buyer@Example.com' }), { email: 'buyer@example.com' });
    // 未在契约中列出的键不落库，也不报错地“顺带”写入。
    assert.deepEqual(normalizeCustomerInput({ displayName: 'Mei', status: 'blocked', version: 9 }), { displayName: 'Mei' });
    rejects(() => normalizeCustomerInput({ displayName: '   ' }));
    rejects(() => normalizeCustomerInput({ displayName: 'x'.repeat(121) }));
    rejects(() => normalizeCustomerInput({ phone: 'call me' }));
    rejects(() => normalizeCustomerInput({ tags: ['vip', 'VIP'] }));
    rejects(() => normalizeCustomerInput({ tags: [''] }));
    rejects(() => normalizeCustomerInput({ tags: 'vip' }));
    rejects(() => normalizeCustomerInput({ internalNote: 'x'.repeat(1_001) }));
    rejects(() => normalizeCustomerInput({ displayName: 'a\nb' }));
});
test('a patch must actually change something', () => {
    assert.doesNotThrow(() => assertNonEmptyPatch({ phone: null }));
    rejects(() => assertNonEmptyPatch({}));
    // 只带未知键等于空补丁：不能产生一次“更新”却什么都没改。
    rejects(() => assertNonEmptyPatch({ status: 'active' }));
});
test('member patches need an audit reason and only touch status or tier', () => {
    assert.deepEqual(normalizeMemberPatch({ status: 'suspended', reason: ' abuse ' }), { status: 'suspended', reason: 'abuse', tierRequested: false });
    assert.deepEqual(normalizeMemberPatch({ tierId: null, reason: 'tier reset' }), { reason: 'tier reset', tierRequested: false });
    assert.deepEqual(normalizeMemberPatch({ tierId: '0b8f8c0e-5c1a-4a0a-9c0a-6f1a2b3c4d5e', reason: 'upgrade' }), { reason: 'upgrade', tierRequested: true });
    rejects(() => normalizeMemberPatch({ status: 'active' }));
    rejects(() => normalizeMemberPatch({ status: 'deleted', reason: 'x' }));
    rejects(() => normalizeMemberPatch({ reason: '   ' }));
    rejects(() => normalizeMemberPatch({ tierId: null }));
});
test('closing a member is terminal while suspension is reversible', () => {
    assert.doesNotThrow(() => assertMemberStatusTransition('active', 'suspended'));
    assert.doesNotThrow(() => assertMemberStatusTransition('suspended', 'active'));
    assert.doesNotThrow(() => assertMemberStatusTransition('suspended', 'closed'));
    rejects(() => assertMemberStatusTransition('closed', 'active'), 'MEMBER_CLOSED');
    rejects(() => assertMemberStatusTransition('closed', 'suspended'), 'MEMBER_CLOSED');
});
