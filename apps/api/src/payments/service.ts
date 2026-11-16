import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  assertCodRequiresDispatch, assertCollectable, assertPaymentAmount, assertVersion, nextPaymentStatus,
  normalizeMethodPatch, normalizeOutcome, orderPaymentStatusFor, paymentNumber, provider, PaymentRuleError,
  type MethodPatchInput, type OutcomeInput, type PaymentChannel, type ProviderDefinition,
} from '../../../../packages/domain/src/payments.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';

type Tx = Prisma.TransactionClient;
type MethodRow = Prisma.PaymentMethodConfigGetPayload<{}>;
type PaymentRow = Prisma.PaymentGetPayload<{}>;
type PaymentOrderRow = Prisma.ShopOrderGetPayload<{}>;

/** 状态冲突是 409，输入问题是 422：与订单模块保持同一套映射。 */
const CONFLICT_CODES = new Set(['VERSION_CONFLICT', 'PAYMENT_STATE_CONFLICT', 'PAYMENT_OUTCOME_NOT_ALLOWED',
  'ORDER_ALREADY_CANCELLED', 'PAYMENT_STATUS_UNKNOWN_REQUIRES_PROVIDER', 'IDEMPOTENCY_CONFLICT',
  'PAYMENT_ALREADY_RECORDED']);

const DEFAULT_METHODS = [
  { providerCode: 'cod', environment: 'production', displayName: 'Cash on delivery', enabled: true,
    approvalReference: 'built_in_default', publicConfig: { instructions: 'Pay the courier on delivery.' } },
  { providerCode: 'manual_bank_transfer', environment: 'production', displayName: 'Manual bank transfer',
    enabled: false, approvalReference: null, publicConfig: {} },
] as const;

export interface MethodPatchBody { providerCode?: unknown; environment?: unknown; enabled?: unknown; displayName?: unknown;
  approvalReference?: unknown; publicConfig?: unknown; secretRef?: unknown }
export interface PaymentFilters { status?: string | null; orderId?: string | null; providerCode?: string | null }

/**
 * 付款方式配置与交易台账（M08 第一批）。
 *
 * 三条不变量：
 * 1. 配置只存凭证引用（secret:// / env://），响应只回“是否已配置 + 指纹”，明文不出库。
 * 2. 台账一笔订单每渠道一条，登记走 Idempotency-Key + If-Match，重放不产生第二条流水。
 * 3. 订单付款状态是台账状态的投影：登记收款/拒收/退回时一起推进，且不伪造未发生的收款。
 */
export class PaymentsService {
  constructor(private readonly identity: IdentityService) {}
  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof PaymentRuleError) throw new AuthError(CONFLICT_CODES.has(error.code) ? 409 : 422, error.code);
      throw error;
    }
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') throw new AuthError(409, 'STATE_CONFLICT');
      if (code === 'P2003') throw new AuthError(422, 'VALIDATION_ERROR');
      if (code === 'P2025') throw new AuthError(404, 'NOT_FOUND');
      if (code === 'P2011' || code === 'P2000') throw new AuthError(422, 'VALIDATION_ERROR');
      throw error;
    }
  }

  private async lock(tx: Tx, key: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }

  private key(value: string) {
    if (typeof value !== 'string' || value.length < 16 || value.length > 128) throw new AuthError(422, 'VALIDATION_ERROR');
    return value;
  }

  /** 凭证引用只留指纹：换了引用就要重新确认，界面上也能看出“凭证已更换”。 */
  private fingerprint(reference: string) {
    return createHash('sha256').update(reference).digest('hex').slice(0, 16);
  }

  /**
   * 首期两个渠道的默认行：COD 默认启用（线下收款无需服务商批准），
   * 人工转账默认关闭且未批准，必须由店主填批准依据后手动打开。
   */
  private async ensureDefaults(tx: Tx) {
    await tx.paymentMethodConfig.createMany({ data: DEFAULT_METHODS.map(row => ({ ...row,
      approvedAt: row.approvalReference ? new Date() : null, connectionStatus: 'unverified' })), skipDuplicates: true });
  }

  private methodView(row: MethodRow) {
    return { id: row.id, providerCode: row.providerCode, environment: row.environment, displayName: row.displayName,
      enabled: row.enabled, approvalStatus: row.approvalReference ? 'approved' as const : 'unapproved' as const,
      approvalReference: row.approvalReference ?? null, approvedAt: row.approvedAt?.toISOString() ?? null,
      publicConfig: row.publicConfig as Record<string, string>, secretConfigured: Boolean(row.secretRef),
      secretFingerprint: row.secretFingerprint ?? null, connectionStatus: row.connectionStatus,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null, version: row.version,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  private paymentView(row: PaymentRow, order: PaymentOrderRow, events: Prisma.PaymentEventGetPayload<{}>[] | null) {
    return { id: row.id, publicPaymentNumber: row.publicPaymentNumber, orderId: row.orderId,
      publicOrderNumber: order.publicOrderNumber, providerCode: row.providerCode, environment: row.environment,
      channel: row.channel, status: row.status, amountMinor: row.amountMinor, currency: row.currency,
      providerTransactionId: row.providerTransactionId ?? null, paidAt: row.paidAt?.toISOString() ?? null,
      returnedAt: row.returnedAt?.toISOString() ?? null, reference: row.reference ?? null,
      failureCode: row.failureCode ?? null, failureMessage: row.failureMessage ?? null,
      recordedBy: row.recordedBy ?? null, version: row.version, createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(events ? { events: events.map(event => ({ id: event.id, type: event.type, fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus, source: event.source, actorId: event.actorId ?? null, occurredAt: event.occurredAt.toISOString() })) } : {}) };
  }

  private day(timezone: string, now: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).reduce<Record<string, string>>((acc, part) => (part.type === 'literal' ? acc : { ...acc, [part.type]: part.value }), {});
    return `${parts.year}${parts.month}${parts.day}`;
  }

  private async settings(tx: Tx) {
    const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
    return { currency: row?.baseCurrency ?? 'HKD', timezone: row?.timezone ?? 'Asia/Hong_Kong' };
  }

  private async methodRow(tx: Tx, code: string, environment = 'production') {
    return tx.paymentMethodConfig.findUnique({ where: { providerCode_environment: { providerCode: code, environment } } });
  }

  // ---- 支付方式配置 -----------------------------------------------------------

  async listMethods(supplied: string) {
    return this.identity.withPermission(supplied, null, 'payment.config', async tx => {
      await this.ensureDefaults(tx);
      const rows = await tx.paymentMethodConfig.findMany({ orderBy: [{ providerCode: 'asc' }, { environment: 'asc' }] });
      return { items: rows.map(row => this.methodView(row)) };
    });
  }

  /**
   * 配置或启停一个已接入的渠道。启用必须有批准依据；关闭时保留凭证引用（便于重新开启），
   * 但只要该渠道仍有待处理的流水就拒绝停用——停了会让在途收款无人认领。
   */
  async updateMethod(supplied: string, csrf: string | null, expectedVersion: number, body: MethodPatchBody, ctx: RequestContext) {
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'payment.config', async (tx, actor, _session, now) => {
      const definition = this.rule(() => provider(typeof body.providerCode === 'string' ? body.providerCode : ''));
      if (body.environment !== 'sandbox' && body.environment !== 'production') throw new AuthError(422, 'VALIDATION_ERROR');
      await this.ensureDefaults(tx);
      await this.lock(tx, `payment-method:${definition.code}:${body.environment}`);
      const existing = await tx.paymentMethodConfig.findUnique({ where: { providerCode_environment:
        { providerCode: definition.code, environment: body.environment } } });
      if (!existing) throw new AuthError(404, 'NOT_FOUND');
      this.rule(() => assertVersion(expectedVersion, existing.version));

      const existingSecret = existing.secretRef;
      const input: MethodPatchInput = this.rule(() => normalizeMethodPatch(body, {
        displayName: existing.displayName, publicConfig: existing.publicConfig as Record<string, string>,
        secretRef: existingSecret, approvalReference: existing.approvalReference }));
      if (input.enabled) this.rule(() => { if (!input.approvalReference) throw new PaymentRuleError('PAYMENT_APPROVAL_REQUIRED'); });
      if (!input.enabled && existing.enabled) {
        const pending = await tx.payment.count({ where: { methodConfigId: existing.id,
          status: { in: ['pending', 'authorized', 'unknown'] } } });
        if (pending > 0) throw new AuthError(409, 'PAYMENT_METHOD_IN_USE');
      }

      const secretChanged = input.secretRef !== existingSecret;
      const approvedAt = input.approvalReference
        ? existing.approvalReference === input.approvalReference && existing.approvedAt ? existing.approvedAt : now
        : null;
      const updated = await tx.paymentMethodConfig.update({ where: { id: existing.id }, data: {
        displayName: input.displayName, enabled: input.enabled, approvalReference: input.approvalReference,
        approvedAt,
        publicConfig: input.publicConfig as Prisma.InputJsonValue, secretRef: input.secretRef,
        ...(secretChanged ? { secretFingerprint: input.secretRef ? this.fingerprint(input.secretRef) : null } : {}),
        version: { increment: 1 } } });
      await this.identity.recordAudit(tx, ctx, actor.id, input.enabled ? 'payments.method.enabled' : 'payments.method.updated',
        updated.id, 'success', secretChanged ? 'credential reference rotated' : undefined);
      return this.methodView(updated);
    }));
  }

  /**
   * 结账时的可售方式判定：只认 production 环境、已启用、已批准的配置；
   * COD 还要求所选配送方式本身开启了货到付款。缺一即明确拒绝，不静默降级。
   */
  async resolveCheckout(tx: Tx, methodCode: string, codEnabledByRate: boolean) {
    await this.ensureDefaults(tx);
    // 未知或未接入的方式一律按“该方式不可用”处理：结账页不该看到没有适配器的渠道。
    const definition = (() => {
      try { return provider(methodCode); } catch { throw new AuthError(422, 'PAYMENT_METHOD_UNAVAILABLE'); }
    })();
    const row = await this.methodRow(tx, definition.code);
    if (!row || !row.enabled || !row.approvalReference) throw new AuthError(422, 'PAYMENT_METHOD_UNAVAILABLE');
    if (definition.channel === 'cod' && !codEnabledByRate) throw new AuthError(422, 'PAYMENT_METHOD_UNAVAILABLE');
    return { definition, row };
  }

  /** 下单即开一条待收流水：台账从“应收”开始，收款登记只推进状态，不补造记录。 */
  async openLedger(tx: Tx, order: PaymentOrderRow, definition: ProviderDefinition, row: MethodRow) {
    const settings = await this.settings(tx);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const suffix = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
        return await tx.payment.create({ data: { publicPaymentNumber: paymentNumber(this.day(settings.timezone, new Date()), suffix),
          dedupeKey: `${definition.code}:${order.id}`, orderId: order.id, methodConfigId: row.id,
          providerCode: definition.code, environment: row.environment, channel: definition.channel, status: 'pending',
          amountMinor: order.totalMinor, currency: order.currency, metadata: { source: 'checkout' } } });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002' && attempt < 2) continue;
        throw error;
      }
    }
  }

  private async ensureLedger(tx: Tx, order: PaymentOrderRow, definition: ProviderDefinition) {
    const row = await tx.payment.findUnique({ where: { dedupeKey: `${definition.code}:${order.id}` } });
    if (row) return row;
    // 迁移前创建的订单没有流水：登记时按订单金额补一条，金额仍只来自订单快照。
    const config = await this.methodRow(tx, definition.code);
    const settings = await this.settings(tx);
    const suffix = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    return tx.payment.create({ data: { publicPaymentNumber: paymentNumber(this.day(settings.timezone, new Date()), suffix),
      dedupeKey: `${definition.code}:${order.id}`, orderId: order.id, methodConfigId: config?.id ?? null,
      providerCode: definition.code, environment: config?.environment ?? 'production', channel: definition.channel,
      status: 'pending', amountMinor: order.totalMinor, currency: order.currency, metadata: { source: 'backfill' } } });
  }

  // ---- 交易台账 ---------------------------------------------------------------

  async listPayments(supplied: string, limit: number, cursor: string | null, filters: PaymentFilters) {
    const status = filters.status ?? null;
    if (status !== null && !['pending', 'authorized', 'succeeded', 'failed', 'cancelled', 'unknown', 'collected',
      'rejected', 'returned'].includes(status)) throw new AuthError(422, 'VALIDATION_ERROR');
    const providerCode = filters.providerCode ?? null;
    if (providerCode !== null) this.rule(() => provider(providerCode));
    const orderId = filters.orderId ?? null;
    if (orderId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      throw new AuthError(422, 'VALIDATION_ERROR');
    }
    return this.identity.withPermission(supplied, null, 'payments.read', async tx => {
      if (cursor && !await tx.payment.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.payment.findMany({ where: {
        ...(status ? { status } : {}), ...(providerCode ? { providerCode } : {}), ...(orderId ? { orderId } : {}) },
        include: { order: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const visible = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: visible.map(row => this.paymentView(row, row.order, null)), hasMore,
        nextCursor: hasMore ? visible.at(-1)!.id : null };
    });
  }

  async getPayment(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'payments.read', async tx => {
      const row = await tx.payment.findUnique({ where: { id }, include: { order: true,
        events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      return this.paymentView(row, row.order, row.events);
    });
  }

  /**
   * 登记 COD 收款、拒收、退回，或人工转账到账。
   * 同一 Idempotency-Key 重放返回同一结果；同键不同内容 409。金额、币种、时间窗全部复核。
   */
  async recordOrderPayment(supplied: string, csrf: string | null, orderId: string, idempotencyKey: string,
    body: Record<string, unknown>, ctx: RequestContext) {
    this.key(idempotencyKey);
    const digest = createHash('sha256').update(`payment.result\n${orderId}\n${JSON.stringify(body)}`).digest('hex');
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'payments.collect', async (tx, actor, _session, now) => {
      await this.lock(tx, `order:${orderId}`);
      const replay = await tx.orderAction.findUnique({ where: { idempotencyKey } });
      if (replay) {
        if (replay.orderId !== orderId || replay.action !== 'payment.result' || replay.requestDigest !== digest) {
          throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
        }
        const order = await tx.shopOrder.findUnique({ where: { id: orderId } });
        if (!order) throw new AuthError(404, 'NOT_FOUND');
        const payment = await tx.payment.findUnique({ where: { dedupeKey: `${order.paymentMethodCode}:${orderId}` },
          include: { events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } } });
        if (!payment) throw new AuthError(409, 'STATE_CONFLICT');
        return { orderId: order.id, orderPaymentStatus: order.paymentStatus, orderVersion: order.version,
          payment: this.paymentView(payment, order, payment.events) };
      }

      const order = await tx.shopOrder.findUnique({ where: { id: orderId } });
      if (!order) throw new AuthError(404, 'NOT_FOUND');
      const input: OutcomeInput = this.rule(() => normalizeOutcome(body, now));
      this.rule(() => assertVersion(input.expectedVersion, order.version));
      const definition = this.rule(() => provider(order.paymentMethodCode));
      const payment = await this.ensureLedger(tx, order, definition);
      const nextStatus = this.rule(() => nextPaymentStatus(payment.status, input.outcome, definition.channel));
      this.rule(() => assertCollectable(order, input.occurredAt));
      const dispatched = await tx.shipment.count({ where: { orderId, status: { in: ['dispatched', 'delivered'] } } }) > 0;
      this.rule(() => assertCodRequiresDispatch(definition.channel as PaymentChannel, input.outcome, dispatched));
      this.rule(() => assertPaymentAmount({ paymentAmountMinor: payment.amountMinor, orderTotalMinor: order.totalMinor,
        amountMinor: input.amountMinor, currency: payment.currency, orderCurrency: order.currency }));

      const paidAt = nextStatus === 'collected' || nextStatus === 'succeeded' ? input.occurredAt : payment.paidAt;
      const updated = await tx.payment.update({ where: { id: payment.id }, data: { status: nextStatus, paidAt,
        returnedAt: nextStatus === 'returned' ? input.occurredAt : null, reference: input.reference ?? payment.reference,
        failureCode: input.outcome === 'rejected' ? 'customer_rejected' : input.outcome === 'cancelled' ? 'cancelled' : null,
        failureMessage: input.reason, recordedBy: actor.id, version: { increment: 1 } } });
      const orderPaymentStatus = orderPaymentStatusFor(nextStatus);
      const updatedOrder = await tx.shopOrder.update({ where: { id: order.id },
        data: { paymentStatus: orderPaymentStatus, version: { increment: 1 } } });
      const event = await tx.paymentEvent.create({ data: { paymentId: payment.id, orderId: order.id, type: input.outcome,
        fromStatus: payment.status, toStatus: nextStatus, source: 'admin', actorId: actor.id,
        dedupeKey: `admin:${idempotencyKey}`, payload: { amountMinor: input.amountMinor, currency: payment.currency,
          reference: input.reference, reason: input.reason }, occurredAt: input.occurredAt } });
      await tx.orderAction.create({ data: { idempotencyKey, orderId: order.id, action: 'payment.result',
        requestDigest: digest, objectId: payment.id } });
      await this.identity.recordAudit(tx, ctx, actor.id, `payments.${input.outcome}`, order.id, 'success',
        input.reason ?? undefined);
      return { orderId: order.id, orderPaymentStatus, orderVersion: updatedOrder.version,
        payment: this.paymentView(updated, updatedOrder, [event]) };
    }));
  }

  /** 供结账下单使用：按订单金额开一张待收流水（Payment 行必须在订单事务里一起落库）。 */
}
