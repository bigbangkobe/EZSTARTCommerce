import { REPORT_METRIC_VERSION, FUNNEL_METRIC_VERSION, REPORT_EXPORT_TTL_MINUTES, REPORT_KEYS, PAID_PAYMENT_STATUSES, COD_PAYMENT_STATUSES, REFUNDED_STATUS, CANCELLED_ORDER_STATUS, REPORT_MIN_SAMPLE, localDay, within, sumMinor, ratio, smallSampleRatio, RowAccumulator, assertReportKey, assertReportFormat, normalizeReportFilters, exportPreamble, csvDocument, ReportRuleError, } from '../../../../packages/domain/src/reports.js';
import { PLACEMENT_METRIC_VERSION, PLACEMENT_MIN_IMPRESSION_SESSIONS, allocateRefund, impressionKey, netRevenueMinor, placementCoverage, placementRatio, } from '../../../../packages/domain/src/placement.js';
import { AuthError } from '../identity/service.js';
const EMPTY_FUNNEL = { events: [], sessions: [], orders: [] };
const EMPTY_PLACEMENT = {
    events: [], pageViewSessions: 0, lastSectionEventAt: null, added: [], items: [],
    refundByItem: new Map(), unallocatedRefundMinor: 0,
};
/**
 * 交易经营报表（M14 第一批）：服务端权威数据的只读聚合。
 *
 * 三条不变量：
 * 1. 权限在入口统一校验：读要 reports.view，导出要 reports.export；报表只读聚合，
 *    不返回任何顾客/订单明细，字段级也不含联系方式（契约的维度键是闭集）。
 * 2. 金额按币种分组：每行 dimensions 带 currency，totals 只在不涉币种歧义时给计数类指标，
 *    金额一律进 rows，杜绝跨币种相加。
 * 3. 权威时间各取所需：下单看 placedAt、收款看 paidAt、退款看 executedAt、注册看 joinedAt、
 *    积分看 createdAt；同一订单可因不同事件落在不同日，符合 M14 口径初稿。
 */
export class ReportsService {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    get db() { return this.identity.db; }
    rule(fn) {
        try {
            return fn();
        }
        catch (error) {
            if (error instanceof ReportRuleError)
                throw new AuthError(422, error.code);
            throw error;
        }
    }
    /** 供导出复用：不含权限校验（由调用方的 reports.export 边界保护），保证页面与导出同一口径。 */
    async buildReport(reportKeyRaw, query, tx) {
        const reportKey = this.rule(() => assertReportKey(reportKeyRaw));
        const { filters, from, to } = this.rule(() => normalizeReportFilters(query));
        const run = async (client) => {
            const snap = await this.load(client, from, to, filters);
            if (reportKey === 'funnel')
                snap.funnel = await this.loadFunnel(client, from, to, filters);
            if (reportKey === 'placement')
                snap.placement = await this.loadPlacement(client, from, to, filters);
            return this.aggregate(reportKey, filters, from, to, snap);
        };
        // 导出调用方已经在外层事务里（withPermission），不能嵌套 $transaction。
        return tx ? run(tx) : this.db.$transaction(run);
    }
    /** 报表查询：受 reports.view 保护，csrf 传 null（读操作不需要 CSRF）。 */
    async report(supplied, reportKeyRaw, query) {
        return this.identity.withPermission(supplied, null, 'reports.view', async () => this.buildReport(reportKeyRaw, query));
    }
    /** 一次把区间内所有明细读到内存：报表数据量受最大跨度约束，避免 N+1 与各报表口径漂移。 */
    async load(tx, from, to, filters) {
        const orderWhere = {
            placedAt: { gte: from, lt: to },
            ...(filters.marketCode ? { marketCode: filters.marketCode } : {}),
            ...(filters.paymentMethodCode ? { paymentMethodCode: filters.paymentMethodCode } : {}),
        };
        // 收款/退款按自己的权威时间取，但订单维度筛选仍沿用同一市场/付款方式条件。
        const paymentWhere = {
            paidAt: { gte: from, lt: to },
            status: { in: [...PAID_PAYMENT_STATUSES] },
            ...(filters.marketCode ? { order: { marketCode: filters.marketCode } } : {}),
            ...(filters.paymentMethodCode ? { order: { paymentMethodCode: filters.paymentMethodCode } } : {}),
        };
        const refundWhere = {
            executedAt: { gte: from, lt: to }, status: REFUNDED_STATUS,
            ...(filters.marketCode ? { order: { marketCode: filters.marketCode } } : {}),
            ...(filters.paymentMethodCode ? { order: { paymentMethodCode: filters.paymentMethodCode } } : {}),
        };
        const orders = await tx.shopOrder.findMany({ where: orderWhere });
        const orderIds = orders.map(order => order.id);
        const [items, payments, refunds, redemptions, inventory, thresholds, variants, members, ledger, tiers, coupons] = await Promise.all([
            tx.orderItem.findMany({ where: { orderId: { in: orderIds } } }),
            tx.payment.findMany({ where: paymentWhere }),
            tx.refund.findMany({ where: refundWhere }),
            tx.couponRedemption.findMany({ where: { reservedAt: { gte: from, lt: to } } }),
            tx.inventoryItem.findMany(),
            tx.inventoryThreshold.findMany(),
            tx.productVariant.findMany(),
            tx.memberProfile.findMany(),
            tx.pointLedger.findMany({ where: { createdAt: { gte: from, lt: to } } }),
            tx.membershipTier.findMany(),
            tx.coupon.findMany(),
        ]);
        return {
            orders, items, payments, refunds, redemptions, inventory, members, ledger,
            coupons: new Map(coupons.map(coupon => [coupon.id, coupon])),
            thresholds: new Map(thresholds.map(row => [row.variantId, row])),
            variants: new Map(variants.map(row => [row.id, row])),
            tiers: new Map(tiers.map(row => [row.id, row])),
        };
    }
    /** 漏斗数据在同一事务里读：事件按筛选/同意过滤，会话与订单全量取后在内存 join。 */
    async loadFunnel(tx, from, to, filters) {
        const eventWhere = {
            occurredAt: { gte: from, lt: to }, consentState: 'granted',
            ...(filters.locale ? { locale: filters.locale } : {}),
            ...(filters.deviceClass ? { deviceClass: filters.deviceClass } : {}),
            ...(filters.source ? { source: filters.source } : {}),
            ...(filters.marketCode ? { marketCode: filters.marketCode } : {}),
        };
        const orderWhere = {
            placedAt: { gte: from, lt: to }, cartId: { not: null },
            ...(filters.marketCode ? { marketCode: filters.marketCode } : {}),
        };
        const [events, sessions, orders] = await Promise.all([
            tx.analyticsEvent.findMany({ where: eventWhere }),
            tx.analyticsSession.findMany(),
            tx.shopOrder.findMany({ where: orderWhere }),
        ]);
        return {
            events: events.map(e => ({ sessionId: e.sessionId, eventName: e.eventName, occurredAt: e.occurredAt.toISOString() })),
            sessions: sessions.map(s => ({ sessionId: s.sessionId, cartId: s.cartId, deviceClass: s.deviceClass,
                source: s.source, locale: s.locale, marketCode: s.marketCode,
                firstSeenAt: s.firstSeenAt })),
            orders: orders.map(o => ({ cartId: o.cartId, placedAt: o.placedAt, currency: o.currency })),
        };
    }
    coverage(snap) {
        let latest = null;
        for (const order of snap.orders)
            if (!latest || order.placedAt > latest)
                latest = order.placedAt;
        for (const payment of snap.payments)
            if (payment.paidAt && (!latest || payment.paidAt > latest))
                latest = payment.paidAt;
        return {
            sourceOrderCount: snap.orders.length,
            lastDataAt: latest?.toISOString() ?? null,
            complete: true,
            note: `订单按 placedAt、收款按 paidAt、退款按 executedAt 归属；共 ${snap.orders.length} 笔订单进入统计。`,
        };
    }
    result(reportKey, filters, from, to, snap, totals, rows) {
        const currencies = [...new Set([
                ...snap.orders.map(order => order.currency),
                ...snap.payments.map(payment => payment.currency),
                ...snap.refunds.map(refund => refund.currency),
            ])].sort();
        return {
            reportKey, metricDefinitionVersion: REPORT_METRIC_VERSION,
            generatedAt: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(),
            timezone: filters.timezone, currencies,
            filters: { ...filters }, totals, rows, coverage: this.coverage(snap),
        };
    }
    /** 按 reportKey 分派到具体聚合；每个聚合只产出一个 totals + rows。 */
    aggregate(key, filters, from, to, snap) {
        switch (key) {
            case 'sales_summary': return this.salesSummary(filters, from, to, snap);
            case 'orders_by_status': return this.byDimension('status', filters, from, to, snap);
            case 'orders_by_payment': return this.byDimension('paymentStatus', filters, from, to, snap);
            case 'orders_by_method': return this.byDimension('paymentMethodCode', filters, from, to, snap);
            case 'product_sales': return this.productSales(filters, from, to, snap);
            case 'inventory': return this.inventory(filters, from, to, snap);
            case 'coupons': return this.coupons(filters, from, to, snap);
            case 'members': return this.members(filters, from, to, snap);
            case 'funnel': return this.funnel(filters, from, to, snap);
            case 'placement': return this.placement(filters, from, to, snap);
        }
    }
    /** 销售汇总：下单额/净销售额/退款分币种，按店铺日给出趋势行。 */
    salesSummary(filters, from, to, snap) {
        const byCurrency = new Map();
        const empty = () => ({ placed: [], discount: [], shipping: [], collected: [], cod: [], refunded: [], cancelled: [] });
        const trend = new RowAccumulator();
        let cancelledOrders = 0;
        for (const order of snap.orders) {
            const bucket = byCurrency.get(order.currency) ?? empty();
            byCurrency.set(order.currency, bucket);
            bucket.placed.push(order.totalMinor);
            bucket.discount.push(order.discountMinor + order.pointsValueMinor);
            bucket.shipping.push(order.shippingMinor);
            if (order.orderStatus === CANCELLED_ORDER_STATUS) {
                bucket.cancelled.push(order.totalMinor);
                cancelledOrders += 1;
            }
            const day = localDay(filters.timezone, order.placedAt);
            trend.add({ day, currency: order.currency }, { orderCount: 1, placedMinor: order.totalMinor });
        }
        for (const payment of snap.payments) {
            const bucket = byCurrency.get(payment.currency) ?? empty();
            byCurrency.set(payment.currency, bucket);
            bucket.collected.push(payment.amountMinor);
            if ([...COD_PAYMENT_STATUSES].includes(payment.status))
                bucket.cod.push(payment.amountMinor);
        }
        for (const refund of snap.refunds) {
            const bucket = byCurrency.get(refund.currency) ?? empty();
            byCurrency.set(refund.currency, bucket);
            bucket.refunded.push(refund.amountMinor);
        }
        const rows = [];
        for (const [currency, bucket] of [...byCurrency].sort(([a], [b]) => a.localeCompare(b))) {
            const collected = sumMinor(bucket.collected);
            const refunded = sumMinor(bucket.refunded);
            rows.push({ dimensions: { currency }, metrics: {
                    orderCount: bucket.placed.length,
                    placedMinor: sumMinor(bucket.placed),
                    discountMinor: sumMinor(bucket.discount),
                    shippingMinor: sumMinor(bucket.shipping),
                    collectedMinor: collected,
                    codCollectedMinor: sumMinor(bucket.cod),
                    refundedMinor: refunded,
                    netSalesMinor: collected - refunded,
                    cancelledMinor: sumMinor(bucket.cancelled),
                } });
        }
        rows.push(...trend.list().sort((a, b) => String(a.dimensions.day).localeCompare(String(b.dimensions.day)) || String(a.dimensions.currency).localeCompare(String(b.dimensions.currency))));
        return this.result('sales_summary', filters, from, to, snap, { orderCount: snap.orders.length, cancelledOrderCount: cancelledOrders, paymentCount: snap.payments.length, refundCount: snap.refunds.length }, rows);
    }
    /** 按订单状态 / 付款状态 / 付款方式分组：金额分币种、行内计数。 */
    byDimension(dim, filters, from, to, snap) {
        const key = dim === 'status' ? 'orders_by_status' : dim === 'paymentStatus' ? 'orders_by_payment' : 'orders_by_method';
        const dimKey = dim === 'status' ? 'status' : dim === 'paymentStatus' ? 'status' : 'method';
        const acc = new RowAccumulator();
        for (const order of snap.orders) {
            const value = dim === 'status' ? order.orderStatus
                : dim === 'paymentStatus' ? order.paymentStatus : order.paymentMethodCode;
            acc.add({ [dimKey]: value || 'unknown', currency: order.currency }, { orderCount: 1, placedMinor: order.totalMinor });
        }
        return this.result(key, filters, from, to, snap, { orderCount: snap.orders.length }, acc.list().sort((a, b) => String(a.dimensions[dimKey]).localeCompare(String(b.dimensions[dimKey])) || String(a.dimensions.currency).localeCompare(String(b.dimensions.currency))));
    }
    /** 商品销售排行：按 sku + 币种聚合数量与商品行净额，只统计下单的行（含后续取消）。 */
    productSales(filters, from, to, snap) {
        const orderCurrency = new Map(snap.orders.map(order => [order.id, order.currency]));
        const acc = new RowAccumulator();
        for (const item of snap.items) {
            const currency = orderCurrency.get(item.orderId) ?? 'UNKNOWN';
            acc.add({ sku: item.sku, productName: item.productName, currency }, {
                quantity: item.quantity,
                placedMinor: item.lineTotalMinor,
                discountMinor: item.lineDiscountMinor,
            });
        }
        return this.result('product_sales', filters, from, to, snap, { lineCount: snap.items.length }, acc.list().sort((a, b) => (b.metrics.placedMinor ?? 0) - (a.metrics.placedMinor ?? 0)));
    }
    /** 库存汇总：可用量 = 在库 - 预留；低库存/缺货按阈值或 0 判定，只读不写。 */
    inventory(filters, from, to, snap) {
        const rows = [];
        let lowCount = 0, outCount = 0;
        for (const row of snap.inventory) {
            const variant = snap.variants.get(row.variantId);
            const threshold = snap.thresholds.get(row.variantId);
            const available = row.onHand - row.reserved;
            const lowLevel = threshold?.lowStockLevel ?? 0;
            if (available <= 0)
                outCount += 1;
            else if (available <= lowLevel)
                lowCount += 1;
            rows.push({ dimensions: { sku: variant?.sku ?? null }, metrics: {
                    onHand: row.onHand, reserved: row.reserved, available, lowStockLevel: lowLevel,
                } });
        }
        return this.result('inventory', filters, from, to, snap, { variantCount: snap.inventory.length, lowStockCount: lowCount, outOfStockCount: outCount }, rows.sort((a, b) => (a.metrics.available ?? 0) - (b.metrics.available ?? 0)));
    }
    /** 优惠券：发放(核销记录数)/核销量/折扣额按券+币种分组，使用率小样本时不展示。 */
    coupons(filters, from, to, snap) {
        const acc = new RowAccumulator();
        let redeemedAll = 0, discountAll = 0;
        for (const redemption of snap.redemptions) {
            const coupon = snap.coupons.get(redemption.couponId);
            const dimensions = { code: coupon?.code ?? redemption.codeSnapshot, currency: redemption.currency };
            const isRedeemed = redemption.status === 'redeemed' && within(redemption.redeemedAt, from, to);
            acc.add(dimensions, {
                reservedCount: 1,
                redeemedCount: isRedeemed ? 1 : 0,
                discountMinor: isRedeemed ? redemption.discountMinor : 0,
            });
            if (isRedeemed) {
                redeemedAll += 1;
                discountAll += redemption.discountMinor;
            }
        }
        // usageRate 是经营聚合指标，用 ratio 即可（分母为 0 时不输出），
        // 不套用小样本阈值——那是 P1 陈列/漏斗场景才需要的保护。
        const rows = acc.list().map(row => {
            const usageRate = ratio(Number(row.metrics.redeemedCount ?? 0), Number(row.metrics.reservedCount ?? 0));
            return usageRate === null ? row : { ...row, metrics: { ...row.metrics, usageRate } };
        });
        return this.result('coupons', filters, from, to, snap, { redeemedCount: redeemedAll, discountMinor: discountAll }, rows);
    }
    /** 会员：注册数、活跃数、积分发放/兑换、等级分布——只聚合不返回任何联系方式或会员号。 */
    members(filters, from, to, snap) {
        let registered = 0, active = 0;
        for (const member of snap.members) {
            if (within(member.joinedAt, from, to))
                registered += 1;
            if (member.status === 'active')
                active += 1;
        }
        let issued = 0, redeemedPoints = 0;
        const tierAcc = new RowAccumulator();
        for (const entry of snap.ledger) {
            if (entry.deltaPoints > 0)
                issued += entry.deltaPoints;
            if (entry.deltaPoints < 0)
                redeemedPoints += Math.abs(entry.deltaPoints);
        }
        for (const member of snap.members) {
            if (member.status !== 'active')
                continue;
            const tier = member.tierId ? snap.tiers.get(member.tierId) : undefined;
            tierAcc.add({ tier: tier?.code ?? 'unassigned' }, { activeMembers: 1 });
        }
        return this.result('members', filters, from, to, snap, { registeredMembers: registered, activeMembers: active, pointsIssued: issued, pointsRedeemed: redeemedPoints,
            lifetimeSpendMinor: 0 }, tierAcc.list().sort((a, b) => String(a.dimensions.tier).localeCompare(String(b.dimensions.tier))));
    }
    /**
     * 访问漏斗（M14 第二批）：访问 → 商品浏览 → 加购 → 开始结账 → 成功下单。
     *
     * 口径：
     * - 前四步来自已同意（granted）的浏览器事件，按 sessionId 去重；purchase 不采信浏览器，
     *   而是用服务端 ShopOrder.cartId join AnalyticsSession.cartId，归因到会话，去重计一次。
     * - 每步会话数是独立去重的集合大小（标准漏斗近似）；阶段转化率用 smallSampleRatio，
     *   分母 < 20 显示"数据不足"（返回 null，前端不渲染百分比），避免反推个体行为。
     * - 匿名 traffic：sessionId 随机，不含 PII；不跨设备/跨会话归因。
     * - 维度分组 groupBy 闭集 {step,device,source,locale,day}，day 按店铺时区归属首见日。
     */
    funnel(filters, from, to, snap) {
        const data = snap.funnel ?? EMPTY_FUNNEL;
        const groupBy = filters.groupBy ?? 'step';
        const sessionById = new Map(data.sessions.map(s => [s.sessionId, s]));
        const orderedCartIds = new Set(data.orders.map(o => o.cartId).filter((c) => Boolean(c)));
        // 每一步的会话集合。eventStep: 事件名 -> sessionId 集合；purchase: 通过 cartId 归因的 sessionId 集合。
        const stepSessions = new Map();
        const touch = (step, id) => {
            let set = stepSessions.get(step);
            if (!set) {
                set = new Set();
                stepSessions.set(step, set);
            }
            set.add(id);
        };
        for (const e of data.events) {
            if (e.eventName !== 'purchase')
                touch(e.eventName, e.sessionId);
        }
        for (const s of data.sessions) {
            if (s.cartId && orderedCartIds.has(s.cartId))
                touch('purchase', s.sessionId);
        }
        const steps = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
        const stepLabels = {
            page_view: '访问', view_item: '商品浏览', add_to_cart: '加入购物车',
            begin_checkout: '开始结账', purchase: '成功下单',
        };
        const bucketOf = (sessionId, step) => {
            const s = sessionById.get(sessionId);
            if (!s)
                return 'unknown';
            switch (groupBy) {
                case 'device': return s.deviceClass ?? 'unknown';
                case 'source': return s.source ?? 'unknown';
                case 'locale': return s.locale ?? 'unknown';
                case 'day': return s.firstSeenAt ? localDay(filters.timezone, s.firstSeenAt) : 'unknown';
                default: return 'unknown';
            }
        };
        const rows = [];
        if (groupBy === 'step') {
            let prev = 0, first = 0;
            for (const step of steps) {
                const count = stepSessions.get(step)?.size ?? 0;
                if (step === steps[0])
                    first = count;
                const metrics = { sessions: count };
                const stepRate = smallSampleRatio(count, prev);
                const overallRate = smallSampleRatio(count, first);
                if (stepRate !== null)
                    metrics.stepRate = stepRate;
                if (overallRate !== null)
                    metrics.overallRate = overallRate;
                rows.push({ dimensions: { step: stepLabels[step] ?? step }, metrics });
                prev = count;
            }
        }
        else {
            // 按维度分桶，每桶内算五步；桶顺序稳定（先出现先输出）。
            const buckets = new Map();
            for (const [step, ids] of stepSessions) {
                for (const id of ids) {
                    const bucket = bucketOf(id, step);
                    let perStep = buckets.get(bucket);
                    if (!perStep) {
                        perStep = new Map();
                        buckets.set(bucket, perStep);
                    }
                    let set = perStep.get(step);
                    if (!set) {
                        set = new Set();
                        perStep.set(step, set);
                    }
                    set.add(id);
                }
            }
            const dimKey = groupBy === 'device' ? 'device' : groupBy === 'source' ? 'source'
                : groupBy === 'locale' ? 'locale' : 'day';
            for (const [bucket, perStep] of buckets) {
                let prev = 0, first = 0;
                for (const step of steps) {
                    const count = perStep.get(step)?.size ?? 0;
                    if (step === steps[0])
                        first = count;
                    const metrics = { sessions: count };
                    const stepRate = smallSampleRatio(count, prev);
                    const overallRate = smallSampleRatio(count, first);
                    if (stepRate !== null)
                        metrics.stepRate = stepRate;
                    if (overallRate !== null)
                        metrics.overallRate = overallRate;
                    rows.push({ dimensions: { [dimKey]: bucket, step: stepLabels[step] ?? step }, metrics });
                    prev = count;
                }
            }
        }
        const totalSessions = new Set();
        for (const ids of stepSessions.values())
            for (const id of ids)
                totalSessions.add(id);
        const purchased = stepSessions.get('purchase')?.size ?? 0;
        const coverage = {
            sourceOrderCount: data.orders.length,
            lastDataAt: data.events.reduce((latest, e) => !latest || e.occurredAt > latest ? e.occurredAt : latest, null),
            complete: data.sessions.length > 0,
            note: `漏斗事件按 sessionId 去重；成功下单由服务端订单 cartId 归因（不采信浏览器 purchase）；` +
                `共 ${data.events.length} 条已同意事件、${data.sessions.length} 个会话、${data.orders.length} 笔订单进入统计；` +
                `阶段转化率分母不足 ${REPORT_MIN_SAMPLE} 显示数据不足。`,
        };
        return {
            reportKey: 'funnel', metricDefinitionVersion: FUNNEL_METRIC_VERSION,
            generatedAt: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(),
            timezone: filters.timezone, currencies: [...new Set(data.orders.map(o => o.currency))].sort(),
            filters: { ...filters }, totals: { sessions: totalSessions.size, sessionsPurchased: purchased, eventCount: data.events.length },
            rows, coverage,
        };
    }
    // ---- 陈列效果（M14 P1）--------------------------------------------------
    /** 陈列归因的筛选：只认匿名区块/页面/发布版本与设备/语言/市场快照。 */
    attributionWhere(filters) {
        return {
            ...(filters.sectionKey ? { sectionKey: filters.sectionKey } : {}),
            ...(filters.pageKey ? { pageKey: filters.pageKey } : {}),
            ...(filters.publishVersionId ? { publishVersionId: filters.publishVersionId } : {}),
            ...(filters.locale ? { locale: filters.locale } : {}),
            ...(filters.deviceClass ? { deviceClass: filters.deviceClass } : {}),
            ...(filters.marketCode ? { marketCode: filters.marketCode } : {}),
        };
    }
    /**
     * 陈列数据源。曝光/点击来自第一方事件；加购来自服务端归因行（浏览器不能直接写）；
     * 订单/净实收只认已归因的订单行，退款按售后明细分摊到订单行，无法关联的退款单独列示。
     */
    async loadPlacement(tx, from, to, filters) {
        const eventFilter = {
            ...(filters.sectionKey ? { sectionKey: filters.sectionKey } : {}),
            ...(filters.pageKey ? { pageKey: filters.pageKey } : {}),
            ...(filters.publishVersionId ? { publishVersionId: filters.publishVersionId } : {}),
            ...(filters.locale ? { locale: filters.locale } : {}),
            ...(filters.deviceClass ? { deviceClass: filters.deviceClass } : {}),
            ...(filters.marketCode ? { marketCode: filters.marketCode } : {}),
        };
        const pageFilter = {
            ...(filters.pageKey ? { pageKey: filters.pageKey } : {}),
            ...(filters.locale ? { locale: filters.locale } : {}),
            ...(filters.deviceClass ? { deviceClass: filters.deviceClass } : {}),
            ...(filters.marketCode ? { marketCode: filters.marketCode } : {}),
        };
        const attributionFilter = this.attributionWhere(filters);
        const [events, pageViews, lastSection, added, attributed] = await Promise.all([
            tx.analyticsEvent.findMany({ where: {
                    occurredAt: { gte: from, lt: to }, consentState: 'granted', environment: 'production',
                    trafficClass: 'human', eventName: { in: ['section_impression', 'section_click'] },
                    sectionKey: { not: null }, ...eventFilter
                } }),
            tx.analyticsEvent.findMany({ where: {
                    occurredAt: { gte: from, lt: to }, consentState: 'granted', environment: 'production',
                    trafficClass: 'human', eventName: 'page_view', ...pageFilter
                }, select: { sessionId: true } }),
            tx.analyticsEvent.findFirst({ where: { eventName: { in: ['section_impression', 'section_click'] },
                    sectionKey: { not: null } }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
            tx.placementAttribution.findMany({ where: { addedAt: { gte: from, lt: to }, ...attributionFilter } }),
            tx.placementAttribution.findMany({ where: { orderItemId: { not: null }, ...attributionFilter,
                    orderItem: { is: { order: { is: { placedAt: { gte: from, lt: to } } } } } },
                include: { orderItem: { include: { order: true } } } }),
        ]);
        const orderIds = [...new Set(attributed.map(row => row.orderItem.orderId))];
        const [payments, refunds, orderItems] = await Promise.all([
            orderIds.length ? tx.payment.findMany({ where: { orderId: { in: orderIds },
                    status: { in: [...PAID_PAYMENT_STATUSES] } }, select: { orderId: true } }) : Promise.resolve([]),
            orderIds.length ? tx.refund.findMany({ where: { orderId: { in: orderIds }, status: REFUNDED_STATUS } }) : Promise.resolve([]),
            orderIds.length ? tx.orderItem.findMany({ where: { orderId: { in: orderIds } } }) : Promise.resolve([]),
        ]);
        const caseIds = refunds.map(refund => refund.caseId).filter((value) => Boolean(value));
        const caseItems = caseIds.length ? await tx.afterSalesItem.findMany({ where: { caseId: { in: caseIds } } }) : [];
        const refundByItem = new Map();
        let unallocatedRefundMinor = 0;
        for (const refund of refunds) {
            const rows = caseItems.filter(item => item.caseId === refund.caseId).map(item => {
                const line = orderItems.find(orderItem => orderItem.id === item.orderItemId);
                const base = item.amountMinor ?? ((item.approvedQuantity ?? item.requestedQuantity) * (line?.unitPriceMinor ?? 0));
                return { id: item.orderItemId, lineTotalMinor: base };
            });
            // 订单级/无售后明细的退款不按比例伪造区块归因，单独列示。
            if (!rows.length) {
                unallocatedRefundMinor += refund.amountMinor;
                continue;
            }
            for (const [id, amount] of allocateRefund(rows, refund.amountMinor)) {
                refundByItem.set(id, (refundByItem.get(id) ?? 0) + amount);
            }
        }
        const paidOrders = new Set(payments.map(payment => payment.orderId));
        return {
            events: events.map(event => ({ sessionId: event.sessionId, eventName: event.eventName,
                pageKey: event.pageKey, sectionId: event.sectionId, sectionKey: event.sectionKey,
                publishVersionId: event.publishVersionId })),
            pageViewSessions: new Set(pageViews.map(event => event.sessionId)).size,
            lastSectionEventAt: lastSection?.occurredAt ?? null,
            added: added.map(row => ({ id: row.id, sessionId: row.sessionId, sectionId: row.sectionId,
                sectionKey: row.sectionKey, pageKey: row.pageKey, publishVersionId: row.publishVersionId,
                currency: null })),
            items: attributed.map(row => ({
                orderItemId: row.orderItem.id, orderId: row.orderItem.orderId,
                lineTotalMinor: row.orderItem.lineTotalMinor, currency: row.orderItem.order.currency,
                placedAt: row.orderItem.order.placedAt, collected: paidOrders.has(row.orderItem.orderId),
                cancelled: row.orderItem.order.orderStatus === CANCELLED_ORDER_STATUS,
                sectionId: row.sectionId, sectionKey: row.sectionKey, pageKey: row.pageKey,
                publishVersionId: row.publishVersionId, sessionId: row.sessionId,
            })),
            refundByItem, unallocatedRefundMinor,
        };
    }
    /**
     * 区块效果报表：按 sectionKey（默认）/ sectionId / page / version 聚合。
     * 阶段转化率分母是该范围内去重后的曝光会话；曝光会话不足 20 时给 insufficientSample=1 且不输出比率。
     * 金额按币种分行：同一区块出现多币种时，会话行不带金额，金额各自成行，绝不跨币种相加。
     */
    placement(filters, from, to, snap) {
        const data = snap.placement ?? EMPTY_PLACEMENT;
        const groupBy = filters.groupBy && ['sectionId', 'page', 'version'].includes(filters.groupBy)
            ? filters.groupBy : 'section';
        const dimKey = groupBy === 'section' ? 'sectionKey' : groupBy === 'sectionId' ? 'sectionId'
            : groupBy === 'page' ? 'page' : 'version';
        const bucketOf = (row) => {
            switch (groupBy) {
                case 'sectionId': return row.sectionId ?? 'unknown';
                case 'page': return row.pageKey ?? 'unknown';
                case 'version': return row.publishVersionId ?? 'unknown';
                default: return row.sectionKey ?? 'unknown';
            }
        };
        const buckets = new Map();
        const bucket = (key) => {
            let row = buckets.get(key);
            if (!row) {
                row = { impressions: new Set(), clicks: 0, clickSessions: new Set(), addToCarts: 0,
                    addSessions: new Set(), orderItems: 0, orders: new Set(), money: new Map() };
                buckets.set(key, row);
            }
            return row;
        };
        for (const event of data.events) {
            if (!event.sectionKey)
                continue;
            const row = bucket(bucketOf(event));
            if (event.eventName === 'section_impression')
                row.impressions.add(impressionKey(event.sessionId, event.pageKey, event.sectionKey));
            else {
                row.clicks += 1;
                row.clickSessions.add(event.sessionId + '\u0000' + (event.pageKey ?? ''));
            }
        }
        for (const added of data.added) {
            const row = bucket(bucketOf(added));
            row.addToCarts += 1;
            if (added.sessionId)
                row.addSessions.add(added.sessionId);
        }
        for (const item of data.items) {
            const row = bucket(bucketOf(item));
            row.orderItems += 1;
            row.orders.add(item.orderId);
            // 只有已收款且未取消的订单进净实收；待收 COD 与取消订单不计。
            if (!item.collected || item.cancelled)
                continue;
            const refund = data.refundByItem.get(item.orderItemId) ?? 0;
            const money = row.money.get(item.currency) ?? { net: 0, refunds: 0 };
            money.net += netRevenueMinor(item.lineTotalMinor, refund);
            money.refunds += Math.max(0, refund);
            row.money.set(item.currency, money);
        }
        const rows = [];
        for (const [key, row] of buckets) {
            const impressionSessions = row.impressions.size;
            const clickSessions = row.clickSessions.size;
            const addSessions = row.addSessions.size;
            const orderCount = row.orders.size;
            const metrics = {
                impressionSessions, clicks: row.clicks, clickSessions,
                addToCarts: row.addToCarts, addSessions, orderItems: row.orderItems, orderCount,
            };
            if (impressionSessions < PLACEMENT_MIN_IMPRESSION_SESSIONS)
                metrics.insufficientSample = 1;
            const clickRate = placementRatio(clickSessions, impressionSessions);
            const addRate = placementRatio(addSessions, impressionSessions);
            const orderRate = placementRatio(orderCount, impressionSessions);
            if (clickRate !== null)
                metrics.clickRate = clickRate;
            if (addRate !== null)
                metrics.addRate = addRate;
            if (orderRate !== null)
                metrics.orderRate = orderRate;
            const currencies = [...row.money.keys()].sort();
            const single = currencies.length === 1 ? currencies[0] : null;
            if (single) {
                metrics.netRevenueMinor = row.money.get(single).net;
                metrics.refundMinor = row.money.get(single).refunds;
            }
            rows.push({ dimensions: { [dimKey]: key, ...(currencies.length === 1 ? { currency: single } : {}) }, metrics });
            if (currencies.length > 1) {
                for (const currency of currencies) {
                    const money = row.money.get(currency);
                    rows.push({ dimensions: { [dimKey]: key, currency },
                        metrics: { netRevenueMinor: money.net, refundMinor: money.refunds } });
                }
            }
        }
        const totals = {
            sections: buckets.size,
            impressionSessions: data.events.filter(e => e.eventName === 'section_impression')
                .reduce((set, e) => set.add(impressionKey(e.sessionId, e.pageKey, e.sectionKey ?? '')), new Set()).size,
            clicks: data.events.filter(e => e.eventName === 'section_click').length,
            addToCarts: data.added.length,
            orderItems: data.items.length,
            orderCount: new Set(data.items.map(item => item.orderId)).size,
            unallocatedRefundMinor: data.unallocatedRefundMinor,
        };
        // 覆盖率判定直接用局部值，避免 Record 索引在严格模式下退化成 number | undefined。
        const impressionTotal = totals['impressionSessions'] ?? 0;
        const orderTotal = totals['orderCount'] ?? 0;
        const currencies = [...new Set(data.items.map(item => item.currency))].sort();
        if (currencies.length === 1) {
            totals.netRevenueMinor = sumMinor(data.items.filter(item => item.collected && !item.cancelled)
                .map(item => netRevenueMinor(item.lineTotalMinor, data.refundByItem.get(item.orderItemId) ?? 0)));
        }
        const coverageStatus = placementCoverage({
            pageViewSessions: data.pageViewSessions,
            impressionSessions: impressionTotal,
            sectionEvents: data.events.length,
            lastSectionEventAt: data.lastSectionEventAt,
            to, now: new Date(),
        });
        return {
            reportKey: 'placement', metricDefinitionVersion: PLACEMENT_METRIC_VERSION,
            generatedAt: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(),
            timezone: filters.timezone, currencies,
            filters: { ...filters }, totals, rows,
            coverage: {
                sourceOrderCount: orderTotal,
                lastDataAt: data.lastSectionEventAt?.toISOString() ?? null,
                complete: coverageStatus.status === 'ok',
                note: `${coverageStatus.note} 曝光按「区块 50% 可见且持续 1 秒」由主题上报并已去重；` +
                    `加购为服务端成功写入购物袋的归因行；订单与净实收只认下单前 24 小时内最后一次区块交互，` +
                    `退款按售后明细分摊，未关联明细的退款单列 ${data.unallocatedRefundMinor} 分。` +
                    `曝光会话少于 ${PLACEMENT_MIN_IMPRESSION_SESSIONS} 时不给阶段转化率。`,
            },
        };
    }
    // ---- 导出任务（M14）--------------------------------------------------------
    /** 把行转成扁平 CSV：前导注释带筛选/时区/币种/口径版本/覆盖状态，随后 totals 与 rows。 */
    toCsv(result, includePii) {
        const lines = exportPreamble(result.filters, result.reportKey, result.currencies, result.generatedAt, `${result.coverage.note} includePii=${includePii}`);
        lines.push(['section', 'dimensions', 'metrics']);
        lines.push(['totals', '', JSON.stringify(result.totals)]);
        for (const row of result.rows) {
            lines.push(['row', JSON.stringify(row.dimensions), JSON.stringify(row.metrics)]);
        }
        return csvDocument(lines);
    }
    /**
     * 创建导出任务：受 reports.export 保护，写操作带 CSRF 与 Idempotency-Key。
     * 同步生成 CSV（数据量受最大跨度约束），任务行落库后返回状态与短时下载 URL。
     * includePii 首期恒为忽略——聚合报表本就没有 PII，即使调用方传 true 也不放大数据面。
     */
    async createExport(supplied, csrf, idempotencyKey, body, ctx) {
        const reportKey = this.rule(() => assertReportKey(body['reportKey']));
        const format = this.rule(() => assertReportFormat(body['format']));
        const { filters } = this.rule(() => normalizeReportFilters(body));
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 128)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const includePii = body['includePii'] === true;
        return this.identity.withPermission(supplied, csrf, 'reports.export', async (tx, actor) => {
            const existing = await tx.reportExport.findUnique({ where: { idempotencyKey } });
            if (existing)
                return this.exportView(existing);
            const result = await this.buildReport(reportKey, filters, tx);
            const content = this.toCsv(result, includePii);
            const now = new Date();
            const expiresAt = new Date(now.getTime() + REPORT_EXPORT_TTL_MINUTES * 60_000);
            const created = await tx.reportExport.create({ data: {
                    id: crypto.randomUUID(), idempotencyKey, requestedBy: actor.id,
                    reportKey, format, status: 'completed', filters: filters,
                    includePii, fileName: `${reportKey}-${now.toISOString().slice(0, 10)}.csv`,
                    rowCount: result.rows.length, content, completedAt: now, expiresAt,
                } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'report.export', created.id, 'success', reportKey);
            return this.exportView(created);
        }, true);
    }
    /** 查询导出任务：受 reports.export 保护，只能看自己发起的任务（与其他管理明细的越权口径一致）。 */
    async getExport(supplied, id) {
        return this.identity.withPermission(supplied, null, 'reports.export', async (tx) => {
            const row = await tx.reportExport.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            return this.exportView(row);
        });
    }
    /** 下载 CSV：校验过期与状态，返回内容供 controller 以 text/csv 写出。 */
    async downloadExport(supplied, id) {
        return this.identity.withPermission(supplied, null, 'reports.export', async (tx) => {
            const row = await tx.reportExport.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            if (row.status !== 'completed' || !row.content)
                throw new AuthError(409, 'STATE_CONFLICT');
            if (row.expiresAt.getTime() <= Date.now())
                throw new AuthError(409, 'EXPORT_EXPIRED');
            return { fileName: row.fileName ?? `${row.reportKey}.csv`, content: row.content };
        });
    }
    exportView(row) {
        const ready = row.status === 'completed' && row.expiresAt.getTime() > Date.now();
        return {
            id: row.id, reportKey: row.reportKey, format: row.format, status: row.status,
            includePii: row.includePii, filters: row.filters,
            fileName: row.fileName, rowCount: row.rowCount, errorCode: row.errorCode,
            downloadUrl: ready ? `/api/v1/admin/report-exports/${row.id}/download` : null,
            createdAt: row.createdAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null,
            expiresAt: row.expiresAt.toISOString(),
        };
    }
}
/** 报表 key 的只读导出（供测试与文档断言）。 */
export const REPORT_KEY_SET = new Set(REPORT_KEYS);
