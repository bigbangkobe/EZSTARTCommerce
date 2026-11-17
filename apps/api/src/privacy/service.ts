import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  assertDueAtExtension, assertPrivacyTransition, decisionStatus, dueAtFrom, isTerminal, normalizeDueDays,
  normalizePrivacyDecision, normalizePrivacyRequestInput, normalizePrivacyUpdate, normalizePrivacyVerification,
  overdueDays, privacyDay, privacyRequestNumber, PRIVACY_RULE_VERSION, PRIVACY_STATUSES, PrivacyRuleError,
  requiresVerifiedIdentity, type PrivacyRequestType, type PrivacyStatus,
} from '../../../../packages/domain/src/privacy.js';
import { AuthError, IdentityService, type RequestContext, type User } from '../identity/service.js';

type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 状态冲突是 409（「现在不能这么做」），其余规则错误都是 422（「这么填不对」）。 */
const CONFLICT_CODES = new Set(['PRIVACY_STATUS_CONFLICT', 'EMPTY_PATCH']);

const includeRequest = {
  customer: true,
  owner: { select: { id: true, displayName: true } },
  reviewer: { select: { id: true, displayName: true } },
  verifier: { select: { id: true, displayName: true } },
} as const;

type RequestRow = Prisma.CustomerPrivacyRequestGetPayload<{ include: typeof includeRequest }>;

/**
 * 顾客资料请求（M10 第六批）。
 *
 * 这一层只做「受理与审批」，不动顾客数据：
 * 1. 未核验身份不得进入 approved/completed —— 服务层挡一次，数据库 CHECK 再挡一次。
 * 2. 每次状态变化都写审计（privacy.request.*），详情页的处理历史就从审计里读，
 *    与后台「查看审计记录」是同一份事实，不另存一份可能对不上的副本。
 * 3. 核验与决定各自要一把幂等键：网络失败重试不会重复核验，也不会把一次批准写成两次。
 * 4. 到期与逾期只是提醒：逾期不会让请求自动变成「已完成」，也不会自动拒绝。
 */
export class PrivacyService {
  constructor(private readonly identity: IdentityService) {}
  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof PrivacyRuleError) {
        throw new AuthError(CONFLICT_CODES.has(error.code) ? 409 : 422, error.code);
      }
      throw error;
    }
  }

  private async lock(tx: Tx, key: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }

  /**
   * 幂等键全表唯一：同一把键被用在另一条请求上，说明客户端把键复用到了不同意图，
   * 那是 409 而不是「成功两次」——否则一次批准可能落到两条申请上。
   */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new AuthError(409, 'IDEMPOTENCY_KEY_REUSED');
      throw error;
    }
  }

  private async setting(tx: Tx) {
    return tx.privacySetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1, dueDays: 30 } });
  }

  /** 视图只带必要的人名：隐私专员未必有 customers.read_pii，顾客姓名不是他的必需信息。 */
  private view(row: RequestRow, now: Date, actor: User) {
    const showCustomer = this.has(actor, 'customers.read_masked');
    return {
      id: row.id, requestNumber: row.requestNumber, requestType: row.requestType, sourceChannel: row.sourceChannel,
      scope: row.requestScope, customerRef: row.customerRef, customerId: row.customerId,
      customerName: showCustomer ? row.customer?.displayName ?? null : null,
      verificationState: row.verificationState, verificationMethod: row.verificationMethod,
      verificationEvidenceRef: row.verificationEvidenceRef,
      verifiedAt: row.verifiedAt?.toISOString() ?? null, verifier: row.verifier,
      status: row.status, receivedAt: row.receivedAt.toISOString(), dueAt: row.dueAt.toISOString(),
      overdueDays: isTerminal(row.status as PrivacyStatus) ? 0 : overdueDays(row.dueAt, now),
      owner: row.owner, reviewer: row.reviewer,
      decisionAt: row.decisionAt?.toISOString() ?? null, decisionReason: row.decisionReason,
      retentionExceptionRef: row.retentionExceptionRef, exportJobRef: row.exportJobRef,
      completedAt: row.completedAt?.toISOString() ?? null,
      ruleVersion: PRIVACY_RULE_VERSION, version: row.version,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  private settingsView(row: { dueDays: number; version: number; updatedAt: Date }) {
    return { dueDays: row.dueDays, version: row.version, updatedAt: row.updatedAt.toISOString() };
  }

  private has(actor: User, code: string) {
    return actor.roles.some(link => link.role.permissionCodes.includes(code));
  }

  /** 处理历史来自审计：谁在什么时候做了什么、为什么，详情页与审计页看到的是同一行。 */
  private async history(tx: Tx, id: string) {
    const rows = await tx.auditLog.findMany({ where: { objectId: id, action: { startsWith: 'privacy.' } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: 100 });
    const actors = [...new Set(rows.map(row => row.actorId).filter((value): value is string => Boolean(value)))];
    const people = actors.length
      ? await tx.adminUser.findMany({ where: { id: { in: actors } }, select: { id: true, displayName: true } })
      : [];
    const names = new Map(people.map(person => [person.id, person.displayName]));
    return rows.map(row => ({ action: row.action, actorName: row.actorId ? names.get(row.actorId) ?? null : null,
      result: row.result, reason: row.reason, occurredAt: row.occurredAt.toISOString() }));
  }

  // ---- 队列与详情 -------------------------------------------------------------

  /** 队列默认按到期先后排：最该处理的排前面，逾期与否由 dueAt 与状态共同决定。 */
  async queue(supplied: string, limit: number, cursor: string | null, status: string | null, overdue: boolean | null) {
    if (status !== null && !PRIVACY_STATUSES.includes(status as PrivacyStatus)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, null, 'privacy.read', async (tx, actor, _session, now) => {
      if (cursor && !await tx.customerPrivacyRequest.findUnique({ where: { id: cursor } })) {
        throw new AuthError(422, 'VALIDATION_ERROR');
      }
      const open = { status: { notIn: ['rejected', 'completed'] } };
      const where: Prisma.CustomerPrivacyRequestWhereInput = {
        ...(status ? { status } : {}),
        ...(overdue === true ? { ...open, dueAt: { lt: now } } : {}),
        ...(overdue === false ? { dueAt: { gte: now } } : {}),
      };
      const rows = await tx.customerPrivacyRequest.findMany({ where, include: includeRequest,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const page = rows.slice(0, limit);
      const setting = await this.setting(tx);
      const [openCount, overdueCount] = await Promise.all([
        tx.customerPrivacyRequest.count({ where: open }),
        tx.customerPrivacyRequest.count({ where: { ...open, dueAt: { lt: now } } }),
      ]);
      return { items: page.map(row => this.view(row, now, actor)), hasMore: rows.length > limit,
        nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
        summary: { open: openCount, overdue: overdueCount }, settings: this.settingsView(setting) };
    });
  }

  async get(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'privacy.read', async (tx, actor, _session, now) => {
      const row = await tx.customerPrivacyRequest.findUnique({ where: { id }, include: includeRequest });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      return { ...this.view(row, now, actor), history: await this.history(tx, row.id) };
    });
  }

  // ---- 受理 -----------------------------------------------------------------

  async create(supplied: string, csrfToken: string, body: unknown, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfToken, 'privacy.manage', async (tx, actor, _session, now) => {
      const input = this.rule(() => normalizePrivacyRequestInput(body));
      const setting = await this.setting(tx);
      const requestNumber = await this.nextNumber(tx, now);
      const row = await tx.customerPrivacyRequest.create({ data: {
        id: randomUUID(), requestNumber, requestType: input.requestType, sourceChannel: input.sourceChannel,
        requestScope: input.scope, customerRef: input.customerRef, status: 'received', verificationState: 'pending',
        receivedAt: now, dueAt: dueAtFrom(now, setting.dueDays), ownerId: actor.id, createdAt: now, updatedAt: now,
      }, include: includeRequest });
      await this.identity.recordAudit(tx, ctx, actor.id, 'privacy.request.created', row.id, 'success',
        `${input.requestType} via ${input.sourceChannel}`);
      return this.view(row, now, actor);
    });
  }

  /** 单号按 UTC 日分组：PR-20261117-0001。同一天内靠事务级 advisory lock 串行，取号不会撞。 */
  private async nextNumber(tx: Tx, now: Date): Promise<string> {
    const day = privacyDay(now);
    await this.lock(tx, `privacy-number:${day}`);
    let sequence = await tx.customerPrivacyRequest.count({ where: { requestNumber: { startsWith: `PR-${day}-` } } }) + 1;
    for (;;) {
      const candidate = privacyRequestNumber(day, sequence);
      if (!await tx.customerPrivacyRequest.findUnique({ where: { requestNumber: candidate } })) return candidate;
      sequence += 1;
    }
  }

  // ---- 核验 -----------------------------------------------------------------

  async verify(supplied: string, csrfToken: string, id: string, idempotencyKey: string, body: unknown, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfToken, 'privacy.verify', async (tx, actor, _session, now) => {
      const input = this.rule(() => normalizePrivacyVerification(body));
      const customerId = this.customerRef(body);
      await this.lock(tx, `privacy:${id}`);
      const row = await tx.customerPrivacyRequest.findUnique({ where: { id }, include: includeRequest });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      // 同一把键重放：原样返回，不重复记录核验人。
      if (row.idempotencyKey === idempotencyKey) return this.view(row, now, actor);
      if (isTerminal(row.status as PrivacyStatus)) throw new AuthError(409, 'PRIVACY_STATUS_CONFLICT');
      if (row.verificationState === 'verified') throw new AuthError(409, 'PRIVACY_ALREADY_VERIFIED');
      this.rule(() => assertPrivacyTransition(row.status as PrivacyStatus, 'verified'));
      if (customerId !== null) {
        const customer = await tx.customer.findUnique({ where: { id: customerId } });
        if (!customer) throw new AuthError(422, 'PRIVACY_CUSTOMER_NOT_FOUND');
      }
      const updated = await this.write(() => tx.customerPrivacyRequest.update({ where: { id }, data: {
        verificationState: 'verified', verificationMethod: input.verificationMethod,
        verificationEvidenceRef: input.evidenceRef, verifiedAt: now, verifiedBy: actor.id,
        customerId, status: 'verified', idempotencyKey, version: { increment: 1 }, updatedAt: now,
      }, include: includeRequest }));
      await this.identity.recordAudit(tx, ctx, actor.id, 'privacy.request.verified', id, 'success', input.reason);
      return this.view(updated, now, actor);
    });
  }

  /** 核验时可以顺带指定顾客；契约里这是可选字段，不填就只完成「人已核验」。 */
  private customerRef(body: unknown): string | null {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    const raw = (body as Record<string, unknown>).customerId;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string' || !UUID.test(raw)) throw new AuthError(422, 'VALIDATION_ERROR');
    return raw;
  }

  // ---- 决定 -----------------------------------------------------------------

  async decide(supplied: string, csrfToken: string, id: string, idempotencyKey: string, body: unknown, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfToken, 'privacy.process', async (tx, actor, _session, now) => {
      await this.lock(tx, `privacy:${id}`);
      const row = await tx.customerPrivacyRequest.findUnique({ where: { id }, include: includeRequest });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      if (row.idempotencyKey === idempotencyKey) return this.view(row, now, actor);
      const input = this.rule(() => normalizePrivacyDecision(body, row.requestType as PrivacyRequestType));
      const next = decisionStatus(input.decision);
      // 顺序决定错误语义：终态先说「已经结案」，再谈身份门槛，最后才是「这一步不能这么走」。
      if (isTerminal(row.status as PrivacyStatus)) throw new AuthError(409, 'PRIVACY_STATUS_CONFLICT');
      if (requiresVerifiedIdentity(next) && row.verificationState !== 'verified') {
        throw new AuthError(409, 'PRIVACY_VERIFICATION_REQUIRED');
      }
      this.rule(() => assertPrivacyTransition(row.status as PrivacyStatus, next));
      const updated = await this.write(() => tx.customerPrivacyRequest.update({ where: { id }, data: {
        status: next, decisionAt: now, decisionReason: input.reason, reviewerId: actor.id,
        retentionExceptionRef: input.retentionExceptionRef, exportJobRef: input.exportJobId,
        ...(next === 'completed' ? { completedAt: now } : {}),
        idempotencyKey, version: { increment: 1 }, updatedAt: now,
      }, include: includeRequest }));
      await this.identity.recordAudit(tx, ctx, actor.id, `privacy.request.${next}`, id, 'success', input.reason);
      return this.view(updated, now, actor);
    });
  }

  // ---- 负责人与延期 -----------------------------------------------------------

  async update(supplied: string, csrfToken: string, id: string, version: number, body: unknown, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfToken, 'privacy.manage', async (tx, actor, _session, now) => {
      const input = this.rule(() => normalizePrivacyUpdate(body));
      await this.lock(tx, `privacy:${id}`);
      const row = await tx.customerPrivacyRequest.findUnique({ where: { id }, include: includeRequest });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      if (row.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      if (isTerminal(row.status as PrivacyStatus)) throw new AuthError(409, 'PRIVACY_STATUS_CONFLICT');
      if (input.ownerId) {
        const owner = await tx.adminUser.findUnique({ where: { id: input.ownerId } });
        if (!owner || owner.status !== 'active') throw new AuthError(422, 'PRIVACY_OWNER_INVALID');
      }
      if (input.dueAt) this.rule(() => assertDueAtExtension(input.dueAt!, row.receivedAt));
      const updated = await tx.customerPrivacyRequest.update({ where: { id }, data: {
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        version: { increment: 1 }, updatedAt: now,
      }, include: includeRequest });
      await this.identity.recordAudit(tx, ctx, actor.id, 'privacy.request.updated', id, 'success', input.reason);
      return this.view(updated, now, actor);
    });
  }

  // ---- 口径 -----------------------------------------------------------------

  async updateSettings(supplied: string, csrfToken: string, version: number, body: unknown, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfToken, 'privacy.manage', async (tx, actor, _session, _now) => {
      const dueDays = this.rule(() => normalizeDueDays(
        body !== null && typeof body === 'object' ? (body as Record<string, unknown>).dueDays : undefined));
      await this.lock(tx, 'privacy-settings');
      const row = await this.setting(tx);
      if (row.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      const updated = await tx.privacySetting.update({ where: { id: 1 },
        data: { dueDays, version: { increment: 1 } } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'privacy.settings.updated', 'privacy-setting', 'success',
        `dueDays=${dueDays}`);
      return this.settingsView(updated);
    });
  }
}
