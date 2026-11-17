import { randomUUID } from 'node:crypto';
import { maskEmail } from '../../../../packages/domain/src/orders.js';
import { encrypt } from '../identity/crypto.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';

/**
 * 邮件自检（M10 批次七C）。
 *
 * 店主填好 SMTP 凭据、起 worker 之后，需要一条不依赖任何业务事件就能验证链路的路：
 * - API 不持有 SMTP 配置（那是 worker 的事），所以自检邮件与会员验证码走同一条队列，
 *   测的就是真实投递路径本身——排队、租约、解密、SMTP、销毁密文。
 * - 收件人明文只存在于密文里；列表只显示掩码。密文在发送成功后即销毁，
 *   与会员验证码同一套规则：账面上不留任何可复用的联系方式。
 * - 任务 10 分钟有效：它只回答「此刻链路通不通」，不值得在队列里过夜。
 */
const TEST_TTL_MS = 10 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCALES = new Set(['en', 'zh-CN', 'zh-HK']);

type JobRow = { id: string; maskedTarget: string | null; status: string; attempts: number;
  lastErrorCode: string | null; createdAt: Date; sentAt: Date | null; expiresAt: Date };

export class NotificationService {
  constructor(private readonly identity: IdentityService) {}

  private view(row: JobRow) {
    return { id: row.id, recipientMasked: row.maskedTarget, status: row.status, attempts: row.attempts,
      lastErrorCode: row.lastErrorCode, createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null, expiresAt: row.expiresAt.toISOString() };
  }

  async sendTest(supplied: string, csrfToken: string | null, body: Record<string, unknown>, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfToken, 'notifications.manage', async (tx, actor, _session, now) => {
      const recipient = typeof body.recipient === 'string' ? body.recipient.trim().toLowerCase() : '';
      if (!EMAIL.test(recipient) || recipient.length > 320) throw new AuthError(422, 'VALIDATION_ERROR');
      const locale = typeof body.locale === 'string' && LOCALES.has(body.locale) ? body.locale : 'en';
      const id = randomUUID();
      // targetVersion 对自检任务没有意义，但表上遗留 CHECK 要求 >= 1，写 1 兼容。
      const job = await tx.identityNotificationJob.create({ data: { id, kind: 'admin_mail_test', targetVersion: 1,
        encryptedPayload: encrypt(JSON.stringify({ email: recipient, locale }), id, this.identity.config, 'admin-mail-test'),
        maskedTarget: maskEmail(recipient), expiresAt: new Date(now.getTime() + TEST_TTL_MS), createdAt: now } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'notifications.mail_test.requested', job.id);
      return this.view(job);
    }, false);
  }

  async listTests(supplied: string, limit: number) {
    return this.identity.withPermission(supplied, null, 'notifications.read', async tx => {
      const rows = await tx.identityNotificationJob.findMany({ where: { kind: 'admin_mail_test' },
        orderBy: { createdAt: 'desc' }, take: limit });
      return { items: rows.map(row => this.view(row)), hasMore: false, nextCursor: null };
    }, false);
  }
}
