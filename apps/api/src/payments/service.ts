import { redeemCouponInTx } from '../promotions/redeem.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  assertCodRequiresDispatch, assertCollectable, assertPaymentAmount, assertVersion, nextPaymentStatus,
  nextPaymentStatusFromProvider, normalizeMethodPatch, normalizeOutcome, orderPaymentStatusFor, paymentNumber,
  provider, providers, PaymentRuleError,
  type MethodPatchInput, type OutcomeInput, type PaymentChannel, type PaymentOutcome, type PaymentStatus,
  type ProviderDefinition,
} from '../../../../packages/domain/src/payments.js';
import {
  assertCreatePaymentInput, assertNoSecretShape, assertRefundInput, assertWebhookAmount, checkoutVisible,
  PaymentAdapterError,
  webhookEventKey, type AdapterContext, type AdapterStatus, type PaymentAdapter,
} from '../../../../packages/domain/src/payment-adapter.js';
import type { SecretResolver } from './adapters/secret-resolver.js';
import { paymentEnvironment, type PaymentEnvironment } from './environment.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';

type Tx = Prisma.TransactionClient;
type MethodRow = Prisma.PaymentMethodConfigGetPayload<{}>;
type PaymentRow = Prisma.PaymentGetPayload<{}>;
type PaymentOrderRow = Prisma.ShopOrderGetPayload<{}>;
type PaymentWithOrder = Prisma.PaymentGetPayload<{ include: { order: true } }>;
type Environment = PaymentEnvironment;

/** 线上支付需要的三件外部能力；缺失时线上支付整体不可用（返回 503），线下不受影响。 */
export interface OnlinePaymentDeps {
  readonly resolver: SecretResolver;
  readonly adapterFor: (code: string, environment: Environment) => PaymentAdapter;
  /** 站点根地址，用于拼 returnUrl 与 notifyUrl，例：https://mrinhk.com */
  readonly baseUrl: string;
}

/** 渠道对一笔退款的结论。pending 表示"还没定"，绝不能被当成成功或失败。 */
export interface ProviderRefundOutcome {
  readonly providerRefundId: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly rawStatus: string;
}

/** 单类扫描的计数。unchanged 不是失败——渠道也说"还没定"是正常结果。 */
export interface SweepCounters { scanned: number; converged: number; unchanged: number; failed: number }

export interface ReconcileError { id: string; kind: 'payment' | 'refund'; code: string }

export interface ReconcileReport {
  startedAt: string;
  finishedAt: string;
  olderThanMinutes: number;
  payments: SweepCounters;
  refunds: SweepCounters;
  errors: ReconcileError[];
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function errorCode(error: unknown, fallback = 'RECONCILE_FAILED'): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length ? code : fallback;
}

/** 状态冲突是 409，输入问题是 422：与订单模块保持同一套映射。 */
const CONFLICT_CODES = new Set(['VERSION_CONFLICT', 'PAYMENT_STATE_CONFLICT', 'PAYMENT_OUTCOME_NOT_ALLOWED',
  'ORDER_ALREADY_CANCELLED', 'PAYMENT_STATUS_UNKNOWN_REQUIRES_PROVIDER', 'IDEMPOTENCY_CONFLICT',
  'PAYMENT_ALREADY_RECORDED', 'ORDER_NOT_SHIPPED']);

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
  constructor(private readonly identity: IdentityService, private readonly online: OnlinePaymentDeps | null = null) {}
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
  /**
   * 首次进入支付页时补齐配置行。
   *
   * 关键点：**白名单里的每个渠道都要有行**，否则后台只能改已存在的记录，
   * 客户想接自己的收单账号时会卡在"系统里没有这条路"——那"自助配置"就是假的。
   * 新建行一律 `enabled=false` 且无批准依据：能不能开，由客户测通再说。
   */
  private async ensureDefaults(tx: Tx) {
    const online = providers
      .filter(definition => definition.channel === 'online')
      .flatMap(definition => (definition.sandboxOnly ? ['sandbox'] : ['sandbox', 'production'])
        .map(environment => ({ providerCode: definition.code, environment, displayName: definition.label,
          enabled: false, approvalReference: null as string | null, publicConfig: {} })));
    await tx.paymentMethodConfig.createMany({ data: [...DEFAULT_METHODS, ...online].map(row => ({ ...row,
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

  /**
   * 本站点使用的支付环境。生产实例只能用生产渠道；staging 用 `PAYMENTS_ENVIRONMENT=sandbox`
   * 才能用 mock 之类仅沙箱存在的渠道。默认 production——配错时宁可"少一个渠道"，
   * 也不能让沙箱渠道在生产里出现。
   *
   * 判定集中在 `paymentEnvironment`：密钥解析器也用它，两处不能各认一套变量。
   */
  private environment(): Environment {
    return paymentEnvironment();
  }

  private async methodRow(tx: Tx, code: string, environment = this.environment()) {
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
   * COD 还要求所选配送方式本身开启了货到付款；并且该渠道必须落在
   * 购物车商品允许的集合内（商品级约束，见 availableChannelsFor）。缺一即明确拒绝。
   */
  async resolveCheckout(tx: Tx, methodCode: string, codEnabledByRate: boolean,
    allowed: ReadonlySet<PaymentChannel> = new Set<PaymentChannel>(['cod', 'manual', 'online'])) {
    await this.ensureDefaults(tx);
    // 未知或未接入的方式一律按“该方式不可用”处理：结账页不该看到没有适配器的渠道。
    const definition = (() => {
      try { return provider(methodCode); } catch { throw new AuthError(422, 'PAYMENT_METHOD_UNAVAILABLE'); }
    })();
    // 购物车里有一件「必须先行转账」的商品，整单就不能货到付款。
    if (!allowed.has(definition.channel)) throw new AuthError(422, 'PAYMENT_METHOD_NOT_ALLOWED_FOR_CART');
    const row = await this.methodRow(tx, definition.code, this.environment());
    if (!row || !row.enabled || !row.approvalReference) throw new AuthError(422, 'PAYMENT_METHOD_UNAVAILABLE');
    if (definition.channel === 'cod' && !codEnabledByRate) throw new AuthError(422, 'PAYMENT_METHOD_UNAVAILABLE');
    // 线上渠道还多一道：凭据没测通就不许出现在结账页。
    // 配错凭据的最坏结果是"看不见这个支付方式"，而不是"顾客下单必失败"。
    if (definition.channel === 'online' && !checkoutVisible({ enabled: row.enabled,
      connectionStatus: row.connectionStatus, environment: row.environment,
      requestEnvironment: this.environment() })) throw new AuthError(422, 'PAYMENT_METHOD_UNAVAILABLE');
    return { definition, row };
  }

  /**
   * 结账页可展示的收款方式：站点已启用 + 已批准 + 落在商品允许的集合内。
   *
   * 与 resolveCheckout 共用同一套门禁，避免「页面能选、下单被拒」这种割裂。
   * 只回展示所需字段：凭证引用与指纹一概不出现在面向顾客的响应里。
   */
  async availableMethods(tx: Tx, allowed: ReadonlySet<PaymentChannel>, codEnabledByRate: boolean) {
    if (!allowed.size) return [];
    await this.ensureDefaults(tx);
    const environment = this.environment();
    const rows = await tx.paymentMethodConfig.findMany({ where: { environment, enabled: true },
      orderBy: { providerCode: 'asc' } });
    const output: Array<{ code: string; channel: PaymentChannel; label: string; instructions: string | null }> = [];
    for (const row of rows) {
      const definition = providers.find(entry => entry.code === row.providerCode);
      if (!definition || !allowed.has(definition.channel) || !row.approvalReference) continue;
      if (definition.channel === 'cod' && !codEnabledByRate) continue;
      if (definition.channel === 'online' && !checkoutVisible({ enabled: row.enabled,
        connectionStatus: row.connectionStatus, environment: row.environment,
        requestEnvironment: environment })) continue;
      const config = row.publicConfig as Record<string, string>;
      output.push({ code: definition.code, channel: definition.channel, label: row.displayName,
        // 顾客看到的付款指引：COD 由确认页按语言生成，转账渠道就是这一段原文。
        instructions: definition.channel === 'cod' ? null : config.accountSummary ?? null });
    }
    return output;
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
    const config = await this.methodRow(tx, definition.code, this.environment());
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
      // 收款成功才把券从预占转核销；拒收/取消保持原状，由订单取消或超时清理负责释放。
      if (nextStatus === 'collected' || nextStatus === 'succeeded') {
        await redeemCouponInTx(tx, order.id, { id: actor.id, type: 'admin' }, now);
      }
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

  // ---- 线上支付 ---------------------------------------------------------------

  private onlineDeps(): OnlinePaymentDeps {
    if (!this.online) throw new AuthError(503, 'SERVICE_NOT_READY');
    return this.online;
  }

  /** 适配器抛的规则错误统一转 400：回调里任何验签/金额问题都不该是 5xx。 */
  private adapterRule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof PaymentAdapterError) {
        throw new AuthError(error.code === 'SECRET_REFERENCE_INVALID' ? 422 : 400, error.code);
      }
      throw error;
    }
  }

  /**
   * 异步版本的规则转换。适配器方法都是 async，同步 try/catch 抓不到 rejection——
   * 漏了这层，验签失败会变成 500，渠道就会一直重试。
   */
  private async adapterCall<T>(fn: () => Promise<T>, failureStatus: number): Promise<T> {
    try { return await fn(); } catch (error) {
      if (error instanceof PaymentAdapterError) {
        throw new AuthError(error.code === 'SECRET_REFERENCE_INVALID' ? 422 : failureStatus, error.code);
      }
      throw error;
    }
  }

  private async adapterCredentials(secretRef: string, environment: Environment): Promise<Record<string, string>> {
    try {
      return { ...await this.onlineDeps().resolver.resolve(secretRef) };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'SECRET_FETCH_FAILED';
      // 密钥取不到属于配置问题，不是客户端问题；但要给出可诊断的错误码，不能静默空凭据。
      throw new AuthError(code === 'SECRET_SCHEME_NOT_ALLOWED_IN_PRODUCTION' ? 422 : 503, code);
    }
  }

  private adapterContext(code: string, environment: Environment, credentials: Record<string, string>,
    publicConfig: Record<string, string>): AdapterContext {
    return { providerCode: code, environment, credentials, publicConfig };
  }

  /**
   * 发起线上支付：读订单与台账 → 解析密钥 → 调渠道拿收银台地址 → 回写渠道单号。
   *
   * 关键约束：
   * 1. 归属校验用 cartId，与下单同一凭证；换个人拿到 orderId 也发不起来。
   * 2. 金额只取订单快照，不接受客户端传入；渠道侧幂等键固定为内部台账号。
   * 3. 渠道调用在数据库事务之外：外部 IO 不占事务，失败也不留半截状态。
   */
  async onlineIntent(orderId: string, cartId: string, ctx: RequestContext) {
    const deps = this.onlineDeps();
    if (typeof orderId !== 'string' || !/^[0-9a-f-]{36}$/i.test(orderId)) throw new AuthError(422, 'VALIDATION_ERROR');

    const prep = await this.db.$transaction(async tx => {
      const order = await tx.shopOrder.findUnique({ where: { id: orderId } });
      if (!order || order.cartId !== cartId) throw new AuthError(404, 'NOT_FOUND');
      if (order.orderStatus === 'cancelled') throw new AuthError(409, 'ORDER_ALREADY_CANCELLED');
      const definition = this.rule(() => provider(order.paymentMethodCode));
      if (definition.channel !== 'online') throw new AuthError(422, 'PAYMENT_METHOD_NOT_ONLINE');
      const payment = await tx.payment.findUnique({ where: { dedupeKey: `${definition.code}:${order.id}` } });
      if (!payment) throw new AuthError(409, 'STATE_CONFLICT');
      if (payment.status === 'succeeded' || payment.status === 'collected') throw new AuthError(409, 'PAYMENT_ALREADY_RECORDED');
      if (payment.status === 'cancelled' || payment.status === 'failed') throw new AuthError(409, 'PAYMENT_STATE_CONFLICT');
      const environment: Environment = payment.environment === 'sandbox' ? 'sandbox' : 'production';
      const config = await tx.paymentMethodConfig.findUnique({ where: { providerCode_environment:
        { providerCode: definition.code, environment: payment.environment } } });
      if (!config || !config.enabled || !config.approvalReference) throw new AuthError(422, 'PAYMENT_METHOD_UNAVAILABLE');
      if (!config.secretRef) throw new AuthError(422, 'PAYMENT_CREDENTIAL_REQUIRED');
      return { order, payment, definition, config, environment };
    });

    const credentials = await this.adapterCredentials(prep.config.secretRef as string, prep.environment);
    const adapter = deps.adapterFor(prep.definition.code, prep.environment);
    const base = deps.baseUrl.replace(/\/+$/, '');
    const input = this.adapterRule(() => assertCreatePaymentInput({
      paymentNumber: prep.payment.publicPaymentNumber,
      orderNumber: prep.order.publicOrderNumber,
      amountMinor: prep.order.totalMinor,
      currency: prep.order.currency,
      returnUrl: `${base}/checkout/return?order=${encodeURIComponent(prep.order.publicOrderNumber)}`,
      notifyUrl: `${base}/api/v1/webhooks/payments/${prep.definition.code}`,
      locale: 'zh-HK',
    }, prep.environment));

    // 渠道侧失败属于上游问题（502），不是客户端请求有问题。
    const result = await this.adapterCall(() => adapter.createPayment(
      this.adapterContext(prep.definition.code, prep.environment, credentials,
        prep.config.publicConfig as Record<string, string>), input), 502);

    // 跳转地址是给前端的，不写进 metadata：它会随台账查询与导出扩散，没必要留。
    const metadata = { ...(prep.payment.metadata as Record<string, unknown>), adapterStatus: result.status };
    this.adapterRule(() => assertNoSecretShape(metadata));
    await this.db.$transaction(async tx => {
      await tx.payment.update({ where: { id: prep.payment.id }, data: {
        providerTransactionId: result.providerTransactionId, metadata: metadata as Prisma.InputJsonValue } });
      await this.identity.recordAudit(tx, ctx, null, 'payments.online.intent', prep.payment.id, 'success');
    });
    return { paymentId: prep.payment.id, publicPaymentNumber: prep.payment.publicPaymentNumber,
      providerCode: prep.definition.code, providerTransactionId: result.providerTransactionId,
      redirectUrl: result.redirectUrl, status: result.status };
  }

  /**
   * 接收渠道回调。顺序不可调整：
   * 验签 → 找单（找不到返回 deferred，由对账补）→ 幂等（重复直接返回）→ 金额 → 状态机 → 事件。
   *
   * 返回的 kind 让控制器决定 HTTP 码：accepted/duplicate/deferred 都是 200，
   * 只有验签失败才 400——渠道重试风暴比丢一条回调更难收拾。
   */
  async handleWebhook(providerCode: string, environment: Environment, headers: Record<string, string>,
    rawBody: Buffer, ctx: RequestContext) {
    const deps = this.onlineDeps();
    const config = await this.db.paymentMethodConfig.findUnique({ where: { providerCode_environment:
      { providerCode, environment } } });
    // 未启用或未配置的渠道：不泄露它是否存在。
    if (!config || !config.enabled || !config.secretRef) throw new AuthError(404, 'NOT_FOUND');

    const credentials = await this.adapterCredentials(config.secretRef, environment);
    const adapter = deps.adapterFor(providerCode, environment);
    const adapterCtx = this.adapterContext(providerCode, environment, credentials,
      config.publicConfig as Record<string, string>);
    // 验签失败必须走到这里就断，绝不进入下面的落库逻辑。
    const event = await this.adapterCall(() => adapter.verifyWebhook(adapterCtx, headers, rawBody), 400);

    return this.guarded(() => this.db.$transaction(async tx => {
      const payment = event.paymentNumber
        ? await tx.payment.findUnique({ where: { publicPaymentNumber: event.paymentNumber }, include: { order: true } })
        : await tx.payment.findFirst({ where: { providerCode, providerTransactionId: event.providerTransactionId },
          include: { order: true } });
      if (!payment) return { kind: 'deferred' as const, paymentStatus: null };

      await this.lock(tx, `payment:${payment.id}`);
      const eventKey = this.adapterRule(() => webhookEventKey(providerCode, event.eventId));
      const settled = await this.settlePayment(tx, payment, {
        status: event.status, amountMinor: event.amountMinor, currency: event.currency,
        dedupeKey: eventKey, occurredAt: event.occurredAt, source: 'provider',
        payload: { providerTransactionId: event.providerTransactionId, adapterStatus: event.status },
      });
      if (settled.kind === 'duplicate') return { kind: 'duplicate' as const, paymentStatus: payment.status };
      return { kind: settled.kind, paymentStatus: settled.paymentStatus };
    }));
  }

  /**
   * 渠道结论落库：金额复核 → 状态机 → 台账 → 事件 → 订单投影。
   *
   * 回调与对账共用这一段，避免两条路径对"成功/冲突"给出不同判断。
   * 幂等靠 dedupeKey：同一个渠道事件、或同一次对账结论，只会落一条事件。
   */
  private async settlePayment(tx: Tx, payment: PaymentWithOrder, input: {
    status: AdapterStatus; amountMinor: number | null; currency: string | null;
    dedupeKey: string; occurredAt: Date; source: 'provider' | 'system'; payload: Record<string, unknown>;
  }): Promise<{ kind: 'accepted' | 'duplicate' | 'conflict'; paymentStatus: PaymentStatus }> {
    const prior = await tx.paymentEvent.findUnique({ where: { dedupeKey: input.dedupeKey } });
    if (prior) return { kind: 'duplicate', paymentStatus: payment.status as PaymentStatus };

    // 只有“钱到账”才强制金额一致；失败/取消回调渠道可能不带金额，不能因此拒收事件。
    // 金额不符不能抛 400：那会让渠道无限重试。记为冲突、不推进状态，留给人工处理。
    let conflict: string | null = null;
    if (input.status === 'succeeded') {
      try {
        this.adapterRule(() => assertWebhookAmount({ amountMinor: input.amountMinor, currency: input.currency,
          expectedAmountMinor: payment.amountMinor, expectedCurrency: payment.currency }));
      } catch {
        conflict = 'WEBHOOK_AMOUNT_MISMATCH';
      }
    }

    const outcome = input.status === 'succeeded' || input.status === 'cancelled' || input.status === 'failed'
      ? input.status as PaymentOutcome : null;
    let nextStatus: PaymentStatus = payment.status as PaymentStatus;
    if (outcome && !conflict) {
      try {
        nextStatus = this.rule(() => nextPaymentStatusFromProvider(payment.status, outcome, 'online'));
      } catch (error) {
        // 已终态又收到前进事件：不改状态，但要把事件留下来，供对账时解释差异。
        if (error instanceof AuthError && error.code === 'PAYMENT_STATE_CONFLICT') conflict = error.code;
        else throw error;
      }
    }

    const advanced = nextStatus !== payment.status;
    const paidAt = nextStatus === 'succeeded' ? input.occurredAt : payment.paidAt;
    if (advanced) {
      await tx.payment.update({ where: { id: payment.id }, data: {
        status: nextStatus, paidAt,
        failureCode: nextStatus === 'failed' ? 'provider_declined' : nextStatus === 'cancelled' ? 'cancelled' : null,
        failureMessage: nextStatus === 'failed' || nextStatus === 'cancelled' ? `provider:${input.status}` : null,
        version: { increment: 1 } } });
      if (payment.order.orderStatus !== 'cancelled') {
        await tx.shopOrder.update({ where: { id: payment.orderId }, data: {
          paymentStatus: orderPaymentStatusFor(nextStatus), version: { increment: 1 } } });
      }
      if (nextStatus === 'succeeded') {
        await redeemCouponInTx(tx, payment.orderId, { id: null, type: 'system' }, input.occurredAt);
      }
    }

    await tx.paymentEvent.create({ data: { paymentId: payment.id, orderId: payment.orderId,
      type: outcome ?? input.status, fromStatus: payment.status, toStatus: nextStatus, source: input.source,
      dedupeKey: input.dedupeKey, occurredAt: input.occurredAt, payload: {
        ...input.payload, amountMinor: input.amountMinor, currency: input.currency,
        ...(conflict ? { conflict } : {}) } as Prisma.InputJsonValue } });

    return { kind: conflict ? 'conflict' : 'accepted', paymentStatus: nextStatus };
  }

  /**
   * 后台“测试连接”：用最小代价验证凭据可用，结果写回 connectionStatus。
   * 失败只影响前台是否展示该方式，不影响已存在的订单。
   */
  async testConnection(supplied: string, csrf: string | null, providerCode: string, environment: string,
    ctx: RequestContext) {
    const deps = this.onlineDeps();
    if (environment !== 'sandbox' && environment !== 'production') throw new AuthError(422, 'VALIDATION_ERROR');
    const env: Environment = environment;
    return this.identity.withPermission(supplied, csrf, 'payment.config', async (tx, actor, _session, now) => {
      const row = await tx.paymentMethodConfig.findUnique({ where: { providerCode_environment:
        { providerCode, environment } } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      if (!row.secretRef) throw new AuthError(422, 'PAYMENT_CREDENTIAL_REQUIRED');

      const credentials = await this.adapterCredentials(row.secretRef, env);
      const adapter = deps.adapterFor(providerCode, env);
      const check = await this.adapterCall(() => adapter.testConnection(this.adapterContext(providerCode, env,
        credentials, row.publicConfig as Record<string, string>)), 502);

      const updated = await tx.paymentMethodConfig.update({ where: { id: row.id }, data: {
        connectionStatus: check.ok ? 'ok' : 'failed', lastCheckedAt: now, version: { increment: 1 } } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'payments.method.connection_check', row.id,
        'success', check.ok ? 'ok' : 'failed');
      return { providerCode, environment, connectionStatus: updated.connectionStatus,
        lastCheckedAt: updated.lastCheckedAt?.toISOString() ?? now.toISOString(),
        detail: check.detail, version: updated.version };
    });
  }

  /**
   * 对账：把长时间停在中间态的支付与退款收敛掉。
   *
   * 为什么必须有它：回调是"渠道愿意告诉你"时才发生。渠道重试耗尽、进程恰好在落库前重启、
   * 网络单向不通，都会让一笔已成功的支付永远停在 pending——钱收了，系统不知道。
   *
   * 三条边界：
   * 1. 只处理超时的，不碰刚创建的：刚发起就查，渠道那边可能还没落库，只会得到噪声。
   * 2. 只推进状态，不制造状态：渠道说 pending/unknown 就保持原状，绝不猜。
   * 3. 单个失败不中断整批：一笔查不通不应该让其他 49 笔也收敛不了。
   */
  async reconcile(options: { olderThanMinutes?: number; limit?: number } = {}): Promise<ReconcileReport> {
    const startedAt = new Date();
    const olderThanMinutes = clampInt(options.olderThanMinutes, 15, 1, 7 * 24 * 60);
    const limit = clampInt(options.limit, 50, 1, 500);
    const cutoff = new Date(startedAt.getTime() - olderThanMinutes * 60_000);

    const payments: SweepCounters = { scanned: 0, converged: 0, unchanged: 0, failed: 0 };
    const refunds: SweepCounters = { scanned: 0, converged: 0, unchanged: 0, failed: 0 };
    const errors: ReconcileError[] = [];

    const stalePayments = await this.db.payment.findMany({ where: { channel: 'online',
      status: { in: ['pending', 'authorized', 'unknown'] }, providerTransactionId: { not: null },
      createdAt: { lt: cutoff } }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true } });

    for (const stale of stalePayments) {
      payments.scanned += 1;
      try {
        const result = await this.queryOnlinePayment(stale.id);
        if (!result || result.status === 'pending' || result.status === 'unknown') { payments.unchanged += 1; continue; }
        const settled = await this.db.$transaction(async tx => {
          await this.lock(tx, `payment:${stale.id}`);
          const current = await tx.payment.findUnique({ where: { id: stale.id }, include: { order: true } });
          if (!current) return null;
          return this.settlePayment(tx, current, { status: result.status, amountMinor: result.amountMinor,
            currency: result.currency, dedupeKey: `reconcile:${stale.id}:${result.status}`, occurredAt: new Date(),
            source: 'system', payload: { reconciled: true, rawStatus: result.rawStatus } });
        });
        if (!settled) { payments.unchanged += 1; continue; }
        if (settled.kind === 'duplicate') payments.unchanged += 1;
        else if (settled.kind === 'conflict') { payments.failed += 1; errors.push({ id: stale.id, kind: 'payment',
          code: 'AMOUNT_OR_STATE_CONFLICT' }); }
        else payments.converged += 1;
      } catch (error) {
        payments.failed += 1;
        errors.push({ id: stale.id, kind: 'payment', code: errorCode(error) });
      }
    }

    const staleRefunds = await this.db.refund.findMany({ where: { channel: 'online',
      status: { in: ['processing', 'unknown'] }, createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' }, take: limit, select: { id: true, status: true } });

    for (const stale of staleRefunds) {
      refunds.scanned += 1;
      try {
        const result = await this.queryOnlineRefund(stale.id);
        // 还没拿到渠道退款单号 = 上次没真正发出去，留给人工重试，不当成失败。
        if (!result || result.status === 'pending') { refunds.unchanged += 1; continue; }
        const next = result.status === 'succeeded' ? 'refunded' : 'failed';
        const settled = await this.settleRefundFromProvider(stale.id, next, result.providerRefundId,
          result.rawStatus);
        if (settled === 'duplicate') refunds.unchanged += 1;
        else refunds.converged += 1;
      } catch (error) {
        refunds.failed += 1;
        errors.push({ id: stale.id, kind: 'refund', code: errorCode(error) });
      }
    }

    return { startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), olderThanMinutes,
      payments, refunds, errors };
  }

  /** 按台账查渠道当前结论；没有渠道单号（还没发起过）返回 null。 */
  async queryOnlinePayment(paymentId: string): Promise<{ status: AdapterStatus; amountMinor: number | null;
    currency: string | null; rawStatus: string } | null> {
    const row = await this.db.payment.findUnique({ where: { id: paymentId }, include: { methodConfig: true } });
    if (!row || !row.providerTransactionId) return null;
    const config = row.methodConfig;
    if (!config || !config.secretRef) throw new AuthError(422, 'PAYMENT_CREDENTIAL_REQUIRED');
    const environment: Environment = row.environment === 'sandbox' ? 'sandbox' : 'production';
    const credentials = await this.adapterCredentials(config.secretRef, environment);
    const adapter = this.onlineDeps().adapterFor(row.providerCode, environment);
    const result = await this.adapterCall(() => adapter.queryPayment(this.adapterContext(row.providerCode,
      environment, credentials, config.publicConfig as Record<string, string>),
      row.providerTransactionId as string), 502);
    return { status: result.status, amountMinor: result.amountMinor, currency: result.currency,
      rawStatus: result.rawStatus };
  }

  /**
   * 用渠道结论收敛一笔退款。只处理 processing / unknown：
   * 已经 refunded 的再收到"成功"不重复记账，直接当重放。
   */
  private async settleRefundFromProvider(refundId: string, next: 'refunded' | 'failed',
    providerRefundId: string, rawStatus: string): Promise<'settled' | 'duplicate'> {
    return this.db.$transaction(async tx => {
      await this.lock(tx, `refund:${refundId}`);
      const row = await tx.refund.findUnique({ where: { id: refundId } });
      if (!row) return 'duplicate';
      if (row.status === next) return 'duplicate';
      if (row.status !== 'processing' && row.status !== 'unknown') return 'duplicate';
      const dedupeKey = `reconcile:refund:${refundId}:${next}`;
      const prior = await tx.refundEvent.findUnique({ where: { dedupeKey } });
      if (prior) return 'duplicate';

      await tx.refund.update({ where: { id: refundId }, data: { status: next,
        executedAt: next === 'refunded' ? new Date() : row.executedAt,
        // 数据库要求"退款成功必须有执行人"。对账没人点按钮，记在批准人身上——
        // 他是这笔退款的授权者，比伪造一个系统账号更容易追溯。
        executedBy: next === 'refunded' ? row.executedBy ?? row.approvedBy ?? row.requestedBy : row.executedBy,
        externalRefundId: row.externalRefundId ?? providerRefundId,
        failureCode: next === 'failed' ? 'provider_declined' : null,
        failureMessage: next === 'failed' ? `provider:${rawStatus}` : null, version: { increment: 1 } } });
      await tx.refundEvent.create({ data: { refundId, type: next, fromStatus: row.status, toStatus: next,
        source: 'provider', dedupeKey, payload: { reconciled: true, providerRefundId, rawStatus },
        occurredAt: new Date() } });
      return 'settled';
    });
  }

  /**
   * 供售后调用：把一笔退款交给渠道执行。**不写库**——事务边界由调用方控制。
   *
   * 调用方必须先落 `processing` 再调这里。否则渠道成功而进程崩溃时，
   * 系统里没有任何痕迹能证明"这笔钱可能已经退出去了"，对账也无从下手。
   */
  async executeOnlineRefund(refundId: string): Promise<ProviderRefundOutcome> {
    const row = await this.refundWithChannel(refundId);
    const channel = await this.refundChannel(row);
    const input = this.adapterRule(() => assertRefundInput({
      refundNumber: row.publicRefundNumber,
      providerTransactionId: channel.providerTransactionId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      reason: row.reason,
    }));
    const result = await this.adapterCall(() => channel.adapter.refund(channel.context, input), 502);
    return { providerRefundId: result.providerRefundId, status: result.status, rawStatus: result.rawStatus };
  }

  /** 按渠道退款单号回查，供对账收敛 `processing` / `unknown`；没发出去过的退款返回 null。 */
  async queryOnlineRefund(refundId: string): Promise<ProviderRefundOutcome | null> {
    const row = await this.refundWithChannel(refundId);
    if (!row.externalRefundId) return null;
    const channel = await this.refundChannel(row);
    const result = await this.adapterCall(() => channel.adapter.queryRefund(channel.context,
      row.externalRefundId as string), 502);
    return { providerRefundId: result.providerRefundId, status: result.status, rawStatus: result.rawStatus };
  }

  private async refundWithChannel(refundId: string) {
    const row = await this.db.refund.findUnique({ where: { id: refundId },
      include: { payment: { include: { methodConfig: true } } } });
    if (!row) throw new AuthError(404, 'NOT_FOUND');
    if (row.channel !== 'online') throw new AuthError(422, 'PAYMENT_METHOD_NOT_ONLINE');
    return row;
  }

  private async refundChannel(row: { payment: { providerTransactionId: string | null;
    methodConfig: { providerCode: string; environment: string; secretRef: string | null;
      publicConfig: unknown } | null } }) {
    const config = row.payment.methodConfig;
    if (!row.payment.providerTransactionId) throw new AuthError(409, 'PAYMENT_TRANSACTION_MISSING');
    if (!config || !config.secretRef) throw new AuthError(422, 'PAYMENT_CREDENTIAL_REQUIRED');
    const environment: Environment = config.environment === 'sandbox' ? 'sandbox' : 'production';
    const credentials = await this.adapterCredentials(config.secretRef, environment);
    const adapter = this.onlineDeps().adapterFor(config.providerCode, environment);
    return { adapter, providerTransactionId: row.payment.providerTransactionId,
      context: this.adapterContext(config.providerCode, environment, credentials,
        config.publicConfig as Record<string, string>) };
  }
}
