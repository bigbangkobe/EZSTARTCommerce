import type { Prisma } from '../../../../packages/database/src/client.js';
import { IdentityService } from '../identity/service.js';

type Tx = Prisma.TransactionClient;

/**
 * 后台工作台（首页）聚合。
 *
 * 为什么要有这个接口：订单/库存列表都没有状态筛选也没有总数，前端想拼一个“今天要干什么”
 * 的首页就得把所有分页翻一遍。与其让每个客户端各写一套不精确的统计，不如在这里一次算准。
 *
 * 权限模型：接口门槛是 orders.read（所有业务岗都有），但各块按各自权限计算 —— 看不了售后的
 * 人拿到 null 而不是 0。0 会被读成“没有待处理”，null 才是“你看不到”，这个区别必须保留。
 */
const OPEN_CASE_STATUSES = ['submitted', 'under_review', 'approved', 'needs_information',
  'return_in_transit', 'received_inspection', 'refund_pending', 'replacement_sent'];

/** 待发货：已确认但还没发完的订单，取消/挂起的不算。 */
const DISPATCH_STATUSES = ['confirmed', 'processing', 'partially_shipped'];
const OPEN_FULFILLMENT = ['unfulfilled', 'preparing', 'partially_fulfilled'];

export class WorkbenchService {
  constructor(private readonly identity: IdentityService) {}
  private get db() { return this.identity.db; }

  /** 低库存口径与库存列表的 lowStock 过滤完全一致：可售数 <= 阈值（未设阈值按 0）。 */
  private async lowStockCount(tx: Tx) {
    const rows = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "ProductVariant" v
      JOIN "Product" p ON p."id" = v."productId"
      LEFT JOIN "InventoryItem" i ON i."variantId" = v."id"
      LEFT JOIN "InventoryThreshold" t ON t."variantId" = v."id"
      WHERE (COALESCE(i."onHand", 0) - COALESCE(i."reserved", 0)) <= COALESCE(t."lowStockLevel", 0)`;
    return Number(rows[0]?.count ?? 0);
  }

  async summary(supplied: string) {
    return this.identity.withPermission(supplied, null, 'orders.read', async (tx, actor) => {
      const seesAfterSales = this.identity.hasPermission(actor, 'aftersales.read');
      const seesInventory = this.identity.hasPermission(actor, 'inventory.read');
      const [awaitingConfirmation, awaitingDispatch, prepaidUnsettled, openCases, lowStock, recent] = await Promise.all([
        // 货到付款的订单落库即 confirmed，不会进待确认；待确认只来自线下转账待核。
        tx.shopOrder.count({ where: { orderStatus: 'awaiting_confirmation' } }),
        tx.shopOrder.count({ where: { orderStatus: { in: DISPATCH_STATUSES }, fulfillmentStatus: { in: OPEN_FULFILLMENT } } }),
        // 先付款商品却还没收到钱：发货会被拦，所以首页必须显眼。
        tx.shopOrder.count({ where: { requiresPrepayment: true, orderStatus: { not: 'cancelled' },
          paymentStatus: { notIn: ['succeeded', 'collected'] } } }),
        seesAfterSales ? tx.afterSalesCase.count({ where: { status: { in: OPEN_CASE_STATUSES } } }) : Promise.resolve(null),
        seesInventory ? this.lowStockCount(tx) : Promise.resolve(null),
        tx.shopOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 6,
          select: { id: true, publicOrderNumber: true, orderStatus: true, paymentStatus: true,
            currency: true, totalMinor: true, createdAt: true } }),
      ]);
      return {
        generatedAt: new Date().toISOString(),
        orders: { awaitingConfirmation, awaitingDispatch, prepaidUnsettled },
        aftersales: openCases === null ? null : { open: openCases },
        inventory: lowStock === null ? null : { lowStock },
        recentOrders: recent.map(order => ({ ...order, createdAt: order.createdAt.toISOString() })),
      };
    });
  }
}
