import { createHash } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import { normalizeAddress, type Address } from '../../../../packages/domain/src/checkout.js';
import {
  allocateShipment, assertAddressChangeable, assertAddressChangeConfirmed, assertCancellable,
  assertShipmentCreatable, assertShipmentDeliver, assertShipmentDispatch, assertVersion,
  fulfillmentAfterDispatch, maskContact, normalizeCancel, normalizeConfirmationRef, normalizeNote,
  OrderRuleError, orderStatusAfterDispatch, repriceShipping, type ContactSnapshot, type ShipmentLineRequest,
} from '../../../../packages/domain/src/orders.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import { awardOrderPointsInTx, restoreOrderPointsInTx } from '../members/loyalty-service.js';
import type { ShippingService } from '../shipping/service.js';
import { releaseCouponInTx, expireCouponInTx } from '../promotions/redeem.js';
import { releaseOrderReservations } from './reservations.js';

type Tx = Prisma.TransactionClient;

const includeDetail = {
  items: { orderBy: { id: 'asc' } },
  events: { orderBy: { createdAt: 'asc' } },
  notes: { orderBy: { createdAt: 'asc' } },
  shipments: { include: { items: true, carrierEvents: { orderBy: { occurredAt: 'asc' } } }, orderBy: { createdAt: 'asc' } },
} as const;
type OrderRow = Prisma.ShopOrderGetPayload<{ include: typeof includeDetail }>;
type ShipmentRow = Prisma.ShipmentGetPayload<{ include: { items: true } }>;
type CarrierEventRow = Prisma.CarrierStatusEventGetPayload<{}>;

export interface AddressChangeBody { expectedVersion: number; address: Address; customerConfirmationRef?: string | null }
export interface ShipmentBody { items: ShipmentLineRequest[]; carrierCode?: string | null; carrierName?: string | null;
  trackingNumber?: string | null; note?: string | null }
export interface DispatchBody { dispatchedAt: string; trackingNumber?: string | null; evidenceRef?: string | null }
export interface DeliverBody { deliveredAt: string; evidenceRef?: string | null; note?: string | null }

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** 状态码映射：版本/状态冲突是 409，输入问题是 422。 */
const CONFLICT_CODES = new Set(['VERSION_CONFLICT', 'ORDER_ALREADY_SHIPPED', 'ORDER_ALREADY_CANCELLED',
  'PAID_ORDER_REQUIRES_REFUND', 'SHIPMENT_QUANTITY_EXCEEDED', 'SHIPMENT_ALREADY_DISPATCHED',
  'SHIPMENT_ALREADY_DELIVERED', 'SHIPMENT_NOT_DISPATCHED', 'SHIPMENT_CANCELLED', 'STATE_CONFLICT',
  'IDEMPOTENCY_CONFLICT', 'RESERVATION_EXPIRED']);

/**
 * 订单管理与履约（M07）。
 *
 * 三条不变量：
 * 1. 状态只由显式 action 推进，写入前一律核对版本（expectedVersion / If-Match）。
 * 2. 包裹累计数量不得超过订购量；发货才真正扣减 onHand，取消/过期只释放 reserved。
 * 3. 后台写操作带 Idempotency-Key，重放返回同一结果，不重复扣库存或重复建包裹。
 *
 * 首期没有支付网关，所以 COD 订单的 paymentStatus 始终是 cod_due：签收不等于收款，
 * 收款登记属于 M08，这里不伪造“已收款”。
 */
export class OrdersService {
  constructor(private readonly identity: IdentityService, private readonly shipping: ShippingService) {}
  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof OrderRuleError) throw new AuthError(CONFLICT_CODES.has(error.code) ? 409 : 422, error.code);
      throw error;
    }
  }

  private async lock(tx: Tx, key: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }

  private key(value: string | undefined) {
    if (typeof value !== 'string' || value.length < 16 || value.length > 128) throw new AuthError(422, 'VALIDATION_ERROR');
    return value;
  }

  private digest(action: string, orderId: string, body: unknown) {
    return createHash('sha256').update(`${action}\n${orderId}\n${JSON.stringify(body)}`).digest('hex');
  }

  /** 可选自由文本：trim 后为空按 null 处理，拒绝控制字符与超长。 */
  private optionalText(value: string | null | undefined, max: number) {
    if (value === undefined || value === null) return null;
    const text = value.trim();
    if (!text.length) return null;
    if (text.length > max || CONTROL.test(text)) throw new AuthError(422, 'VALIDATION_ERROR');
    return text;
  }

  private timestamp(value: string) {
    if (typeof value !== 'string' || value.length > 40) throw new AuthError(422, 'VALIDATION_ERROR');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new AuthError(422, 'VALIDATION_ERROR');
    // 履约时间不能写进未来：签收时间造假会让报表失真。
    if (date.getTime() > Date.now() + 60_000) throw new AuthError(422, 'VALIDATION_ERROR');
    return date;
  }

  private shippedQuantities(row: OrderRow, statuses: readonly string[]) {
    const counts = new Map<string, number>();
    for (const shipment of row.shipments) {
      if (!statuses.includes(shipment.status)) continue;
      for (const item of shipment.items) counts.set(item.orderItemId, (counts.get(item.orderItemId) ?? 0) + item.quantity);
    }
    return counts;
  }

  private allocatedQuantities(row: OrderRow) {
    return this.shippedQuantities(row, ['created', 'dispatched', 'delivered']);
  }

  private shipmentView(row: ShipmentRow & { carrierEvents?: CarrierEventRow[] }) {
    return { id: row.id, status: row.status, carrierCode: row.carrierCode ?? null,
      carrierName: row.carrierName ?? null, trackingNumber: row.trackingNumber ?? null, note: row.note ?? null,
      dispatchedAt: row.dispatchedAt?.toISOString() ?? null, deliveredAt: row.deliveredAt?.toISOString() ?? null,
      evidenceRef: row.evidenceRef ?? null, version: row.version,
      carrierStatus: row.carrierStatus ?? null,
      lastCarrierEventAt: row.lastCarrierEventAt?.toISOString() ?? null,
      carrierEvents: [...(row.carrierEvents ?? [])].map(event => ({ eventId: event.eventId,
        carrierCode: event.carrierCode, status: event.status, occurredAt: event.occurredAt.toISOString(),
        trackingNumber: event.trackingNumber, note: event.note })),
      items: [...row.items].map(item => ({ orderItemId: item.orderItemId, quantity: item.quantity })) };
  }

  private orderView(row: OrderRow, pii: boolean) {
    const contact = row.contact as unknown as ContactSnapshot;
    const shipped = this.shippedQuantities(row, ['dispatched', 'delivered']);
    const allocated = this.allocatedQuantities(row);
    return {
      id: row.id, publicOrderNumber: row.publicOrderNumber, orderStatus: row.orderStatus,
      paymentStatus: row.paymentStatus, fulfillmentStatus: row.fulfillmentStatus, currency: row.currency,
      subtotalMinor: row.subtotalMinor, discountMinor: row.discountMinor, shippingMinor: row.shippingMinor,
      taxMinor: row.taxMinor, totalMinor: row.totalMinor, version: row.version, locale: row.locale,
      marketCode: row.marketCode, paymentMethodCode: row.paymentMethodCode, customerNote: row.customerNote ?? null,
      placedAt: row.placedAt.toISOString(),
      lines: [...row.items].map(item => ({ id: item.id, variantId: item.variantId, sku: item.sku,
        productName: item.productName, variantName: item.variantName ?? null, quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor, lineSubtotalMinor: item.lineSubtotalMinor,
        lineDiscountMinor: item.lineDiscountMinor, lineTotalMinor: item.lineTotalMinor,
        shippedQuantity: shipped.get(item.id) ?? 0, allocatedQuantity: allocated.get(item.id) ?? 0 })),
      addressSnapshot: row.shippingAddress ?? null,
      contact: pii ? contact : maskContact(contact),
      shippingMethod: row.shippingMethodSnapshot,
      cancellation: row.cancelledAt ? { cancelledAt: row.cancelledAt.toISOString(),
        reasonCode: row.cancelReasonCode ?? null, reason: row.cancelReason ?? null,
        customerNotified: row.customerNotified } : null,
      shipments: [...row.shipments].map(shipment => this.shipmentView(shipment)),
      statusHistory: [...row.events].map(event => ({ id: event.id, fromStatus: event.fromStatus,
        toStatus: event.toStatus, reason: event.reason, actorType: event.actorType,
        createdAt: event.createdAt.toISOString() })),
      notes: [...row.notes].map(note => ({ id: note.id, note: note.note, authorId: note.authorId,
        createdAt: note.createdAt.toISOString() })),
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async detail(tx: Tx, id: string): Promise<OrderRow> {
    const row = await tx.shopOrder.findUnique({ where: { id }, include: includeDetail });
    if (!row) throw new AuthError(404, 'NOT_FOUND');
    return row;
  }

  async list(supplied: string, limit: number, cursor: string | null, query: string | null) {
    return this.identity.withPermission(supplied, null, 'orders.read', async tx => {
      if (cursor && !await tx.shopOrder.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const where: Prisma.ShopOrderWhereInput = query ? { OR: [
        { publicOrderNumber: { contains: query, mode: 'insensitive' } },
        { customerNote: { contains: query, mode: 'insensitive' } },
      ] } : {};
      const rows = await tx.shopOrder.findMany({ where, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const items = rows.slice(0, limit);
      return { items: items.map(row => {
        const contact = maskContact(row.contact as unknown as ContactSnapshot);
        return { id: row.id, publicOrderNumber: row.publicOrderNumber, orderStatus: row.orderStatus,
          paymentStatus: row.paymentStatus, currency: row.currency, totalMinor: row.totalMinor,
          contactMasked: contact.email ?? contact.phone,
          createdAt: row.placedAt.toISOString() };
      }), hasMore: rows.length > limit, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
    });
  }

  async get(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'orders.read', async (tx, actor) =>
      this.orderView(await this.detail(tx, id), this.identity.hasPermission(actor, 'customers.read_pii')));
  }

  // ---- 取消 -------------------------------------------------------------------

  /** 释放该订单所有 active 预留；售后取消案件复用同一实现，避免两套扣减逻辑漂移。 */
  private async releaseReservations(tx: Tx, orderId: string, onlyExpired = false) {
    return releaseOrderReservations(tx, orderId, onlyExpired);
  }

  private async replay(tx: Tx, key: string, action: string, orderId: string, digest: string) {
    const existing = await tx.orderAction.findUnique({ where: { idempotencyKey: key } });
    if (!existing) return null;
    if (existing.orderId !== orderId || existing.action !== action || existing.requestDigest !== digest)
      throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
    return existing;
  }

  async cancel(supplied: string, csrfValue: string | null, id: string, idempotencyKey: string | undefined,
    body: { reasonCode?: string | null; reason: string; expectedVersion: number; customerNotified?: boolean },
    ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const input = this.rule(() => normalizeCancel(body));
    const digest = this.digest('cancel', id, input);
    return this.identity.withPermission(supplied, csrfValue, 'orders.cancel', async (tx, actor) => {
      await this.lock(tx, `order:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      const replay = await this.replay(tx, key, 'cancel', id, digest);
      if (replay) return this.orderView(await this.detail(tx, id), pii);
      const row = await this.detail(tx, id);
      this.rule(() => assertVersion(input.expectedVersion, row.version));
      this.rule(() => assertCancellable(row.orderStatus, row.paymentStatus));
      await this.releaseReservations(tx, id);
      const now = new Date();
      // 取消是“明确不会再收款”的一种：券额度立即释放，已扣积分也按同一笔订单补回。
      await releaseCouponInTx(tx, id, input.reasonCode ?? 'admin_cancelled', { id: actor.id, type: 'admin' }, now);
      await restoreOrderPointsInTx(tx, id, now, 'order_cancelled');
      await tx.shopOrder.update({ where: { id }, data: { orderStatus: 'cancelled', cancelledAt: now,
        cancelReasonCode: input.reasonCode, cancelReason: input.reason, customerNotified: input.customerNotified,
        version: { increment: 1 } } });
      await tx.orderStatusEvent.create({ data: { orderId: id, fromStatus: row.orderStatus, toStatus: 'cancelled',
        reason: input.reasonCode ?? 'admin_cancelled', actorType: 'admin' } });
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: id, action: 'cancel', requestDigest: digest } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'order.cancelled', id, 'success', input.reason);
      return this.orderView(await this.detail(tx, id), pii);
    }, true);
  }

  // ---- 改址 -------------------------------------------------------------------

  /**
   * 改址必须重算运费：沿用原配送方式（不静默换方法），费用变化时要求顾客确认依据。
   * 一旦任何包裹已离开仓库就拒绝，避免“货在路上、地址却变了”。
   */
  async changeAddress(supplied: string, csrfValue: string | null, id: string, idempotencyKey: string | undefined,
    body: AddressChangeBody, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const address = this.rule(() => normalizeAddress(body.address));
    const reference = this.rule(() => normalizeConfirmationRef(body.customerConfirmationRef));
    const digest = this.digest('address_change', id, { expectedVersion: body.expectedVersion, address, reference });
    return this.identity.withPermission(supplied, csrfValue, 'orders.address_change', async (tx, actor) => {
      await this.lock(tx, `order:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const pii = this.identity.hasPermission(actor, 'customers.read_pii');
      const replay = await this.replay(tx, key, 'address_change', id, digest);
      if (replay) return this.orderView(await this.detail(tx, id), pii);
      const row = await this.detail(tx, id);
      this.rule(() => assertVersion(body.expectedVersion, row.version));
      this.rule(() => assertAddressChangeable(row.orderStatus, row.fulfillmentStatus));
      if (!row.shippingRateId) throw new AuthError(409, 'SHIPPING_UNAVAILABLE');
      const store = await tx.storeConfig.findUnique({ where: { id: 1 } });
      const fallback = store?.defaultLocale ?? 'zh-CN';
      const methods = await this.shipping.methodsFor(tx, address, row.subtotalMinor, row.currency, row.locale, fallback);
      const method = methods.find(item => item.id === row.shippingRateId);
      if (!method) throw new AuthError(409, 'SHIPPING_UNAVAILABLE');
      const priced = this.rule(() => repriceShipping({ subtotalMinor: row.subtotalMinor,
        discountMinor: row.discountMinor, taxMinor: row.taxMinor }, method.feeMinor));
      this.rule(() => assertAddressChangeConfirmed(row.totalMinor, priced.totalMinor, reference));
      const now = new Date();
      await tx.shopOrder.update({ where: { id }, data: { shippingAddress: address as unknown as Prisma.InputJsonValue,
        shippingMinor: priced.shippingMinor, totalMinor: priced.totalMinor, version: { increment: 1 },
        updatedAt: now } });
      await tx.orderAddressChange.create({ data: { orderId: id,
        ...(row.shippingAddress === null ? {} : { previousAddress: row.shippingAddress as Prisma.InputJsonValue }),
        newAddress: address as unknown as Prisma.InputJsonValue, shippingMinorBefore: row.shippingMinor,
        shippingMinorAfter: priced.shippingMinor, totalMinorBefore: row.totalMinor, totalMinorAfter: priced.totalMinor,
        customerConfirmationRef: reference, actorId: actor.id } });
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: id, action: 'address_change', requestDigest: digest } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'order.address_changed', id, 'success',
        `shipping ${row.shippingMinor} -> ${priced.shippingMinor}; total ${row.totalMinor} -> ${priced.totalMinor}`);
      return this.orderView(await this.detail(tx, id), pii);
    }, true);
  }

  // ---- 内部备注 ---------------------------------------------------------------

  async addNote(supplied: string, csrfValue: string | null, id: string,
    body: { note: string }, ctx: RequestContext) {
    const note = this.rule(() => normalizeNote(body.note));
    return this.identity.withPermission(supplied, csrfValue, 'orders.update', async (tx, actor) => {
      await this.lock(tx, `order:${id}`);
      const row = await tx.shopOrder.findUnique({ where: { id } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      const created = await tx.orderNote.create({ data: { orderId: id, note, authorId: actor.id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'order.note.added', id);
      return { id: created.id, orderId: id, note: created.note, authorId: created.authorId,
        createdAt: created.createdAt.toISOString() };
    }, true);
  }

  // ---- 包裹与履约 -------------------------------------------------------------

  async createShipment(supplied: string, csrfValue: string | null, id: string, idempotencyKey: string | undefined,
    body: ShipmentBody, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const carrierCode = this.optionalText(body.carrierCode, 80);
    const carrierName = this.optionalText(body.carrierName, 120);
    const trackingNumber = this.optionalText(body.trackingNumber, 160);
    const note = this.optionalText(body.note, 1_000);
    const digest = this.digest('shipment_create', id, { items: body.items, carrierCode, carrierName, trackingNumber, note });
    return this.identity.withPermission(supplied, csrfValue, 'shipments.manage', async (tx, actor) => {
      await this.lock(tx, `order:${id}`);
      await this.lock(tx, `order-action:${key}`);
      const replay = await this.replay(tx, key, 'shipment_create', id, digest);
      if (replay?.objectId) {
        const existing = await tx.shipment.findUnique({ where: { id: replay.objectId }, include: { items: true } });
        if (existing) return this.shipmentView(existing);
      }
      const row = await this.detail(tx, id);
      this.rule(() => assertShipmentCreatable(row.orderStatus));
      const lines = this.rule(() => allocateShipment(row.items.map(item => ({ id: item.id, quantity: item.quantity })),
        this.allocatedQuantities(row), body.items ?? []));
      const created = await tx.shipment.create({ data: { orderId: id, carrierCode, carrierName, trackingNumber, note,
        items: { create: lines } }, include: { items: true } });
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: id, action: 'shipment_create',
        requestDigest: digest, objectId: created.id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'order.shipment.created', created.id);
      return this.shipmentView(created);
    }, true);
  }

  /** 发货才动库存：onHand 减少、reserved 同步释放，并按累计发出来推进订单状态。 */
  async dispatchShipment(supplied: string, csrfValue: string | null, id: string, idempotencyKey: string | undefined,
    expectedVersion: number, body: DispatchBody, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const dispatchedAt = this.timestamp(body.dispatchedAt);
    const trackingNumber = this.optionalText(body.trackingNumber, 160);
    const evidenceRef = this.optionalText(body.evidenceRef, 200);
    const digest = this.digest('shipment_dispatch', id, { expectedVersion, dispatchedAt: dispatchedAt.toISOString(),
      trackingNumber, evidenceRef });
    return this.identity.withPermission(supplied, csrfValue, 'shipments.manage', async (tx, actor, _session, now) => {
      const shipment = await tx.shipment.findUnique({ where: { id }, include: { items: true } });
      if (!shipment) throw new AuthError(404, 'NOT_FOUND');
      await this.lock(tx, `order:${shipment.orderId}`);
      await this.lock(tx, `order-action:${key}`);
      const replay = await this.replay(tx, key, 'shipment_dispatch', shipment.orderId, digest);
      if (replay) {
        const fresh = await tx.shipment.findUnique({ where: { id }, include: { items: true } });
        return this.shipmentView(fresh!);
      }
      this.rule(() => assertVersion(expectedVersion, shipment.version));
      this.rule(() => assertShipmentDispatch(shipment.status));
      const row = await this.detail(tx, shipment.orderId);
      if (row.orderStatus === 'cancelled') throw new AuthError(409, 'ORDER_ALREADY_CANCELLED');

      for (const item of shipment.items) {
        const line = row.items.find(entry => entry.id === item.orderItemId);
        if (!line || !line.variantId) throw new AuthError(409, 'STATE_CONFLICT');
        const reservation = await tx.inventoryReservation.findUnique({ where: { orderId_variantId: {
          orderId: row.id, variantId: line.variantId } } });
        if (!reservation || reservation.status !== 'active' || reservation.quantity < item.quantity)
          throw new AuthError(409, 'RESERVATION_EXPIRED');
        const updated = await tx.$executeRaw`UPDATE "InventoryItem" SET "onHand" = "onHand" - ${item.quantity},
          "reserved" = "reserved" - ${item.quantity}
          WHERE "variantId" = ${line.variantId}::uuid AND "onHand" >= ${item.quantity} AND "reserved" >= ${item.quantity}`;
        if (updated === 0) throw new AuthError(409, 'OUT_OF_STOCK');
        const remaining = reservation.quantity - item.quantity;
        await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { quantity: remaining,
          status: remaining === 0 ? 'committed' : 'active' } });
      }

      const updatedShipment = await tx.shipment.update({ where: { id }, data: { status: 'dispatched',
        dispatchedAt, evidenceRef, ...(trackingNumber === null ? {} : { trackingNumber }), version: { increment: 1 } },
        include: { items: true } });
      const shipped = this.shippedQuantities(row, ['dispatched', 'delivered']);
      for (const item of updatedShipment.items) shipped.set(item.orderItemId,
        (shipped.get(item.orderItemId) ?? 0) + item.quantity);
      const shippedAll = row.items.every(item => (shipped.get(item.id) ?? 0) >= item.quantity);
      const nextStatus = orderStatusAfterDispatch(shippedAll);
      const fromStatus = row.orderStatus;
      await tx.shopOrder.update({ where: { id: row.id }, data: { orderStatus: nextStatus,
        fulfillmentStatus: fulfillmentAfterDispatch(shippedAll), version: { increment: 1 } } });
      if (fromStatus !== nextStatus) {
        await tx.orderStatusEvent.create({ data: { orderId: row.id, fromStatus, toStatus: nextStatus,
          reason: 'shipment_dispatched', actorType: 'admin' } });
      }
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: row.id, action: 'shipment_dispatch',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'order.shipment.dispatched', id);
      return this.shipmentView(updatedShipment);
    }, true);
  }

  /** 签收只改履约，不碰 paymentStatus：COD 收款必须另有收款登记。 */
  async deliverShipment(supplied: string, csrfValue: string | null, id: string, idempotencyKey: string | undefined,
    body: DeliverBody, ctx: RequestContext) {
    const key = this.key(idempotencyKey);
    const deliveredAt = this.timestamp(body.deliveredAt);
    const evidenceRef = this.optionalText(body.evidenceRef, 200);
    const note = this.optionalText(body.note, 1_000);
    const digest = this.digest('shipment_deliver', id, { deliveredAt: deliveredAt.toISOString(), evidenceRef, note });
    return this.identity.withPermission(supplied, csrfValue, 'shipments.manage', async (tx, actor, _session, now) => {
      const shipment = await tx.shipment.findUnique({ where: { id }, include: { items: true } });
      if (!shipment) throw new AuthError(404, 'NOT_FOUND');
      await this.lock(tx, `order:${shipment.orderId}`);
      await this.lock(tx, `order-action:${key}`);
      const replay = await this.replay(tx, key, 'shipment_deliver', shipment.orderId, digest);
      if (replay) {
        const fresh = await tx.shipment.findUnique({ where: { id }, include: { items: true } });
        return this.shipmentView(fresh!);
      }
      const view = await this.applyDelivery(tx, id, deliveredAt, evidenceRef, note, now, 'admin');
      await tx.orderAction.create({ data: { idempotencyKey: key, orderId: shipment.orderId, action: 'shipment_deliver',
        requestDigest: digest, objectId: id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'order.shipment.delivered', id);
      return view;
    }, true);
  }

  /**
   * 承运商 delivered 回调复用同一套履约推进，但只允许作用于已 dispatch 的包裹：
   * 签名只证明"承运商说过"，不能替代员工的库存扣减与授权动作。
   * 调用方负责在自己的事务里做事件幂等和审计。
   */
  async applyCarrierDelivery(tx: Tx, shipmentId: string, deliveredAt: Date, evidenceRef: string, now: Date) {
    return this.applyDelivery(tx, shipmentId, deliveredAt, evidenceRef, null, now, 'system');
  }

  /** 签收的公共履约部分：改包裹状态、推进订单、发放积分；不含权限、幂等键与审计。 */
  private async applyDelivery(tx: Tx, id: string, deliveredAt: Date, evidenceRef: string | null,
    note: string | null, now: Date, actorType: 'admin' | 'system') {
    const shipment = await tx.shipment.findUnique({ where: { id }, include: { items: true } });
    if (!shipment) throw new AuthError(404, 'NOT_FOUND');
    this.rule(() => assertShipmentDeliver(shipment.status));
    const row = await this.detail(tx, shipment.orderId);
    const updated = await tx.shipment.update({ where: { id }, data: { status: 'delivered', deliveredAt,
      evidenceRef, ...(note === null ? {} : { note }), version: { increment: 1 } }, include: { items: true } });
    const delivered = this.shippedQuantities(row, ['delivered']);
    for (const item of updated.items) delivered.set(item.orderItemId,
      (delivered.get(item.orderItemId) ?? 0) + item.quantity);
    const allDelivered = row.items.every(item => (delivered.get(item.id) ?? 0) >= item.quantity);
    if (allDelivered) {
      await tx.shopOrder.update({ where: { id: row.id }, data: { orderStatus: 'completed',
        fulfillmentStatus: 'delivered', version: { increment: 1 } } });
      if (row.orderStatus !== 'completed') {
        await tx.orderStatusEvent.create({ data: { orderId: row.id, fromStatus: row.orderStatus,
          toStatus: 'completed', reason: 'shipment_delivered', actorType } });
      }
      // 订单完成才发放积分：只认已经建立的会员关联，访客订单不按邮箱反推。
      // 同一订单重复触发时由 `order:{id}:earn` 幂等键挡住，不会二次发放。
      await awardOrderPointsInTx(tx, row.id, now);
    } else if (row.fulfillmentStatus !== 'partially_fulfilled') {
      await tx.shopOrder.update({ where: { id: row.id }, data: { fulfillmentStatus: 'partially_fulfilled' } });
    }
    return this.shipmentView(updated);
  }

  // ---- 过期预留 ---------------------------------------------------------------

  /**
   * 释放过期预留。仍然停留在 awaiting_confirmation 的订单会被自动取消：
   * 库存已不归它，继续挂着只会让后台看到一张永远发不出的单。
   * 已经进入确认/处理中的订单不在这里动——那是需要人工介入的异常，不是自动清理。
   */
  async releaseExpiredReservations(limit = 50) {
    const now = new Date();
    return this.db.$transaction(async tx => {
      const pending = await tx.inventoryReservation.findMany({ where: { status: 'active', expiresAt: { lte: now } },
        select: { orderId: true }, distinct: ['orderId'], take: limit });
      let released = 0;
      let cancelled = 0;
      for (const { orderId } of pending) {
        await this.lock(tx, `order:${orderId}`);
        const order = await tx.shopOrder.findUnique({ where: { id: orderId } });
        if (!order) continue;
        if (order.orderStatus !== 'awaiting_confirmation' && order.orderStatus !== 'cancelled') continue;
        released += await this.releaseReservations(tx, orderId, true);
        // 库存预留与券额度同时到期：只释放一边会让券永远卡在预占里。
        await expireCouponInTx(tx, orderId, { id: null, type: 'system' }, now);
        await restoreOrderPointsInTx(tx, orderId, now, 'reservation_expired');
        if (order.orderStatus !== 'cancelled') {
          await tx.shopOrder.update({ where: { id: orderId }, data: { orderStatus: 'cancelled', cancelledAt: now,
            cancelReasonCode: 'reservation_expired',
            cancelReason: 'Inventory hold expired before the order was confirmed.', customerNotified: false,
            version: { increment: 1 } } });
          await tx.orderStatusEvent.create({ data: { orderId, fromStatus: order.orderStatus, toStatus: 'cancelled',
            reason: 'reservation_expired', actorType: 'system' } });
          cancelled += 1;
        }
      }
      return { orders: pending.length, released, cancelled };
    }, { timeout: 30_000 });
  }
}
