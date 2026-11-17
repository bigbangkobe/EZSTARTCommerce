import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  assertMemberStatusTransition, assertNonEmptyPatch, assertOtpRequestAllowed, assertOtpVerifiable, defaultDisplayName,
  MemberRuleError, memberNumber, memberPolicy, memberSessionExpiry, nextOtpFailure, normalizeCustomerInput, normalizeMemberEmail,
  normalizeMemberPatch, otpChallengeView, otpCode, otpCodeDigest, otpEmailDigest, sessionTokenDigest, type MemberStatus,
} from '../../../../packages/domain/src/members.js';
import { maskEmail, maskPhone } from '../../../../packages/domain/src/orders.js';
import { SUPPORTED_LOCALES } from '../../../../packages/domain/src/store.js';
import { csrf, decrypt, encrypt, equal } from '../identity/crypto.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';

type Tx = Prisma.TransactionClient;
type CustomerRow = Prisma.CustomerGetPayload<{ include: { member: true } }>;
type MemberRow = Prisma.MemberProfileGetPayload<{ include: { customer: true } }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBER_NO_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RATE_CODES = new Set(['OTP_RATE_LIMITED', 'OTP_RESEND_TOO_SOON', 'OTP_ATTEMPTS_EXHAUSTED']);

/**
 * 顾客与会员（M10 第一批）。
 *
 * 四条边界：
 * 1. 访客结账永远不需要会员；OTP 只是“已验证邮箱”的一条可选路径。
 * 2. 会员只来自已验证的邮箱：挑战通过后才创建顾客/会员，绝不按姓名合并。
 * 3. 挑战表不存明文验证码与明文邮箱；投递复用同一条通知队列，过期即清密。
 * 4. 会员会话 cookie 只带随机 token，库中只有摘要；读取本人资料以外的任何顾客数据都要后台权限。
 */
export class MembersService {
  constructor(private readonly identity: IdentityService) {}
  private get db() { return this.identity.db; }
  private get config() { return this.identity.config; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof MemberRuleError) {
        if (RATE_CODES.has(error.code)) throw new AuthError(429, 'RATE_LIMITED');
        throw new AuthError(422, error.code);
      }
      throw error;
    }
  }

  private async clock(tx: Tx): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return rows[0]!.now;
  }

  private async lock(tx: Tx, key: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }

  private emailDigest(email: string) { return otpEmailDigest(this.config.encryptionKey, this.config.instanceId, email); }
  private codeDigest(challengeId: string, code: string) {
    return otpCodeDigest(this.config.encryptionKey, this.config.instanceId, challengeId, code);
  }

  private memberSummary(member: { memberNo: string; status: string; joinedAt: Date }, customer: { displayName: string; emailNormalized: string | null }) {
    return { memberNo: member.memberNo, status: member.status, joinedAt: member.joinedAt.toISOString(),
      displayName: customer.displayName, email: customer.emailNormalized };
  }

  /**
   * 申请验证码。响应形状与状态对已登记、未登记邮箱完全一致：
   * 调用方无法据此判断某个邮箱是否是会员。
   */
  async requestOtp(body: { email: unknown; locale: unknown; purpose: unknown }, ctx: RequestContext) {
    await this.identity.limitIp(ctx);
    const email = this.rule(() => normalizeMemberEmail(body.email));
    if (typeof body.locale !== 'string' || !(SUPPORTED_LOCALES as readonly string[]).includes(body.locale)) throw new AuthError(422, 'VALIDATION_ERROR');
    if (body.purpose !== 'member_login') throw new AuthError(422, 'VALIDATION_ERROR');
    const locale = body.locale;
    const emailDigest = this.emailDigest(email);
    return this.db.$transaction(async tx => {
      const now = await this.clock(tx);
      // 同一邮箱的并发申请串行化：否则两次并发请求都能通过“60 秒冷却”检查。
      await this.lock(tx, `member-otp:${emailDigest}`);
      const recent = await tx.memberOtpChallenge.findMany({ where: { emailDigest, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
        select: { createdAt: true } });
      this.rule(() => assertOtpRequestAllowed(recent, now));
      const challengeId = randomUUID();
      const code = otpCode();
      const expiresAt = new Date(now.getTime() + memberPolicy.otpTtlSeconds * 1_000);
      await tx.memberOtpChallenge.create({ data: { id: challengeId, emailDigest,
        emailCipher: encrypt(email, challengeId, this.config, 'member-otp-email'),
        codeDigest: this.codeDigest(challengeId, code), locale, purpose: 'member_login',
        maxAttempts: memberPolicy.otpVerifyAttempts, expiresAt, createdAt: now, updatedAt: now } });
      const job = await tx.identityNotificationJob.create({ data: { id: randomUUID(), kind: 'member_otp', otpChallengeId: challengeId, targetVersion: 1,
        encryptedPayload: encrypt(JSON.stringify({ code, email }), challengeId, this.config, 'member-otp'),
        expiresAt, createdAt: now } });
      await tx.memberOtpChallenge.update({ where: { id: challengeId }, data: { notificationJobId: job.id } });
      return otpChallengeView(challengeId, expiresAt, now);
    });
  }

  /**
   * 邀请码不存在、已过期、已使用、错误次数用尽都不透露账户是否存在，只在 429 与 401 之间区分。
   *
   * 失败也必须在事务里“写完再返回”：抛异常会让尝试计数与作废状态一起回滚，
   * 于是错误次数永远停在 0，验证码可以无限尝试。
   */
  async verifyOtp(body: { challengeId: string; code: string }, ctx: RequestContext) {
    await this.identity.limitIp(ctx);
    if (!UUID.test(body.challengeId)) throw new AuthError(422, 'VALIDATION_ERROR');
    if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new AuthError(422, 'VALIDATION_ERROR');
    type Outcome = { ok: true; token: string; data: object } | { ok: false; status: 401 | 403 | 429; code: string };
    const outcome = await this.db.$transaction(async (tx): Promise<Outcome> => {
      const now = await this.clock(tx);
      const existing = await tx.memberOtpChallenge.findUnique({ where: { id: body.challengeId } });
      if (!existing) return { ok: false, status: 401, code: 'UNAUTHORIZED' };
      // 同一挑战的并发验证串行化：否则错误次数预算可被并发绕过。
      await this.lock(tx, `member-challenge:${existing.id}`);
      const challenge = await tx.memberOtpChallenge.findUniqueOrThrow({ where: { id: existing.id } });
      try { assertOtpVerifiable(challenge, now); } catch {
        if (challenge.status === 'pending' && challenge.expiresAt.getTime() <= now.getTime()) {
          await tx.memberOtpChallenge.update({ where: { id: challenge.id }, data: { status: 'expired', updatedAt: now } });
        }
        return { ok: false, status: 401, code: 'UNAUTHORIZED' };
      }
      if (!equal(this.codeDigest(challenge.id, body.code), challenge.codeDigest)) {
        const failure = nextOtpFailure(challenge.attempts, challenge.maxAttempts);
        await tx.memberOtpChallenge.update({ where: { id: challenge.id }, data: { ...failure, updatedAt: now } });
        // 次数用尽后下一次请求得到 429，而不是无限次 401。
        return failure.status === 'failed'
          ? { ok: false, status: 429, code: 'RATE_LIMITED' }
          : { ok: false, status: 401, code: 'UNAUTHORIZED' };
      }
      // 一次性消费：先落状态再发会话，重复提交同一挑战拿不到第二个会话。
      await tx.memberOtpChallenge.update({ where: { id: challenge.id }, data: { status: 'consumed', verifiedAt: now, updatedAt: now } });
      const email = this.rule(() => normalizeMemberEmail(decrypt(challenge.emailCipher, challenge.id, this.config, 'member-otp-email')));
      await this.lock(tx, `member:${challenge.emailDigest}`);
      let customer = await tx.customer.findUnique({ where: { emailNormalized: email } });
      if (!customer) {
        customer = await tx.customer.create({ data: { emailNormalized: email, displayName: defaultDisplayName(email), createdAt: now, updatedAt: now } });
      }
      let member = await tx.memberProfile.findUnique({ where: { customerId: customer.id } });
      if (!member) {
        member = await tx.memberProfile.create({ data: { customerId: customer.id, memberNo: await this.nextMemberNo(tx, now),
          joinedAt: now, createdAt: now, updatedAt: now } });
      }
      // 验证成功即证明邮箱归属：被停用/关闭的会员不能拿到新会话。挑战仍然消费掉，避免旧码被反复利用。
      if (member.status !== 'active') return { ok: false, status: 403, code: 'FORBIDDEN' };
      // 同一个已验证邮箱的既有访客订单归入会员，来源记为 email_match；重复登录不会重复链接。
      await tx.$executeRaw`
        INSERT INTO "OrderMemberLink" ("orderId", "memberId", "source", "linkedAt")
        SELECT o."id", ${member.id}::uuid, 'email_match', ${now}
        FROM "ShopOrder" o
        WHERE o."contact"->>'email' IS NOT NULL AND lower(btrim(o."contact"->>'email')) = ${email}
        ON CONFLICT ("orderId", "memberId") DO NOTHING`;
      const token = randomBytes(32).toString('base64url');
      const expiresAt = memberSessionExpiry(now);
      await tx.memberSession.create({ data: { memberId: member.id, tokenDigest: sessionTokenDigest(token),
        expiresAt, createdAt: now, updatedAt: now } });
      return { ok: true, token, data: { member: this.memberSummary(member, customer), csrfToken: csrf(token, this.config, 'member'),
        expiresAt: expiresAt.toISOString() } };
    });
    if (!outcome.ok) throw new AuthError(outcome.status, outcome.code);
    return { token: outcome.token, data: outcome.data };
  }

  private async nextMemberNo(tx: Tx, now: Date): Promise<string> {
    const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = Array.from({ length: 6 }, () => MEMBER_NO_ALPHABET[randomInt(MEMBER_NO_ALPHABET.length)]).join('');
      const candidate = memberNumber(day, suffix);
      if (!await tx.memberProfile.findUnique({ where: { memberNo: candidate } })) return candidate;
    }
    throw new AuthError(500, 'INTERNAL_ERROR');
  }

  /** 会话只认 token 摘要：cookie 被换掉或库被读都拿不到可用会话。 */
  private async requireSession(tx: Tx, token: string) {
    const now = await this.clock(tx);
    const session = await tx.memberSession.findUnique({ where: { tokenDigest: sessionTokenDigest(token) },
      include: { member: { include: { customer: true } } } });
    if (!session || session.status !== 'active' || session.expiresAt.getTime() <= now.getTime()) throw new AuthError(401, 'UNAUTHORIZED');
    if (session.member.status !== 'active') throw new AuthError(401, 'UNAUTHORIZED');
    return { session, member: session.member, customer: session.member.customer, now };
  }

  async profile(token: string) {
    return this.db.$transaction(async tx => {
      const { member, customer } = await this.requireSession(tx, token);
      return this.memberSummary(member, customer);
    });
  }

  /** 会员只看到自己的订单摘要；金额与状态来自订单本身，不重新计算。 */
  async memberOrders(token: string, limit: number, cursor: string | null) {
    return this.db.$transaction(async tx => {
      const { member } = await this.requireSession(tx, token);
      const key = { orderId_memberId: { orderId: cursor ?? '', memberId: member.id } };
      if (cursor) {
        if (!await tx.orderMemberLink.findUnique({ where: key })) throw new AuthError(422, 'VALIDATION_ERROR');
      }
      const rows = await tx.orderMemberLink.findMany({ where: { memberId: member.id },
        orderBy: [{ linkedAt: 'desc' }, { orderId: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: key, skip: 1 } : {}), include: { order: true } });
      const visible = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: visible.map(link => ({ orderNumber: link.order.publicOrderNumber, orderStatus: link.order.orderStatus,
        paymentStatus: link.order.paymentStatus, fulfillmentStatus: link.order.fulfillmentStatus,
        currency: link.order.currency, totalMinor: link.order.totalMinor,
        placedAt: link.order.placedAt.toISOString(), linkedAt: link.linkedAt.toISOString() })),
        hasMore, nextCursor: hasMore ? visible.at(-1)!.orderId : null };
    });
  }

  /** 登出必须带会话派生出的 CSRF：跨站请求拿不到这个值。 */
  async logout(token: string, csrfToken: string) {
    if (!equal(csrf(token, this.config, 'member'), csrfToken)) throw new AuthError(403, 'FORBIDDEN');
    await this.db.$transaction(async tx => {
      const now = await this.clock(tx);
      const session = await tx.memberSession.findUnique({ where: { tokenDigest: sessionTokenDigest(token) } });
      if (!session || session.status !== 'active') return;
      await tx.memberSession.update({ where: { id: session.id }, data: { status: 'revoked', revokedAt: now, updatedAt: now } });
    });
  }

  // ---- 后台：顾客与会员 ----------------------------------------------------

  private customerView(row: CustomerRow, pii: boolean) {
    return { id: row.id, displayName: row.displayName,
      // 默认只给遮蔽值：没有 customers.read_pii 的账号看不到完整邮箱与电话。
      email: row.emailNormalized === null ? null : pii ? row.emailNormalized : maskEmail(row.emailNormalized),
      phone: row.phone === null ? null : pii ? row.phone : maskPhone(row.phone),
      tags: row.tags, status: row.status, internalNote: pii ? row.internalNote : null,
      member: row.member === null ? null : { memberNo: row.member.memberNo, status: row.member.status, joinedAt: row.member.joinedAt.toISOString() },
      version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  private memberView(row: MemberRow, pii: boolean) {
    return { id: row.id, memberNo: row.memberNo, status: row.status, joinedAt: row.joinedAt.toISOString(),
      consentRef: row.consentRef, version: row.version,
      customer: { id: row.customer.id, displayName: row.customer.displayName,
        email: row.customer.emailNormalized === null ? null : pii ? row.customer.emailNormalized : maskEmail(row.customer.emailNormalized) } };
  }

  async listCustomers(supplied: string, limit: number, cursor: string | null, q: string | null) {
    if (q !== null && (typeof q !== 'string' || q.length > 80)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, null, 'customers.read_masked', async (tx, actor) => {
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      if (cursor && !await tx.customer.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const term = q?.trim() ?? '';
      const rows = await tx.customer.findMany({
        where: term ? { OR: [{ emailNormalized: { contains: term.toLowerCase() } }, { displayName: { contains: term } },
          { phone: { contains: term } }, { tags: { has: term } }] } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { member: true } });
      const visible = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: visible.map(row => this.customerView(row, pii)), hasMore, nextCursor: hasMore ? visible.at(-1)!.id : null };
    });
  }

  async createCustomer(supplied: string, csrfToken: string | null, body: Record<string, unknown>, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfToken, 'customers.manage', async (tx, actor, _session, now) => {
      const input = this.rule(() => normalizeCustomerInput(body));
      if (!input.displayName) throw new AuthError(422, 'VALIDATION_ERROR');
      try {
        const row = await tx.customer.create({ data: { displayName: input.displayName, emailNormalized: input.email ?? null,
          phone: input.phone ?? null, tags: input.tags ?? [], internalNote: input.internalNote ?? null,
          createdAt: now, updatedAt: now }, include: { member: true } });
        await this.identity.recordAudit(tx, ctx, actor.id, 'customer.created', row.id, 'success', row.displayName);
        return this.customerView(row, true);
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') throw new AuthError(409, 'CUSTOMER_EMAIL_TAKEN');
        throw error;
      }
    });
  }

  async getCustomer(supplied: string, id: string) {
    if (!UUID.test(id)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, null, 'customers.read_masked', async (tx, actor) => {
      const row = await tx.customer.findUnique({ where: { id }, include: { member: true } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      return this.customerView(row, this.identity.hasPermission(actor, 'customers.read_pii'));
    });
  }

  async updateCustomer(supplied: string, csrfToken: string | null, id: string, expectedVersion: number,
    body: Record<string, unknown>, ctx: RequestContext) {
    if (!UUID.test(id)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, csrfToken, 'customers.manage', async (tx, actor, _session, now) => {
      await this.lock(tx, `customer:${id}`);
      const row = await tx.customer.findUnique({ where: { id }, include: { member: true } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      if (row.version !== expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
      this.rule(() => assertNonEmptyPatch(body));
      const input = this.rule(() => normalizeCustomerInput(body));
      try {
        const updated = await tx.customer.update({ where: { id }, data: { ...input, updatedAt: now, version: { increment: 1 } },
          include: { member: true } });
        await this.identity.recordAudit(tx, ctx, actor.id, 'customer.updated', id, 'success',
          Object.keys(input).join(','));
        return this.customerView(updated, true);
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') throw new AuthError(409, 'CUSTOMER_EMAIL_TAKEN');
        throw error;
      }
    });
  }

  async listMembers(supplied: string, limit: number, cursor: string | null) {
    return this.identity.withPermission(supplied, null, 'members.manage', async (tx, actor) => {
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      if (cursor && !await tx.memberProfile.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.memberProfile.findMany({ orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { customer: true } });
      const visible = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: visible.map(row => this.memberView(row, pii)), hasMore, nextCursor: hasMore ? visible.at(-1)!.id : null };
    });
  }

  /** 后台建会员只针对已存在顾客；等级目录（M10 后续批次）落地前，tierId 一律拒绝而不是静默丢弃。 */
  async createMember(supplied: string, csrfToken: string | null, body: Record<string, unknown>, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfToken, 'members.manage', async (tx, actor, _session, now) => {
      if (body['tierId'] !== undefined && body['tierId'] !== null) throw new AuthError(422, 'MEMBER_TIERS_UNAVAILABLE');
      const customerId = body['customerId'];
      if (typeof customerId !== 'string' || !UUID.test(customerId)) throw new AuthError(422, 'VALIDATION_ERROR');
      const consentRef = body['consentRef'];
      if (typeof consentRef !== 'string' || !consentRef.trim().length || consentRef.length > 200) throw new AuthError(422, 'VALIDATION_ERROR');
      await this.lock(tx, `customer:${customerId}`);
      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer) throw new AuthError(404, 'NOT_FOUND');
      if (await tx.memberProfile.findUnique({ where: { customerId } })) throw new AuthError(409, 'MEMBER_EXISTS');
      const row = await tx.memberProfile.create({ data: { customerId, memberNo: await this.nextMemberNo(tx, now),
        consentRef: consentRef.trim(), joinedAt: now, createdAt: now, updatedAt: now }, include: { customer: true } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'member.created', row.id, 'success', consentRef.trim());
      return this.memberView(row, true);
    });
  }

  /** 等级变更要等会员等级目录；状态迁移必须走闭集，closed 不可回退。停用即撤销全部会员会话。 */
  async updateMember(supplied: string, csrfToken: string | null, id: string, expectedVersion: number,
    body: Record<string, unknown>, ctx: RequestContext) {
    if (!UUID.test(id)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, csrfToken, 'members.manage', async (tx, actor, _session, now) => {
      await this.lock(tx, `member:${id}`);
      const row = await tx.memberProfile.findUnique({ where: { id }, include: { customer: true } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      if (row.version !== expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
      const patch = this.rule(() => normalizeMemberPatch(body));
      if (patch.tierRequested) throw new AuthError(422, 'MEMBER_TIERS_UNAVAILABLE');
      const status = patch.status ?? (row.status as MemberStatus);
      this.rule(() => assertMemberStatusTransition(row.status as MemberStatus, status));
      const updated = await tx.memberProfile.update({ where: { id }, data: { status, updatedAt: now, version: { increment: 1 } },
        include: { customer: true } });
      if (status !== 'active') {
        await tx.memberSession.updateMany({ where: { memberId: id, status: 'active' },
          data: { status: 'revoked', revokedAt: now, updatedAt: now } });
      }
      await this.identity.recordAudit(tx, ctx, actor.id, 'member.updated', id, 'success', patch.reason);
      return this.memberView(updated, true);
    });
  }
}
