import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../../packages/database/src/client.js';
import type { IdentityConfig } from '../../api/src/identity/config.js';
import { decrypt } from '../../api/src/identity/crypto.js';
import { digest } from '../../../packages/domain/src/identity.js';
import type { MailSender } from './mail.js';

/**
 * Delivers every single-use identity secret. One queue row carries either an invitation or a password reset;
 * the payload is re-validated against its live target immediately before handing it to SMTP.
 */
export class NotificationWorker {
  constructor(private readonly db: PrismaClient, private readonly config: IdentityConfig, private readonly sender: MailSender) {}
  async tick(): Promise<boolean> {
    // Database time is authoritative. Clear expired plaintext-equivalent secrets,
    // including terminal records, before leasing any further work.
    await this.db.$executeRaw`UPDATE "IdentityNotificationJob" SET "encryptedPayload" = NULL,
      status = CASE WHEN status IN ('pending','processing') THEN 'cancelled' ELSE status END,
      "leaseToken" = NULL, "leaseExpiresAt" = NULL
      WHERE "expiresAt" <= clock_timestamp() AND ("encryptedPayload" IS NOT NULL OR status IN ('pending','processing'))`;
    await this.db.$executeRaw`UPDATE "AdminChallenge" SET "pendingSecret" = NULL WHERE "expiresAt" <= clock_timestamp() AND "pendingSecret" IS NOT NULL`;
    // An expired reset can no longer be completed, so its pending credential is retired as well.
    await this.db.$executeRaw`UPDATE "AdminPasswordReset" SET status = 'revoked'
      WHERE status = 'pending' AND "expiresAt" <= clock_timestamp()`;
    // A process may crash after its final send attempt. Do not leave it stuck forever.
    await this.db.$executeRaw`UPDATE "IdentityNotificationJob" SET status = 'failed', "encryptedPayload" = NULL,
      "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = 'ATTEMPTS_EXHAUSTED'
      WHERE status = 'processing' AND "leaseExpiresAt" <= clock_timestamp() AND attempts >= 5`;
    const lease = randomUUID();
    const claimed = await this.db.$queryRaw<{ id: string }[]>`
      WITH candidate AS (SELECT id FROM "IdentityNotificationJob"
        WHERE "expiresAt" > clock_timestamp() AND "encryptedPayload" IS NOT NULL AND attempts < 5
        AND ((status = 'pending' AND "availableAt" <= clock_timestamp()) OR (status = 'processing' AND "leaseExpiresAt" <= clock_timestamp()))
        ORDER BY "availableAt", id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE "IdentityNotificationJob" AS job SET status = 'processing', attempts = attempts + 1,
        "leaseToken" = ${lease}::uuid, "leaseExpiresAt" = clock_timestamp() + interval '120 seconds'
      FROM candidate WHERE job.id = candidate.id RETURNING job.id`;
    const id = claimed[0]?.id;
    if (!id) return false;
    const job = await this.db.identityNotificationJob.findUniqueOrThrow({ where: { id }, include: {
      invitation: { include: { user: { include: { roles: { include: { role: true } } } }, inviter: { include: { roles: { include: { role: true } } } } } },
      passwordReset: { include: { user: true } },
    } });
    const clock = await this.db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const now = clock[0]!.now;
    const leased = job.status === 'processing' && job.leaseToken === lease && job.encryptedPayload !== null && job.expiresAt > now &&
      job.leaseExpiresAt !== null && job.leaseExpiresAt > now;
    const where = { id, status: 'processing', leaseToken: lease };
    const cancel = () => this.db.identityNotificationJob.updateMany({ where,
      data: { status: 'cancelled', encryptedPayload: null, leaseToken: null, leaseExpiresAt: null } });
    let delivery: { to: string; locale: string; expiresAt: Date; kind: 'invitation' | 'password_reset'; purpose: string; link: (secret: string) => string } | null = null;
    if (leased && job.kind === 'invitation' && job.invitation) {
      const invitation = job.invitation; const actor = invitation.inviter; const target = invitation.user;
      const owned = new Set(actor.roles.flatMap(link => link.role.permissionCodes));
      const valid = invitation.status === 'pending' && invitation.version === job.targetVersion && invitation.notificationJobId === id &&
        invitation.expiresAt > now && target.status === 'invited' && actor.status === 'active' && owned.has('staff.manage') &&
        target.roles.length > 0 && target.roles.every(link => link.role.kind !== 'owner' && link.role.permissionCodes.every(code => owned.has(code)));
      if (valid) delivery = { to: target.email, locale: target.locale, kind: 'invitation', expiresAt: invitation.expiresAt,
        purpose: `invitation:${id}:${job.targetVersion}`, link: (secret: string) => `${this.config.allowedOrigin}/admin/accept-invitation#${encodeURIComponent(secret)}` };
    } else if (leased && job.kind === 'password_reset' && job.passwordReset) {
      const reset = job.passwordReset; const target = reset.user;
      const valid = reset.status === 'pending' && reset.version === job.targetVersion && reset.notificationJobId === id &&
        reset.expiresAt > now && target.status === 'active';
      if (valid) delivery = { to: target.email, locale: target.locale, kind: 'password_reset', expiresAt: reset.expiresAt,
        purpose: `password-reset:${id}:${job.targetVersion}`, link: (secret: string) => `${this.config.allowedOrigin}/admin/reset-password#${encodeURIComponent(secret)}` };
    }
    if (!delivery) { await cancel(); return true; }
    try {
      const secret = decrypt(job.encryptedPayload!, job.kind === 'invitation' ? job.invitation!.userId : job.passwordReset!.userId, this.config, delivery.purpose);
      const expected = job.kind === 'invitation' ? job.invitation!.tokenDigest : job.passwordReset!.tokenDigest;
      if (digest(secret) !== expected) throw new Error('INVALID_PAYLOAD');
      // Fragment never reaches HTTP access logs. The page removes it before posting.
      await this.sender.send({ id, kind: delivery.kind, to: delivery.to, locale: delivery.locale,
        link: delivery.link(secret), expiresAt: delivery.expiresAt });
      await this.db.identityNotificationJob.updateMany({ where, data: { status: 'sent', encryptedPayload: null, sentAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastErrorCode: null } });
    } catch {
      // Never log provider errors: they may contain credentials or the full message.
      await this.db.identityNotificationJob.updateMany({ where, data: { status: job.attempts >= 5 ? 'failed' : 'pending',
        ...(job.attempts >= 5 ? { encryptedPayload: null } : {}), leaseToken: null, leaseExpiresAt: null,
        availableAt: new Date(now.getTime() + Math.min(3600, 30 * 2 ** (job.attempts - 1)) * 1000), lastErrorCode: 'DELIVERY_FAILED' } });
    }
    return true;
  }
}
