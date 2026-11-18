import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  canonicalCarrierBody, CarrierRuleError, normalizeCarrierEvent, signatureRef, verifyCarrierSignature,
} from '../../../../packages/domain/src/carrier.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import type { OrdersService } from '../orders/service.js';

type Tx = Prisma.TransactionClient;

export interface CarrierWebhookAck {
  received: boolean;
  duplicate: boolean;
  shipmentStatus: string;
}

/**
 * 承运商状态回传（M09 剩余）。
 *
 * 不变量：
 * 1. 先验签再查库：未登记 carrierCode、过期时间戳或签名不符一律拒绝，不给未认证调用者探测包裹的机会。
 * 2. 签名覆盖时间戳 + 规范化 body；eventId 唯一且用行锁串行化，重复回调只产生一条台账与一次状态推进。
 * 3. 状态只由已 dispatch 的包裹前进；delivered 复用 OrdersService 的履约推进，不碰 paymentStatus。
 * 4. 回调字段只有包裹标识、状态与可选追踪号/备注；契约与领域层都拒 PII，落库只留签名前缀。
 */
export class CarrierWebhookService {
  constructor(private readonly identity: IdentityService, private readonly orders: OrdersService,
    private readonly secrets: Record<string, string>) {}
  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof CarrierRuleError)
        throw new AuthError(error.code === 'INVALID_SIGNATURE' ? 401 : 422, error.code);
      throw error;
    }
  }

  async receive(carrierCode: string, body: unknown, signature: string | null,
    timestamp: string | null, ctx: RequestContext): Promise<CarrierWebhookAck> {
    const secret = this.secrets[carrierCode];
    if (!secret) throw new AuthError(404, 'NOT_FOUND');
    const canonical = this.rule(() => canonicalCarrierBody(body));
    this.rule(() => verifyCarrierSignature(secret, canonical, signature, timestamp));
    const event = this.rule(() => normalizeCarrierEvent(body));
    await this.identity.limitIp(ctx);

    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'carrier-event:' + event.eventId}))::text`;
      const existing = await tx.carrierStatusEvent.findUnique({ where: { eventId: event.eventId } });
      if (existing) {
        const shipment = await tx.shipment.findUnique({ where: { id: existing.shipmentId } });
        if (!shipment) throw new AuthError(404, 'NOT_FOUND');
        return { received: false, duplicate: true, shipmentStatus: shipment.status };
      }

      const shipment = await tx.shipment.findUnique({ where: { id: event.shipmentId } });
      if (!shipment) throw new AuthError(404, 'NOT_FOUND');
      if (shipment.carrierCode && shipment.carrierCode !== carrierCode)
        throw new AuthError(409, 'CARRIER_MISMATCH');
      if (event.trackingNumber && shipment.trackingNumber
        && event.trackingNumber.trim() !== shipment.trackingNumber.trim())
        throw new AuthError(409, 'TRACKING_MISMATCH');

      await tx.carrierStatusEvent.create({ data: {
        eventId: event.eventId, shipmentId: shipment.id, carrierCode, status: event.status,
        occurredAt: event.occurredAt, trackingNumber: event.trackingNumber, note: event.note,
        signatureRef: signatureRef(signature!),
      } });
      await tx.shipment.update({ where: { id: shipment.id }, data: {
        carrierStatus: event.status, lastCarrierEventAt: event.occurredAt,
        ...(event.trackingNumber && !shipment.trackingNumber ? { trackingNumber: event.trackingNumber } : {}),
      } });

      if (event.status === 'delivered' && shipment.status !== 'delivered') {
        await this.orders.applyCarrierDelivery(tx, shipment.id, event.occurredAt,
          `carrier:${event.eventId}`, new Date());
      }
      await this.identity.recordAudit(tx, ctx, null, 'shipment.carrier_status', shipment.id,
        'success', `${carrierCode}:${event.status}`);
      const fresh = await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      return { received: true, duplicate: false, shipmentStatus: fresh.status };
    });
  }
}
