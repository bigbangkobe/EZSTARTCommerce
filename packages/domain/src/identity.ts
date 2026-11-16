import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { expiresAt, securityPolicy } from '../../config/src/security-policy.js';

export class IdentityConflict extends Error {
  constructor(readonly code: string) { super(code); }
}

function validDates(...dates: Date[]): boolean {
  return dates.every(date => Number.isFinite(date.getTime()));
}

export type Invitation = Readonly<{
  id: string;
  userId: string;
  version: number;
  status: 'pending' | 'accepted' | 'revoked';
  tokenDigest: string;
  expiresAt: Date;
  lastSentAt: Date;
  sendWindowStartedAt: Date;
  sendsInWindow: number;
}>;

/** The caller persists this record and encrypted notification job in ONE DB transaction. */
export function issueInvitation(id: string, userId: string, now: Date): { invitation: Invitation; token: string } {
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

function checkVersion(invitation: Invitation, expectedVersion: number): void {
  if (invitation.version !== expectedVersion) throw new IdentityConflict('VERSION_CONFLICT');
}

function pending(invitation: Invitation): void {
  if (invitation.status !== 'pending') throw new IdentityConflict('INVITATION_NOT_PENDING');
}

export function resendInvitation(invitation: Invitation, expectedVersion: number, now: Date): { invitation: Invitation; token: string } {
  checkVersion(invitation, expectedVersion);
  pending(invitation);
  if (!validDates(now, invitation.lastSentAt, invitation.sendWindowStartedAt)) throw new IdentityConflict('INVITATION_INVALID');
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

export function acceptInvitation(invitation: Invitation, expectedVersion: number, token: string, now: Date): Invitation {
  checkVersion(invitation, expectedVersion);
  pending(invitation);
  if (!validDates(now, invitation.expiresAt) || now.getTime() >= invitation.expiresAt.getTime() || !sameDigest(invitation.tokenDigest, digest(token))) {
    throw new IdentityConflict('INVITATION_INVALID');
  }
  return { ...invitation, version: invitation.version + 1, status: 'accepted' };
}

export function revokeInvitation(invitation: Invitation, expectedVersion: number): Invitation {
  checkVersion(invitation, expectedVersion);
  pending(invitation);
  return { ...invitation, version: invitation.version + 1, status: 'revoked' };
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export type Challenge = Readonly<{
  userId: string;
  browserDigest: string;
  purpose: 'verify_mfa' | 'enroll_mfa';
  expiresAt: Date;
  failures: number;
  consumedAt: Date | null;
}>;

export function assertChallenge(challenge: Challenge, expected: { userId: string; browserToken: string; purpose: Challenge['purpose'] }, now: Date): void {
  if (!validDates(now, challenge.expiresAt) || challenge.userId !== expected.userId || challenge.purpose !== expected.purpose || challenge.consumedAt ||
      challenge.failures >= securityPolicy.challengeMaxFailures || now.getTime() >= challenge.expiresAt.getTime() ||
      !sameDigest(challenge.browserDigest, digest(expected.browserToken))) {
    throw new IdentityConflict('CHALLENGE_INVALID');
  }
}

/** Reading/validating a challenge does not consume it; repository must atomically consume on success. */
export function assertSession(session: { status: string; revoked: boolean; idleExpiresAt: Date; absoluteExpiresAt: Date; mfaRequired: boolean; mfaEnabled: boolean; mfaVerified: boolean }, now: Date): void {
  if (!validDates(now, session.idleExpiresAt, session.absoluteExpiresAt) || session.status !== 'active' || session.revoked || now.getTime() >= session.idleExpiresAt.getTime() ||
      now.getTime() >= session.absoluteExpiresAt.getTime() ||
      (session.mfaRequired && (!session.mfaEnabled || !session.mfaVerified))) {
    throw new IdentityConflict('SESSION_INVALID');
  }
}
