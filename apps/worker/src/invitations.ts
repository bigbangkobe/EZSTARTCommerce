import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../../packages/database/src/client.js';
import type { IdentityConfig } from '../../api/src/identity/config.js';
import { decrypt } from '../../api/src/identity/crypto.js';
import { digest } from '../../../packages/domain/src/identity.js';
import type { MailSender } from './mail.js';

export class InvitationWorker {
  constructor(private readonly db: PrismaClient, private readonly config: IdentityConfig, private readonly sender: MailSender) {}
  async tick(): Promise<boolean> {
    // Database time is authoritative. Clear expired plaintext-equivalent secrets,
    // including terminal records, before leasing any further work.
    await this.db.$executeRaw`UPDATE "IdentityNotificationJob" SET "encryptedPayload" = NULL,
      status = CASE WHEN status IN ('pending','processing') THEN 'cancelled' ELSE status END,
      "leaseToken" = NULL, "leaseExpiresAt" = NULL
      WHERE "expiresAt" <= clock_timestamp() AND ("encryptedPayload" IS NOT NULL OR status IN ('pending','processing'))`;
    await this.db.$executeRaw`UPDATE "AdminChallenge" SET "pendingSecret" = NULL WHERE "expiresAt" <= clock_timestamp() AND "pendingSecret" IS NOT NULL`;
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
    const job = await this.db.identityNotificationJob.findUniqueOrThrow({ where: { id }, include: { invitation: {
      include: { user: { include: { roles: { include: { role: true } } } }, inviter: { include: { roles: { include: { role: true } } } } },
    } } });
    const invitation = job.invitation; const actor = invitation.inviter; const target = invitation.user;
    const owned = new Set(actor.roles.flatMap(link => link.role.permissionCodes));
    const clock = await this.db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const valid = job.status === 'processing' && job.leaseToken === lease && job.encryptedPayload && job.expiresAt > clock[0]!.now &&
      job.leaseExpiresAt !== null && job.leaseExpiresAt > clock[0]!.now &&
      invitation.status === 'pending' && invitation.version === job.invitationVersion && invitation.notificationJobId === id &&
      invitation.expiresAt > clock[0]!.now && target.status === 'invited' && actor.status === 'active' && owned.has('staff.manage') &&
      target.roles.length > 0 && target.roles.every(link => link.role.kind !== 'owner' && link.role.permissionCodes.every(code => owned.has(code)));
    const where = { id, status: 'processing', leaseToken: lease };
    if (!valid) {
      await this.db.identityNotificationJob.updateMany({ where, data: { status: 'cancelled', encryptedPayload: null, leaseToken: null, leaseExpiresAt: null } });
      return true;
    }
    try {
      const secret = decrypt(job.encryptedPayload!, target.id, this.config, `invitation:${id}:${job.invitationVersion}`);
      if (digest(secret) !== invitation.tokenDigest) throw new Error('INVALID_PAYLOAD');
      // Fragment never reaches HTTP access logs. The page removes it before posting.
      const link = `${this.config.allowedOrigin}/admin/accept-invitation#${encodeURIComponent(secret)}`;
      await this.sender.send({ id, to: target.email, locale: target.locale, link, expiresAt: invitation.expiresAt });
      await this.db.identityNotificationJob.updateMany({ where, data: { status: 'sent', encryptedPayload: null, sentAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastErrorCode: null } });
    } catch {
      // Never log provider errors: they may contain credentials or the full message.
      await this.db.identityNotificationJob.updateMany({ where, data: { status: job.attempts >= 5 ? 'failed' : 'pending',
        ...(job.attempts >= 5 ? { encryptedPayload: null } : {}), leaseToken: null, leaseExpiresAt: null,
        availableAt: new Date(clock[0]!.now.getTime() + Math.min(3600, 30 * 2 ** (job.attempts - 1)) * 1000), lastErrorCode: 'DELIVERY_FAILED' } });
    }
    return true;
  }
}
