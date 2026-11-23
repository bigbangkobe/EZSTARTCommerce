import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { connectDatabase } from '../packages/database/src/client.js';
import { testPostgres } from './helpers/postgres.js';
import { issueInvitation, issuePasswordReset } from '../packages/domain/src/identity.js';
import { encrypt } from '../apps/api/src/identity/crypto.js';
import { NotificationWorker } from '../apps/worker/src/notifications.js';
import { mailConfig } from '../apps/worker/src/mail.js';
test('SMTP configuration rejects incomplete credentials and header injection', () => {
    assert.throws(() => mailConfig({}));
    const env = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'user', SMTP_PASSWORD: 'secret', SMTP_FROM: 'store@example.test' };
    assert.equal(mailConfig(env).secure, false);
    assert.equal(mailConfig({ ...env, SMTP_PORT: '465' }).secure, true);
    assert.throws(() => mailConfig({ ...env, SMTP_FROM: 'store@example.test\r\nBcc:bad@example.test' }));
    assert.throws(() => mailConfig({ ...env, SMTP_PORT: 'NaN' }));
});
test('notification worker leases, retries, expires, cancels and clears secrets in PostgreSQL', { timeout: 120_000 }, async (t) => {
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const config = { instanceId: randomUUID(), allowedOrigin: 'https://shop.example.test', encryptionKey: randomBytes(32) };
    const delivered = [];
    const sender = { async send(mail) { delivered.push(mail); } };
    const worker = new NotificationWorker(db, config, sender);
    const second = new NotificationWorker(db, config, sender);
    const role = await db.adminRole.create({ data: { name: 'Manager', kind: 'custom', permissionCodes: ['staff.manage', 'catalog.read'] } });
    const targetRole = await db.adminRole.create({ data: { name: 'Operator', kind: 'custom', permissionCodes: ['catalog.read'] } });
    const actor = await db.adminUser.create({ data: { email: 'manager@example.test', displayName: 'Manager', locale: 'en', passwordHash: 'unused', roles: { create: { roleId: role.id } } } });
    async function queued() {
        const user = await db.adminUser.create({ data: { email: `${randomUUID()}@example.test`, displayName: 'Staff', locale: 'en', status: 'invited', passwordHash: 'unused', roles: { create: { roleId: targetRole.id } } } });
        const issued = issueInvitation(randomUUID(), user.id, new Date());
        const jobId = randomUUID();
        await db.adminInvitation.create({ data: { ...issued.invitation, inviterId: actor.id, notificationJobId: jobId } });
        await db.identityNotificationJob.create({ data: { id: jobId, kind: 'invitation', invitationId: issued.invitation.id, targetVersion: 1, expiresAt: issued.invitation.expiresAt,
                encryptedPayload: encrypt(issued.token, user.id, config, `invitation:${jobId}:1`) } });
        return { user, issued, jobId };
    }
    async function queuedReset(locale = 'en') {
        const user = await db.adminUser.create({ data: { email: `${randomUUID()}@example.test`, displayName: 'Staff', locale, passwordHash: 'unused' } });
        const resetId = randomUUID();
        const issued = issuePasswordReset(resetId, user.id, new Date());
        const jobId = randomUUID();
        await db.adminPasswordReset.create({ data: { id: resetId, userId: user.id, version: 1, tokenDigest: issued.reset.tokenDigest,
                expiresAt: issued.reset.expiresAt, requestedAt: issued.reset.requestedAt, notificationJobId: jobId } });
        await db.identityNotificationJob.create({ data: { id: jobId, kind: 'password_reset', passwordResetId: resetId, targetVersion: 1,
                expiresAt: issued.reset.expiresAt, encryptedPayload: encrypt(issued.token, user.id, config, `password-reset:${jobId}:1`) } });
        return { user, issued, jobId, resetId };
    }
    try {
        await t.test('the queue rejects a job that references the wrong kind of target', async () => {
            const invitation = await queued();
            const reset = await queuedReset();
            // Both foreign keys are valid here, so only the kind/target CHECK can reject the row.
            await assert.rejects(db.identityNotificationJob.create({ data: { id: randomUUID(), kind: 'password_reset',
                    invitationId: invitation.issued.invitation.id, passwordResetId: reset.resetId,
                    targetVersion: 1, expiresAt: new Date(Date.now() + 60_000), encryptedPayload: 'x' } }));
            await assert.rejects(db.identityNotificationJob.create({ data: { id: randomUUID(), kind: 'invitation',
                    targetVersion: 1, expiresAt: new Date(Date.now() + 60_000), encryptedPayload: 'x' } }));
            assert.equal((await db.identityNotificationJob.findUniqueOrThrow({ where: { id: reset.jobId } })).kind, 'password_reset');
            await db.identityNotificationJob.updateMany({ where: { id: { in: [invitation.jobId, reset.jobId] } },
                data: { status: 'cancelled', encryptedPayload: null } });
        });
        await t.test('two workers send a claimed job once and erase the secret', async () => {
            const fixture = await queued();
            await Promise.all([worker.tick(), second.tick()]);
            assert.equal(delivered.length, 1);
            assert.equal(delivered[0].kind, 'invitation');
            assert.equal(delivered[0].link, `${config.allowedOrigin}/admin/accept-invitation#${fixture.issued.token}`);
            assert.equal(new URL(delivered[0].link).search, '');
            const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
            assert.equal(job.status, 'sent');
            assert.equal(job.attempts, 1);
            assert.equal(job.encryptedPayload, null);
            assert.equal(job.leaseToken, null);
            assert.equal(await worker.tick(), false);
        });
        await t.test('a password reset is delivered once with its own link and locale copy', async () => {
            const fixture = await queuedReset('zh-CN');
            await Promise.all([worker.tick(), second.tick()]);
            const message = delivered.at(-1);
            assert.equal(message.kind, 'password_reset');
            assert.equal(message.to, fixture.user.email);
            assert.equal(message.locale, 'zh-CN');
            assert.equal(message.link, `${config.allowedOrigin}/admin/reset-password#${fixture.issued.token}`);
            assert.equal(new URL(message.link).search, '');
            const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
            assert.equal(job.status, 'sent');
            assert.equal(job.encryptedPayload, null);
            assert.equal(await worker.tick(), false);
        });
        await t.test('failure retries the same credential and terminates after five attempts', async () => {
            const fixture = await queued();
            const links = [];
            const failing = new NotificationWorker(db, config, { async send(mail) { const link = mail.link ?? ''; links.push(link); throw new Error(`provider leaked ${link}`); } });
            for (let i = 1; i <= 5; i++) {
                await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { availableAt: new Date(0) } });
                await failing.tick();
                const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
                assert.equal(job.attempts, i);
                assert.equal(job.lastErrorCode, 'DELIVERY_FAILED');
                assert.equal(job.status, i === 5 ? 'failed' : 'pending');
                if (i < 5) {
                    assert.ok(job.encryptedPayload);
                    assert.equal(await failing.tick(), false);
                }
                else
                    assert.equal(job.encryptedPayload, null);
            }
            assert.equal(new Set(links).size, 1);
            assert.equal(await failing.tick(), false);
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
            assert.equal(failed.status, 'failed');
            assert.equal(failed.encryptedPayload, null);
        });
        await t.test('expired, revoked, stale-version and unauthorized jobs never send', async () => {
            const before = delivered.length;
            for (const kind of ['expired', 'revoked', 'version', 'suspended', 'permission']) {
                const fixture = await queued();
                if (kind === 'expired')
                    await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { expiresAt: new Date(0) } });
                if (kind === 'revoked')
                    await db.adminInvitation.update({ where: { id: fixture.issued.invitation.id }, data: { status: 'revoked' } });
                if (kind === 'version')
                    await db.adminInvitation.update({ where: { id: fixture.issued.invitation.id }, data: { version: 2 } });
                if (kind === 'suspended')
                    await db.adminUser.update({ where: { id: actor.id }, data: { status: 'suspended' } });
                if (kind === 'permission')
                    await db.adminRole.update({ where: { id: role.id }, data: { permissionCodes: [] } });
                await worker.tick();
                const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
                assert.equal(job.status, 'cancelled');
                assert.equal(job.encryptedPayload, null);
                await db.adminUser.update({ where: { id: actor.id }, data: { status: 'active' } });
                await db.adminRole.update({ where: { id: role.id }, data: { permissionCodes: ['staff.manage', 'catalog.read'] } });
            }
            assert.equal(delivered.length, before);
        });
        await t.test('superseded, expired and suspended password resets never send', async () => {
            const before = delivered.length;
            for (const kind of ['expired-job', 'expired-credential', 'rotated', 'completed', 'suspended']) {
                const fixture = await queuedReset();
                if (kind === 'expired-job')
                    await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { expiresAt: new Date(0) } });
                if (kind === 'expired-credential')
                    await db.adminPasswordReset.update({ where: { id: fixture.resetId }, data: { expiresAt: new Date(0) } });
                if (kind === 'rotated')
                    await db.adminPasswordReset.update({ where: { id: fixture.resetId }, data: { version: 2 } });
                if (kind === 'completed')
                    await db.adminPasswordReset.update({ where: { id: fixture.resetId }, data: { status: 'completed' } });
                if (kind === 'suspended')
                    await db.adminUser.update({ where: { id: fixture.user.id }, data: { status: 'suspended' } });
                await worker.tick();
                const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
                assert.equal(job.encryptedPayload, null);
                assert.ok(['cancelled', 'failed'].includes(job.status), `${kind} left job ${job.status}`);
            }
            assert.equal(delivered.length, before);
            const stale = await queuedReset();
            await db.adminPasswordReset.update({ where: { id: stale.resetId }, data: { expiresAt: new Date(0) } });
            await worker.tick();
            assert.equal((await db.adminPasswordReset.findUniqueOrThrow({ where: { id: stale.resetId } })).status, 'revoked');
        });
        await t.test('revocation during an in-flight send cannot resurrect a cancelled job', async () => {
            const fixture = await queued();
            const revoking = new NotificationWorker(db, config, { async send() {
                    await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: { status: 'cancelled', encryptedPayload: null } });
                } });
            await revoking.tick();
            const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
            assert.equal(job.status, 'cancelled');
            assert.equal(job.encryptedPayload, null);
        });
        await t.test('a decrypted payload that does not match its digest is never sent', async () => {
            const fixture = await queuedReset();
            await db.identityNotificationJob.update({ where: { id: fixture.jobId }, data: {
                    encryptedPayload: encrypt('wrong-secret', fixture.user.id, config, `password-reset:${fixture.jobId}:1`)
                } });
            const before = delivered.length;
            await worker.tick();
            assert.equal(delivered.length, before);
            const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
            assert.equal(job.lastErrorCode, 'DELIVERY_FAILED');
            assert.ok(job.encryptedPayload);
        });
    }
    finally {
        await db.$disconnect();
        await cluster.stop();
    }
});
test('mail self-test jobs are delivered once, keep only the masked recipient, and resist payload swapping', { timeout: 120_000 }, async () => {
    const cluster = await testPostgres();
    const db = connectDatabase(cluster.url);
    const config = { instanceId: randomUUID(), allowedOrigin: 'https://shop.example.test', encryptionKey: randomBytes(32) };
    const delivered = [];
    const worker = new NotificationWorker(db, config, { async send(mail) { delivered.push(mail); } });
    try {
        // 正常投递：收件人与语言只从密文来，发送后密文销毁、掩码留下。
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + 600_000);
        await db.identityNotificationJob.create({ data: { id, kind: 'admin_mail_test', targetVersion: 1, expiresAt,
                maskedTarget: 'o***@example.test',
                encryptedPayload: encrypt(JSON.stringify({ email: 'owner@example.test', locale: 'zh-HK' }), id, config, 'admin-mail-test') } });
        assert.equal(await worker.tick(), true);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].kind, 'admin_mail_test');
        assert.equal(delivered[0].to, 'owner@example.test');
        assert.equal(delivered[0].locale, 'zh-HK');
        const job = await db.identityNotificationJob.findUniqueOrThrow({ where: { id } });
        assert.equal(job.status, 'sent');
        assert.equal(job.encryptedPayload, null);
        assert.equal(job.maskedTarget, 'o***@example.test');
        assert.equal(await worker.tick(), false);
        // 密文必须 AAD 绑本行：把别的任务行加密过的收件人塞进来，解密必然失败，邮件绝不能发。
        const tampered = randomUUID();
        await db.identityNotificationJob.create({ data: { id: tampered, kind: 'admin_mail_test', targetVersion: 1, expiresAt,
                encryptedPayload: encrypt(JSON.stringify({ email: 'other@example.test' }), id, config, 'admin-mail-test') } });
        assert.equal(await worker.tick(), true);
        assert.equal(delivered.length, 1);
        const retried = await db.identityNotificationJob.findUniqueOrThrow({ where: { id: tampered } });
        assert.equal(retried.status, 'pending');
        assert.equal(retried.lastErrorCode, 'DELIVERY_FAILED');
        await db.identityNotificationJob.updateMany({ where: { id: tampered }, data: { status: 'cancelled', encryptedPayload: null } });
        // 配对约束：自检任务不能指目标表，验证码任务必须指挑战行。
        await assert.rejects(db.identityNotificationJob.create({ data: { id: randomUUID(), kind: 'admin_mail_test',
                otpChallengeId: tampered, targetVersion: 0, expiresAt, encryptedPayload: 'x' } }));
        await assert.rejects(db.identityNotificationJob.create({ data: { id: randomUUID(), kind: 'member_otp',
                targetVersion: 0, expiresAt, encryptedPayload: 'x' } }));
    }
    finally {
        await db.$disconnect();
        await cluster.stop();
    }
});
