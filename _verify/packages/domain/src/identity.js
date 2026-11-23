import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { expiresAt, securityPolicy } from '../../config/src/security-policy.js';
export class IdentityConflict extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
function validDates(...dates) {
    return dates.every(date => Number.isFinite(date.getTime()));
}
/** The caller persists this record and encrypted notification job in ONE DB transaction. */
export function issueInvitation(id, userId, now) {
    const token = randomBytes(securityPolicy.secretBytes).toString('base64url');
    return {
        token,
        invitation: {
            id, userId, version: 1, status: 'pending', tokenDigest: digest(token),
            expiresAt: expiresAt(now, securityPolicy.invitationSeconds), lastSentAt: now,
            sendWindowStartedAt: now, sendsInWindow: 1,
        },
    };
}
function checkVersion(invitation, expectedVersion) {
    if (invitation.version !== expectedVersion)
        throw new IdentityConflict('VERSION_CONFLICT');
}
function pending(invitation) {
    if (invitation.status !== 'pending')
        throw new IdentityConflict('INVITATION_NOT_PENDING');
}
export function resendInvitation(invitation, expectedVersion, now) {
    checkVersion(invitation, expectedVersion);
    pending(invitation);
    if (!validDates(now, invitation.lastSentAt, invitation.sendWindowStartedAt))
        throw new IdentityConflict('INVITATION_INVALID');
    if (now.getTime() < invitation.lastSentAt.getTime() + securityPolicy.invitationResendSeconds * 1_000) {
        throw new IdentityConflict('RATE_LIMITED');
    }
    const resetWindow = now.getTime() >= invitation.sendWindowStartedAt.getTime() + 3_600_000;
    if (!resetWindow && invitation.sendsInWindow >= securityPolicy.invitationSendsPerHour) {
        throw new IdentityConflict('RATE_LIMITED');
    }
    const issued = issueInvitation(invitation.id, invitation.userId, now);
    return {
        token: issued.token,
        invitation: {
            ...issued.invitation, version: invitation.version + 1,
            sendWindowStartedAt: resetWindow ? now : invitation.sendWindowStartedAt,
            sendsInWindow: resetWindow ? 1 : invitation.sendsInWindow + 1,
        },
    };
}
export function acceptInvitation(invitation, expectedVersion, token, now) {
    checkVersion(invitation, expectedVersion);
    pending(invitation);
    if (!validDates(now, invitation.expiresAt) || now.getTime() >= invitation.expiresAt.getTime() || !sameDigest(invitation.tokenDigest, digest(token))) {
        throw new IdentityConflict('INVITATION_INVALID');
    }
    return { ...invitation, version: invitation.version + 1, status: 'accepted' };
}
export function revokeInvitation(invitation, expectedVersion) {
    checkVersion(invitation, expectedVersion);
    pending(invitation);
    return { ...invitation, version: invitation.version + 1, status: 'revoked' };
}
function resetSecret() {
    return randomBytes(securityPolicy.secretBytes).toString('base64url');
}
/** One-time password reset credential; the caller persists it with its encrypted job in one transaction. */
export function issuePasswordReset(id, userId, now) {
    const secret = resetSecret();
    return {
        token: secret,
        reset: {
            id, userId, version: 1, status: 'pending', tokenDigest: digest(secret),
            expiresAt: expiresAt(now, securityPolicy.resetPasswordSeconds), requestedAt: now,
        },
    };
}
/** A repeat request replaces the previous credential; the old secret and its delivery job must be discarded. */
export function rotatePasswordReset(reset, now) {
    if (!validDates(now, reset.expiresAt, reset.requestedAt))
        throw new IdentityConflict('RESET_INVALID');
    const secret = resetSecret();
    return {
        token: secret,
        reset: {
            ...reset, version: reset.version + 1, status: 'pending', tokenDigest: digest(secret),
            expiresAt: expiresAt(now, securityPolicy.resetPasswordSeconds), requestedAt: now,
        },
    };
}
/** Consumption never logs the user in; the caller still revokes sessions and keeps every MFA requirement. */
export function completePasswordReset(reset, token, now) {
    if (!validDates(now, reset.expiresAt) || reset.status !== 'pending' || now.getTime() >= reset.expiresAt.getTime() ||
        !sameDigest(reset.tokenDigest, digest(token))) {
        throw new IdentityConflict('RESET_INVALID');
    }
    return { ...reset, version: reset.version + 1, status: 'completed' };
}
export function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}
function sameDigest(left, right) {
    if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
        return false;
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
export function assertChallenge(challenge, expected, now) {
    if (!validDates(now, challenge.expiresAt) || challenge.userId !== expected.userId || challenge.purpose !== expected.purpose || challenge.consumedAt ||
        challenge.failures >= securityPolicy.challengeMaxFailures || now.getTime() >= challenge.expiresAt.getTime() ||
        !sameDigest(challenge.browserDigest, digest(expected.browserToken))) {
        throw new IdentityConflict('CHALLENGE_INVALID');
    }
}
/** Reading/validating a challenge does not consume it; repository must atomically consume on success. */
export function assertSession(session, now) {
    if (!validDates(now, session.idleExpiresAt, session.absoluteExpiresAt) || session.status !== 'active' || session.revoked || now.getTime() >= session.idleExpiresAt.getTime() ||
        now.getTime() >= session.absoluteExpiresAt.getTime() ||
        (session.mfaRequired && (!session.mfaEnabled || !session.mfaVerified))) {
        throw new IdentityConflict('SESSION_INVALID');
    }
}
