import { createHash, createHmac, randomUUID } from 'node:crypto';
import { memberHmac } from '../../../../packages/domain/src/members.js';
import { allocateDiscount, assertBatchRecipientCount, assertCouponUsable, assertMemberTierEligible, assertMinSubtotal, assertUsageLimits, couponDiscount, couponSnapshot, eligibleLines, maskCouponCode, memberLimitMaterial, mergeCouponPatch, normalizeBatchIssue, normalizeCoupon, normalizeCouponBatch, PromotionRuleError, } from '../../../../packages/domain/src/promotions.js';
import { AuthError } from '../identity/service.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RULE_CODES = new Set(['COUPON_NOT_FOUND', 'COUPON_DISABLED', 'COUPON_NOT_STARTED', 'COUPON_EXPIRED',
    'COUPON_CURRENCY_MISMATCH', 'COUPON_MIN_SUBTOTAL_NOT_MET', 'COUPON_NOT_APPLICABLE', 'COUPON_LIMIT_REACHED',
    'COUPON_CUSTOMER_LIMIT_REACHED', 'COUPON_MEMBER_ONLY', 'COUPON_CHANGED', 'STATE_CONFLICT',
    'MEMBER_TIER_UNKNOWN', 'MEMBER_TIER_RETIRED', 'BATCH_RECIPIENT_COUNT_CHANGED']);
/**
 * 优惠券（M11）。
 *
 * 三条边界：
 * 1. 券只被报价与下单引用；任何规则修改都不会改写既有订单的金额或快照。
 * 2. 额度只在下单事务里预占，报价只做只读试算——报价成功不代表券一定留到最后。
 * 3. 顾客限额用 HMAC(联系方式)，不落原邮箱/电话；报表与审计都看不到原值。
 */
export class PromotionsService {
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
            if (error instanceof PromotionRuleError)
                throw new AuthError(RULE_CODES.has(error.code) ? 409 : 422, error.code);
            throw error;
        }
    }
    async guarded(fn) {
        try {
            return await fn();
        }
        catch (error) {
            const code = error.code;
            if (code === 'P2002')
                throw new AuthError(409, 'COUPON_CODE_TAKEN');
            if (code === 'P2003')
                throw new AuthError(422, 'VALIDATION_ERROR');
            if (code === 'P2025')
                throw new AuthError(404, 'NOT_FOUND');
            throw error;
        }
    }
    async lock(tx, key) { await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }
    key(value) {
        if (typeof value !== 'string' || value.length < 16 || value.length > 128)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return value;
    }
    ruleOf(row) {
        return { code: row.code, status: row.status,
            discountType: row.discountType, discountValue: row.discountValue,
            currency: row.currency, validFrom: row.validFrom, validUntil: row.validUntil,
            minSubtotalMinor: row.minSubtotalMinor ?? null, totalLimit: row.totalLimit ?? null,
            perCustomerLimit: row.perCustomerLimit ?? null, eligibleProductIds: row.eligibleProductIds,
            eligibleCategoryIds: row.eligibleCategoryIds, memberTierIds: row.memberTierIds,
            refundPolicy: row.refundPolicy };
    }
    /**
     * 访客限额键：实例密钥 HMAC(规范化邮箱或电话)。
     * 邮箱按小写、电话只留数字与开头 +，避免同一顾客因写法不同绕过“每人一次”。
     */
    guestCustomerKey(contact) {
        const material = contact.email !== null
            ? `email:${contact.email.trim().toLowerCase()}`
            : `phone:${(contact.phone ?? '').replace(/[^\d+]/g, '')}`;
        return createHmac('sha256', this.identity.config.encryptionKey)
            .update(`${this.identity.config.instanceId}:coupon:${material}`).digest('hex');
    }
    /**
     * 顾客限额键：登录会员走不可逆 memberId 摘要（跨邮箱/改电话仍是同一人），
     * 访客回退到联系方式 HMAC。两者形状一致（64 位十六进制），可共存于同一列。
     * 由下单链路在报价时调用一次并冻结到报价行，之后不再重算。
     */
    customerKey(contact, memberId) {
        if (memberId !== null) {
            return memberHmac(this.identity.config.encryptionKey, memberLimitMaterial(this.identity.config.instanceId, memberId));
        }
        return this.guestCustomerKey(contact);
    }
    async usage(tx, couponId, customerKey = null) {
        const grouped = await tx.couponRedemption.groupBy({ by: ['status'],
            where: { couponId, ...(customerKey ? { customerKey } : {}) }, _count: { _all: true } });
        const count = (status) => grouped.find(item => item.status === status)?._count._all ?? 0;
        // 返还次数要连表算，Prisma 的 groupBy 表达不了“按券聚合的关联表行数”，这里用两条固定 SQL。
        const returned = customerKey
            ? await tx.$queryRaw `
          SELECT COUNT(*)::bigint AS "count" FROM "CouponQuotaReturn" q
          JOIN "CouponRedemption" r ON r."id" = q."redemptionId"
          WHERE r."couponId" = ${couponId}::uuid AND r."customerKey" = ${customerKey}`
            : await tx.$queryRaw `
          SELECT COUNT(*)::bigint AS "count" FROM "CouponQuotaReturn" q
          JOIN "CouponRedemption" r ON r."id" = q."redemptionId"
          WHERE r."couponId" = ${couponId}::uuid`;
        const returnedCount = Number(returned[0]?.count ?? 0);
        const reservedCount = count('reserved');
        const redeemedCount = count('redeemed');
        return { reservedCount, redeemedCount, releasedCount: count('released'), expiredCount: count('expired'),
            returnedCount, usedCount: reservedCount + redeemedCount - returnedCount };
    }
    view(row, usage) {
        return { id: row.id, code: row.code, codeMasked: maskCouponCode(row.code), status: row.status,
            discountType: row.discountType, discountValue: row.discountValue, currency: row.currency,
            validFrom: row.validFrom.toISOString(), validUntil: row.validUntil.toISOString(),
            minSubtotalMinor: row.minSubtotalMinor ?? null, totalLimit: row.totalLimit ?? null,
            perCustomerLimit: row.perCustomerLimit ?? null, eligibleProductIds: row.eligibleProductIds,
            eligibleCategoryIds: row.eligibleCategoryIds, memberTierIds: row.memberTierIds,
            refundPolicy: row.refundPolicy, version: row.version, createdBy: row.createdBy ?? null,
            createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), usage };
    }
    async list(supplied, limit, cursor, filters) {
        const q = filters.q ?? null;
        if (q !== null && (typeof q !== 'string' || q.length > 80))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const status = filters.status ?? null;
        if (status !== null && status !== 'active' && status !== 'disabled')
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.identity.withPermission(supplied, null, 'coupons.read', async (tx) => {
            if (cursor && !await tx.coupon.findUnique({ where: { id: cursor } }))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const rows = await tx.coupon.findMany({ where: { ...(status ? { status } : {}),
                    ...(q ? { code: { contains: q.trim().toUpperCase() } } : {}) },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            const visible = rows.slice(0, limit);
            const hasMore = rows.length > limit;
            return { items: await Promise.all(visible.map(async (row) => this.view(row, await this.usage(tx, row.id)))),
                hasMore, nextCursor: hasMore ? visible.at(-1).id : null };
        });
    }
    async get(supplied, id) {
        if (!UUID.test(id))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.identity.withPermission(supplied, null, 'coupons.read', async (tx) => {
            const row = await tx.coupon.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            return this.view(row, await this.usage(tx, id));
        });
    }
    async baseCurrency(tx) {
        const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
        return row?.baseCurrency ?? 'HKD';
    }
    async create(supplied, csrf, body, ctx) {
        return this.guarded(() => this.identity.withPermission(supplied, csrf, 'coupons.manage', async (tx, actor, _s, now) => {
            const currency = await this.baseCurrency(tx);
            const input = this.rule(() => normalizeCoupon(body, currency));
            await this.assertTiers(tx, input);
            const row = await tx.coupon.create({ data: { ...input, createdBy: actor.id, createdAt: now, updatedAt: now } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'coupon.created', row.id, 'success', row.code);
            return this.view(row, await this.usage(tx, row.id));
        }));
    }
    /**
     * 会员专属券：等级必须真实存在且处于 active。退役等级不能分配给新券，
     * 否则会建出一张永远无法被满足的资格条件。空数组表示公开券，不做校验。
     */
    async assertTiers(tx, input) {
        if (!input.memberTierIds.length)
            return;
        const rows = await tx.membershipTier.findMany({ where: { id: { in: input.memberTierIds } } });
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const id of input.memberTierIds) {
            const row = byId.get(id);
            if (!row)
                throw new AuthError(422, 'MEMBER_TIER_UNKNOWN');
            if (row.status !== 'active')
                throw new AuthError(422, 'MEMBER_TIER_RETIRED');
        }
    }
    async update(supplied, csrf, id, expectedVersion, body, ctx) {
        if (!UUID.test(id))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.guarded(() => this.identity.withPermission(supplied, csrf, 'coupons.manage', async (tx, actor, _s, now) => {
            await this.lock(tx, `coupon:${id}`);
            const row = await tx.coupon.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            if (row.version !== expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const input = this.rule(() => mergeCouponPatch(this.ruleOf(row), body));
            await this.assertTiers(tx, input);
            await tx.coupon.update({ where: { id }, data: { ...input, updatedAt: now, version: { increment: 1 } } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'coupon.updated', id, 'success', input.code);
            const updated = await tx.coupon.findUniqueOrThrow({ where: { id } });
            return this.view(updated, await this.usage(tx, id));
        }));
    }
    /** 停用本身幂等：重复调用只是确认它仍然停用，不会因为重试多出第二条审计。 */
    async disable(supplied, csrf, id, idempotencyKey, body, ctx) {
        if (!UUID.test(id))
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.key(idempotencyKey);
        const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
        if (!reason.length || reason.length > 500)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.guarded(() => this.identity.withPermission(supplied, csrf, 'coupons.manage', async (tx, actor, _s, now) => {
            await this.lock(tx, `coupon:${id}`);
            const row = await tx.coupon.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            if (row.status !== 'disabled') {
                await tx.coupon.update({ where: { id }, data: { status: 'disabled', updatedAt: now, version: { increment: 1 } } });
                await this.identity.recordAudit(tx, ctx, actor.id, 'coupon.disabled', id, 'success', reason);
            }
            const updated = await tx.coupon.findUniqueOrThrow({ where: { id } });
            return this.view(updated, await this.usage(tx, id));
        }));
    }
    async redemptions(supplied, id, limit, cursor) {
        if (!UUID.test(id))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.identity.withPermission(supplied, null, 'coupons.read', async (tx) => {
            const coupon = await tx.coupon.findUnique({ where: { id } });
            if (!coupon)
                throw new AuthError(404, 'NOT_FOUND');
            if (cursor && !await tx.couponRedemption.findUnique({ where: { id: cursor } }))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const rows = await tx.couponRedemption.findMany({ where: { couponId: id },
                include: { order: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            const visible = rows.slice(0, limit);
            const hasMore = rows.length > limit;
            return { items: visible.map(row => this.redemptionView(row)), hasMore,
                nextCursor: hasMore ? visible.at(-1).id : null };
        });
    }
    redemptionView(row) {
        return { id: row.id, orderId: row.orderId, publicOrderNumber: row.order.publicOrderNumber,
            status: row.status, discountMinor: row.discountMinor, currency: row.currency,
            // 只出示不可逆摘要的前 8 位，够客服定位、又不构成联系方式泄露。
            customerRef: row.customerKey ? row.customerKey.slice(0, 8) : null,
            reservedAt: row.reservedAt.toISOString(), redeemedAt: row.redeemedAt?.toISOString() ?? null,
            releasedAt: row.releasedAt?.toISOString() ?? null, expiresAt: row.expiresAt?.toISOString() ?? null,
            ruleVersion: row.ruleSnapshot.ruleVersion ?? null };
    }
    /**
     * 报价试算：只读，不占额度。返回按行的折扣分摊与完整规则快照，
     * 报价响应只暴露 codeMasked 与折扣金额。
     */
    async priceQuote(tx, input) {
        if (input.code === null)
            return null;
        const row = await tx.coupon.findUnique({ where: { code: input.code } });
        if (!row)
            throw new AuthError(409, 'COUPON_NOT_FOUND');
        const rule = this.ruleOf(row);
        // 会员专属券：校验当前顾客等级是否命中；访客或无等级会员用 null，专属券会明确拒绝。
        this.rule(() => assertMemberTierEligible(rule, input.memberTierId ?? null));
        this.rule(() => assertCouponUsable(rule, input.now, input.currency));
        const subtotal = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
        this.rule(() => assertMinSubtotal(rule, subtotal));
        const eligible = eligibleLines(rule, input.lines);
        if (!eligible.length)
            throw new AuthError(409, 'COUPON_NOT_APPLICABLE');
        const eligibleSubtotal = eligible.reduce((sum, line) => sum + line.amountMinor, 0);
        const discountMinor = this.rule(() => couponDiscount(rule, eligibleSubtotal));
        if (discountMinor < 1)
            throw new AuthError(409, 'COUPON_NOT_APPLICABLE');
        const customerKey = this.customerKey(input.contact, input.memberId ?? null);
        const totalUsage = await this.usage(tx, row.id);
        const customerUsage = await this.usage(tx, row.id, customerKey);
        this.rule(() => assertUsageLimits(row, totalUsage.usedCount, customerUsage.usedCount));
        const allocations = this.rule(() => allocateDiscount(eligible.map(line => ({ key: line.key, amountMinor: line.amountMinor })), discountMinor));
        const lineDiscounts = new Map(input.lines.map(line => [line.key, allocations.get(line.key) ?? 0]));
        return { coupon: row, couponId: row.id, couponCode: row.code, discountMinor, lineDiscounts,
            summary: { codeMasked: maskCouponCode(row.code), discountMinor },
            snapshot: couponSnapshot({ ...rule, id: row.id, version: row.version }, discountMinor),
            ruleVersion: `coupon:${row.id}:v${row.version}`, customerKey };
    }
    /**
     * 下单时对会员专属券的资格复核。报价时命中等级、下单时会话失效或等级被改，
     * 都会让 tierId 落空或与券要求不符，从而拒绝——不能沿用已经不属于该顾客的折扣。
     */
    async assertRedemptionEligible(tx, row, tierId) {
        if (!row.memberTierIds.length)
            return;
        const tiers = await tx.membershipTier.findMany({ where: { id: { in: row.memberTierIds } } });
        const candidates = tiers.filter(tier => tier.status === 'active').map(tier => tier.id);
        // 只把仍为 active 的等级当作有效资格；退役等级不再授予新折扣。
        this.rule(() => assertMemberTierEligible({ memberTierIds: candidates }, tierId));
    }
    /**
     * 下单事务内预占。调用方必须已经写下订单行（金额来自报价快照），
     * 这里只做“券还可用吗”的复核与额度预占，任何不一致都会让整个订单回滚。
     */
    async reserve(tx, input) {
        const { priced } = input;
        await this.lock(tx, `coupon:${priced.couponId}`);
        const row = await tx.coupon.findUnique({ where: { id: priced.couponId } });
        if (!row)
            throw new AuthError(409, 'COUPON_NOT_FOUND');
        if (row.version !== priced.coupon.version)
            throw new AuthError(409, 'COUPON_CHANGED');
        const rule = this.ruleOf(row);
        this.rule(() => assertCouponUsable(rule, input.now, priced.coupon.currency));
        const totalUsage = await this.usage(tx, row.id);
        const customerUsage = await this.usage(tx, row.id, input.customerKey);
        this.rule(() => assertUsageLimits(row, totalUsage.usedCount, customerUsage.usedCount));
        const digest = createHash('sha256').update(`coupon.reserve\n${priced.couponId}\n${input.orderId}`).digest('hex');
        const redemption = await tx.couponRedemption.create({ data: { couponId: row.id, orderId: input.orderId,
                status: 'reserved', discountMinor: priced.discountMinor, currency: row.currency, customerKey: input.customerKey,
                codeSnapshot: row.code, ruleSnapshot: priced.snapshot,
                dedupeKey: `coupon:reserve:${digest}`, reservedAt: input.now, expiresAt: input.expiresAt } });
        // 预占也要留事件：否则“这张券什么时候被占住”只能靠列上的时间猜。
        await tx.couponRedemptionEvent.create({ data: { redemptionId: redemption.id, fromStatus: null,
                toStatus: 'reserved', reason: 'order_reserved', actorType: 'customer', actorId: null,
                dedupeKey: `coupon:${redemption.id}:reserved`, createdAt: input.now } });
        return redemption;
    }
    /**
     * 批量发放（M11 解锁，依赖 M10 会员目录）。建批只登记意图并计算冻结收件人数，
     * 真正发放必须再走 issue 复核人数。名单与筛选都解析成具体的会员 id 列表。
     */
    async createBatch(supplied, csrf, body, ctx) {
        return this.guarded(() => this.identity.withPermission(supplied, csrf, 'coupons.issue', async (tx, actor, _s, now) => {
            const input = this.rule(() => normalizeCouponBatch(body));
            const coupon = await tx.coupon.findUnique({ where: { id: input.couponId } });
            if (!coupon)
                throw new AuthError(404, 'NOT_FOUND');
            const memberIds = await this.resolveRecipients(tx, input);
            // 建批端契约不接收幂等键：批次本身即一次性管理对象，用自身 id 派生唯一键即可。
            const batchId = randomUUID();
            const row = await tx.couponBatch.create({ data: {
                    id: batchId, couponId: input.couponId, channel: input.channel,
                    recipientMemberIds: memberIds,
                    ...(input.recipientFilter ? { recipientFilter: input.recipientFilter } : {}),
                    recipientCount: memberIds.length, status: 'pending', templateId: input.templateId,
                    idempotencyKey: `batch:${batchId}`, createdBy: actor.id, createdAt: now, updatedAt: now,
                } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'coupon.batch.created', row.id, 'success', `${coupon.code}:${memberIds.length}`);
            return this.batchView(row);
        }));
    }
    /** 名单是显式 id，逐个校验存在；筛选按等级取 active 会员。返回去重后的具体 id 列表。 */
    async resolveRecipients(tx, input) {
        if (input.recipientMemberIds.length) {
            const rows = await tx.memberProfile.findMany({ where: { id: { in: input.recipientMemberIds } } });
            if (rows.length !== input.recipientMemberIds.length)
                throw new AuthError(422, 'BATCH_MEMBER_UNKNOWN');
            return [...input.recipientMemberIds];
        }
        const tierIds = input.recipientFilter.memberTierIds;
        const rows = await tx.memberProfile.findMany({ where: { status: 'active', tierId: { in: tierIds } } });
        return rows.map(row => row.id);
    }
    /**
     * 发放：用建批时冻结的人数复核，确认数不一致要求重建批次（不就地改名单）。
     * 幂等键保证同一批次只发放一次；重复发放返回原结果，不做第二次写入或审计。
     */
    async issueBatch(supplied, csrf, id, idempotencyKey, body, ctx) {
        if (!UUID.test(id))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const key = this.key(idempotencyKey);
        const input = this.rule(() => normalizeBatchIssue(body));
        return this.guarded(() => this.identity.withPermission(supplied, csrf, 'coupons.issue', async (tx, actor, _s, now) => {
            await this.lock(tx, `coupon-batch:${id}`);
            const row = await tx.couponBatch.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            if (row.status === 'issued')
                return this.batchView(row);
            this.rule(() => assertBatchRecipientCount(row.recipientCount, input.confirmedRecipientCount));
            await tx.couponBatch.update({ where: { id }, data: { status: 'issued', confirmedRecipientCount: input.confirmedRecipientCount,
                    issuedAt: now, updatedAt: now } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'coupon.batch.issued', id, 'success', `${row.recipientCount}:${row.channel}`);
            return this.batchView(await tx.couponBatch.findUniqueOrThrow({ where: { id } }));
        }));
    }
    batchView(row) {
        return { id: row.id, couponId: row.couponId, channel: row.channel,
            recipientCount: row.recipientCount, recipientMemberIds: row.recipientMemberIds,
            status: row.status, confirmedRecipientCount: row.confirmedRecipientCount,
            templateId: row.templateId, idempotencyKey: row.idempotencyKey,
            createdBy: row.createdBy ?? null, createdAt: row.createdAt.toISOString(),
            issuedAt: row.issuedAt?.toISOString() ?? null };
    }
}
