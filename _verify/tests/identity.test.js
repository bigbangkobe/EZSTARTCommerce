import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptInvitation, assertChallenge, assertSession, completePasswordReset, digest, issueInvitation, issuePasswordReset, resendInvitation, revokeInvitation, rotatePasswordReset } from '../packages/domain/src/identity.js';
import { marketAllowsTrade } from '../packages/domain/src/market.js';
import { securityPolicy } from '../packages/config/src/security-policy.js';
const now = new Date('2026-10-19T10:00:00Z');
const later = (seconds) => new Date(now.getTime() + seconds * 1_000);
test('invitation expires at the exact deadline and cannot be accepted twice', () => {
    const issued = issueInvitation('invite-1', 'user-1', now);
    assert.equal(issued.invitation.tokenDigest, digest(issued.token));
    assert.notEqual(issued.invitation.tokenDigest, issued.token);
    assert.throws(() => acceptInvitation(issued.invitation, 1, issued.token, issued.invitation.expiresAt), /INVITATION_INVALID/);
    assert.throws(() => acceptInvitation(issued.invitation, 1, issued.token, new Date('invalid')), /INVITATION_INVALID/);
    const accepted = acceptInvitation(issued.invitation, 1, issued.token, later(1));
    assert.equal(accepted.status, 'accepted');
    assert.throws(() => acceptInvitation(accepted, 2, issued.token, later(2)), /INVITATION_NOT_PENDING/);
});
test('resending rotates the secret, enforces cooldown and rejects stale versions', () => {
    const issued = issueInvitation('invite-1', 'user-1', now);
    assert.throws(() => resendInvitation(issued.invitation, 1, later(59)), /RATE_LIMITED/);
    const resent = resendInvitation(issued.invitation, 1, later(60));
    assert.throws(() => acceptInvitation(resent.invitation, 2, issued.token, later(61)), /INVITATION_INVALID/);
    assert.throws(() => resendInvitation(resent.invitation, 1, later(121)), /VERSION_CONFLICT/);
    assert.equal(acceptInvitation(resent.invitation, 2, resent.token, later(61)).status, 'accepted');
});
test('invitation hourly quota cannot be reset by each resend', () => {
    let invitation = issueInvitation('invite-1', 'user-1', now).invitation;
    for (let i = 1; i < securityPolicy.invitationSendsPerHour; i++) {
        invitation = resendInvitation(invitation, invitation.version, later(i * 60)).invitation;
    }
    assert.throws(() => resendInvitation(invitation, invitation.version, later(300)), /RATE_LIMITED/);
    const next = resendInvitation(invitation, invitation.version, later(3_600)).invitation;
    assert.equal(next.sendsInWindow, 1);
});
test('revoked invites reject the previously valid token', () => {
    const issued = issueInvitation('invite-1', 'user-1', now);
    const revoked = revokeInvitation(issued.invitation, 1);
    assert.throws(() => acceptInvitation(revoked, 2, issued.token, later(1)), /INVITATION_NOT_PENDING/);
    assert.throws(() => resendInvitation(revoked, 2, later(60)), /INVITATION_NOT_PENDING/);
});
test('password reset expires exactly at its deadline and completes only once', () => {
    const issued = issuePasswordReset('reset-1', 'user-1', now);
    assert.equal(issued.reset.tokenDigest, digest(issued.token));
    assert.notEqual(issued.reset.tokenDigest, issued.token);
    assert.equal(issued.reset.expiresAt.getTime(), later(securityPolicy.resetPasswordSeconds).getTime());
    assert.throws(() => completePasswordReset(issued.reset, 'wrong-token', later(1)), /RESET_INVALID/);
    assert.throws(() => completePasswordReset(issued.reset, issued.token, issued.reset.expiresAt), /RESET_INVALID/);
    assert.throws(() => completePasswordReset(issued.reset, issued.token, new Date('invalid')), /RESET_INVALID/);
    const completed = completePasswordReset(issued.reset, issued.token, later(1));
    assert.equal(completed.status, 'completed');
    assert.throws(() => completePasswordReset(completed, issued.token, later(2)), /RESET_INVALID/);
    assert.throws(() => completePasswordReset({ ...completed, status: 'revoked', version: completed.version }, issued.token, later(2)), /RESET_INVALID/);
});
test('a repeat reset request rotates the secret and invalidates the previous one', () => {
    const issued = issuePasswordReset('reset-1', 'user-1', now);
    const rotated = rotatePasswordReset(issued.reset, later(90));
    assert.equal(rotated.reset.version, 2);
    assert.equal(rotated.reset.id, issued.reset.id);
    assert.notEqual(rotated.reset.tokenDigest, issued.reset.tokenDigest);
    assert.equal(rotated.reset.expiresAt.getTime(), later(90 + securityPolicy.resetPasswordSeconds).getTime());
    assert.throws(() => completePasswordReset(rotated.reset, issued.token, later(91)), /RESET_INVALID/);
    assert.equal(completePasswordReset(rotated.reset, rotated.token, later(91)).status, 'completed');
    assert.throws(() => rotatePasswordReset({ ...issued.reset, requestedAt: new Date('invalid') }, later(120)), /RESET_INVALID/);
});
test('challenge guards reject wrong user, browser, purpose, expiry, failures and replay', () => {
    const challenge = { userId: 'user-1', browserDigest: digest('browser-secret'), purpose: 'verify_mfa',
        expiresAt: later(300), failures: 0, consumedAt: null };
    const expected = { userId: 'user-1', browserToken: 'browser-secret', purpose: 'verify_mfa' };
    assert.doesNotThrow(() => assertChallenge(challenge, expected, now));
    for (const changed of [{ userId: 'user-2' }, { browserToken: 'wrong' }, { purpose: 'enroll_mfa' }]) {
        assert.throws(() => assertChallenge(challenge, { ...expected, ...changed }, now), /CHALLENGE_INVALID/);
    }
    assert.throws(() => assertChallenge(challenge, expected, later(300)), /CHALLENGE_INVALID/);
    assert.throws(() => assertChallenge(challenge, expected, new Date('invalid')), /CHALLENGE_INVALID/);
    assert.throws(() => assertChallenge({ ...challenge, failures: 5 }, expected, now), /CHALLENGE_INVALID/);
    assert.throws(() => assertChallenge({ ...challenge, consumedAt: now }, expected, now), /CHALLENGE_INVALID/);
});
test('sessions reject suspension, missing MFA, revocation and either deadline', () => {
    const session = { status: 'active', revoked: false, idleExpiresAt: later(1_800), absoluteExpiresAt: later(43_200),
        mfaRequired: true, mfaEnabled: true, mfaVerified: true };
    assert.doesNotThrow(() => assertSession(session, now));
    assert.throws(() => assertSession(session, new Date('invalid')), /SESSION_INVALID/);
    for (const changed of [{ status: 'suspended' }, { revoked: true }, { mfaVerified: false },
        { mfaEnabled: false }, { idleExpiresAt: now }, { absoluteExpiresAt: now }]) {
        assert.throws(() => assertSession({ ...session, ...changed }, now), /SESSION_INVALID/);
    }
});
test('market eligibility rechecks enabled status, approval and expiry at transaction time', () => {
    assert.equal(marketAllowsTrade(true, { status: 'approved', validUntil: later(1) }, now), true);
    for (const status of ['pending', 'rejected', 'revoked', 'expired']) {
        assert.equal(marketAllowsTrade(true, { status, validUntil: null }, now), false);
    }
    assert.equal(marketAllowsTrade(false, { status: 'approved', validUntil: null }, now), false);
    assert.equal(marketAllowsTrade(true, { status: 'approved', validUntil: now }, now), false);
});
