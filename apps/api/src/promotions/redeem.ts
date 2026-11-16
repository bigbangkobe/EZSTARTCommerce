import type { Prisma } from '../../../../packages/database/src/client.js';

type Tx = Prisma.TransactionClient;

/**
 * 优惠占位的三个事务内动作。
 *
 * 它们只改“这张券在这张订单上的占用状态”，不读请求、不写审计：
 * 下单预占、收款核销、取消/超时释放、整单退款返还额度都走这里，
 * 保证订单、支付、售后三条链路对同一张券只有一套状态机。
 */
export interface CouponActor { id: string | null; type: 'customer' | 'admin' | 'system' }

async function transition(tx: Tx, orderId: string, from: 'reserved', to: 'redeemed' | 'released' | 'expired',
  reason: string, actor: CouponActor, dedupeKey: string, now: Date) {
  const row = await tx.couponRedemption.findUnique({ where: { orderId } });
  if (!row || row.status !== from) return null;
  const changed = await tx.couponRedemption.updateMany({ where: { id: row.id, status: from }, data: {
    status: to, version: { increment: 1 }, expiresAt: null,
    ...(to === 'redeemed' ? { redeemedAt: now } : {}),
    ...(to === 'released' ? { releasedAt: now } : {}),
  } });
  if (!changed.count) return null;
  await tx.couponRedemptionEvent.create({ data: { redemptionId: row.id, fromStatus: from, toStatus: to,
    reason: reason.slice(0, 200), actorType: actor.type, actorId: actor.id, dedupeKey, createdAt: now } });
  return { couponId: row.couponId, redemptionId: row.id, discountMinor: row.discountMinor };
}

/** 收款成功（线上成功或 COD 人工登记）→ 预占转核销；已经核销的重复调用不改任何东西。 */
export function redeemCouponInTx(tx: Tx, orderId: string, actor: CouponActor, now: Date) {
  return transition(tx, orderId, 'reserved', 'redeemed', 'payment_confirmed', actor,
    `coupon:${orderId}:redeemed`, now);
}

/** 订单明确取消/明确支付失败 → 释放额度；付款未知不调用本函数。 */
export function releaseCouponInTx(tx: Tx, orderId: string, reason: string, actor: CouponActor, now: Date,
  suffix = 'released') {
  return transition(tx, orderId, 'reserved', 'released', reason, actor, `coupon:${orderId}:${suffix}`, now);
}

/** 预留超时（订单随之自动取消）→ 额度过期，与主动取消分开记录原因。 */
export function expireCouponInTx(tx: Tx, orderId: string, actor: CouponActor, now: Date) {
  return transition(tx, orderId, 'reserved', 'expired', 'reservation_expired', actor,
    `coupon:${orderId}:expired`, now);
}

/**
 * 整单退款完成且券配置为 restore → 新建一条返还记录。
 * 原核销记录保持 redeemed，不改写历史；额度统计按“返还条数”扣减。
 */
export async function restoreCouponQuotaInTx(tx: Tx, orderId: string, refundId: string | null, reason: string,
  now: Date) {
  const row = await tx.couponRedemption.findUnique({ where: { orderId }, include: { coupon: true } });
  if (!row || row.status !== 'redeemed' || row.coupon.refundPolicy !== 'restore') return null;
  if (await tx.couponQuotaReturn.findUnique({ where: { redemptionId: row.id } })) return null;
  await tx.couponQuotaReturn.create({ data: { redemptionId: row.id, refundId, reason: reason.slice(0, 200), createdAt: now } });
  await tx.couponRedemptionEvent.create({ data: { redemptionId: row.id, fromStatus: 'redeemed', toStatus: 'redeemed',
    reason: `quota_returned:${reason}`.slice(0, 200), actorType: 'system', actorId: null,
    dedupeKey: `coupon:${row.id}:quota-returned`, createdAt: now } });
  return { couponId: row.couponId, redemptionId: row.id };
}
