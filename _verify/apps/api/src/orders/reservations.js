/**
 * 释放订单的库存预留。取消、过期清理与售后退款审批共用同一条路径：
 * 只有 reserved 足够时才扣减，绝不把 reserved 减成负数。
 */
export async function releaseOrderReservations(tx, orderId, onlyExpired = false) {
    const rows = await tx.inventoryReservation.findMany({ where: { orderId, status: 'active',
            ...(onlyExpired ? { expiresAt: { lte: new Date() } } : {}) } });
    for (const row of rows) {
        await tx.inventoryItem.updateMany({ where: { variantId: row.variantId, reserved: { gte: row.quantity } },
            data: { reserved: { decrement: row.quantity } } });
        await tx.inventoryReservation.update({ where: { id: row.id }, data: { status: 'released' } });
    }
    return rows.length;
}
