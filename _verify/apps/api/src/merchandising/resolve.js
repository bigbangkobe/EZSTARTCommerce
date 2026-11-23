import { rankCandidates, visibleLimit, } from '../../../../packages/domain/src/merchandising.js';
export const includeProduct = { translations: true, variants: { include: { inventory: true } }, media: true };
export function sellableWhere(scope, extra = []) {
    return {
        status: 'active',
        marketCodes: { has: scope.marketCode },
        AND: [
            { OR: [{ publishedAt: null }, { publishedAt: { lte: scope.now } }] },
            ...(scope.eligibleProductIds.length ? [{ id: { in: [...scope.eligibleProductIds] } }] : []),
            // 页面级分类范围在这里统一收口：陈列、手工位、平铺商品三条路径共用同一个口径，
            // 少写一处就会让分类页混进别的分类商品。
            ...(scope.categoryIds?.length ? [{ categories: { some: { categoryId: { in: [...scope.categoryIds] } } } }] : []),
            ...(scope.collectionIds?.length ? [{ collections: { some: { collectionId: { in: [...scope.collectionIds] } } } }] : []),
            ...extra,
        ],
    };
}
/** 候选池上限：动态区块只需要「足够补满展示位」的候选，不把整站商品读进内存。 */
const POOL_LIMIT = 120;
export async function sellablePool(tx, scope, categoryIds, collectionId = null) {
    // 页面级范围（scope）与区块级范围是「与」的关系：分类页里的动态区块只能在该分类内再筛，
    // 专题页里的动态区块同理只能在该专题内再筛。
    const filters = [
        ...(categoryIds.length ? [{ categories: { some: { categoryId: { in: [...categoryIds] } } } }] : []),
        ...(collectionId ? [{ collections: { some: { collectionId } } }] : []),
    ];
    return tx.product.findMany({
        where: sellableWhere(scope, filters),
        include: includeProduct,
        // 池子按创建时间截断不会漏掉新品：newest 排序的候选一定在最近的 120 件里。
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: POOL_LIMIT,
    });
}
/**
 * 手工区块按 id 取商品：只取仍可售的那些，其余记为缺位交给后台修复。
 * 分类页的页面级范围在这里也生效——手工位不能把别的分类商品带上分类页
 * （保存时已按分类校验，这里只是兜住「保存后商品被移出分类」的情况）。
 */
export async function sellableByIds(tx, scope, ids) {
    if (!ids.length)
        return [];
    return tx.product.findMany({ where: sellableWhere(scope, [{ id: { in: [...ids] } }]), include: includeProduct });
}
/**
 * 近 30 天已履约销量：只计已发货/已完成订单的件数，取消与未付款不算，
 * 成功退款按退回件数冲减（规格 5.4）。刷单买不到排名。
 */
export async function fulfilledSales30d(tx, ids, now) {
    if (!ids.length)
        return new Map();
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const rows = await tx.$queryRaw `
    WITH sold AS (
      SELECT v."productId" AS product_id, SUM(oi."quantity") AS units
      FROM "OrderItem" oi
      JOIN "ProductVariant" v ON v."id" = oi."variantId"
      JOIN "ShopOrder" o ON o."id" = oi."orderId"
      WHERE o."paymentStatus" = 'paid'
        AND o."fulfillmentStatus" IN ('fulfilled', 'delivered')
        AND o."placedAt" >= ${since}
        AND v."productId" = ANY(${[...ids]}::uuid[])
      GROUP BY v."productId"
    ), returned AS (
      SELECT v."productId" AS product_id,
             SUM(COALESCE(asi."approvedQuantity", asi."requestedQuantity")) AS units
      FROM "AfterSalesItem" asi
      JOIN "AfterSalesCase" c ON c."id" = asi."caseId"
      JOIN "OrderItem" oi ON oi."id" = asi."orderItemId"
      JOIN "ProductVariant" v ON v."id" = oi."variantId"
      WHERE c."status" = 'refunded' AND v."productId" = ANY(${[...ids]}::uuid[])
      GROUP BY v."productId"
    )
    SELECT sold.product_id, GREATEST(sold.units - COALESCE(returned.units, 0), 0) AS units
    FROM sold LEFT JOIN returned ON returned.product_id = sold.product_id`;
    return new Map(rows.map(row => [row.product_id, Number(row.units)]));
}
/** 商品最低可售变体价（分）；没有可售变体时为 null，排序时排到最后。 */
export function priceMinorOf(row) {
    const prices = row.variants.filter(variant => variant.status === 'active').map(variant => variant.priceMinor);
    return prices.length ? Math.min(...prices) : null;
}
export function candidateOf(row, units) {
    return { productId: row.id, publishedAt: row.publishedAt, priceMinor: priceMinorOf(row), unitsSold: units };
}
/**
 * 按区块配置挑商品：
 * - manual：按配置顺序取，跳过不合格的（不补位——手工区块的意义就是运营挑的那几件）；
 * - 动态：候选池里不合格商品根本进不来，排序后取前 limit 件，因此会自动补足。
 */
export function selectProducts(section, pool, units, eligibleIds) {
    const limit = visibleLimit(section);
    if (section.sortMode === 'manual') {
        const byId = new Map(pool.map(row => [row.id, row]));
        const rows = [];
        const missing = [];
        for (const id of section.productIds) {
            const row = byId.get(id);
            if (!row || !eligibleIds.has(id)) {
                missing.push(id);
                continue;
            }
            if (rows.length < limit)
                rows.push(row);
        }
        return { rows, missing };
    }
    const ranked = rankCandidates(pool.map(row => candidateOf(row, units.get(row.id) ?? 0)), section.sortMode);
    const byId = new Map(pool.map(row => [row.id, row]));
    return { rows: ranked.slice(0, limit).map(candidate => byId.get(candidate.productId)).filter(Boolean), missing: [] };
}
