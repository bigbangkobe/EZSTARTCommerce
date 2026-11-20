import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  AfterSalesRuleError, allocateLineAmount, approvedAmount, assertCancelCaseOrder, assertCaseAction,
  assertCaseRefundable, assertInspectionQuantity, assertRefundablePayment, assertRefundWithinBalance,
  caseNumber, normalizeCaseLines, normalizeReason, normalizeReasonCode, nextRefundStatus, optionalText,
  parseTimestamp, refundableBalance, refundNumber, restocksStock, statusAfterAction, MOVEMENT_TYPE,
  type CaseAction, type CaseLine, type Disposition, type RefundAction,
} from '../../../../packages/domain/src/aftersales.js';
import { maskContact, type ContactSnapshot } from '../../../../packages/domain/src/orders.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import type { PaymentsService, ProviderRefundOutcome } from '../payments/service.js';
import { releaseOrderReservations } from '../orders/reservations.js';
import { releaseCouponInTx, restoreCouponQuotaInTx } from '../promotions/redeem.js';
import { restoreOrderPointsInTx } from '../members/loyalty-service.js';

type Tx = Prisma.TransactionClient;

const includeCase = {
  order: true,
  items: { include: { orderItem: true }, orderBy: { id: 'asc' } },
  refunds: { orderBy: { createdAt: 'asc' } },
  returns: { orderBy: { createdAt: 'asc' } },
  receipts: { include: { items: true }, orderBy: { createdAt: 'asc' } },
  inspections: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: { createdAt: 'asc' } },
} as const;
type CaseRow = Prisma.AfterSalesCaseGetPayload<{ include: typeof includeCase }>;
type RefundBase = Prisma.RefundGetPayload<{ include: { payment: true; order: true } }>;
type RefundRow = RefundBase & { events: Prisma.RefundEventGetPayload<{}>[] };

/** 状态冲突 409，输入问题 422：与订单/付款模块保持同一套映射。 */
const CONFLICT_CODES = new Set(['CASE_STATE_CONFLICT', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'CASE_QUANTITY_EXCEEDED', 'REFUND_STATE_CONFLICT', 'REFUND_EXCEEDS_BALANCE', 'REFUND_STATUS_UNKNOWN_REQUIRES_PROVIDER',
  'PAYMENT_ALREADY_RETURNED', 'ORDER_ALREADY_CANCELLED', 'ORDER_ALREADY_SHIPPED', 'PAID_ORDER_REQUIRES_REFUND',
  'CASE_NOT_APPROVED', 'INSPECTION_QUANTITY_EXCEEDED', 'REFUND_IN_PROGRESS', 'STATE_CONFLICT']);

export interface CreateCaseBody { orderId?: unknown; caseType?: unknown; items?: unknown; reasonCode?: unknown;
  reason?: unknown; requestedRefundMinor?: unknown; ownerId?: unknown }
export interface CreateRefundBody { orderId?: unknown; paymentId?: unknown; caseId?: unknown; amountMinor?: unknown;
  currency?: unknown; reasonCode?: unknown; reason?: unknown }
export interface CaseFilters { status?: string | null; caseType?: string | null; orderId?: string | null; q?: string | null }
export interface RefundFilters { status?: string | null; orderId?: string | null; caseId?: string | null; paymentId?: string | null }

const CASE_STATUSES = ['submitted', 'under_review', 'approved', 'rejected', 'needs_information', 'return_in_transit',
  'received_inspection', 'refund_pending', 'refunded', 'replacement_sent', 'completed', 'closed'] as const;
const REFUND_STATUSES = ['requested', 'approved', 'processing', 'refunded', 'failed', 'rejected', 'cancelled',
  'unknown'] as const;

/**
 * 售后、退货质检与退款（M16 第一批）。
 *
 * 四条不变量：
 * 1. 案件不改写订单/付款快照，只记录申请、批准、收货、质检与处置。
 * 2. 退款上限 = 实收 - 已退 - 在途；COD 未收款、已退回的流水一律拒绝。
 * 3. 审批与执行必须由不同权限完成，且批准人不能是申请人（自己批自己退没有意义）。
 * 4. 只有质检为 `sellable` 的数量才加回可售库存，其余处置只留流水。
 */
export class AfterSalesService {
  constructor(private readonly identity: IdentityService,
    private readonly payments: PaymentsService | null = null) {}
  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof AfterSalesRuleError) throw new AuthError(CONFLICT_CODES.has(error.code) ? 409 : 422, error.code);
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

  private key(value: string | undefined) {
    if (typeof value !== 'string' || value.length < 16 || value.length > 128) throw new AuthError(422, 'VALIDATION_ERROR');
    return value;
  }

  private digest(action: string, objectId: string, body: unknown) {
    return createHash('sha256').update(`${action}\n${objectId}\n${JSON.stringify(body)}`).digest('hex');
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

  private suffix() { return randomBytes(4).toString('hex').toUpperCase().slice(0, 6); }

  // ---- 视图 -------------------------------------------------------------------

  private refundView(row: RefundBase, events: Prisma.RefundEventGetPayload<{}>[] | null) {
    return { id: row.id, publicRefundNumber: row.publicRefundNumber, orderId: row.orderId,
      publicOrderNumber: row.order.publicOrderNumber, paymentId: row.paymentId,
      publicPaymentNumber: row.payment.publicPaymentNumber, caseId: row.caseId ?? null,
      channel: row.channel, providerCode: row.providerCode, environment: row.environment,
      amountMinor: row.amountMinor, currency: row.currency, status: row.status,
      reasonCode: row.reasonCode ?? null, reason: row.reason, requestedBy: row.requestedBy,
      approvedBy: row.approvedBy ?? null, executedBy: row.executedBy ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null, executedAt: row.executedAt?.toISOString() ?? null,
      reference: row.reference ?? null, externalRefundId: row.externalRefundId ?? null,
      failureCode: row.failureCode ?? null, failureMessage: row.failureMessage ?? null,
      version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      ...(events ? { events: events.map(event => ({ id: event.id, type: event.type,
        fromStatus: event.fromStatus ?? null, toStatus: event.toStatus, source: event.source,
        actorId: event.actorId ?? null, occurredAt: event.occurredAt.toISOString() })) } : {}) };
  }

  /** 可退余额：实收 - 已退 - 在途；指定流水时只看那一笔。 */
  private async balances(tx: Tx, orderId: string, paymentId?: string) {
    const scope = { orderId, ...(paymentId ? { paymentId } : {}) };
    const [collected, refunded, pending] = await Promise.all([
      paymentId
        ? tx.payment.findUnique({ where: { id: paymentId } }).then(row => row
          && (row.status === 'collected' || row.status === 'succeeded') ? row.amountMinor : 0)
        : tx.payment.aggregate({ where: { orderId, status: { in: ['collected', 'succeeded'] } },
          _sum: { amountMinor: true } }).then(total => total._sum.amountMinor ?? 0),
      tx.refund.aggregate({ where: { ...scope, status: 'refunded' }, _sum: { amountMinor: true } })
        .then(total => total._sum.amountMinor ?? 0),
      tx.refund.aggregate({ where: { ...scope, status: { in: ['requested', 'approved', 'processing', 'unknown'] } },
        _sum: { amountMinor: true } }).then(total => total._sum.amountMinor ?? 0),
    ]);
    return { collectedMinor: collected, refundedMinor: refunded, pendingMinor: pending,
      availableMinor: refundableBalance({ collectedMinor: collected, refundedMinor: refunded, pendingMinor: pending }) };
  }

  private async caseView(tx: Tx, row: CaseRow, pii: boolean) {
    const contact = row.order.contact as unknown as ContactSnapshot;
    const balance = await this.balances(tx, row.orderId);
    const received = new Map<string, number>();
    for (const receipt of row.receipts) for (const item of receipt.items) {
      received.set(item.orderItemId, (received.get(item.orderItemId) ?? 0) + item.quantity);
    }
    const inspected = new Map<string, number>();
    for (const record of row.inspections) {
      inspected.set(record.orderItemId, (inspected.get(record.orderItemId) ?? 0) + record.quantity);
    }
    return {
      id: row.id, publicCaseNumber: row.publicCaseNumber, orderId: row.orderId,
      publicOrderNumber: row.order.publicOrderNumber, caseType: row.caseType, status: row.status,
      reasonCode: row.reasonCode ?? null, reason: row.reason, source: row.source,
      requestedRefundMinor: row.requestedRefundMinor ?? null, approvedRefundMinor: row.approvedRefundMinor ?? null,
      refundedMinor: balance.refundedMinor, pendingRefundMinor: balance.pendingMinor,
      refundableMinor: balance.availableMinor, currency: row.order.currency,
      orderStatus: row.order.orderStatus, paymentStatus: row.order.paymentStatus,
      orderTotalMinor: row.order.totalMinor, contactMasked: maskContact(contact).email ?? maskContact(contact).phone,
      ownerId: row.ownerId ?? null, approvedAt: row.approvedAt?.toISOString() ?? null,
      approvedBy: row.approvedBy ?? null, rejectedAt: row.rejectedAt?.toISOString() ?? null,
      rejectReason: row.rejectReason ?? null, closedAt: row.closedAt?.toISOString() ?? null,
      version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      items: [...row.items].map(item => ({ orderItemId: item.orderItemId, sku: item.orderItem.sku,
        productName: item.orderItem.productName, variantName: item.orderItem.variantName ?? null,
        orderedQuantity: item.orderItem.quantity, requestedQuantity: item.requestedQuantity,
        approvedQuantity: item.approvedQuantity ?? null, amountMinor: item.amountMinor ?? null,
        disposed: item.disposition ?? null, receivedQuantity: received.get(item.orderItemId) ?? 0,
        inspectedQuantity: inspected.get(item.orderItemId) ?? 0 })),
      refunds: [...row.refunds].map(refund => ({ id: refund.id, publicRefundNumber: refund.publicRefundNumber,
        status: refund.status, amountMinor: refund.amountMinor, currency: refund.currency,
        channel: refund.channel, createdAt: refund.createdAt.toISOString(),
        executedAt: refund.executedAt?.toISOString() ?? null })),
      returns: [...row.returns].map(shipment => ({ id: shipment.id, status: shipment.status,
        carrierCode: shipment.carrierCode ?? null, carrierName: shipment.carrierName ?? null,
        trackingNumber: shipment.trackingNumber ?? null, shippedAt: shipment.shippedAt?.toISOString() ?? null,
        receivedAt: shipment.receivedAt?.toISOString() ?? null, reference: shipment.reference ?? null })),
      receipts: [...row.receipts].map(receipt => ({ id: receipt.id, receivedAt: receipt.receivedAt.toISOString(),
        reference: receipt.reference ?? null,
        items: [...receipt.items].map(item => ({ orderItemId: item.orderItemId, quantity: item.quantity })) })),
      inspections: [...row.inspections].map(record => ({ id: record.id, orderItemId: record.orderItemId,
        quantity: record.quantity, disposition: record.disposition, note: record.note ?? null,
        actorId: record.actorId ?? null, createdAt: record.createdAt.toISOString() })),
      events: [...row.events].map(event => ({ id: event.id, type: event.type, fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus, note: event.note ?? null, actorId: event.actorId ?? null,
        createdAt: event.createdAt.toISOString() })),
      ...(pii ? { contact } : {}),
    };
  }

  private async detail(tx: Tx, id: string): Promise<CaseRow> {
    const row = await tx.afterSalesCase.findUnique({ where: { id }, include: includeCase });
    if (!row) throw new AuthError(404, 'NOT_FOUND');
    return row;
  }

  /** 只依赖 `refund` 委托，事务内与事务外都能用（线上退款需要分两次事务）。 */
  private async refundDetail(tx: { refund: Tx['refund'] }, id: string): Promise<RefundRow> {
    const row = await tx.refund.findUnique({ where: { id },
      include: { events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] }, payment: true, order: true } });
    if (!row) throw new AuthError(404, 'NOT_FOUND');
    return row;
  }

  /** 案件动作的幂等复放：同键同内容返回当前视图，同键不同内容直接冲突。 */
  private async replay(tx: Tx, key: string, action: string, orderId: string, digest: string) {
    const existing = await tx.orderAction.findUnique({ where: { idempotencyKey: key } });
    if (!existing) return null;
    if (existing.orderId !== orderId || existing.action !== action || existing.requestDigest !== digest) {
      throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
    }
    return existing;
  }

  private async recordEvent(tx: Tx, caseId: string, type: string, fromStatus: string | null, toStatus: string,
    note: string | null, actorId: string | null, dedupeKey: string) {
    return tx.afterSalesEvent.create({ data: { caseId, type, fromStatus, toStatus, note, actorId, dedupeKey } });
  }

  // ---- 案件读取 ---------------------------------------------------------------

  async list(supplied: string, limit: number, cursor: string | null, filters: CaseFilters) {
    const status = filters.status ?? null;
    if (status !== null && !(CASE_STATUSES as readonly string[]).includes(status)) throw new AuthError(422, 'VALIDATION_ERROR');
    const caseType = filters.caseType ?? null;
    if (caseType !== null && !['cancel', 'refund', 'return', 'exchange'].includes(caseType)) {
      throw new AuthError(422, 'VALIDATION_ERROR');
    }
    const orderId = filters.orderId ?? null;
    if (orderId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      throw new AuthError(422, 'VALIDATION_ERROR');
    }
    const q = filters.q ?? null;
    return this.identity.withPermission(supplied, null, 'aftersales.read', async (tx, actor) => {
      if (cursor && !await tx.afterSalesCase.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.afterSalesCase.findMany({ where: {
        ...(status ? { status } : {}), ...(caseType ? { caseType } : {}), ...(orderId ? { orderId } : {}),
        ...(q ? { OR: [{ publicCaseNumber: { contains: q, mode: 'insensitive' as const } },
          { reason: { contains: q, mode: 'insensitive' as const } },
          { order: { publicOrderNumber: { contains: q, mode: 'insensitive' as const } } }] } : {}) },
        include: includeCase, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const visible = rows.slice(0, limit);
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      const items = [];
      for (const row of visible) items.push(await this.caseView(tx, row, pii));
      return { items, hasMore: rows.length > limit, nextCursor: rows.length > limit ? visible.at(-1)!.id : null };
    });
  }

  async get(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'aftersales.read', async (tx, actor) =>
      this.caseView(tx, await this.detail(tx, id), this.identity.hasPermission(actor, 'customers.read_pii')));
  }

  // ---- 建立案件 ---------------------------------------------------------------

  /**
   * 从订单建立案件。可选数量由服务端算：订购量减去该订单其它案件的申请量，
   * 客户端说多少不算数；金额分摊按订单行快照等比折算，不改订单。
   */
  async create(supplied: string, csrf: string | null, idempotencyKey: string | undefined, body: CreateCaseBody,
    ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      throw new AuthError(422, 'VALIDATION_ERROR');
    }
    const caseType = body.caseType;
    if (caseType !== 'cancel' && caseType !== 'refund' && caseType !== 'return' && caseType !== 'exchange') {
      throw new AuthError(422, 'VALIDATION_ERROR');
    }
    const reason = this.rule(() => normalizeReason(body.reason));
    const reasonCode = this.rule(() => normalizeReasonCode(body.reasonCode));
    let requestedRefundMinor: number | null = null;
    if (body.requestedRefundMinor !== undefined && body.requestedRefundMinor !== null) {
      if (!Number.isSafeInteger(body.requestedRefundMinor) || (body.requestedRefundMinor as number) < 0) {
        throw new AuthError(422, 'VALIDATION_ERROR');
      }
      requestedRefundMinor = body.requestedRefundMinor as number;
    }
    if ((caseType === 'cancel' || caseType === 'exchange') && requestedRefundMinor !== null && requestedRefundMinor > 0) {
      // 取消与换货不产生退款；想退钱必须建退款/退货案件。
      throw new AuthError(422, 'CASE_NOT_REFUNDABLE');
    }
    const ownerId = typeof body.ownerId === 'string' ? body.ownerId : null;
    if (ownerId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
      throw new AuthError(422, 'VALIDATION_ERROR');
    }
    const digest = this.digest('aftersales.create', orderId, { caseType, reason, reasonCode, requestedRefundMinor,
      items: body.items, ownerId });
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'aftersales.manage', async (tx, actor, _s, now) => {
      await this.lock(tx, `order:${orderId}`);
      await this.lock(tx, `order-action:${key}`);
      const replay = await this.replay(tx, key, 'aftersales.create', orderId, digest);
      if (replay?.objectId) return this.caseView(tx, await this.detail(tx, replay.objectId),
        this.identity.hasPermission(actor, 'customers.read_pii'));
      const order = await tx.shopOrder.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order) throw new AuthError(404, 'NOT_FOUND');
      if (caseType === 'cancel') this.rule(() => assertCancelCaseOrder(order));

      const prior = await tx.afterSalesCase.findMany({ where: { orderId }, include: { items: true } });
      const requested = new Map<string, number>();
      for (const existing of prior) for (const item of existing.items) {
        if (existing.status === 'rejected' || existing.status === 'closed') continue;
        requested.set(item.orderItemId, (requested.get(item.orderItemId) ?? 0) + item.requestedQuantity);
      }
      const lines = this.rule(() => normalizeCaseLines(order.items.map(item => ({ id: item.id, quantity: item.quantity })),
        requested, body.items));
      const settings = await this.settings(tx);
      let created: CaseRow | null = null;
      for (let attempt = 0; created === null; attempt += 1) {
        try {
          created = await tx.afterSalesCase.create({ data: {
            publicCaseNumber: caseNumber(this.day(settings.timezone, now), this.suffix()), orderId,
            caseType, status: 'submitted', reasonCode, reason, source: 'admin', requestedRefundMinor,
            ownerId, items: { create: lines.map(line => ({ orderItemId: line.orderItemId,
              requestedQuantity: line.quantity })) } }, include: includeCase });
        } catch (error) {
          if ((error as { code?: string }).code === 'P2002' && attempt < 2) continue;
          throw error;
        }
      }
      await this.recordEvent(tx, created.id, 'created', null, 'submitted', reason, actor.id, `case:${created.id}:created`);
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId, action: 'aftersales.create',
        requestDigest: digest, objectId: created.id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'aftersales.case.created', created.id);
      return this.caseView(tx, created, this.identity.hasPermission(actor, 'customers.read_pii'));
    }, true));
  }

  // ---- 审批与关闭 -------------------------------------------------------------

  /**
   * 批准案件。取消类会真正取消订单并释放预留（未发货、未收款才允许）；
   * 其余类型只锁定批准数量与应退金额，钱还没有出去。
   */
  async approve(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    expectedVersion: number, body: { reason?: unknown; reasonCode?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const reason = this.rule(() => normalizeReason(body.reason));
    const reasonCode = this.rule(() => normalizeReasonCode(body.reasonCode));
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'aftersales.approve', async (tx, actor, _s, now) => {
      const current = await this.detail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `case:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const digest = this.digest('aftersales.approve', id, { expectedVersion, reason, reasonCode });
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      if (await this.replay(tx, key, 'aftersales.approve', current.orderId, digest)) {
        return this.caseView(tx, await this.detail(tx, id), pii);
      }
      const row = await this.detail(tx, id);
      if (expectedVersion !== row.version) throw new AuthError(409, 'VERSION_CONFLICT');
      this.rule(() => assertCaseAction(row.status, 'approve'));
      const order = await tx.shopOrder.findUnique({ where: { id: row.orderId } });
      if (!order) throw new AuthError(404, 'NOT_FOUND');

      let approvedRefundMinor: number | null = null;
      let nextStatus = statusAfterAction('approve');
      let closedAt: Date | null = null;
      if (row.caseType === 'cancel') {
        this.rule(() => assertCancelCaseOrder(order));
        await releaseOrderReservations(tx, order.id);
        await releaseCouponInTx(tx, order.id, 'aftersales_cancel', { id: actor.id, type: 'admin' }, now);
        await restoreOrderPointsInTx(tx, order.id, now, 'aftersales_cancel');
        await tx.shopOrder.update({ where: { id: order.id }, data: { orderStatus: 'cancelled', cancelledAt: now,
          cancelReasonCode: reasonCode ?? 'aftersales_cancel', cancelReason: reason, customerNotified: false,
          version: { increment: 1 } } });
        await tx.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: order.orderStatus,
          toStatus: 'cancelled', reason: reasonCode ?? 'aftersales_cancel', actorType: 'admin' } });
        // 取消类没有后续履约：批准即结案，避免后台挂着一堆“已批准但无事可做”的案件。
        nextStatus = 'completed';
        closedAt = now;
      } else if (row.caseType !== 'exchange') {
        let allocated = 0;
        for (const item of row.items) {
          allocated += this.rule(() => allocateLineAmount(item.orderItem.lineTotalMinor, item.orderItem.quantity,
            item.requestedQuantity));
        }
        approvedRefundMinor = this.rule(() => approvedAmount({ caseType: row.caseType, orderTotalMinor: order.totalMinor,
          requestedMinor: row.requestedRefundMinor ?? null, allocatedMinor: allocated,
          currency: order.currency, orderCurrency: order.currency }));
        for (const item of row.items) {
          await tx.afterSalesItem.update({ where: { id: item.id }, data: {
            approvedQuantity: item.requestedQuantity,
            amountMinor: this.rule(() => allocateLineAmount(item.orderItem.lineTotalMinor,
              item.orderItem.quantity, item.requestedQuantity)) } });
        }
      } else {
        for (const item of row.items) {
          await tx.afterSalesItem.update({ where: { id: item.id }, data: { approvedQuantity: item.requestedQuantity } });
        }
        nextStatus = 'replacement_sent';
      }

      await tx.afterSalesCase.update({ where: { id }, data: { status: nextStatus,
        approvedAt: now, approvedBy: actor.id, approvedRefundMinor,
        ...(closedAt ? { closedAt } : {}), version: { increment: 1 } } });
      await this.recordEvent(tx, id, 'approved', row.status, nextStatus, reason, actor.id, `case:${id}:approved`);
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'aftersales.approve',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'aftersales.case.approved', id,
        'success', approvedRefundMinor === null ? reason : `${reason}; approved ${approvedRefundMinor}`);
      return this.caseView(tx, await this.detail(tx, id), pii);
    }, true));
  }

  async reject(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    body: { reason?: unknown; reasonCode?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const reason = this.rule(() => normalizeReason(body.reason));
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'aftersales.approve', async (tx, actor, _s, now) => {
      const current = await this.detail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `case:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const digest = this.digest('aftersales.reject', id, { reason });
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      if (await this.replay(tx, key, 'aftersales.reject', current.orderId, digest)) {
        return this.caseView(tx, await this.detail(tx, id), pii);
      }
      const row = await this.detail(tx, id);
      this.rule(() => assertCaseAction(row.status, 'reject'));
      await tx.afterSalesCase.update({ where: { id }, data: { status: 'rejected', rejectedAt: now,
        rejectedBy: actor.id, rejectReason: reason, version: { increment: 1 } } });
      await this.recordEvent(tx, id, 'rejected', row.status, 'rejected', reason, actor.id, `case:${id}:rejected`);
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'aftersales.reject',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'aftersales.case.rejected', id, 'success', reason);
      return this.caseView(tx, await this.detail(tx, id), pii);
    }, true));
  }

  /** 登记退货物流：只对退货/换货案件有效，且必须先批准。 */
  async registerReturn(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    body: { carrierCode?: unknown; carrierName?: unknown; trackingNumber?: unknown; shippedAt?: unknown;
      reference?: unknown; note?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const carrierCode = this.rule(() => optionalText(body.carrierCode, 80));
    const carrierName = this.rule(() => optionalText(body.carrierName, 120));
    const trackingNumber = this.rule(() => optionalText(body.trackingNumber, 160));
    const reference = this.rule(() => optionalText(body.reference, 200));
    const note = this.rule(() => optionalText(body.note, 1_000));
    if (!trackingNumber) throw new AuthError(422, 'VALIDATION_ERROR');
    const shippedAt = body.shippedAt === undefined ? new Date() : this.rule(() => parseTimestamp(body.shippedAt));
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'aftersales.inspect', async (tx, actor) => {
      const current = await this.detail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `case:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const digest = this.digest('aftersales.return', id, { carrierCode, carrierName, trackingNumber,
        shippedAt: shippedAt.toISOString(), reference, note });
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      if (await this.replay(tx, key, 'aftersales.return', current.orderId, digest)) {
        return this.caseView(tx, await this.detail(tx, id), pii);
      }
      const row = await this.detail(tx, id);
      if (row.caseType !== 'return' && row.caseType !== 'exchange') throw new AuthError(422, 'CASE_NOT_RETURNABLE');
      this.rule(() => assertCaseAction(row.status, 'dispatch_return'));
      const shipment = await tx.returnShipment.create({ data: { caseId: id, carrierCode, carrierName,
        trackingNumber, status: 'in_transit', shippedAt, reference, note } });
      await tx.afterSalesCase.update({ where: { id }, data: { status: 'return_in_transit', version: { increment: 1 } } });
      await this.recordEvent(tx, id, 'return_registered', row.status, 'return_in_transit',
        trackingNumber, actor.id, `case:${id}:return:${shipment.id}`);
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'aftersales.return',
        requestDigest: digest, objectId: shipment.id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'aftersales.return.registered', id);
      return this.caseView(tx, await this.detail(tx, id), pii);
    }, true));
  }

  /** 收货：只登记“收到了多少”，不动库存；库存处置在质检时才发生。 */
  async receiveReturn(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    body: { receivedAt?: unknown; reference?: unknown; shipmentId?: unknown; items?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const receivedAt = body.receivedAt === undefined ? new Date() : this.rule(() => parseTimestamp(body.receivedAt));
    const reference = this.rule(() => optionalText(body.reference, 200));
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'aftersales.inspect', async (tx, actor) => {
      const current = await this.detail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `case:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const digest = this.digest('aftersales.receive', id, { receivedAt: receivedAt.toISOString(), reference,
        shipmentId: body.shipmentId ?? null, items: body.items });
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      if (await this.replay(tx, key, 'aftersales.receive', current.orderId, digest)) {
        return this.caseView(tx, await this.detail(tx, id), pii);
      }
      const row = await this.detail(tx, id);
      this.rule(() => assertCaseAction(row.status, 'receive_return'));
      const received = new Map<string, number>();
      for (const receipt of row.receipts) for (const item of receipt.items) {
        received.set(item.orderItemId, (received.get(item.orderItemId) ?? 0) + item.quantity);
      }
      const lines: CaseLine[] = this.rule(() => normalizeCaseLines(
        row.items.map(item => ({ id: item.orderItemId, quantity: item.requestedQuantity })), received, body.items));

      let shipmentId: string | null = null;
      if (body.shipmentId !== undefined && body.shipmentId !== null) {
        if (typeof body.shipmentId !== 'string') throw new AuthError(422, 'VALIDATION_ERROR');
        const shipment = await tx.returnShipment.findUnique({ where: { id: body.shipmentId } });
        if (!shipment || shipment.caseId !== id) throw new AuthError(404, 'NOT_FOUND');
        shipmentId = shipment.id;
      } else {
        const open = await tx.returnShipment.findFirst({ where: { caseId: id, status: 'in_transit' },
          orderBy: { createdAt: 'desc' } });
        shipmentId = open?.id ?? null;
      }
      if (shipmentId) {
        await tx.returnShipment.update({ where: { id: shipmentId }, data: { status: 'received', receivedAt,
          version: { increment: 1 } } });
      }
      const receipt = await tx.returnReceipt.create({ data: { caseId: id, shipmentId, receivedAt, reference,
        actorId: actor.id, items: { create: lines } }, include: { items: true } });
      await tx.afterSalesCase.update({ where: { id }, data: { status: 'received_inspection', version: { increment: 1 } } });
      await this.recordEvent(tx, id, 'received', row.status, 'received_inspection', reference, actor.id,
        `case:${id}:receipt:${receipt.id}`);
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'aftersales.receive',
        requestDigest: digest, objectId: receipt.id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'aftersales.return.received', id);
      return this.caseView(tx, await this.detail(tx, id), pii);
    }, true));
  }

  /**
   * 质检与库存处置。只有 `sellable` 加回 onHand，且数量上限为“已收 - 已检”，
   * 同一批货不可能被质检两次而把库存加两遍。
   */
  async inspect(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    body: { reason?: unknown; items?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const reason = this.rule(() => normalizeReason(body.reason));
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) {
      throw new AuthError(422, 'VALIDATION_ERROR');
    }
    const requested = body.items.map(raw => {
      const item = raw as { orderItemId?: unknown; quantity?: unknown; disposition?: unknown; note?: unknown };
      if (!item || typeof item.orderItemId !== 'string') throw new AuthError(422, 'VALIDATION_ERROR');
      if (item.disposition !== 'sellable' && item.disposition !== 'damaged'
        && item.disposition !== 'quarantine' && item.disposition !== 'scrap') throw new AuthError(422, 'VALIDATION_ERROR');
      return { orderItemId: item.orderItemId, quantity: item.quantity as number,
        disposition: item.disposition as Disposition, note: this.rule(() => optionalText(item.note, 1_000)) };
    });
    // 同一订单行允许出现多次：一次质检可以把一行拆成「可卖 1 件 + 报废 1 件」两条记录。
    // 数量上限因此必须按行汇总校验，而不是逐条独立校验（两条 2 件各自合法，合计却超收）。
    const requestedByLine = new Map<string, number>();
    for (const item of requested) {
      requestedByLine.set(item.orderItemId, (requestedByLine.get(item.orderItemId) ?? 0) + item.quantity);
    }
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'aftersales.inspect', async (tx, actor) => {
      const current = await this.detail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `case:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const digest = this.digest('aftersales.inspect', id, { reason, items: requested });
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      if (await this.replay(tx, key, 'aftersales.inspect', current.orderId, digest)) {
        return this.caseView(tx, await this.detail(tx, id), pii);
      }
      const row = await this.detail(tx, id);
      this.rule(() => assertCaseAction(row.status, 'inspect'));
      const received = new Map<string, number>();
      for (const receipt of row.receipts) for (const item of receipt.items) {
        received.set(item.orderItemId, (received.get(item.orderItemId) ?? 0) + item.quantity);
      }
      const inspected = new Map<string, number>();
      for (const record of row.inspections) {
        inspected.set(record.orderItemId, (inspected.get(record.orderItemId) ?? 0) + record.quantity);
      }
      for (const [orderItemId, quantity] of requestedByLine) {
        if (!received.has(orderItemId)) throw new AuthError(422, 'VALIDATION_ERROR');
        this.rule(() => assertInspectionQuantity(received.get(orderItemId) ?? 0,
          inspected.get(orderItemId) ?? 0, quantity));
      }

      for (const item of requested) {
        const line = row.items.find(entry => entry.orderItemId === item.orderItemId);
        if (!line) throw new AuthError(422, 'VALIDATION_ERROR');
        const record = await tx.inspectionRecord.create({ data: { caseId: id,
          receiptId: row.receipts.at(-1)?.id ?? null, orderItemId: item.orderItemId, quantity: item.quantity,
          disposition: item.disposition, note: item.note, actorId: actor.id } });
        await tx.afterSalesItem.update({ where: { id: line.id }, data: { disposition: item.disposition } });
        let stockDelta = 0;
        let onHandAfter: number | null = null;
        if (restocksStock(item.disposition)) {
          const variantId = line.orderItem.variantId;
          if (!variantId) throw new AuthError(409, 'STATE_CONFLICT');
          const inventory = await tx.inventoryItem.upsert({ where: { variantId },
            update: { onHand: { increment: item.quantity } }, create: { variantId, onHand: item.quantity } });
          stockDelta = item.quantity; onHandAfter = inventory.onHand;
        }
        await tx.inventoryMovement.create({ data: { variantId: line.orderItem.variantId ?? failVariant(),
          orderId: row.orderId, caseId: id, type: MOVEMENT_TYPE[item.disposition], quantity: item.quantity,
          stockDelta, onHandAfter, reason, dedupeKey: `inspection:${record.id}`, actorId: actor.id } });
      }
      await tx.afterSalesCase.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.recordEvent(tx, id, 'inspected', row.status, 'received_inspection', reason, actor.id,
        `case:${id}:inspect:${key}`);
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'aftersales.inspect',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'aftersales.return.inspected', id);
      return this.caseView(tx, await this.detail(tx, id), pii);
    }, true));
  }

  /** 关闭案件：还有在途退款时不允许关，否则钱和案卷会同时失联。 */
  async close(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    expectedVersion: number, body: { reason?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const reason = this.rule(() => normalizeReason(body.reason));
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'aftersales.manage', async (tx, actor, _s, now) => {
      const current = await this.detail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `case:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const digest = this.digest('aftersales.close', id, { expectedVersion, reason });
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      if (await this.replay(tx, key, 'aftersales.close', current.orderId, digest)) {
        return this.caseView(tx, await this.detail(tx, id), pii);
      }
      const row = await this.detail(tx, id);
      if (expectedVersion !== row.version) throw new AuthError(409, 'VERSION_CONFLICT');
      // 在途退款先报：它比「状态不允许关案」更具体，调用方直接知道要等钱结算而不是改状态。
      const open = await tx.refund.count({ where: { caseId: id,
        status: { in: ['requested', 'approved', 'processing', 'unknown'] } } });
      if (open > 0) throw new AuthError(409, 'REFUND_IN_PROGRESS');
      this.rule(() => assertCaseAction(row.status, 'close'));
      await tx.afterSalesCase.update({ where: { id }, data: { status: 'completed', closedAt: now,
        version: { increment: 1 } } });
      await this.recordEvent(tx, id, 'closed', row.status, 'completed', reason, actor.id, `case:${id}:closed`);
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'aftersales.close',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'aftersales.case.closed', id);
      return this.caseView(tx, await this.detail(tx, id), pii);
    }, true));
  }

  // ---- 退款 -------------------------------------------------------------------

  async listRefunds(supplied: string, limit: number, cursor: string | null, filters: RefundFilters) {
    const status = filters.status ?? null;
    if (status !== null && !(REFUND_STATUSES as readonly string[]).includes(status)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, null, 'payments.read', async tx => {
      if (cursor && !await tx.refund.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.refund.findMany({ where: {
        ...(status ? { status } : {}), ...(filters.orderId ? { orderId: filters.orderId } : {}),
        ...(filters.caseId ? { caseId: filters.caseId } : {}), ...(filters.paymentId ? { paymentId: filters.paymentId } : {}) },
        include: { events: false, payment: true, order: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const visible = rows.slice(0, limit);
      return { items: visible.map(row => this.refundView(row, null)), hasMore: rows.length > limit,
        nextCursor: rows.length > limit ? visible.at(-1)!.id : null };
    });
  }

  async getRefund(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'payments.read', async tx =>
      this.refundView(await this.refundDetail(tx, id), (await this.refundDetail(tx, id)).events));
  }

  /**
   * 申请退款。金额上限来自实收余额（扣掉已退与在途），不是订单总额；
   * COD 未收款、已退回的流水没有“可退余额”，直接被拒。
   */
  private async requestRefund(tx: Tx, actorId: string, ref: { orderId: string; paymentId: string; caseId: string | null },
    input: { amountMinor: number; currency: string; reason: string; reasonCode: string | null }, key: string,
    digest: string, ctx: RequestContext) {
    const order = await tx.shopOrder.findUnique({ where: { id: ref.orderId } });
    if (!order) throw new AuthError(404, 'NOT_FOUND');
    const payment = await tx.payment.findUnique({ where: { id: ref.paymentId } });
    if (!payment || payment.orderId !== order.id) throw new AuthError(404, 'NOT_FOUND');
    this.rule(() => assertRefundablePayment(payment.status));
    if (payment.currency !== order.currency) throw new AuthError(422, 'REFUND_CURRENCY_MISMATCH');

    const orderBalance = await this.balances(tx, order.id);
    this.rule(() => assertRefundWithinBalance({ availableMinor: orderBalance.availableMinor,
      amountMinor: input.amountMinor, currency: input.currency, orderCurrency: order.currency }));
    const paymentBalance = await this.balances(tx, order.id, payment.id);
    this.rule(() => assertRefundWithinBalance({ availableMinor: paymentBalance.availableMinor,
      amountMinor: input.amountMinor, currency: input.currency, orderCurrency: payment.currency }));

    let caseRow: CaseRow | null = null;
    if (ref.caseId) {
      const current = await this.detail(tx, ref.caseId);
      caseRow = current;
      if (current.orderId !== order.id) throw new AuthError(422, 'VALIDATION_ERROR');
      this.rule(() => assertCaseRefundable(current.caseType, current.status));
      const approved = current.approvedRefundMinor ?? 0;
      const used = current.refunds.reduce((sum, refund) =>
        ['requested', 'approved', 'processing', 'unknown', 'refunded'].includes(refund.status) ? sum + refund.amountMinor : sum, 0);
      if (input.amountMinor > approved - used) throw new AuthError(409, 'REFUND_EXCEEDS_BALANCE');
    }

    const settings = await this.settings(tx);
    let created: RefundRow | null = null;
    for (let attempt = 0; created === null; attempt += 1) {
      try {
        created = await tx.refund.create({ data: { publicRefundNumber: refundNumber(this.day(settings.timezone, new Date()),
          this.suffix()), idempotencyKey: key, requestDigest: digest, orderId: order.id, paymentId: payment.id,
          caseId: ref.caseId, channel: payment.channel, providerCode: payment.providerCode,
          environment: payment.environment, amountMinor: input.amountMinor, currency: order.currency,
          status: 'requested', reasonCode: input.reasonCode, reason: input.reason, requestedBy: actorId },
          include: { events: true, payment: true, order: true } });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002' && attempt < 2) continue;
        throw error;
      }
    }
    await tx.refundEvent.create({ data: { refundId: created.id, type: 'requested', fromStatus: null,
      toStatus: 'requested', source: 'admin', actorId, dedupeKey: `refund:${created.id}:requested`,
      payload: { amountMinor: input.amountMinor, currency: order.currency, reason: input.reason },
      occurredAt: new Date() } });
    if (caseRow) {
      if (caseRow.status !== 'refund_pending') {
        this.rule(() => assertCaseAction(caseRow.status, 'request_refund'));
        await tx.afterSalesCase.update({ where: { id: caseRow.id }, data: { status: 'refund_pending',
          version: { increment: 1 } } });
        await this.recordEvent(tx, caseRow.id, 'refund_requested', caseRow.status, 'refund_pending', input.reason,
          actorId, `case:${caseRow.id}:refund:${created.id}`);
      }
    }
    await this.identity.recordAudit(tx, ctx, actorId, 'refunds.requested', created.id, 'success',
      `${input.amountMinor} ${order.currency}`);
    // 事件在 create 之后才写，create 的 include 拿不到：重读一次，否则响应里的 events 永远是空数组。
    return tx.refund.findUniqueOrThrow({ where: { id: created.id },
      include: { events: true, payment: true, order: true } });
  }

  /** 订单级退款（不挂案件）：用于没有建案件但确实要退钱的场景。 */
  async createRefund(supplied: string, csrf: string | null, idempotencyKey: string | undefined, body: CreateRefundBody,
    ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    const paymentId = typeof body.paymentId === 'string' ? body.paymentId : '';
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(orderId) || !uuid.test(paymentId)) throw new AuthError(422, 'VALIDATION_ERROR');
    if (!Number.isSafeInteger(body.amountMinor) || (body.amountMinor as number) < 1) throw new AuthError(422, 'VALIDATION_ERROR');
    if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) throw new AuthError(422, 'VALIDATION_ERROR');
    const currency = body.currency;
    const amountMinor = body.amountMinor as number;
    const reason = this.rule(() => normalizeReason(body.reason));
    const reasonCode = this.rule(() => normalizeReasonCode(body.reasonCode));
    let caseId: string | null = null;
    if (body.caseId !== undefined && body.caseId !== null) {
      if (typeof body.caseId !== 'string' || !uuid.test(body.caseId)) throw new AuthError(422, 'VALIDATION_ERROR');
      caseId = body.caseId;
    }
    const digest = this.digest('refund.create', orderId, { paymentId, caseId, amountMinor, currency, reason, reasonCode });
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'refunds.create', async (tx, actor) => {
      await this.lock(tx, `order:${orderId}`);
      await this.lock(tx, `refund:${key}`);
      const existing = await tx.refund.findUnique({ where: { idempotencyKey: key },
        include: { events: true, payment: true, order: true } });
      if (existing) {
        if (existing.orderId !== orderId || existing.requestDigest !== digest) {
          throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
        }
        return this.refundView(existing, existing.events);
      }
      const created = await this.requestRefund(tx, actor.id, { orderId, paymentId, caseId },
        { amountMinor, currency, reason, reasonCode }, key, digest, ctx);
      return this.refundView(created, created.events);
    }, true));
  }

  /** 案件内退款：支付流水由服务端从订单里挑（必须是真正收到钱的那条）。 */
  async createCaseRefund(supplied: string, csrf: string | null, caseId: string, idempotencyKey: string | undefined,
    body: { amountMinor?: unknown; currency?: unknown; reason?: unknown; reasonCode?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    if (!Number.isSafeInteger(body.amountMinor) || (body.amountMinor as number) < 1) throw new AuthError(422, 'VALIDATION_ERROR');
    if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) throw new AuthError(422, 'VALIDATION_ERROR');
    const currency = body.currency;
    const amountMinor = body.amountMinor as number;
    const reason = this.rule(() => normalizeReason(body.reason));
    const reasonCode = this.rule(() => normalizeReasonCode(body.reasonCode));
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'refunds.create', async (tx, actor) => {
      const current = await this.detail(tx, caseId);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `refund:${key}`);
      const digest = this.digest('refund.create', current.orderId, { caseId, amountMinor, currency, reason, reasonCode });
      const existing = await tx.refund.findUnique({ where: { idempotencyKey: key },
        include: { events: true, payment: true, order: true } });
      if (existing) {
        if (existing.orderId !== current.orderId || existing.requestDigest !== digest) {
          throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
        }
        return this.refundView(existing, existing.events);
      }
      const payment = await tx.payment.findFirst({ where: { orderId: current.orderId,
        status: { in: ['collected', 'succeeded'] } }, orderBy: { createdAt: 'desc' } });
      if (!payment) throw new AuthError(422, 'NOTHING_TO_REFUND');
      const created = await this.requestRefund(tx, actor.id,
        { orderId: current.orderId, paymentId: payment.id, caseId },
        { amountMinor, currency, reason, reasonCode }, key, digest, ctx);
      return this.refundView(created, created.events);
    }, true));
  }

  /**
   * 批准退款。批准人不能是申请人——同一个人既能申请又能批，审批就没有意义了。
   * 这里只推进状态，钱还没有动；执行是另一个权限。
   */
  async approveRefund(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    body: { reason?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const reason = this.rule(() => normalizeReason(body.reason));
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'refund.approve', async (tx, actor, _s, now) => {
      const current = await this.refundDetail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `refund:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const digest = this.digest('refund.approve', id, { reason });
      if (await this.replay(tx, key, 'refund.approve', current.orderId, digest)) {
        return this.refundView(await this.refundDetail(tx, id), (await this.refundDetail(tx, id)).events);
      }
      const row = await this.refundDetail(tx, id);
      if (row.requestedBy === actor.id) throw new AuthError(403, 'SELF_APPROVAL_FORBIDDEN');
      const next = this.rule(() => nextRefundStatus(row.status, 'approve' as RefundAction));
      await tx.refund.update({ where: { id }, data: { status: next, approvedAt: now,
        approvedBy: actor.id, version: { increment: 1 } } });
      await tx.refundEvent.create({ data: { refundId: id, type: 'approved', fromStatus: row.status,
        toStatus: next, source: 'admin', actorId: actor.id, dedupeKey: `refund:${id}:approved:${key}`,
        payload: { reason }, occurredAt: now } });
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'refund.approve',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'refunds.approved', id, 'success', reason);
      const fresh = await this.refundDetail(tx, id);
      return this.refundView(fresh, fresh.events);
    }, true));
  }

  async rejectRefund(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    body: { reason?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const reason = this.rule(() => normalizeReason(body.reason));
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'refund.approve', async (tx, actor, _s, now) => {
      const current = await this.refundDetail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `refund:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const digest = this.digest('refund.reject', id, { reason });
      if (await this.replay(tx, key, 'refund.reject', current.orderId, digest)) {
        return this.refundView(await this.refundDetail(tx, id), (await this.refundDetail(tx, id)).events);
      }
      const row = await this.refundDetail(tx, id);
      const next = this.rule(() => nextRefundStatus(row.status, 'reject' as RefundAction));
      await tx.refund.update({ where: { id }, data: { status: next, failureCode: 'rejected',
        failureMessage: reason, version: { increment: 1 } } });
      await tx.refundEvent.create({ data: { refundId: id, type: 'rejected', fromStatus: row.status, toStatus: next,
        source: 'admin', actorId: actor.id, dedupeKey: `refund:${id}:rejected:${key}`,
        payload: { reason }, occurredAt: now } });
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'refund.reject',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'refunds.rejected', id, 'success', reason);
      return this.refundView(await this.refundDetail(tx, id), (await this.refundDetail(tx, id)).events);
    }, true));
  }

  /**
   * 执行退款。按渠道分两条路：
   * - 线下（COD、人工转账）：执行等于登记一笔真实发生的线下退款，必须有凭据号与时间。
   * - 线上：先落 processing 再调渠道，拿到结论后收敛；渠道无适配器时明确 503，不假装成功。
   */
  async executeRefund(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    body: { reason?: unknown; reference?: unknown; occurredAt?: unknown }, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const reason = this.rule(() => normalizeReason(body.reason));
    const reference = this.rule(() => optionalText(body.reference, 200));
    const head = await this.db.refund.findUnique({ where: { id }, select: { channel: true } });
    if (!head) throw new AuthError(404, 'NOT_FOUND');
    if (head.channel === 'online') {
      return this.executeOnlineRefund(supplied, csrf, id, key, { reason, reference }, ctx);
    }
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'refund.execute', async (tx, actor, _s, now) => {
      const current = await this.refundDetail(tx, id);
      await this.lock(tx, `order:${current.orderId}`);
      await this.lock(tx, `refund:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const occurredAt = body.occurredAt === undefined ? now : this.rule(() => parseTimestamp(body.occurredAt, now));
      const digest = this.digest('refund.execute', id, { reason, reference, occurredAt: occurredAt.toISOString() });
      if (await this.replay(tx, key, 'refund.execute', current.orderId, digest)) {
        return this.refundView(await this.refundDetail(tx, id), (await this.refundDetail(tx, id)).events);
      }
      const row = await this.refundDetail(tx, id);
      const next = this.rule(() => nextRefundStatus(row.status, 'execute' as RefundAction));
      if (!reference) throw new AuthError(422, 'REFUND_REFERENCE_REQUIRED');
      await tx.refund.update({ where: { id }, data: { status: next, executedAt: occurredAt, executedBy: actor.id,
        reference, externalRefundId: reference, version: { increment: 1 } } });
      await tx.refundEvent.create({ data: { refundId: id, type: 'executed', fromStatus: row.status, toStatus: next,
        source: 'admin', actorId: actor.id, dedupeKey: `refund:${id}:executed:${key}`,
        payload: { amountMinor: row.amountMinor, reference, reason }, occurredAt } });
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.orderId, action: 'refund.execute',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'refunds.executed', id, 'success',
        `${row.amountMinor} ${row.currency}; ${reference}`);
      await this.applyRefundSettlement(tx, row, reference, actor.id, now);
      return this.refundView(await this.refundDetail(tx, id), (await this.refundDetail(tx, id)).events);
    }, true));
  }

  /**
   * 线上退款：两次事务夹一次渠道调用。
   *
   * 为什么不能一个事务做完：渠道调用是外部 IO，可能是秒级甚至超时；把它包进事务会长时间占锁。
   * 更关键的是——渠道成功而本地回滚会造成"钱退了但系统不知道"，比短暂的不一致危险得多。
   * 所以先提交 `processing`，再调渠道，最后按结论收敛；中间的崩溃窗口由对账任务按渠道单号回查。
   */
  private async executeOnlineRefund(supplied: string, csrf: string | null, id: string, key: string,
    input: { reason: string; reference: string | null }, ctx: RequestContext) {
    const payments = this.paymentService();

    const started = await this.guarded(() => this.identity.withPermission(supplied, csrf, 'refund.execute',
      async (tx, actor, _s, now) => {
        const current = await this.refundDetail(tx, id);
        await this.lock(tx, `order:${current.orderId}`);
        await this.lock(tx, `refund:${id}`);
        await this.lock(tx, `order-action:${key}`);
        const digest = this.digest('refund.execute', id, { reason: input.reason, reference: input.reference });
        if (await this.replay(tx, key, 'refund.execute', current.orderId, digest)) return { replay: true as const };
        const next = this.rule(() => nextRefundStatus(current.status, 'start'));
        await tx.refund.update({ where: { id }, data: { status: next, executedBy: actor.id,
          version: { increment: 1 } } });
        await tx.refundEvent.create({ data: { refundId: id, type: 'dispatched', fromStatus: current.status,
          toStatus: next, source: 'admin', actorId: actor.id, dedupeKey: `refund:${id}:dispatched:${key}`,
          payload: { channel: 'online', amountMinor: current.amountMinor,
            providerCode: current.providerCode }, occurredAt: now } });
        await tx.orderAction.create({ data: { idempotencyKey: key, orderId: current.orderId,
          action: 'refund.execute', requestDigest: digest, objectId: id } });
        await this.identity.recordAudit(tx, ctx, actor.id, 'refunds.executed', id, 'success',
          `online dispatched ${current.amountMinor} ${current.currency}`);
        return { replay: false as const };
      }, true));

    if (started.replay) return this.refundSnapshot(id);

    // 渠道调用在事务之外。三类结果必须区分干净：
    // 明确结论（成功/失败）按状态机收敛；明确拒绝（适配器规则错误）落 failed；
    // 网络异常/超时一律 unknown——不能因为"没拿到回包"就判定钱没退出去。
    let result: ProviderRefundOutcome | null = null;
    let rejectedCode: string | null = null;
    let indeterminate = false;
    try {
      result = await payments.executeOnlineRefund(id);
    } catch (error) {
      if (error instanceof AuthError) rejectedCode = error.code;
      else indeterminate = true;
    }

    return this.guarded(() => this.identity.withPermission(supplied, null, 'refund.execute',
      async (tx, actor, _s, now) => {
        const row = await this.refundDetail(tx, id);
        await this.lock(tx, `refund:${id}`);

        let action: RefundAction | null = null;
        if (result?.status === 'succeeded') action = 'execute';
        else if (result?.status === 'failed' || rejectedCode) action = 'fail';
        else if (indeterminate) action = 'mark_unknown';

        if (!action) {
          // 渠道返回 pending：保持 processing，等对账按渠道单号收敛。
          await tx.refund.update({ where: { id }, data: {
            externalRefundId: result?.providerRefundId ?? row.externalRefundId,
            ...(input.reference ? { reference: input.reference } : {}), version: { increment: 1 } } });
          await tx.refundEvent.create({ data: { refundId: id, type: 'provider_pending', fromStatus: row.status,
            toStatus: row.status, source: 'provider', dedupeKey: `refund:${id}:pending:${key}`,
            payload: { providerRefundId: result?.providerRefundId ?? null,
              rawStatus: result?.rawStatus ?? null }, occurredAt: now } });
          return this.refundView(await this.refundDetail(tx, id), (await this.refundDetail(tx, id)).events);
        }

        const next = this.rule(() => nextRefundStatus(row.status, action));
        const executedAt = action === 'execute' ? now : null;
        await tx.refund.update({ where: { id }, data: { status: next, executedAt, executedBy: actor.id,
          externalRefundId: result?.providerRefundId ?? row.externalRefundId,
          reference: input.reference ?? result?.providerRefundId ?? row.reference,
          failureCode: next === 'failed' ? (rejectedCode ?? 'provider_declined') : null,
          failureMessage: next === 'failed' ? (rejectedCode ?? `provider:${result?.rawStatus ?? 'failed'}`) : null,
          version: { increment: 1 } } });
        await tx.refundEvent.create({ data: { refundId: id, type: next, fromStatus: row.status, toStatus: next,
          source: next === 'unknown' ? 'provider' : 'admin', actorId: actor.id,
          dedupeKey: `refund:${id}:${next}:${key}`,
          payload: { providerRefundId: result?.providerRefundId ?? null, rawStatus: result?.rawStatus ?? null,
            reason: input.reason, ...(rejectedCode ? { failureCode: rejectedCode } : {}) }, occurredAt: now } });
        await this.identity.recordAudit(tx, ctx, actor.id, 'refunds.executed', id,
          next === 'failed' ? 'failure' : next === 'unknown' ? 'unknown' : 'success',
          `${next} ${row.amountMinor} ${row.currency}${rejectedCode ? `; ${rejectedCode}` : ''}`);

        if (next === 'refunded') await this.applyRefundSettlement(tx, row, row.reference, actor.id, now);
        return this.refundView(await this.refundDetail(tx, id), (await this.refundDetail(tx, id)).events);
      }));
  }

  /**
   * 退款落定（refunded）后的连带影响，两条退款路径共用。
   * 只在「整单退完」时返券返积分：部分退款返还额度会让用户拿回不该拿的券。
   */
  private async applyRefundSettlement(tx: Tx, row: RefundRow, reference: string | null, actorId: string | null,
    now: Date) {
    const settled = await tx.refund.aggregate({ where: { orderId: row.orderId, status: 'refunded',
      id: { not: row.id } }, _sum: { amountMinor: true } });
    const order = await tx.shopOrder.findUnique({ where: { id: row.orderId } });
    if (order && (settled._sum.amountMinor ?? 0) + row.amountMinor >= order.totalMinor) {
      await restoreCouponQuotaInTx(tx, order.id, row.id, 'full_refund', now);
      await restoreOrderPointsInTx(tx, order.id, now, 'full_refund');
    }

    if (!row.caseId) return;
    const caseRow = await this.detail(tx, row.caseId);
    const refunded = caseRow.refunds.reduce((sum, refund) => sum + (refund.status === 'refunded' ? refund.amountMinor : 0), 0);
    if ((caseRow.approvedRefundMinor ?? 0) > 0 && refunded >= (caseRow.approvedRefundMinor ?? 0)) {
      this.rule(() => assertCaseAction(caseRow.status, 'refund_settled'));
      await tx.afterSalesCase.update({ where: { id: caseRow.id }, data: { status: 'refunded',
        version: { increment: 1 } } });
      await this.recordEvent(tx, caseRow.id, 'refunded', caseRow.status, 'refunded', reference, actorId,
        `case:${caseRow.id}:refunded:${row.id}`);
    }
  }

  private paymentService(): PaymentsService {
    if (!this.payments) throw new AuthError(503, 'PAYMENT_ADAPTER_UNAVAILABLE');
    return this.payments;
  }

  private async refundSnapshot(id: string) {
    const row = await this.refundDetail(this.db, id);
    return this.refundView(row, row.events);
  }
}

/** 走到这里说明订单行没有变体：宁可 409 也不能把库存流水挂到空值上。 */
function failVariant(): never {
  throw new AuthError(409, 'STATE_CONFLICT');
}
