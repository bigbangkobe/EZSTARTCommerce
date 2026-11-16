import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../apps/api/src/app.js';
import { IdentityContracts } from '../apps/api/src/identity/contracts.js';
import { IdentityService } from '../apps/api/src/identity/service.js';
import { decrypt, passwordHash, totp, totpStep } from '../apps/api/src/identity/crypto.js';
import { connectDatabase } from '../packages/database/src/client.js';
import { digest } from '../packages/domain/src/identity.js';
import { testPostgres } from './helpers/postgres.js';

test('PostgreSQL 18 identity HTTP lifecycle and adversarial cases', { timeout: 120_000 }, async t => {
  const cluster = await testPostgres();
  const db = connectDatabase(cluster.url);
  const contracts = new IdentityContracts();
  const origin = 'https://shop.example.test';
  const bootstrapToken = randomBytes(32).toString('base64url');
  const config = { instanceId: randomUUID(), allowedOrigin: origin, encryptionKey: randomBytes(32), bootstrapToken };
  const identity = new IdentityService(db, config, contracts.ownerPermissions);
  let app: INestApplication | undefined;
  let secondApp: INestApplication | undefined;
  let secondDb: ReturnType<typeof connectDatabase> | undefined;
  const owner = { email: 'owner@example.test', displayName: 'Owner', password: 'A-long-test-password-1', locale: 'en' };
  type Jar = Map<string, string>;
  let jar: Jar = new Map();
  let base = '';
  let challengeId = '';
  let enrollmentId = '';
  let secret = '';
  let codes: string[] = [];
  let userId = '';
  let csrf = '';
  const call = async (path: string, body?: unknown, target: Jar = jar, headers: Record<string, string> = {}, schema?: string, server = base, method?: string) => {
    const response = await fetch(server + '/api/v1/' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: [...target].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      assert.ok(value.includes('HttpOnly') && value.includes('Secure'));
      const pair = value.split(';', 1)[0]!; const index = pair.indexOf('=');
      const key = pair.slice(0, index); const token = pair.slice(index + 1);
      if (token) target.set(key, token); else target.delete(key);
    }
    const data = response.status === 204 ? null : await response.json();
    if (response.status >= 400) contracts.assert('ErrorEnvelope', data);
    else if (schema) contracts.assert(schema, data);
    return { status: response.status, body: data, response };
  };
  const login = async (target: Jar = new Map(), server = base) => {
    const result = await call('admin/auth/login', { email: owner.email, password: owner.password }, target, {}, 'AdminAuthenticationChallengeEnvelope', server);
    assert.equal(result.status, 202);
    return { jar: target, id: result.body.data.challengeId as string };
  };
  try {
    await identity.initialize();
    app = await createApp(identity); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    await t.test('migration history and dependency readiness are real', async () => {
      const migrated = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
      assert.equal(Number(migrated[0]!.count), 4);
      const ready = await call('health/ready', undefined, new Map(), {}, 'ReadinessStatusEnvelope');
      assert.equal(ready.status, 200);
      const zone = await db.$queryRaw<{ zone: string }[]>`SELECT current_setting('TimeZone') AS zone`;
      assert.equal(zone[0]!.zone, 'UTC');
    });
    await t.test('readiness rejects altered checksums and incomplete migrations in the real database', async () => {
      const name = '202610190001_identity';
      const rows = await db.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM "_prisma_migrations" WHERE migration_name = ${name}`;
      const original = rows[0]!.checksum;
      try {
        await db.$executeRaw`UPDATE "_prisma_migrations" SET checksum = 'tampered' WHERE migration_name = ${name}`;
        assert.equal((await call('health/ready')).status, 503);
      } finally {
        await db.$executeRaw`UPDATE "_prisma_migrations" SET checksum = ${original} WHERE migration_name = ${name}`;
      }
      const id = randomUUID();
      try {
        await db.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count)
          VALUES (${id}, 'not-shipped', '209901010001_incomplete', NOW(), 0)`;
        assert.equal((await call('health/ready')).status, 503);
        await db.$executeRaw`UPDATE "_prisma_migrations" SET finished_at = NOW() WHERE id = ${id}`;
        assert.equal((await call('health/ready')).status, 503);
        await db.$executeRaw`UPDATE "_prisma_migrations" SET rolled_back_at = NOW() WHERE id = ${id}`;
        assert.equal((await call('health/ready')).status, 200);
      } finally {
        await db.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id = ${id}`;
      }
      assert.equal((await call('health/ready')).status, 200);
    });
    await t.test('origin and unknown request fields are rejected before bootstrap', async () => {
      assert.equal((await call('admin/auth/bootstrap', owner, new Map(), { Origin: 'https://untrusted.test', 'X-Bootstrap-Token': bootstrapToken })).status, 403);
      assert.equal((await call('admin/auth/bootstrap', { ...owner, roleIds: [] }, new Map(), { 'X-Bootstrap-Token': bootstrapToken })).status, 422);
      assert.equal(await db.adminUser.count(), 0);
    });
    await t.test('concurrent bootstrap creates exactly one owner and only a setup capability', async () => {
      const attempts = [new Map<string, string>(), new Map<string, string>()];
      const results = await Promise.all(attempts.map(target => call('admin/auth/bootstrap', owner, target, { 'X-Bootstrap-Token': bootstrapToken })));
      assert.deepEqual(results.map(value => value.status).sort(), [202, 409]);
      const winner = results.findIndex(result => result.status === 202);
      jar = attempts[winner]!; challengeId = results[winner]!.body.data.challengeId;
      contracts.assert('AdminMfaSetupChallengeEnvelope', results[winner]!.body);
      assert.equal(await db.adminUser.count(), 1);
      assert.ok(jar.has('ez_admin_setup')); assert.ok(!jar.has('ez_admin_session'));
      assert.equal((await call('admin/auth/session')).status, 401);
      assert.equal((await call('admin/auth/session', undefined, new Map([['ez_admin_session', jar.get('ez_admin_setup')!]]))).status, 401);
    });
    await t.test('pending TOTP is encrypted and stale enrollment cannot be confirmed', async () => {
      const first = await call('admin/auth/mfa/enrollments', { challengeId }, jar, {}, 'AdminMfaEnrollmentEnvelope');
      assert.equal(first.status, 201);
      const second = await call('admin/auth/mfa/enrollments', { challengeId }, jar, {}, 'AdminMfaEnrollmentEnvelope');
      enrollmentId = second.body.data.enrollmentId; secret = second.body.data.totpSecret;
      const stored = await db.adminChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      assert.ok(stored.pendingSecret && stored.pendingSecret !== secret);
      assert.equal(await db.mfaFactor.count(), 0);
      assert.equal((await call('admin/auth/mfa/enrollments/confirm', { challengeId, enrollmentId: first.body.data.enrollmentId, code: '000000' })).status, 401);
    });
    await t.test('concurrent enrollment confirmation consumes once and issues one recovery-code set', async () => {
      const oldJar = new Map(jar);
      const body = { challengeId, enrollmentId, code: totp(secret, owner.email).generate() };
      const pending = await db.adminChallenge.findUniqueOrThrow({ where: { id: challengeId }, include: { user: true } });
      const clock = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      assert.equal(pending.enrollmentId, enrollmentId);
      assert.equal(pending.userVersion, pending.user.version);
      assert.ok(pending.pendingSecret && decrypt(pending.pendingSecret, pending.userId, config) === secret);
      assert.ok(Math.abs(clock[0]!.now.getTime() - Date.now()) < 2_000, `Database/application UTC clock skew: ${clock[0]!.now.getTime() - Date.now()} ms`);
      assert.ok(totpStep(secret, body.code, clock[0]!.now) !== null, 'Generated TOTP must verify against database time');
      const attempts = [new Map(jar), new Map(jar)];
      const results = await Promise.all(attempts.map(target => call('admin/auth/mfa/enrollments/confirm', body, target)));
      assert.deepEqual(results.map(value => value.status).sort(), [200, 401]);
      const winner = results.findIndex(result => result.status === 200); jar = attempts[winner]!;
      contracts.assert('AdminMfaEnrollmentConfirmedEnvelope', results[winner]!.body);
      codes = results[winner]!.body.data.recoveryCodes; csrf = results[winner]!.body.data.session.csrfToken;
      userId = results[winner]!.body.data.session.user.id;
      assert.equal(codes.length, 10); assert.equal(await db.recoveryCode.count(), 10); assert.equal(await db.adminSession.count(), 1);
      assert.ok(!jar.has('ez_admin_setup')); assert.ok(jar.has('ez_admin_session'));
      assert.equal((await call('admin/auth/mfa/enrollments/confirm', body, oldJar)).status, 401);
      const user = await db.adminUser.findUniqueOrThrow({ where: { id: userId } });
      assert.ok(user.passwordHash.startsWith('$argon2id$')); assert.notEqual(user.passwordHash, owner.password);
      const session = await db.adminSession.findFirstOrThrow();
      assert.equal(session.tokenDigest, digest(jar.get('ez_admin_session')!));
    });
    await t.test('staff invitations enforce permissions, rotation, idempotency, revocation and single acceptance', async () => {
      await db.identityRateLimit.deleteMany();
      const role = await db.adminRole.create({ data: { name: 'Catalog operator', kind: 'custom', permissionCodes: ['catalog.read'] } });
      const headers = { 'X-CSRF-Token': csrf };
      const invite = (email: string) => call('admin/users', { email, displayName: 'Staff', locale: 'en', roleIds: [role.id] }, jar, headers);
      const created = await invite('staff@example.test');
      assert.equal(created.status, 201); contracts.assert('AdminUserEnvelope', created.body);
      const targetId = created.body.data.id;
      assert.equal(created.body.data.status, 'invited');
      assert.equal(created.response.headers.get('etag'), '"1"');
      assert.ok(!JSON.stringify(created.body).includes('invitationToken'));
      assert.equal((await invite('STAFF@example.test')).status, 409);
      assert.equal((await call('admin/users', { email: 'bad@example.test', displayName: 'Bad', locale: 'en', roleIds: [role.id] }, jar)).status, 403);
      const ownerRole = await db.adminRole.findFirstOrThrow({ where: { kind: 'owner' } });
      assert.equal((await call('admin/users', { email: 'owner2@example.test', displayName: 'Bad', locale: 'en', roleIds: [ownerRole.id] }, jar, headers)).status, 403);
      const initial = await call(`admin/users/${targetId}/invitation`, undefined, jar, {}, 'AdminInvitationSummaryEnvelope');
      assert.equal(initial.status, 200);
      const firstJob = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: initial.body.data.notificationJobId } });
      const firstToken = decrypt(firstJob.encryptedPayload!, targetId, config, `invitation:${firstJob.id}:1`);
      assert.throws(() => decrypt(firstJob.encryptedPayload!, targetId, config));
      const accept = (value: string, target: Jar = new Map()) => call('admin/auth/invitations/accept', { invitationToken: value, newPassword: 'Staff-password-123456' }, target);
      const resendHeaders = { ...headers, 'If-Match': '"1"', 'Idempotency-Key': 'invitation-resend-key-1' };
      const path = `admin/users/${targetId}/invitation/resend`;
      assert.equal((await call(path, { reason: 'resend' }, jar, resendHeaders)).status, 429);
      await db.adminInvitation.update({ where: { userId: targetId }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
      const resent = await call(path, { reason: 'resend' }, jar, resendHeaders, 'AdminInvitationSummaryEnvelope');
      assert.equal(resent.status, 200); assert.equal(resent.body.data.version, 2);
      const retry = await call(path, { reason: 'resend' }, jar, resendHeaders);
      assert.deepEqual(retry.body.data, resent.body.data);
      assert.equal(await db.identityNotificationJob.count({ where: { invitationId: initial.body.data.id } }), 2);
      assert.equal((await call(path, { reason: 'changed' }, jar, resendHeaders)).status, 409);
      assert.equal((await accept(firstToken)).status, 401);
      const cancelled = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: firstJob.id } });
      assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.encryptedPayload, null);
      const latest = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: resent.body.data.notificationJobId } });
      const latestToken = decrypt(latest.encryptedPayload!, targetId, config, `invitation:${latest.id}:2`);
      await db.adminUser.update({ where: { id: userId }, data: { status: 'suspended' } });
      assert.equal((await accept(latestToken)).status, 401);
      await db.adminUser.update({ where: { id: userId }, data: { status: 'active' } });
      await db.adminUserRole.deleteMany({ where: { userId } });
      assert.equal((await accept(latestToken)).status, 401);
      await db.adminUserRole.create({ data: { userId, roleId: ownerRole.id } });
      await db.adminUser.update({ where: { id: targetId }, data: { status: 'suspended' } });
      assert.equal((await accept(latestToken)).status, 401);
      await db.adminUser.update({ where: { id: targetId }, data: { status: 'invited' } });
      await db.adminInvitation.update({ where: { userId: targetId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
      assert.equal((await accept(latestToken)).status, 401);
      const expired = await call(`admin/users/${targetId}/invitation`);
      assert.equal(expired.body.data.status, 'expired');
      await db.adminInvitation.update({ where: { userId: targetId }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });
      const attempts = [new Map<string, string>(), new Map<string, string>()];
      const results = await Promise.all(attempts.map(target => accept(latestToken, target)));
      assert.deepEqual(results.map(result => result.status).sort(), [202, 401]);
      const winner = results.findIndex(result => result.status === 202);
      contracts.assert('AdminMfaSetupChallengeEnvelope', results[winner]!.body);
      assert.ok(attempts[winner]!.has('ez_admin_setup')); assert.ok(!attempts[winner]!.has('ez_admin_session'));
      assert.equal((await call('admin/auth/session', undefined, attempts[winner])).status, 401);
      assert.equal((await db.adminUser.findUniqueOrThrow({ where: { id: targetId } })).status, 'active');
      assert.equal((await db.adminInvitation.findUniqueOrThrow({ where: { userId: targetId } })).status, 'accepted');
      assert.equal((await db.identityNotificationJob.findUniqueOrThrow({ where: { id: latest.id } })).encryptedPayload, null);
      const other = await invite('revoked@example.test'); assert.equal(other.status, 201);
      const otherInvitation = await db.adminInvitation.findUniqueOrThrow({ where: { userId: other.body.data.id } });
      const otherJob = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: otherInvitation.notificationJobId! } });
      const otherToken = decrypt(otherJob.encryptedPayload!, other.body.data.id, config, `invitation:${otherJob.id}:1`);
      const revokePath = `admin/users/${other.body.data.id}/invitation/revoke`;
      assert.equal((await call(revokePath, { reason: 'cancel' }, jar, { ...headers, 'If-Match': '"2"' })).status, 409);
      assert.equal((await call(revokePath, { reason: 'cancel' }, jar, { ...headers, 'If-Match': '"1"' })).status, 200);
      assert.equal((await accept(otherToken)).status, 401);
      const deniedUser = await db.adminUser.create({ data: { email: 'limited@example.test', displayName: 'Limited', locale: 'en', passwordHash: 'not-a-usable-password', mfaRequired: false,
        roles: { create: { roleId: role.id } } } });
      const limitedToken = randomBytes(32).toString('base64url');
      await db.adminSession.create({ data: { userId: deniedUser.id, tokenDigest: digest(limitedToken), mfaVerified: false, lastSeenAt: new Date(),
        idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 120_000) } });
      const limitedJar = new Map([['ez_admin_session', limitedToken]]);
      const limitedSession = await call('admin/auth/session', undefined, limitedJar);
      const limitedHeaders = { 'X-CSRF-Token': limitedSession.body.data.csrfToken };
      assert.equal((await call(`admin/users/${targetId}/invitation`, undefined, limitedJar)).status, 403);
      assert.equal((await call('admin/users', { email: 'unauthorized@example.test', displayName: 'Bad', locale: 'en', roleIds: [role.id] }, limitedJar, limitedHeaders)).status, 403);
      const audit = JSON.stringify(await db.auditLog.findMany());
      assert.ok(!audit.includes(firstToken) && !audit.includes(latestToken) && !audit.includes('Staff-password-123456'));
      await db.identityRateLimit.deleteMany();
    });
    await t.test('staff and roles management enforce grant limits, versions, owner protection and immediate revocation', async () => {
      await db.identityRateLimit.deleteMany();
      const headers = { 'X-CSRF-Token': csrf };
      const patch = (path: string, body: unknown, version: number, target = jar, customHeaders = headers, schema?: string) =>
        call(path, body, target, { ...customHeaders, 'If-Match': `"${version}"` }, schema, base, 'PATCH');
      const created = await call('admin/roles', { name: 'API operator', description: 'Limited catalog role', permissionCodes: ['catalog.read'] }, jar, headers, 'AdminRoleEnvelope');
      assert.equal(created.status, 201); const roleId = created.body.data.id;
      assert.equal(created.response.headers.get('etag'), '"1"');
      assert.equal((await call('admin/roles', { name: 'API operator', permissionCodes: [] }, jar, headers)).status, 409);
      assert.equal((await call('admin/roles', { name: 'Unknown', permissionCodes: ['unknown.permission'] }, jar, headers)).status, 422);
      assert.equal((await call('admin/roles', { name: 'No csrf', permissionCodes: [] })).status, 403);
      const concurrent = await Promise.all([
        patch(`admin/roles/${roleId}`, { description: 'Update A' }, 1),
        patch(`admin/roles/${roleId}`, { description: 'Update B' }, 1),
      ]);
      assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
      const roleDetail = await call(`admin/roles/${roleId}`, undefined, jar, {}, 'AdminRoleEnvelope');
      assert.equal(roleDetail.body.data.version, 2);
      const roleList = await call('admin/roles?limit=1', undefined, jar, {}, 'AdminRoleListEnvelope');
      assert.equal(roleList.body.data.items.length, 1); assert.equal(roleList.body.data.hasMore, true);
      const roleNext = await call(`admin/roles?limit=1&cursor=${roleList.body.data.nextCursor}`);
      assert.notEqual(roleList.body.data.items[0].id, roleNext.body.data.items[0].id);
      assert.equal((await call('admin/users?limit=101')).status, 422);
      assert.equal((await call(`admin/users?cursor=${randomUUID()}`)).status, 422);
      const ownerRecord = await db.adminUser.findUniqueOrThrow({ where: { id: userId } });
      const ownerRole = await db.adminRole.findFirstOrThrow({ where: { kind: 'owner' } });
      assert.equal((await patch(`admin/users/${userId}`, { status: 'suspended' }, ownerRecord.version)).status, 409);
      assert.equal((await patch(`admin/users/${userId}`, { roleIds: [roleId] }, ownerRecord.version)).status, 409);
      assert.equal((await patch(`admin/roles/${ownerRole.id}`, { permissionCodes: [] }, ownerRole.version)).status, 409);
      const staff = await call('admin/users', { email: 'management@example.test', displayName: 'Management test', locale: 'en', roleIds: [roleId] }, jar, headers);
      assert.equal(staff.status, 201); const staffId = staff.body.data.id;
      assert.equal((await patch(`admin/users/${staffId}`, { status: 'active' }, 1)).status, 409);
      const detail = await call(`admin/users/${staffId}`, undefined, jar, {}, 'AdminUserEnvelope');
      assert.equal(detail.body.data.status, 'invited');
      const invite = await db.adminInvitation.findUniqueOrThrow({ where: { userId: staffId } });
      const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: invite.notificationJobId! } });
      const invitedToken = decrypt(job.encryptedPayload!, staffId, config, `invitation:${job.id}:1`);
      assert.equal((await patch(`admin/users/${staffId}`, { roleIds: [roleId] }, 1)).status, 200);
      assert.equal((await call('admin/auth/invitations/accept', { invitationToken: invitedToken, newPassword: 'Management-password-12345' }, new Map())).status, 401);
      assert.equal((await db.identityNotificationJob.findUniqueOrThrow({ where: { id: job.id } })).encryptedPayload, null);
      // Establish controlled limited sessions directly to test downstream authorization.
      await db.adminUser.update({ where: { id: staffId }, data: { status: 'active', mfaRequired: false } });
      const issueSession = async (id: string) => {
        const secret = randomBytes(32).toString('base64url');
        await db.adminSession.create({ data: { userId: id, tokenDigest: digest(secret), mfaVerified: false, lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 120_000) } });
        return new Map([['ez_admin_session', secret]]);
      };
      const limited = await issueSession(staffId);
      assert.equal((await call('admin/auth/session', undefined, limited)).status, 200);
      assert.equal((await call('admin/users', undefined, limited)).status, 403);
      assert.equal((await call('admin/roles', undefined, limited)).status, 403);
      const listedSessions = await call(`admin/users/${staffId}/sessions`, undefined, jar, {}, 'AdminSessionListEnvelope');
      assert.equal(listedSessions.body.data.items.length, 1);
      assert.ok(!JSON.stringify(listedSessions.body).includes(limited.get('ez_admin_session')!));
      const revoke = await call(`admin/users/${staffId}/sessions/revoke`, { reason: 'Security review' }, jar, headers, 'AdminSessionsRevokedEnvelope');
      assert.equal(revoke.status, 200); assert.equal(revoke.body.data.revokedCount, 1);
      assert.equal((await call('admin/auth/session', undefined, limited)).status, 401);
      const beforeRoleChange = await issueSession(staffId);
      assert.equal((await patch(`admin/roles/${roleId}`, { permissionCodes: [] }, 2)).status, 200);
      assert.equal((await call('admin/auth/session', undefined, beforeRoleChange)).status, 401);
      const beforeSuspension = await issueSession(staffId);
      const current = await db.adminUser.findUniqueOrThrow({ where: { id: staffId } });
      const suspended = await patch(`admin/users/${staffId}`, { status: 'suspended' }, current.version, jar, headers, 'AdminUserEnvelope');
      assert.equal(suspended.status, 200); assert.equal(suspended.body.data.status, 'suspended');
      assert.equal((await call('admin/auth/session', undefined, beforeSuspension)).status, 401);
      assert.equal((await patch(`admin/users/${staffId}`, { displayName: 'Stale write' }, current.version)).status, 409);
      const cleared = await patch(`admin/users/${staffId}`, { roleIds: [] }, suspended.body.data.version);
      assert.equal(cleared.status, 200); assert.deepEqual(cleared.body.data.roleIds, []);
      const delegatedRole = await db.adminRole.create({ data: { name: 'Limited role manager', kind: 'custom', permissionCodes: ['roles.manage', 'catalog.read'] } });
      const delegatedUser = await db.adminUser.create({ data: { email: 'role-manager@example.test', displayName: 'Role manager', locale: 'en', passwordHash: 'unused', mfaRequired: false, roles: { create: { roleId: delegatedRole.id } } } });
      const delegated = await issueSession(delegatedUser.id);
      const session = await call('admin/auth/session', undefined, delegated);
      const delegatedHeaders = { 'X-CSRF-Token': session.body.data.csrfToken };
      assert.equal((await call('admin/roles', { name: 'Escalation', permissionCodes: ['staff.manage'] }, delegated, delegatedHeaders)).status, 403);
      assert.equal((await call('admin/roles', { name: 'Allowed delegation', permissionCodes: ['catalog.read'] }, delegated, delegatedHeaders)).status, 201);
      const userList = await call('admin/users?limit=1', undefined, jar, {}, 'AdminUserListEnvelope');
      assert.equal(userList.body.data.items.length, 1); assert.equal(userList.body.data.hasMore, true);
      await db.identityRateLimit.deleteMany();
    });
    await t.test('sessions require current MFA and state; CSRF is enforced on logout', async () => {
      const read = await call('admin/auth/session', undefined, jar, {}, 'AdminSessionEnvelope');
      assert.equal(read.status, 200); assert.equal(read.body.data.mfaVerified, true);
      assert.equal((await call('admin/auth/logout', {})).status, 403);
      assert.equal((await call('admin/auth/session')).status, 200);
      const wrong = await call('admin/auth/login', { email: owner.email, password: 'wrong-password-123' }, new Map());
      assert.equal(wrong.status, 401);
      await db.adminUser.update({ where: { id: userId }, data: { status: 'suspended' } });
      assert.equal((await call('admin/auth/session')).status, 401);
      await db.adminUser.update({ where: { id: userId }, data: { status: 'active' } });
    });
    await t.test('TOTP already consumed during enrollment cannot be replayed for login', async () => {
      const attempt = await login();
      const factor = await db.mfaFactor.findUniqueOrThrow({ where: { userId } });
      const usedCode = totp(secret, owner.email).generate({ timestamp: Number(factor.lastUsedStep) * 30_000 });
      const result = await call('admin/auth/mfa/verify', { challengeId: attempt.id, code: usedCode }, attempt.jar);
      assert.equal(result.status, 401);
    });
    await t.test('recovery-code race across two API instances succeeds only once', async () => {
      secondDb = connectDatabase(cluster.url);
      const another = new IdentityService(secondDb, config, contracts.ownerPermissions); await another.initialize();
      secondApp = await createApp(another); await secondApp.listen(0, '127.0.0.1');
      const secondBase = await secondApp.getUrl();
      const a = await login(); const b = await login(new Map(), secondBase);
      const results = await Promise.all([
        call('admin/auth/mfa/verify', { challengeId: a.id, code: codes[0] }, a.jar),
        call('admin/auth/mfa/verify', { challengeId: b.id, code: codes[0] }, b.jar, {}, undefined, secondBase),
      ]);
      assert.deepEqual(results.map(value => value.status).sort(), [200, 401]);
      assert.equal(await db.recoveryCode.count({ where: { userId, consumedAt: { not: null } } }), 1);
      const winner = results.findIndex(result => result.status === 200);
      contracts.assert('AdminSessionEnvelope', results[winner]!.body);
    });
    await t.test('valid TOTP login succeeds, and persisted expiry rejects the session', async () => {
      const attempt = await login();
      const factor = await db.mfaFactor.findUniqueOrThrow({ where: { userId } });
      const clock = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const step = Math.max(Math.floor(clock[0]!.now.getTime() / 30_000), Number(factor.lastUsedStep) + 1);
      const code = totp(secret, owner.email).generate({ timestamp: step * 30_000 });
      const verified = await call('admin/auth/mfa/verify', { challengeId: attempt.id, code }, attempt.jar, {}, 'AdminSessionEnvelope');
      assert.equal(verified.status, 200);
      const expired = await db.adminSession.findUniqueOrThrow({ where: { tokenDigest: digest(attempt.jar.get('ez_admin_session')!) } });
      await db.adminSession.update({ where: { id: expired.id }, data: { idleExpiresAt: new Date(Date.now() - 1_000) } });
      assert.equal((await call('admin/auth/session', undefined, attempt.jar)).status, 401);
    });
    await t.test('factor replacement preserves old factor until confirmation then revokes old sessions', async () => {
      const previous = new Map(jar);
      const unauthorized = await call('admin/auth/mfa/enrollment-authorizations', { currentPassword: owner.password }, jar, { 'X-CSRF-Token': csrf });
      assert.equal(unauthorized.status, 401);
      const authorized = await call('admin/auth/mfa/enrollment-authorizations', { currentPassword: owner.password, currentMfaCode: codes[1] }, jar,
        { 'X-CSRF-Token': csrf }, 'AdminMfaSetupChallengeEnvelope');
      assert.equal(authorized.status, 202);
      const started = await call('admin/auth/mfa/enrollments', { challengeId: authorized.body.data.challengeId }, jar, {}, 'AdminMfaEnrollmentEnvelope');
      assert.equal(started.status, 201);
      assert.equal((await call('admin/auth/session', undefined, previous)).status, 200);
      const replacedSecret = started.body.data.totpSecret;
      const result = await call('admin/auth/mfa/enrollments/confirm', { challengeId: authorized.body.data.challengeId,
        enrollmentId: started.body.data.enrollmentId, code: totp(replacedSecret, owner.email).generate() }, jar, {}, 'AdminMfaEnrollmentConfirmedEnvelope');
      assert.equal(result.status, 200);
      assert.equal((await call('admin/auth/session', undefined, previous)).status, 401);
      secret = replacedSecret; codes = result.body.data.recoveryCodes; csrf = result.body.data.session.csrfToken;
      assert.equal(await db.recoveryCode.count({ where: { userId } }), 10);
    });
    await t.test('own-session revoke cannot target another user and takes effect immediately', async () => {
      const another = await db.adminUser.create({ data: { email: 'other@example.test', displayName: 'Other', locale: 'en', passwordHash: await passwordHash('another-long-password') } });
      const foreign = await db.adminSession.create({ data: { userId: another.id, tokenDigest: digest(randomBytes(32).toString('base64url')),
        mfaVerified: true, lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 120_000) } });
      assert.equal((await call(`admin/auth/sessions/${foreign.id}/revoke`, { reason: 'invalid target' }, jar, { 'X-CSRF-Token': csrf })).status, 404);
      assert.equal((await db.adminSession.findUniqueOrThrow({ where: { id: foreign.id } })).revokedAt, null);
      const list = await call('admin/auth/sessions', undefined, jar, {}, 'AdminSessionListEnvelope');
      assert.equal(list.status, 200);
      const current = list.body.data.items.find((item: { current: boolean }) => item.current);
      assert.equal((await call(`admin/auth/sessions/${current.id}/revoke`, { reason: 'end current session' }, jar, { 'X-CSRF-Token': csrf }, 'AdminSessionRevokedEnvelope')).status, 200);
      assert.equal((await call('admin/auth/session')).status, 401);
    });
    await t.test('failure counters persist and account cooldown survives service instances', async () => {
      await db.identityRateLimit.deleteMany();
      for (let i = 0; i < 5; i++) assert.equal((await call('admin/auth/login', { email: owner.email, password: 'wrong-password-123' }, new Map())).status, 401);
      const blocked = await call('admin/auth/login', { email: owner.email, password: owner.password }, new Map());
      assert.equal(blocked.status, 429); assert.equal(blocked.response.headers.get('retry-after'), '900');
      const throughOther = await call('admin/auth/login', { email: owner.email, password: owner.password }, new Map(), {}, undefined, await secondApp!.getUrl());
      assert.equal(throughOther.status, 429);
    });
    await t.test('audit is append-only and contains no credential material', async () => {
      const audit = await db.auditLog.findMany(); assert.ok(audit.length > 5);
      const content = JSON.stringify(audit);
      assert.ok(!content.includes(owner.password) && !content.includes(secret) && !content.includes(codes[0]!));
      assert.ok(!content.includes(bootstrapToken));
      await assert.rejects(db.auditLog.update({ where: { id: audit[0]!.id }, data: { result: 'changed' } }));
      await assert.rejects(db.auditLog.delete({ where: { id: audit[0]!.id } }));
    });
  } finally {
    if (secondApp) await secondApp.close();
    if (secondDb) await secondDb.$disconnect();
    if (app) await app.close();
    await db.$disconnect();
    await cluster.stop();
  }
});

