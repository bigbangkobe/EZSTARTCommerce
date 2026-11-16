/** Versioned engineering defaults. Changes require security review and migration assessment. */
export const securityPolicy = Object.freeze({
  version: 'identity-v1',
  loginChallengeSeconds: 300,
  enrollmentChallengeSeconds: 600,
  invitationSeconds: 86_400,
  invitationResendSeconds: 60,
  invitationSendsPerHour: 5,
  challengeMaxFailures: 5,
  accountFailureWindowSeconds: 900,
  accountMaxFailures: 5,
  identityIpAttemptsPerWindow: 60,
  accountCooldownSeconds: 900,
  bootstrapWindowSeconds: 900,
  idleSessionSeconds: 1_800,
  absoluteSessionSeconds: 43_200,
  resetPasswordSeconds: 1_800,
  resetRequestCooldownSeconds: 60,
  resetRequestsPerHour: 5,
  secretBytes: 32,
  recoveryCodeCount: 10,
  recoveryCodeCharacters: 20,
  expiredSecretCleanupSeconds: 900,
});

export function expiresAt(now: Date, seconds: number): Date {
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('Invalid security deadline');
  }
  return new Date(now.getTime() + seconds * 1_000);
}
