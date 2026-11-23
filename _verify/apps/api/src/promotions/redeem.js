async function transition(tx, orderId, from, to, reason, actor, dedupeKey, now) {
    const row = await tx.couponRedemption.findUnique({ where: { orderId } });
    if (!row || row.status !== from)
        return null;
    const changed = await tx.couponRedemption.updateMany({ where: { id: row.id, status: from }, data: {
            status: to, version: { increment: 1 }, expiresAt: null,
            ...(to === 'redeemed' ? { redeemedAt: now } : {}),
            ...(to === 'released' ? { releasedAt: now } : {}),
        } });
    if (!changed.count)
        return null;
    await tx.couponRedemptionEvent.create({ data: { redemptionId: row.id, fromStatus: from, toStatus: to,
            reason: reason.slice(0, 200), actorType: actor.type, actorId: actor.id, dedupeKey, createdAt: now } });
    return { couponId: row.couponId, redemptionId: row.id, discountMinor: row.discountMinor };
}
/** 收款成功（线上成功或 COD 人工登记）→ 预占转核销；已经核销的重复调用不改任何东西。 */
export function redeemCouponInTx(tx, orderId, actor, now) {
    return transition(tx, orderId, 'reserved', 'redeemed', 'payment_confirmed', actor, `coupon:${orderId}:redeemed`, now);
}
/** 订单明确取消/明确支付失败 → 释放额度；付款未知不调用本函数。 */
export function releaseCouponInTx(tx, orderId, reason, actor, now, suffix = 'released') {
    return transition(tx, orderId, 'reserved', 'released', reason, actor, `coupon:${orderId}:${suffix}`, now);
}
/** 预留超时（订单随之自动取消）→ 额度过期，与主动取消分开记录原因。 */
export function expireCouponInTx(tx, orderId, actor, now) {
    return transition(tx, orderId, 'reserved', 'expired', 'reservation_expired', actor, `coupon:${orderId}:expired`, now);
}
/**
 * 整单退款完成且券配置为 restore → 新建一条返还记录。
 * 原核销记录保持 redeemed，不改写历史；额度统计按“返还条数”扣减。
 */
export async function restoreCouponQuotaInTx(tx, orderId, refundId, reason, now) {
    const row = await tx.couponRedemption.findUnique({ where: { orderId }, include: { coupon: true } });
    if (!row || row.status !== 'redeemed' || row.coupon.refundPolicy !== 'restore')
        return null;
    if (await tx.couponQuotaReturn.findUnique({ where: { redemptionId: row.id } }))
        return null;
    await tx.couponQuotaReturn.create({ data: { redemptionId: row.id, refundId, reason: reason.slice(0, 200), createdAt: now } });
    await tx.couponRedemptionEvent.create({ data: { redemptionId: row.id, fromStatus: 'redeemed', toStatus: 'redeemed',
            reason: `quota_returned:${reason}`.slice(0, 200), actorType: 'system', actorId: null,
            dedupeKey: `coupon:${row.id}:quota-returned`, createdAt: now } });
    return { couponId: row.couponId, redemptionId: row.id };
}
