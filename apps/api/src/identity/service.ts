import { randomUUID } from 'node:crypto';
import { loadMigrationManifest, migrationsMatch, type MigrationRecord } from '../../../../packages/database/src/migrations.js';

import type { Prisma, PrismaClient } from '../../../../packages/database/src/client.js';
import { issueInvitation, resendInvitation, revokeInvitation, acceptInvitation, issuePasswordReset, rotatePasswordReset, completePasswordReset,
  IdentityConflict, type Invitation, type PasswordReset, digest } from '../../../../packages/domain/src/identity.js';
import { DEFAULT_FEATURE_FLAGS, StoreRuleError, SUPPORTED_LOCALES, assertMarketCanEnable, marketAfterReview, marketView,
  normalizeMarketCode, normalizeMarketInput, normalizeStoreSettings, type MarketInput, type ReviewDecision } from '../../../../packages/domain/src/store.js';
import { expiresAt, securityPolicy as policy } from '../../../../packages/config/src/security-policy.js';
import { resolveRolePresets } from '../../../../packages/config/src/role-presets.js';
import { csrf, decrypt, encrypt, equal, newTotpSecret, passwordHash, passwordMatches, recoveryCodes, token, totp, totpStep } from './crypto.js';
import type { IdentityConfig } from './config.js';

type Tx = Prisma.TransactionClient;
const includeUser = { roles: { include: { role: true } }, factor: true } as const;
type User = Prisma.AdminUserGetPayload<{ include: typeof includeUser }>;
export interface RequestContext { requestId: string; ip: string }
export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
type Outcome<T> = { value: T } | { error: AuthError; failureEmail?: string };
const rejected = (status = 401, code = 'UNAUTHORIZED'): Outcome<never> => ({ error: new AuthError(status, code) });

export class IdentityService {
  private dummyHash = '';
  private migrationManifest: ReadonlyMap<string, string> = new Map();
  constructor(readonly db: PrismaClient, readonly config: IdentityConfig, private readonly permissions: string[]) {}
  async initialize() {
    this.migrationManifest = await loadMigrationManifest();
    const version = await this.db.$queryRaw<{ version: number }[]>`SELECT current_setting('server_version_num')::int AS version`;
    if (!version[0] || version[0].version < 180000 || version[0].version >= 190000 || !await this.ready()) {
      throw new Error('Identity database version or migrations are not ready');
    }
    await this.db.$queryRaw`SELECT 1 FROM "AdminUser" LIMIT 1`;
    this.dummyHash = await passwordHash(token());
    await this.db.$transaction(async tx => this.ensureRolePresets(tx), { timeout: 10_000 });
    if (this.config.bootstrapToken) {
      await this.db.$transaction(async tx => {
        const now = await this.now(tx);
        await tx.bootstrapState.upsert({ where: { id: 1 }, update: {}, create: {
          id: 1, tokenDigest: digest(this.config.bootstrapToken!), expiresAt: expiresAt(now, policy.bootstrapWindowSeconds),
          consumedAt: await tx.adminUser.count() > 0 ? now : null,
        } });
      });
    }
  }
  async onModuleDestroy() { await this.db.$disconnect(); }
  async ready(): Promise<boolean> {
    try {
      const rows = await this.db.$queryRaw<MigrationRecord[]>`
        SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`;
      return migrationsMatch(this.migrationManifest, rows);
    } catch { return false; }
  }
  /**
   * 幂等地补齐默认岗位权限包：缺失的预设角色按当前权限矩阵创建，已存在的一律不改
   * （店主可自行调整预设授权，重启不能被覆盖）。唯一例外是 owner 角色——它不可编辑，
   * 因此按当前契约权限码单向补齐，保证新增模块上线后店主不会失去新权限。
   */
  private async ensureRolePresets(tx: Tx) {
    const presets = resolveRolePresets(this.permissions);
    await this.lock(tx, 'role-presets');
    const existing = await tx.adminRole.findMany({ where: { presetKey: { in: presets.map(preset => preset.key) } } });
    const present = new Set(existing.map(role => role.presetKey));
    for (const preset of presets) {
      if (!present.has(preset.key)) await tx.adminRole.createMany({ data: [preset], skipDuplicates: true });
    }
    const owner = await tx.adminRole.findUnique({ where: { presetKey: 'owner' } });
    const ownerCodes = presets.find(preset => preset.key === 'owner')!.permissionCodes;
    if (!owner) return;
    const merged = [...new Set([...owner.permissionCodes, ...ownerCodes])].sort();
    if (merged.length !== owner.permissionCodes.length) await tx.adminRole.update({ where: { id: owner.id }, data: { permissionCodes: merged } });
  }
  private async now(tx: Tx): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return rows[0]!.now;
  }
  private async lock(tx: Tx, key: string) {
    // The hash only chooses a lock; collisions serialize extra operations, never authorize them.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
  }
  private async audit(tx: Tx, ctx: RequestContext, actorId: string | null, action: string, objectId: string | null, result = 'success', reason?: string) {
    await tx.auditLog.create({ data: { actorId, action, objectId, result, requestId: ctx.requestId,
      ...(reason ? { reason: reason.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1_000) } : {}) } });
  }
  private async withUser<T>(userId: string, fn: (tx: Tx, user: User, now: Date) => Promise<T>, serializeAccess = false): Promise<T> {
    return this.db.$transaction(async tx => {
      if (serializeAccess) await this.lock(tx, 'identity-access');
      await this.lock(tx, `user:${userId}`);
      const user = await tx.adminUser.findUnique({ where: { id: userId }, include: includeUser });
      if (!user || user.status !== 'active') throw new AuthError(401, 'UNAUTHORIZED');
      return fn(tx, user, await this.now(tx));
    }, { timeout: 10_000 });
  }
  private needsMfa(user: User) {
    return user.mfaRequired || user.roles.some(link => ['owner', 'admin'].includes(link.role.kind));
  }
  private userSummary(user: User) {
    return { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale,
      status: user.status, roleIds: user.roles.map(link => link.roleId), mfaRequired: this.needsMfa(user),
      mfaEnabled: user.factor !== null, version: user.version, lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(), updatedAt: user.updatedAt.toISOString() };
  }
  private sessionData(user: User, session: { mfaVerified: boolean; idleExpiresAt: Date; absoluteExpiresAt: Date }, sessionToken: string) {
    return { user: this.userSummary(user), permissionCodes: [...new Set(user.roles.flatMap(link => link.role.permissionCodes))].sort(),
      mfaVerified: session.mfaVerified, idleExpiresAt: session.idleExpiresAt.toISOString(), absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      csrfToken: csrf(sessionToken, this.config) };
  }
  private async newSession(tx: Tx, user: User, now: Date, mfaVerified: boolean) {
    const sessionToken = token();
    const session = await tx.adminSession.create({ data: { userId: user.id, tokenDigest: digest(sessionToken), mfaVerified,
      lastSeenAt: now, idleExpiresAt: expiresAt(now, policy.idleSessionSeconds), absoluteExpiresAt: expiresAt(now, policy.absoluteSessionSeconds) } });
    const updated = await tx.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: now }, include: includeUser });
    await tx.identityRateLimit.deleteMany({ where: { key: this.accountKey(user.email) } });
    return { sessionToken, data: this.sessionData(updated, session, sessionToken) };
  }
  private async newChallenge(tx: Tx, user: User, now: Date, purpose: 'verify_mfa' | 'enroll_mfa') {
    const challengeToken = token();
    const expires = expiresAt(now, purpose === 'verify_mfa' ? policy.loginChallengeSeconds : policy.enrollmentChallengeSeconds);
    const challenge = await tx.adminChallenge.create({ data: { userId: user.id, purpose, tokenDigest: digest(challengeToken),
      factorVersion: user.factor?.version ?? 0, userVersion: user.version, expiresAt: expires } });
    const common = { challengeId: challenge.id, expiresAt: expires.toISOString() };
    return { challengeToken, purpose, data: purpose === 'verify_mfa'
      ? { ...common, nextAction: 'verify_mfa' as const, allowedMethods: ['totp', 'recovery_code'] }
      : { ...common, nextAction: 'enroll_mfa' as const } };
  }
  private accountKey(email: string) { return `account:${digest(email)}`; }
  private async checkAccount(email: string) {
    const now = await this.now(this.db);
    await this.checkAccountIn(this.db, email, now);
  }
  private async checkAccountIn(tx: Tx, email: string, now: Date) {
    const row = await tx.identityRateLimit.findUnique({ where: { key: this.accountKey(email) } });
    if (row?.blockedUntil && row.blockedUntil > now) throw new AuthError(429, 'RATE_LIMITED');
  }
  private async failure(email: string) {
    const key = this.accountKey(email);
    await this.db.$transaction(async tx => {
      await this.lock(tx, key);
      const now = await this.now(tx);
      const row = await tx.identityRateLimit.findUnique({ where: { key } });
      const count = !row || now.getTime() >= row.windowStart.getTime() + policy.accountFailureWindowSeconds * 1_000 ? 1 : row.count + 1;
      await tx.identityRateLimit.upsert({ where: { key }, create: { key, count, windowStart: now }, update: {
        count, windowStart: count === 1 ? now : row!.windowStart,
        blockedUntil: count >= policy.accountMaxFailures ? expiresAt(now, policy.accountCooldownSeconds) : null,
      } });
    });
  }
  async limitIp(ctx: RequestContext) {
    const key = `ip:${digest(ctx.ip)}`;
    const ok = await this.db.$transaction(async tx => {
      await this.lock(tx, key);
      const now = await this.now(tx);
      const row = await tx.identityRateLimit.findUnique({ where: { key } });
      const count = !row || now.getTime() >= row.windowStart.getTime() + policy.accountFailureWindowSeconds * 1_000 ? 1 : row.count + 1;
      if (count > policy.identityIpAttemptsPerWindow) return false;
      await tx.identityRateLimit.upsert({ where: { key }, create: { key, count, windowStart: now }, update: {
        count, windowStart: count === 1 ? now : row!.windowStart,
      } });
      return true;
    });
    if (!ok) throw new AuthError(429, 'RATE_LIMITED');
  }
  private async finish<T>(result: Outcome<T>): Promise<T> {
    if ('error' in result) {
      if (result.failureEmail) await this.failure(result.failureEmail);
      throw result.error;
    }
    return result.value;
  }
  async bootstrap(body: { email: string; password: string; displayName: string; locale: string }, supplied: string, ctx: RequestContext) {
    const gate = await this.db.bootstrapState.findUnique({ where: { id: 1 } });
    if (!gate || !equal(gate.tokenDigest, digest(supplied))) throw new AuthError(401, 'UNAUTHORIZED');
    const encoded = await passwordHash(body.password);
    return this.db.$transaction(async tx => {
      await this.lock(tx, 'bootstrap');
      const now = await this.now(tx);
      const state = await tx.bootstrapState.findUnique({ where: { id: 1 } });
      if (!state || state.expiresAt <= now || !equal(state.tokenDigest, digest(supplied))) throw new AuthError(401, 'UNAUTHORIZED');
      if (state.consumedAt || await tx.adminUser.count() > 0) throw new AuthError(409, 'INSTANCE_INITIALIZED');
      await this.ensureRolePresets(tx);
      const role = await tx.adminRole.findUniqueOrThrow({ where: { presetKey: 'owner' } });
      const user = await tx.adminUser.create({ data: { email: body.email.trim().toLowerCase(), displayName: body.displayName,
        locale: body.locale, passwordHash: encoded, mfaRequired: true, roles: { create: { roleId: role.id } } }, include: includeUser });
      await tx.bootstrapState.update({ where: { id: 1 }, data: { consumedAt: now } });
      await this.audit(tx, ctx, user.id, 'admin.bootstrapped', user.id);
      return this.newChallenge(tx, user, now, 'enroll_mfa');
    }, { timeout: 10_000 });
  }
  async login(body: { email: string; password: string }, ctx: RequestContext) {
    const email = body.email.trim().toLowerCase();
    await this.checkAccount(email);
    const candidate = await this.db.adminUser.findUnique({ where: { email }, include: includeUser });
    const matched = await passwordMatches(candidate?.passwordHash ?? this.dummyHash, body.password);
    if (!candidate || !matched || candidate.status !== 'active') {
      await this.failure(email);
      await this.audit(this.db, ctx, null, 'admin.login', null, 'denied');
      throw new AuthError(401, 'UNAUTHORIZED');
    }
    return this.withUser(candidate.id, async (tx, user, now) => {
      if (user.passwordHash !== candidate.passwordHash) throw new AuthError(401, 'UNAUTHORIZED');
      await this.audit(tx, ctx, user.id, 'admin.login.password_verified', user.id);
      if (user.factor || this.needsMfa(user)) {
        return { status: 202 as const, ...await this.newChallenge(tx, user, now, user.factor ? 'verify_mfa' : 'enroll_mfa') };
      }
      return { status: 200 as const, ...await this.newSession(tx, user, now, false) };
    });
  }
  private async challenge<T>(challengeId: string, supplied: string, purpose: 'verify_mfa' | 'enroll_mfa',
    fn: (tx: Tx, user: User, challenge: Prisma.AdminChallengeGetPayload<{}>, now: Date) => Promise<Outcome<T>>) {
    const candidate = await this.db.adminChallenge.findUnique({ where: { id: challengeId } });
    if (!candidate) throw new AuthError(401, 'UNAUTHORIZED');
    const user = await this.db.adminUser.findUnique({ where: { id: candidate.userId } });
    if (user) await this.checkAccount(user.email);
    const result = await this.withUser(candidate.userId, async (tx, current, now) => {
      const challenge = await tx.adminChallenge.findUnique({ where: { id: challengeId } });
      if (!challenge || challenge.purpose !== purpose || challenge.consumedAt || challenge.expiresAt <= now ||
        challenge.failures >= policy.challengeMaxFailures || challenge.userVersion !== current.version ||
        challenge.factorVersion !== (current.factor?.version ?? 0) || !equal(challenge.tokenDigest, digest(supplied))) {
        throw new AuthError(401, 'UNAUTHORIZED');
      }
      return fn(tx, current, challenge, now);
    });
    return this.finish(result);
  }
  async startEnrollment(body: { challengeId: string }, supplied: string, ctx: RequestContext) {
    return this.challenge(body.challengeId, supplied, 'enroll_mfa', async (tx, user, challenge) => {
      const secret = newTotpSecret(); const enrollmentId = randomUUID();
      await tx.adminChallenge.update({ where: { id: challenge.id }, data: { enrollmentId, pendingSecret: encrypt(secret, user.id, this.config) } });
      await this.audit(tx, ctx, user.id, 'admin.mfa.enrollment_started', enrollmentId);
      return { value: { enrollmentId, expiresAt: challenge.expiresAt.toISOString(), totpSecret: secret, provisioningUri: totp(secret, user.email).toString() } };
    });
  }
  async confirmEnrollment(body: { challengeId: string; enrollmentId: string; code: string }, supplied: string, ctx: RequestContext) {
    return this.challenge(body.challengeId, supplied, 'enroll_mfa', async (tx, user, challenge, now) => {
      if (challenge.enrollmentId !== body.enrollmentId || !challenge.pendingSecret) return rejected();
      const step = totpStep(decrypt(challenge.pendingSecret, user.id, this.config), body.code, now);
      if (step === null) {
        await tx.adminChallenge.update({ where: { id: challenge.id }, data: { failures: { increment: 1 } } });
        await this.audit(tx, ctx, user.id, 'admin.mfa.enrollment_confirmed', challenge.id, 'denied');
        return { error: new AuthError(401, 'UNAUTHORIZED'), failureEmail: user.email };
      }
      const codes = recoveryCodes();
      await tx.mfaFactor.upsert({ where: { userId: user.id }, create: { userId: user.id, encryptedSecret: challenge.pendingSecret, lastUsedStep: step },
        update: { encryptedSecret: challenge.pendingSecret, lastUsedStep: step, version: { increment: 1 } } });
      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.createMany({ data: codes.map(code => ({ userId: user.id, digest: digest(code) })) });
      await tx.adminChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: now, pendingSecret: null } });
      await tx.adminSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      const updated = await tx.adminUser.update({ where: { id: user.id }, data: { version: { increment: 1 } }, include: includeUser });
      const session = await this.newSession(tx, updated, now, true);
      await this.audit(tx, ctx, user.id, 'admin.mfa.enrollment_confirmed', user.id);
      return { value: { sessionToken: session.sessionToken, data: { session: session.data, recoveryCodes: codes } } };
    });
  }
  private async verifyFactor(tx: Tx, user: User, code: string, now: Date): Promise<boolean> {
    if (!user.factor) return false;
    if (/^\d{6}$/.test(code)) {
      const step = totpStep(decrypt(user.factor.encryptedSecret, user.id, this.config), code, now);
      if (step === null || step <= user.factor.lastUsedStep) return false;
      await tx.mfaFactor.update({ where: { userId: user.id }, data: { lastUsedStep: step } });
      return true;
    }
    const changed = await tx.recoveryCode.updateMany({ where: { userId: user.id, digest: digest(code), consumedAt: null }, data: { consumedAt: now } });
    return changed.count === 1;
  }
  async verifyMfa(body: { challengeId: string; code: string }, supplied: string, ctx: RequestContext) {
    return this.challenge(body.challengeId, supplied, 'verify_mfa', async (tx, user, challenge, now) => {
      if (!await this.verifyFactor(tx, user, body.code, now)) {
        await tx.adminChallenge.update({ where: { id: challenge.id }, data: { failures: { increment: 1 } } });
        await this.audit(tx, ctx, user.id, 'admin.mfa.verified', challenge.id, 'denied');
        return { error: new AuthError(401, 'UNAUTHORIZED'), failureEmail: user.email };
      }
      await tx.adminChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
      if (!/^\d{6}$/.test(body.code)) await this.audit(tx, ctx, user.id, 'admin.mfa.recovery_used', user.id);
      await this.audit(tx, ctx, user.id, 'admin.mfa.verified', challenge.id);
      return { value: await this.newSession(tx, user, now, true) };
    });
  }
  private async authenticated<T>(supplied: string, csrfValue: string | null, fn: (tx: Tx, user: User, session: Prisma.AdminSessionGetPayload<{}>, now: Date) => Promise<T>, serializeAccess = false) {
    const candidate = await this.db.adminSession.findUnique({ where: { tokenDigest: digest(supplied) } });
    if (!candidate) throw new AuthError(401, 'UNAUTHORIZED');
    return this.withUser(candidate.userId, async (tx, user, now) => {
      const session = await tx.adminSession.findUnique({ where: { id: candidate.id } });
      if (!session || session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now ||
        (this.needsMfa(user) && (!user.factor || !session.mfaVerified))) throw new AuthError(401, 'UNAUTHORIZED');
      if (csrfValue !== null && !equal(csrfValue, csrf(supplied, this.config))) throw new AuthError(403, 'FORBIDDEN');
      const updated = await tx.adminSession.update({ where: { id: session.id }, data: {
        lastSeenAt: now, idleExpiresAt: new Date(Math.min(expiresAt(now, policy.idleSessionSeconds).getTime(), session.absoluteExpiresAt.getTime())),
      } });
      return fn(tx, user, updated, now);
    }, serializeAccess);
  }
  async session(supplied: string) {
    return this.authenticated(supplied, null, async (_tx, user, session) => this.sessionData(user, session, supplied));
  }
  async logout(supplied: string, csrfValue: string, ctx: RequestContext) {
    await this.authenticated(supplied, csrfValue, async (tx, user, session, now) => {
      await tx.adminSession.update({ where: { id: session.id }, data: { revokedAt: now } });
      await this.audit(tx, ctx, user.id, 'admin.session.revoked', session.id);
    });
  }
  async sessions(supplied: string, limit: number, cursor: string | null) {
    return this.authenticated(supplied, null, async (tx, user, current, now) => {
      if (cursor && !await tx.adminSession.findFirst({ where: { id: cursor, userId: user.id } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.adminSession.findMany({ where: { userId: user.id, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const visible = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: visible.map(row => ({ id: row.id, createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
        idleExpiresAt: row.idleExpiresAt.toISOString(), absoluteExpiresAt: row.absoluteExpiresAt.toISOString(), current: row.id === current.id })),
        hasMore, nextCursor: hasMore ? visible.at(-1)!.id : null };
    });
  }
  async revokeSession(supplied: string, csrfValue: string, sessionId: string, reason: string, ctx: RequestContext) {
    return this.authenticated(supplied, csrfValue, async (tx, user, _current, now) => {
      const target = await tx.adminSession.findFirst({ where: { id: sessionId, userId: user.id } });
      if (!target) throw new AuthError(404, 'NOT_FOUND');
      const revokedAt = target.revokedAt ?? now;
      await tx.adminSession.update({ where: { id: target.id }, data: { revokedAt } });
      await this.audit(tx, ctx, user.id, 'admin.session.revoked', target.id, 'success', reason);
      return { sessionId: target.id, revokedAt: revokedAt.toISOString() };
    });
  }
  async authorizeEnrollment(supplied: string, csrfValue: string, body: { currentPassword: string; currentMfaCode?: string }, ctx: RequestContext) {
    const result = await this.authenticated(supplied, csrfValue, async (tx, user, _session, now): Promise<Outcome<Awaited<ReturnType<IdentityService['newChallenge']>>>> => {
      await this.checkAccountIn(tx, user.email, now);
      if (!await passwordMatches(user.passwordHash, body.currentPassword) || (user.factor && !await this.verifyFactor(tx, user, body.currentMfaCode ?? '', now))) {
        await this.audit(tx, ctx, user.id, 'admin.mfa.enrollment_authorized', user.id, 'denied');
        return { error: new AuthError(401, 'UNAUTHORIZED'), failureEmail: user.email };
      }
      const challenge = await this.newChallenge(tx, user, now, 'enroll_mfa');
      if (user.factor && body.currentMfaCode && !/^\d{6}$/.test(body.currentMfaCode)) await this.audit(tx, ctx, user.id, 'admin.mfa.recovery_used', user.id);
      await this.audit(tx, ctx, user.id, 'admin.mfa.enrollment_authorized', user.id);
      return { value: challenge };
    });
    return this.finish(result);
  }
  private requirePermission(user: User, permission: string) {
    if (!user.roles.some(link => link.role.permissionCodes.includes(permission))) throw new AuthError(403, 'FORBIDDEN');
  }
  private async checkDelegation(tx: Tx, actor: User, roleIds: string[]) {
    this.requirePermission(actor, 'staff.manage');
    const roles = await tx.adminRole.findMany({ where: { id: { in: roleIds } } });
    if (!roleIds.length || roles.length !== roleIds.length) throw new AuthError(422, 'VALIDATION_ERROR');
    const owned = new Set(actor.roles.flatMap(link => link.role.permissionCodes));
    if (roles.some(role => role.kind === 'owner' || role.permissionCodes.some(code => !owned.has(code)))) throw new AuthError(403, 'FORBIDDEN');
    return roles;
  }
  private invitationSummary(invitation: Prisma.AdminInvitationGetPayload<{}>, now: Date) {
    return { id: invitation.id, userId: invitation.userId, status: invitation.status === 'pending' && invitation.expiresAt <= now ? 'expired' : invitation.status,
      version: invitation.version, expiresAt: invitation.expiresAt.toISOString(), lastSentAt: invitation.lastSentAt.toISOString(), notificationJobId: invitation.notificationJobId };
  }
  private invitationRule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof IdentityConflict) throw new AuthError(error.code === 'RATE_LIMITED' ? 429 : 409, error.code);
      throw error;
    }
  }
  private async queueInvitation(tx: Tx, invitation: Invitation, secret: string) {
    await tx.identityNotificationJob.updateMany({ where: { invitationId: invitation.id, status: { in: ['pending', 'processing', 'failed'] } }, data: { status: 'cancelled', encryptedPayload: null } });
    const id = randomUUID();
    await tx.identityNotificationJob.create({ data: { id, invitationId: invitation.id, targetVersion: invitation.version,
      encryptedPayload: encrypt(secret, invitation.userId, this.config, `invitation:${id}:${invitation.version}`), expiresAt: invitation.expiresAt } });
    return id;
  }
  async inviteStaff(supplied: string, csrfValue: string, body: { email: string; displayName: string; locale: string; roleIds: string[] }, ctx: RequestContext) {
    // Perform expensive hashing outside the transaction; authorization is rechecked within it.
    const encoded = await passwordHash(token());
    return this.authenticated(supplied, csrfValue, async (tx, actor, _session, now) => {
      await this.checkDelegation(tx, actor, body.roleIds);
      const email = body.email.trim().toLowerCase();
      await this.lock(tx, `staff-email:${email}`);
      if (await tx.adminUser.findUnique({ where: { email } })) throw new AuthError(409, 'STATE_CONFLICT');
      const user = await tx.adminUser.create({ data: { email, displayName: body.displayName, locale: body.locale, status: 'invited', passwordHash: encoded,
        mfaRequired: true, roles: { create: body.roleIds.map(roleId => ({ roleId })) } }, include: includeUser });
      const issued = issueInvitation(randomUUID(), user.id, now);
      await tx.adminInvitation.create({ data: { ...issued.invitation, inviterId: actor.id } });
      const notificationJobId = await this.queueInvitation(tx, issued.invitation, issued.token);
      await tx.adminInvitation.update({ where: { id: issued.invitation.id }, data: { notificationJobId } });
      await this.audit(tx, ctx, actor.id, 'admin.invitation.issued', user.id);
      return this.userSummary(user);
    }, true);
  }
  async getInvitation(supplied: string, userId: string) {
    return this.authenticated(supplied, null, async (tx, actor, _session, now) => {
      this.requirePermission(actor, 'staff.read');
      const invitation = await tx.adminInvitation.findUnique({ where: { userId } });
      if (!invitation) throw new AuthError(404, 'NOT_FOUND');
      return this.invitationSummary(invitation, now);
    });
  }
  async changeInvitation(supplied: string, csrfValue: string, userId: string, version: number, action: 'resend' | 'revoke', reason: string, key: string, ctx: RequestContext) {
    return this.authenticated(supplied, csrfValue, async (tx, actor, _session, now) => {
      this.requirePermission(actor, 'staff.manage');
      await this.lock(tx, `invitation:${userId}`);
      const current = await tx.adminInvitation.findUnique({ where: { userId } });
      const target = await tx.adminUser.findUnique({ where: { id: userId }, include: includeUser });
      if (!current || !target) throw new AuthError(404, 'NOT_FOUND');
      await this.checkDelegation(tx, actor, target.roles.map(link => link.roleId));
      if (target.status !== 'invited') throw new AuthError(409, 'STATE_CONFLICT');
      const receipts = current.resendReceipts as Record<string, { fingerprint: string; summary: ReturnType<IdentityService['invitationSummary']> }>;
      const receiptKey = digest(`${actor.id}:${key}`);
      const fingerprint = digest(JSON.stringify({ version, reason }));
      if (action === 'resend' && receipts[receiptKey]) {
        if (receipts[receiptKey].fingerprint !== fingerprint) throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
        return receipts[receiptKey].summary;
      }
      const invitation = current as typeof current & Invitation;
      const next = action === 'resend' ? this.invitationRule(() => resendInvitation(invitation, version, now))
        : { invitation: this.invitationRule(() => revokeInvitation(invitation, version)), token: null };
      const notificationJobId = next.token ? await this.queueInvitation(tx, next.invitation, next.token) : current.notificationJobId;
      if (action === 'revoke') await tx.identityNotificationJob.updateMany({ where: { invitationId: current.id }, data: { status: 'cancelled', encryptedPayload: null } });
      const updated = await tx.adminInvitation.update({ where: { id: current.id }, data: { ...next.invitation, notificationJobId, inviterId: actor.id } });
      const summary = this.invitationSummary(updated, now);
      if (action === 'resend') {
        receipts[receiptKey] = { fingerprint, summary };
        await tx.adminInvitation.update({ where: { id: current.id }, data: { resendReceipts: receipts } });
      }
      await this.audit(tx, ctx, actor.id, `admin.invitation.${action === 'resend' ? 'resent' : 'revoked'}`, userId, 'success', reason);
      return summary;
    }, true);
  }
  async acceptStaffInvitation(body: { invitationToken: string; newPassword: string }, ctx: RequestContext) {
    const candidate = await this.db.adminInvitation.findUnique({ where: { tokenDigest: digest(body.invitationToken) } });
    if (!candidate) throw new AuthError(401, 'UNAUTHORIZED');
    const encoded = await passwordHash(body.newPassword);
    return this.db.$transaction(async tx => {
      await this.lock(tx, 'identity-access');
      // Same lock order as management: actor, invitation, target.
      await this.lock(tx, `user:${candidate.inviterId}`);
      await this.lock(tx, `invitation:${candidate.userId}`);
      await this.lock(tx, `user:${candidate.userId}`);
      const now = await this.now(tx);
      const invitation = await tx.adminInvitation.findUnique({ where: { id: candidate.id } });
      const actor = await tx.adminUser.findUnique({ where: { id: candidate.inviterId }, include: includeUser });
      const target = await tx.adminUser.findUnique({ where: { id: candidate.userId }, include: includeUser });
      if (!invitation || invitation.inviterId !== candidate.inviterId || !actor || actor.status !== 'active' || !target || target.status !== 'invited') throw new AuthError(401, 'UNAUTHORIZED');
      try {
        await this.checkDelegation(tx, actor, target.roles.map(link => link.roleId));
        acceptInvitation(invitation as typeof invitation & Invitation, invitation.version, body.invitationToken, now);
      } catch { throw new AuthError(401, 'UNAUTHORIZED'); }
      await tx.adminInvitation.update({ where: { id: invitation.id }, data: { status: 'accepted', version: { increment: 1 } } });
      await tx.identityNotificationJob.updateMany({ where: { invitationId: invitation.id }, data: { status: 'cancelled', encryptedPayload: null } });
      const user = await tx.adminUser.update({ where: { id: target.id }, data: { status: 'active', passwordHash: encoded, version: { increment: 1 } }, include: includeUser });
      await this.audit(tx, ctx, user.id, 'admin.invitation.accepted', user.id);
      if (this.needsMfa(user)) return { status: 202 as const, ...await this.newChallenge(tx, user, now, 'enroll_mfa') };
      return { status: 200 as const, ...await this.newSession(tx, user, now, false) };
    }, { timeout: 10_000 });
  }

  private resetRecord(reset: Prisma.AdminPasswordResetGetPayload<{}>): PasswordReset {
    return { id: reset.id, userId: reset.userId, version: reset.version, status: reset.status as PasswordReset['status'],
      tokenDigest: reset.tokenDigest, expiresAt: reset.expiresAt, requestedAt: reset.requestedAt };
  }
  private async cancelResetJobs(tx: Tx, resetId: string) {
    await tx.identityNotificationJob.updateMany({ where: { passwordResetId: resetId, status: { in: ['pending', 'processing', 'failed'] } },
      data: { status: 'cancelled', encryptedPayload: null, leaseToken: null, leaseExpiresAt: null } });
  }
  /**
   * Uniformly accepted: unknown, suspended, cooling-down and rate-limited accounts all return the same body and
   * create no reset credential, so the response cannot be used to test whether an email is registered.
   */
  async requestPasswordReset(body: { email: string }, ctx: RequestContext) {
    const email = body.email.trim().toLowerCase();
    const key = `reset:${digest(email)}`;
    const accepted = { requestAccepted: true as const };
    return this.db.$transaction(async tx => {
      await this.lock(tx, key);
      const now = await this.now(tx);
      const row = await tx.identityRateLimit.findUnique({ where: { key } });
      const windowElapsed = !row || now.getTime() >= row.windowStart.getTime() + 3_600_000;
      const count = windowElapsed ? 1 : row.count + 1;
      const coolingDown = row?.blockedUntil ? now.getTime() < row.blockedUntil.getTime() : false;
      // blockedUntil is reused as "earliest next send" for this key only; the key is never an account lock.
      await tx.identityRateLimit.upsert({ where: { key }, create: { key, count, windowStart: now, blockedUntil: expiresAt(now, policy.resetRequestCooldownSeconds) },
        update: { count, windowStart: windowElapsed ? now : row!.windowStart, blockedUntil: expiresAt(now, policy.resetRequestCooldownSeconds) } });
      if (coolingDown || count > policy.resetRequestsPerHour) return accepted;
      const user = await tx.adminUser.findUnique({ where: { email } });
      if (!user || user.status !== 'active') return accepted;
      await this.lock(tx, `user:${user.id}`);
      const existing = await tx.adminPasswordReset.findUnique({ where: { userId: user.id } });
      const issued = existing ? rotatePasswordReset(this.resetRecord(existing), now) : issuePasswordReset(randomUUID(), user.id, now);
      await this.cancelResetJobs(tx, issued.reset.id);
      const jobId = randomUUID();
      const data = { version: issued.reset.version, status: issued.reset.status, tokenDigest: issued.reset.tokenDigest,
        expiresAt: issued.reset.expiresAt, requestedAt: issued.reset.requestedAt, notificationJobId: jobId };
      if (existing) await tx.adminPasswordReset.update({ where: { id: existing.id }, data });
      else await tx.adminPasswordReset.create({ data: { ...data, id: issued.reset.id, userId: user.id } });
      await tx.identityNotificationJob.create({ data: { id: jobId, kind: 'password_reset', passwordResetId: issued.reset.id,
        targetVersion: issued.reset.version, expiresAt: issued.reset.expiresAt,
        encryptedPayload: encrypt(issued.token, user.id, this.config, `password-reset:${jobId}:${issued.reset.version}`) } });
      await this.audit(tx, ctx, user.id, 'admin.password_reset.requested', user.id);
      return accepted;
    }, { timeout: 10_000 });
  }
  /** Completion revokes every session and pending challenge but keeps the factor, recovery codes and MFA requirement. */
  async completePasswordReset(body: { resetToken: string; newPassword: string }, ctx: RequestContext) {
    const encoded = await passwordHash(body.newPassword);
    const candidate = await this.db.adminPasswordReset.findUnique({ where: { tokenDigest: digest(body.resetToken) } });
    if (!candidate) throw new AuthError(401, 'UNAUTHORIZED');
    return this.db.$transaction(async tx => {
      await this.lock(tx, 'identity-access');
      await this.lock(tx, `user:${candidate.userId}`);
      const now = await this.now(tx);
      const reset = await tx.adminPasswordReset.findUnique({ where: { id: candidate.id } });
      const user = await tx.adminUser.findUnique({ where: { id: candidate.userId }, include: includeUser });
      if (!reset || !user || user.status !== 'active') throw new AuthError(401, 'UNAUTHORIZED');
      try { completePasswordReset(this.resetRecord(reset), body.resetToken, now); } catch { throw new AuthError(401, 'UNAUTHORIZED'); }
      await this.cancelResetJobs(tx, reset.id);
      await tx.adminPasswordReset.update({ where: { id: reset.id }, data: { status: 'completed', version: { increment: 1 }, tokenDigest: digest(token()) } });
      await tx.adminUser.update({ where: { id: user.id }, data: { passwordHash: encoded, version: { increment: 1 } } });
      await tx.adminSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.adminChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: now, pendingSecret: null } });
      await this.audit(tx, ctx, user.id, 'admin.password_reset.completed', user.id);
      return { requestAccepted: true as const };
    }, { timeout: 10_000 });
  }
  private roleSummary(role: Prisma.AdminRoleGetPayload<{}>) {
    return { id: role.id, name: role.name, kind: role.kind, presetKey: role.presetKey, description: role.description,
      permissionCodes: role.permissionCodes, version: role.version, createdAt: role.createdAt.toISOString(), updatedAt: role.updatedAt.toISOString() };
  }
  private grantable(actor: User, codes: string[]) {
    const owned = new Set(actor.roles.flatMap(link => link.role.permissionCodes));
    if (codes.some(code => !this.permissions.includes(code))) throw new AuthError(422, 'VALIDATION_ERROR');
    if (codes.some(code => !owned.has(code))) throw new AuthError(403, 'FORBIDDEN');
  }
  private checkTarget(actor: User, target: User) {
    this.requirePermission(actor, 'staff.manage');
    const owned = new Set(actor.roles.flatMap(link => link.role.permissionCodes));
    if (target.roles.some(link => link.role.permissionCodes.some(code => !owned.has(code))) ||
      (target.roles.some(link => link.role.kind === 'owner') && !actor.roles.some(link => link.role.kind === 'owner'))) throw new AuthError(403, 'FORBIDDEN');
  }
  private async invalidateAuthority(tx: Tx, userIds: string[], now: Date) {
    for (const id of [...new Set(userIds)].sort()) await this.lock(tx, `user:${id}`);
    await tx.adminUser.updateMany({ where: { id: { in: userIds } }, data: { version: { increment: 1 } } });
    await tx.adminSession.updateMany({ where: { userId: { in: userIds }, revokedAt: null }, data: { revokedAt: now } });
    await tx.adminChallenge.updateMany({ where: { userId: { in: userIds }, consumedAt: null }, data: { consumedAt: now, pendingSecret: null } });
    const invitations = await tx.adminInvitation.findMany({ where: { status: 'pending', OR: [{ userId: { in: userIds } }, { inviterId: { in: userIds } }] } });
    for (const invitation of invitations) {
      await tx.adminInvitation.update({ where: { id: invitation.id }, data: { version: { increment: 1 }, tokenDigest: digest(token()) } });
      await tx.identityNotificationJob.updateMany({ where: { invitationId: invitation.id, status: { in: ['pending', 'processing', 'failed'] } },
        data: { status: 'cancelled', encryptedPayload: null, leaseToken: null, leaseExpiresAt: null } });
    }
    const resets = await tx.adminPasswordReset.findMany({ where: { userId: { in: userIds }, status: 'pending' } });
    for (const reset of resets) {
      await tx.adminPasswordReset.update({ where: { id: reset.id }, data: { status: 'revoked', version: { increment: 1 }, tokenDigest: digest(token()) } });
      await this.cancelResetJobs(tx, reset.id);
    }
  }
  async listStaff(supplied: string, limit: number, cursor: string | null) {
    return this.authenticated(supplied, null, async (tx, actor) => {
      this.requirePermission(actor, 'staff.read');
      if (cursor && !await tx.adminUser.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.adminUser.findMany({ include: includeUser, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const items = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: items.map(user => this.userSummary(user)), hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
    });
  }
  async getStaff(supplied: string, id: string) {
    return this.authenticated(supplied, null, async (tx, actor) => {
      this.requirePermission(actor, 'staff.read');
      const user = await tx.adminUser.findUnique({ where: { id }, include: includeUser });
      if (!user) throw new AuthError(404, 'NOT_FOUND');
      return this.userSummary(user);
    });
  }
  async updateStaff(supplied: string, csrfValue: string, id: string, version: number,
    body: { displayName?: string; status?: string; roleIds?: string[] }, ctx: RequestContext) {
    return this.authenticated(supplied, csrfValue, async (tx, actor, _session, now) => {
      this.requirePermission(actor, 'staff.manage');
      await this.lock(tx, `user:${id}`);
      const target = await tx.adminUser.findUnique({ where: { id }, include: includeUser });
      if (!target) throw new AuthError(404, 'NOT_FOUND');
      this.checkTarget(actor, target);
      if (target.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      const owner = target.roles.some(link => link.role.kind === 'owner');
      if (owner && (body.status === 'suspended' || body.roleIds !== undefined)) throw new AuthError(409, 'LAST_OWNER_PROTECTED');
      if (body.status === 'active' && target.status !== 'active') {
        const invitation = await tx.adminInvitation.findUnique({ where: { userId: id } });
        if (target.status === 'invited' || (invitation && invitation.status !== 'accepted')) throw new AuthError(409, 'INVITATION_REQUIRED');
      }
      if (body.roleIds !== undefined) {
        if (body.roleIds.length > 0) await this.checkDelegation(tx, actor, body.roleIds);
        await tx.adminUserRole.deleteMany({ where: { userId: id } });
        await tx.adminUserRole.createMany({ data: body.roleIds.map(roleId => ({ userId: id, roleId })) });
      }
      await this.invalidateAuthority(tx, [id], now);
      const updated = await tx.adminUser.update({ where: { id }, data: {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}), ...(body.status !== undefined ? { status: body.status } : {}),
      }, include: includeUser });
      await this.audit(tx, ctx, actor.id, 'admin.user.updated', id);
      return this.userSummary(updated);
    }, true);
  }
  async staffSessions(supplied: string, id: string, limit: number, cursor: string | null) {
    return this.authenticated(supplied, null, async (tx, actor, current, now) => {
      this.requirePermission(actor, 'staff.read');
      if (!await tx.adminUser.findUnique({ where: { id } })) throw new AuthError(404, 'NOT_FOUND');
      if (cursor && !await tx.adminSession.findFirst({ where: { id: cursor, userId: id } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.adminSession.findMany({ where: { userId: id, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const items = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: items.map(row => ({ id: row.id, createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
        idleExpiresAt: row.idleExpiresAt.toISOString(), absoluteExpiresAt: row.absoluteExpiresAt.toISOString(), current: row.id === current.id })),
        hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
    });
  }
  async revokeStaffSessions(supplied: string, csrfValue: string, id: string, reason: string, ctx: RequestContext) {
    return this.authenticated(supplied, csrfValue, async (tx, actor, _session, now) => {
      this.requirePermission(actor, 'staff.manage');
      await this.lock(tx, `user:${id}`);
      const target = await tx.adminUser.findUnique({ where: { id }, include: includeUser });
      if (!target) throw new AuthError(404, 'NOT_FOUND');
      this.checkTarget(actor, target);
      const result = await tx.adminSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
      await tx.adminChallenge.updateMany({ where: { userId: id, consumedAt: null }, data: { consumedAt: now, pendingSecret: null } });
      await this.audit(tx, ctx, actor.id, 'admin.user.sessions_revoked', id, 'success', reason);
      return { userId: id, revokedCount: result.count, revokedAt: now.toISOString() };
    }, true);
  }
  /**
   * 审计只读：不提供写入、修改或删除入口，读取本身也不需要 CSRF（无副作用）。
   * 返回字段刻意不含任何请求体或凭据，摘要只保留既有的 reason。
   */
  async listAuditLogs(supplied: string, limit: number, cursor: string | null) {
    return this.authenticated(supplied, null, async (tx, actor) => {
      this.requirePermission(actor, 'audit.read');
      if (cursor && !await tx.auditLog.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.auditLog.findMany({ orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const items = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: items.map(row => ({ id: row.id, actorId: row.actorId, action: row.action, objectId: row.objectId,
        result: row.result, requestId: row.requestId, reason: row.reason, occurredAt: row.occurredAt.toISOString() })),
        hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
    });
  }
  async listRoles(supplied: string, limit: number, cursor: string | null) {
    return this.authenticated(supplied, null, async (tx, actor) => {
      this.requirePermission(actor, 'roles.manage');
      if (cursor && !await tx.adminRole.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.adminRole.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const items = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: items.map(role => this.roleSummary(role)), hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
    });
  }
  async getRole(supplied: string, id: string) {
    return this.authenticated(supplied, null, async (tx, actor) => {
      this.requirePermission(actor, 'roles.manage');
      const role = await tx.adminRole.findUnique({ where: { id } });
      if (!role) throw new AuthError(404, 'NOT_FOUND');
      return this.roleSummary(role);
    });
  }
  async writeRole(supplied: string, csrfValue: string, id: string | null, version: number | null,
    body: { name?: string; description?: string | null; permissionCodes?: string[] }, ctx: RequestContext) {
    return this.authenticated(supplied, csrfValue, async (tx, actor, _session, now) => {
      this.requirePermission(actor, 'roles.manage');
      const existing = id ? await tx.adminRole.findUnique({ where: { id } }) : null;
      if (id && !existing) throw new AuthError(404, 'NOT_FOUND');
      if (existing?.kind === 'owner') throw new AuthError(409, 'OWNER_ROLE_PROTECTED');
      if (existing && existing.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      if (existing) this.grantable(actor, existing.permissionCodes);
      this.grantable(actor, body.permissionCodes ?? existing?.permissionCodes ?? []);
      const duplicate = body.name ? await tx.adminRole.findUnique({ where: { name: body.name } }) : null;
      if (duplicate && duplicate.id !== id) throw new AuthError(409, 'STATE_CONFLICT');
      const role = existing ? await tx.adminRole.update({ where: { id: existing.id }, data: { ...body, version: { increment: 1 } } })
        : await tx.adminRole.create({ data: { name: body.name!, description: body.description ?? null, kind: 'custom', permissionCodes: body.permissionCodes ?? [] } });
      if (existing) {
        const links = await tx.adminUserRole.findMany({ where: { roleId: existing.id } });
        await this.invalidateAuthority(tx, links.map(link => link.userId), now);
      }
      await this.audit(tx, ctx, actor.id, existing ? 'admin.role.updated' : 'admin.role.created', role.id);
      return this.roleSummary(role);
    }, true);
  }

  // ---- 商店设置（M01）--------------------------------------------------------
  // 单实例单店铺：StoreConfig 恒为 id=1。读取/写入都先确保该行存在，
  // 因此即使实例尚未初始化配置，管理端也能看到可编辑的默认值。

  private async ensureStoreConfig(tx: Tx) {
    return tx.storeConfig.upsert({ where: { id: 1 }, update: {}, create: {
      id: 1, displayName: 'EZSTART Store', locales: [...SUPPORTED_LOCALES], defaultLocale: 'zh-CN',
      baseCurrency: 'HKD', timezone: 'Asia/Hong_Kong', featureFlags: { ...DEFAULT_FEATURE_FLAGS },
    } });
  }

  /** 领域规则失败统一映射为 422：调用方不应看到内部字段名以外的信息。 */
  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) { if (error instanceof StoreRuleError) throw new AuthError(422, 'VALIDATION_ERROR'); throw error; }
  }

  private async storeView(tx: Tx, now: Date) {
    const row = await this.ensureStoreConfig(tx);
    const markets = await tx.marketProfile.findMany({ where: { storeConfigId: row.id }, orderBy: { marketCode: 'asc' } });
    return {
      displayName: row.displayName, locales: row.locales, defaultLocale: row.defaultLocale,
      baseCurrency: row.baseCurrency, timezone: row.timezone,
      // 审核过期在这里即时反映：enabled 会被收敛为 false，不等后台清理任务。
      marketProfiles: markets.map(market => marketView({ ...market, eligibleProductIds: market.eligibleProductIds }, now)),
      featureFlags: row.featureFlags as Record<string, boolean>,
      brandAssets: { logoMediaId: row.logoMediaId ?? null, faviconMediaId: row.faviconMediaId ?? null },
      version: row.version, updatedAt: row.updatedAt.toISOString(),
    };
  }

  async storeConfiguration(supplied: string) {
    return this.authenticated(supplied, null, async (tx, actor) => {
      this.requirePermission(actor, 'store.settings.manage');
      return this.storeView(tx, await this.now(tx));
    });
  }

  async updateStoreConfiguration(supplied: string, csrfValue: string, version: number, body: {
    displayName?: string; locales?: string[]; defaultLocale?: string; baseCurrency?: string; timezone?: string;
    marketProfiles?: MarketInput[]; featureFlags?: Record<string, boolean>;
    brandAssets?: { logoMediaId?: string | null; faviconMediaId?: string | null };
  }, ctx: RequestContext) {
    return this.authenticated(supplied, csrfValue, async (tx, actor, _session, now) => {
      this.requirePermission(actor, 'store.settings.manage');
      await this.lock(tx, 'store-config');
      const row = await this.ensureStoreConfig(tx);
      if (row.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      // 已有交易后再改本位币会让历史订单无法解释，必须拒绝而不是重算历史。
      if (body.baseCurrency !== undefined && body.baseCurrency !== row.baseCurrency && row.tradingStartedAt) throw new AuthError(409, 'CURRENCY_LOCKED');

      const settings = this.rule(() => normalizeStoreSettings({
        displayName: body.displayName ?? row.displayName,
        locales: body.locales ?? row.locales,
        defaultLocale: body.defaultLocale ?? row.defaultLocale,
        baseCurrency: body.baseCurrency ?? row.baseCurrency,
        timezone: body.timezone ?? row.timezone,
        featureFlags: body.featureFlags ?? (row.featureFlags as Record<string, boolean>),
        logoMediaId: body.brandAssets?.logoMediaId !== undefined ? body.brandAssets.logoMediaId : row.logoMediaId,
        faviconMediaId: body.brandAssets?.faviconMediaId !== undefined ? body.brandAssets.faviconMediaId : row.faviconMediaId,
      }));

      if (body.marketProfiles) {
        const existing = new Map((await tx.marketProfile.findMany({ where: { storeConfigId: row.id } })).map(market => [market.marketCode, market]));
        for (const input of body.marketProfiles) {
          const market = this.rule(() => normalizeMarketInput(input));
          const stored = existing.get(market.marketCode);
          if (market.enabled) {
            // 启用只能建立在“审核通过且未过期”之上；审核本身不自动启用市场。
            if (!stored) throw new AuthError(422, 'MARKET_NOT_REVIEWED');
            this.rule(() => assertMarketCanEnable({ ...stored }, now));
          }
          if (stored) await tx.marketProfile.update({ where: { id: stored.id }, data: { enabled: market.enabled, eligibleProductIds: market.eligibleProductIds } });
          else await tx.marketProfile.create({ data: { marketCode: market.marketCode, enabled: false, eligibleProductIds: market.eligibleProductIds, storeConfigId: row.id } });
        }
      }

      await tx.storeConfig.update({ where: { id: row.id }, data: {
        displayName: settings.displayName, locales: [...settings.locales], defaultLocale: settings.defaultLocale,
        baseCurrency: settings.baseCurrency, timezone: settings.timezone, featureFlags: settings.featureFlags,
        logoMediaId: settings.logoMediaId, faviconMediaId: settings.faviconMediaId, version: { increment: 1 },
      } });
      await this.audit(tx, ctx, actor.id, 'store.config.updated', 'store-config', 'success', Object.keys(body).join(','));
      return this.storeView(tx, now);
    }, true);
  }

  /**
   * 记录市场审核结论。审核人、时间由服务端赋值；结论是追加历史，不可改写。
   * 只有店主且会话已完成 MFA 才能记录——这是对外的合规声明，不授权给普通管理员。
   */
  async recordMarketReview(supplied: string, csrfValue: string, marketCodeInput: string, version: number, body: {
    decision: ReviewDecision; evidenceReference: string; reason: string; validUntil: string | null; confirmedMarketCode: string;
  }, ctx: RequestContext) {
    return this.authenticated(supplied, csrfValue, async (tx, actor, session, now) => {
      this.requirePermission(actor, 'store.settings.manage');
      await this.lock(tx, 'store-config');
      const marketCode = this.rule(() => normalizeMarketCode(marketCodeInput));
      if (this.rule(() => normalizeMarketCode(body.confirmedMarketCode)) !== marketCode) throw new AuthError(422, 'VALIDATION_ERROR');
      if (!actor.roles.some(link => link.role.kind === 'owner') || !actor.factor || !session.mfaVerified) throw new AuthError(403, 'FORBIDDEN');
      const row = await this.ensureStoreConfig(tx);
      if (row.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      const market = await tx.marketProfile.findUnique({ where: { marketCode } });
      if (!market) throw new AuthError(404, 'NOT_FOUND');
      const validUntil = body.validUntil === null ? null : new Date(body.validUntil);
      if (validUntil && Number.isNaN(validUntil.getTime())) throw new AuthError(422, 'VALIDATION_ERROR');
      const next = this.rule(() => marketAfterReview(body.decision, validUntil, now));

      const updated = await tx.storeConfig.update({ where: { id: row.id }, data: { version: { increment: 1 } } });
      await tx.marketProfile.update({ where: { id: market.id }, data: next });
      const record = await tx.marketReviewRecord.create({ data: { storeConfigId: row.id, marketCode, decision: body.decision,
        evidenceReference: body.evidenceReference.trim(), reason: body.reason.trim(), reviewedBy: actor.id, reviewedAt: now,
        validUntil: next.reviewValidUntil, storeConfigVersion: updated.version } });
      await this.audit(tx, ctx, actor.id, 'store.market.reviewed', record.id, 'success', `${marketCode}:${body.decision}`);
      return {
        data: { id: record.id, marketCode, decision: record.decision, evidenceReference: record.evidenceReference,
          reason: record.reason, reviewedBy: record.reviewedBy, reviewedAt: record.reviewedAt.toISOString(),
          validUntil: record.validUntil?.toISOString() ?? null, storeConfigVersion: record.storeConfigVersion },
        version: updated.version,
      };
    }, true);
  }

}

