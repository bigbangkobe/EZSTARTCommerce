import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';
import { issueInvitation } from '../packages/domain/src/identity.js';
import { encrypt } from '../apps/api/src/identity/crypto.js';
import { InvitationWorker } from '../apps/worker/src/invitations.js';
import { mailConfig, type InvitationMail } from '../apps/worker/src/mail.js';

test('SMTP configuration rejects incomplete credentials and header injection', () => {
  assert.throws(() => mailConfig({}));
  const env = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'user', SMTP_PASSWORD: 'secret', SMTP_FROM: 'store@example.test' };
  assert.equal(mailConfig(env).secure, false);
  assert.equal(mailConfig({ ...env, SMTP_PORT: '465' }).secure, true);
  assert.throws(() => mailConfig({ ...env, SMTP_FROM: 'store@example.test\r\nBcc:bad@example.test' }));
  assert.throws(() => mailConfig({ ...env, SMTP_PORT: 'NaN' }));
});

test('invitation worker leases, retries, expires, cancels and clears secrets in PostgreSQL', { timeout: 120_000 }, async t => {
  const cluster = await testPostgres(); const db = connectDatabase(cluster.url);
  const config = { instanceId: randomUUID(), allowedOrigin: 'https://shop.example.test', encryptionKey: randomBytes(32) };
  const delivered: InvitationMail[] = [];
  const sender = { async send(mail: InvitationMail) { delivered.push(mail); } };
  const worker = new InvitationWorker(db, config, sender);
  const second = new InvitationWorker(db, config, sender);
  const role = await db.adminRole.create({ data: { name: 'Manager', kind: 'custom', permissionCodes: ['staff.manage', 'catalog.read'] } });
  const targetRole = await db.adminRole.create({ data: { name: 'Operator', kind: 'custom', permissionCodes: ['catalog.read'] } });
  const actor = await db.adminUser.create({ data: { email: 'manager@example.test', displayName: 'Manager', locale: 'en', passwordHash: 'unused', roles: { create: { roleId: role.id } } } });
  async function queued() {
    const user = await db.adminUser.create({ data: { email: `${randomUUID()}@example.test`, displayName: 'Staff', locale: 'en', status: 'invited', passwordHash: 'unused', roles: { create: { roleId: targetRole.id } } } });
    const issued = issueInvitation(randomUUID(), user.id, new Date()); const jobId = randomUUID();
    await db.adminInvitation.create({ data: { ...issued.invitation, inviterId: actor.id, notificationJobId: jobId } });
    await db.identityNotificationJob.create({ data: { id: jobId, invitationId: issued.invitation.id, invitationVersion: 1, expiresAt: issued.invitation.expiresAt,
      encryptedPayload: encrypt(issued.token, user.id, config, `invitation:${jobId}:1`) } });
    return { user, issued, jobId };
  }
  try {
    await t.test('two workers send a claimed job once and erase the secret', async () => {
      const fixture = await queued();
      await Promise.all([worker.tick(), second.tick()]);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]!.link, `${config.allowedOrigin}/admin/accept-invitation#${fixture.issued.token}`);
      assert.equal(new URL(delivered[0]!.link).search, '');
      const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
      assert.equal(job.status, 'sent'); assert.equal(job.attempts, 1); assert.equal(job.encryptedPayload, null); assert.equal(job.leaseToken, null);
      assert.equal(await worker.tick(), false);
    });
    await t.test('failure retries the same credential and terminates after five attempts', async () => {
      const fixture = await queued(); const links: string[] = [];
      const failing = new InvitationWorker(db, config, { async send(mail) { links.push(mail.link); throw new Error(`provider leaked ${mail.link}`); } });
      for (let i = 1; i <= 5; i++) {
        await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { availableAt: new Date(0) } });
        await failing.tick();
        const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
        assert.equal(job.attempts, i); assert.equal(job.lastErrorCode, 'DELIVERY_FAILED');
        assert.equal(job.status, i === 5 ? 'failed' : 'pending');
        if (i < 5) { assert.ok(job.encryptedPayload); assert.equal(await failing.tick(), false); }
        else assert.equal(job.encryptedPayload, null);
      }
      assert.equal(new Set(links).size, 1); assert.equal(await failing.tick(), false);
    });
    await t.test('crashed leases recover and exhausted crashed jobs become terminal', async () => {
      const fixture = await queued();
      await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { status: 'processing', attempts: 1, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 120_000) } });
      assert.equal(await worker.tick(), false);
      await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { leaseExpiresAt: new Date(0) } });
      assert.equal(await worker.tick(), true);
      assert.equal((await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).attempts, 2);
      const exhausted = await queued();
      await db.identityNotificationJob.update({ where: { id: exhausted.jobId }, data: { status: 'processing', attempts: 5, leaseToken: randomUUID(), leaseExpiresAt: new Date(0) } });
      await worker.tick();
      const failed = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: exhausted.jobId } });
      assert.equal(failed.status, 'failed'); assert.equal(failed.encryptedPayload, null);
    });
    await t.test('expired, revoked, stale-version and unauthorized jobs never send', async () => {
      const before = delivered.length;
      for (const kind of ['expired', 'revoked', 'version', 'suspended', 'permission']) {
        const fixture = await queued();
        if (kind === 'expired') await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { expiresAt: new Date(0) } });
        if (kind === 'revoked') await db.adminInvitation.update({ where: { id: fixture.issued.invitation.id }, data: { status: 'revoked' } });
        if (kind === 'version') await db.adminInvitation.update({ where: { id: fixture.issued.invitation.id }, data: { version: 2 } });
        if (kind === 'suspended') await db.adminUser.update({ where: { id: actor.id }, data: { status: 'suspended' } });
        if (kind === 'permission') await db.adminRole.update({ where: { id: role.id }, data: { permissionCodes: [] } });
        await worker.tick();
        const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
        assert.equal(job.status, 'cancelled'); assert.equal(job.encryptedPayload, null);
        await db.adminUser.update({ where: { id: actor.id }, data: { status: 'active' } });
        await db.adminRole.update({ where: { id: role.id }, data: { permissionCodes: ['staff.manage', 'catalog.read'] } });
      }
      assert.equal(delivered.length, before);
    });
    await t.test('revocation during an in-flight send cannot resurrect a cancelled job', async () => {
      const fixture = await queued();
      const revoking = new InvitationWorker(db, config, { async send() {
        await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { status: 'cancelled', encryptedPayload: null } });
      } });
      await revoking.tick();
      const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
      assert.equal(job.status, 'cancelled'); assert.equal(job.encryptedPayload, null);
    });
  } finally { await db.$disconnect(); await cluster.stop(); }
});
