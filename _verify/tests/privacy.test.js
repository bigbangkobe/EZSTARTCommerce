import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDueAtExtension, assertPrivacyTransition, assertExportAllowed, anonymizedDisplayName, canTransition, decisionStatus, dueAtFrom, isTerminal, MARKETING_CONSENT_CHANNELS, normalizeDueDays, normalizePrivacyDecision, normalizePrivacyRequestInput, normalizePrivacyUpdate, normalizePrivacyVerification, overdueDays, privacyDay, privacyRequestNumber, PrivacyRuleError, requiresVerifiedIdentity, } from '../packages/domain/src/privacy.js';
function rejects(fn, code) {
    assert.throws(fn, (error) => error instanceof PrivacyRuleError && error.code === code);
}
const request = (overrides = {}) => normalizePrivacyRequestInput({ requestType: 'access',
    sourceChannel: 'email', scope: ['profile'], ...overrides });
test('a request is accepted only from the closed vocabulary', () => {
    assert.deepEqual(request(), { requestType: 'access', sourceChannel: 'email', customerRef: null, scope: ['profile'] });
    for (const requestType of ['erase', '', 'ACCESS', 42, null])
        rejects(() => request({ requestType }), 'PRIVACY_REQUEST_TYPE_INVALID');
    for (const sourceChannel of ['whatsapp', '', 'EMAIL', 42])
        rejects(() => request({ sourceChannel }), 'PRIVACY_SOURCE_CHANNEL_INVALID');
});
test('scope is trimmed, de-duplicated and bounded', () => {
    // 同一类别写两遍只算一次；顺序保留，方便店主按顾客原话复述。
    assert.deepEqual(request({ scope: [' orders ', 'profile', 'orders'] }).scope, ['orders', 'profile']);
    assert.deepEqual(request({ scope: [] }).scope, []);
    for (const scope of ['profile', [42], [''], ['x'.repeat(81)], Array.from({ length: 21 }, (_, i) => `s${i}`)]) {
        rejects(() => request({ scope }), 'PRIVACY_SCOPE_INVALID');
    }
});
test('what the requester says about themselves is a lead, not an identity', () => {
    assert.equal(request({ customerRef: '  chan@example.com  ' }).customerRef, 'chan@example.com');
    // 空串与缺省都表示「没有提供」，不会变成空字符串写进库里。
    assert.equal(request({ customerRef: '   ' }).customerRef, null);
    assert.equal(request({ customerRef: null }).customerRef, null);
    for (const customerRef of ['x'.repeat(201), 42])
        rejects(() => request({ customerRef }), 'PRIVACY_CUSTOMER_REF_INVALID');
});
test('request numbers group by day and never exceed four digits', () => {
    assert.equal(privacyDay(new Date('2026-11-17T23:30:00.000Z')), '20261117');
    assert.equal(privacyRequestNumber('20261117', 1), 'PR-20261117-0001');
    assert.equal(privacyRequestNumber('20261117', 9_999), 'PR-20261117-9999');
    for (const sequence of [0, 10_000, 1.5])
        rejects(() => privacyRequestNumber('20261117', sequence), 'PRIVACY_NUMBER_INVALID');
    for (const day of ['2026-11-17', '2026111', ''])
        rejects(() => privacyRequestNumber(day, 1), 'PRIVACY_NUMBER_INVALID');
});
test('the due date is a snapshot taken at acceptance', () => {
    const received = new Date('2026-11-17T00:00:00.000Z');
    assert.equal(dueAtFrom(received, 30).toISOString(), '2026-12-17T00:00:00.000Z');
    assert.equal(dueAtFrom(received, 1).toISOString(), '2026-11-18T00:00:00.000Z');
    for (const dueDays of [0, 366, 7.5, '30', null])
        rejects(() => normalizeDueDays(dueDays), 'PRIVACY_DUE_DAYS_INVALID');
});
test('overdue days never go negative and a late same-day request is one day late', () => {
    const due = new Date('2026-11-17T00:00:00.000Z');
    assert.equal(overdueDays(due, new Date('2026-11-16T23:59:59.000Z')), 0);
    assert.equal(overdueDays(due, due), 0);
    // 刚过到期时刻：算逾期 1 天，不显示「逾期 0 天」。
    assert.equal(overdueDays(due, new Date('2026-11-17T00:00:01.000Z')), 1);
    assert.equal(overdueDays(due, new Date('2026-11-20T06:00:00.000Z')), 3);
});
test('status only moves forward through the documented transitions', () => {
    assert.ok(canTransition('received', 'verified'));
    assert.ok(canTransition('received', 'rejected'));
    assert.ok(canTransition('verified', 'needs_information'));
    // 补的是材料不是身份：needs_information 之后直接决定，不重新核验。
    assert.ok(canTransition('needs_information', 'approved'));
    assert.ok(canTransition('approved', 'completed'));
    // 终态不回退，也不跳级。
    for (const to of ['received', 'verified', 'approved', 'completed'])
        assert.equal(canTransition('rejected', to), false);
    for (const to of ['received', 'verified', 'approved', 'needs_information'])
        assert.equal(canTransition('completed', to), false);
    assert.equal(canTransition('received', 'approved'), false);
    assert.equal(canTransition('approved', 'needs_information'), false);
    rejects(() => assertPrivacyTransition('received', 'approved'), 'PRIVACY_STATUS_CONFLICT');
    rejects(() => assertPrivacyTransition('bogus', 'approved'), 'PRIVACY_STATUS_INVALID');
    assert.ok(isTerminal('rejected') && isTerminal('completed') && !isTerminal('approved'));
});
test('only approved and completed require a verified identity', () => {
    assert.ok(requiresVerifiedIdentity('approved'));
    assert.ok(requiresVerifiedIdentity('completed'));
    for (const status of ['received', 'verified', 'needs_information', 'rejected']) {
        assert.equal(requiresVerifiedIdentity(status), false);
    }
    assert.equal(decisionStatus('needs_information'), 'needs_information');
    rejects(() => decisionStatus('pending'), 'PRIVACY_DECISION_INVALID');
});
test('verification records who verified how, and nothing less counts', () => {
    const verified = normalizePrivacyVerification({ verificationMethod: 'reply_to_ticket', evidenceRef: 'ticket-42', reason: 'Replied from the mailbox on file' });
    assert.deepEqual(verified, { verificationMethod: 'reply_to_ticket', evidenceRef: 'ticket-42', reason: 'Replied from the mailbox on file' });
    for (const body of [{}, { verificationMethod: 'x', reason: 'y' }, { verificationMethod: 'x', evidenceRef: 'y' },
        { verificationMethod: ' ', evidenceRef: 'y', reason: 'z' }]) {
        rejects(() => normalizePrivacyVerification(body), 'PRIVACY_VERIFICATION_INVALID');
    }
});
test('completing a deletion needs a retention reference, approving it does not', () => {
    const approved = normalizePrivacyDecision({ decision: 'approved', reason: 'Identity confirmed' }, 'delete');
    assert.equal(approved.decision, 'approved');
    assert.equal(approved.retentionExceptionRef, null);
    // 订单、支付、售后是交易事实：删档也要能指出依据，否则「已完成」只是一句话。
    rejects(() => normalizePrivacyDecision({ decision: 'completed', reason: 'Removed' }, 'delete'), 'PRIVACY_RETENTION_EXCEPTION_REQUIRED');
    rejects(() => normalizePrivacyDecision({ decision: 'completed', reason: 'Removed' }, 'anonymize'), 'PRIVACY_RETENTION_EXCEPTION_REQUIRED');
    assert.equal(normalizePrivacyDecision({ decision: 'completed', reason: 'Removed', retentionExceptionRef: 'retention-v1#orders' }, 'delete')
        .retentionExceptionRef, 'retention-v1#orders');
    // 访问/导出没有保留例外这回事，不需要这个字段。
    assert.equal(normalizePrivacyDecision({ decision: 'completed', reason: 'Delivered by email' }, 'access').retentionExceptionRef, null);
    rejects(() => normalizePrivacyDecision({ decision: 'done', reason: 'x' }, 'access'), 'PRIVACY_DECISION_INVALID');
    rejects(() => normalizePrivacyDecision({ decision: 'completed', reason: '' }, 'access'), 'PRIVACY_DECISION_INVALID');
    rejects(() => normalizePrivacyDecision({ decision: 'completed', reason: 'x', exportJobId: 'not-a-uuid' }, 'export'), 'PRIVACY_DECISION_INVALID');
});
test('only access and export requests may produce a deliverable artifact', () => {
    assertExportAllowed('access');
    assertExportAllowed('export');
    for (const type of ['correct', 'withdraw_marketing', 'delete', 'anonymize']) {
        rejects(() => assertExportAllowed(type), 'PRIVACY_EXPORT_NOT_ALLOWED');
    }
    // 匿名名只保留顾客 id 前缀，不能把旧邮箱本地部分或自填姓名带过去。
    assert.equal(anonymizedDisplayName('3f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'), 'Anonymized 3f2c1d3e');
    rejects(() => anonymizedDisplayName('not-a-uuid'), 'PRIVACY_CUSTOMER_REQUIRED');
    assert.deepEqual([...MARKETING_CONSENT_CHANNELS], ['email', 'sms', 'phone', 'push']);
});
test('owner reassignment and extensions both need a reason and one real change', () => {
    const owner = '3f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    assert.equal(normalizePrivacyUpdate({ ownerId: owner, reason: 'Handing over' }).ownerId, owner);
    assert.equal(normalizePrivacyUpdate({ ownerId: null, reason: 'Unassigning' }).ownerId, null);
    assert.equal(normalizePrivacyUpdate({ dueAt: '2026-12-01T00:00:00.000Z', reason: 'Waiting on the customer' }).dueAt?.toISOString(), '2026-12-01T00:00:00.000Z');
    rejects(() => normalizePrivacyUpdate({ reason: 'nothing else' }), 'EMPTY_PATCH');
    rejects(() => normalizePrivacyUpdate({ ownerId: 'nobody', reason: 'x' }), 'PRIVACY_OWNER_INVALID');
    rejects(() => normalizePrivacyUpdate({ ownerId: owner }), 'PRIVACY_UPDATE_REASON_REQUIRED');
    rejects(() => normalizePrivacyUpdate({ dueAt: 'yesterday', reason: 'x' }), 'PRIVACY_DUE_AT_INVALID');
});
test('an extension cannot move the due date into the past or beyond a year', () => {
    const received = new Date('2026-11-17T00:00:00.000Z');
    assertDueAtExtension(new Date('2026-12-17T00:00:00.000Z'), received);
    assertDueAtExtension(new Date('2027-11-17T00:00:00.000Z'), received);
    // 改到受理之前等于伪造「一直没处理」，超出一年则让到期提醒失去意义。
    rejects(() => assertDueAtExtension(new Date('2026-11-16T00:00:00.000Z'), received), 'PRIVACY_DUE_AT_INVALID');
    rejects(() => assertDueAtExtension(new Date('2028-01-01T00:00:00.000Z'), received), 'PRIVACY_DUE_AT_INVALID');
});
