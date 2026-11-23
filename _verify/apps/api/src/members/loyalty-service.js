import { randomUUID } from 'node:crypto';
import { applyDelta, dueExpiry, earnPoints, expiryDate, LOYALTY_REDEEM_RULE_VERSION, LOYALTY_RULE_VERSION, LoyaltyRuleError, normalizeAdjustment, normalizeSettingPatch, normalizeTierInput, normalizeTierPatch, resolveTier, } from '../../../../packages/domain/src/loyalty.js';
import { maskEmail } from '../../../../packages/domain/src/orders.js';
import { AuthError } from '../identity/service.js';
import { resolveMemberSession } from './session.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 积分余额不足在业务上是 409（与"参数不合法"区分开），其余规则错误都是 422。 */
const CONFLICT_CODES = new Set(['POINT_BALANCE_INSUFFICIENT', 'EMPTY_PATCH', 'TIER_RANK_TAKEN', 'TIER_CODE_TAKEN']);
/**
 * 会员等级与积分（M10 第二批）。
 *
 * 三条边界：
 * 1. 余额只能由追加流水改变：账户与流水在同一事务里写，流水表由触发器拒绝改删。
 * 2. 同一业务事件只记一次账：发放用 `order:{id}:earn`，人工调整用 `admin-adjust:{幂等键}`，
 *    重复提交返回同一笔，而不是再加一笔。
 * 3. 等级与口径都只是配置：改规则不影响历史账，流水里留着 `ruleVersion`。
 */
export class LoyaltyService {
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
            if (error instanceof LoyaltyRuleError) {
                throw new AuthError(CONFLICT_CODES.has(error.code) ? 409 : 422, error.code);
            }
            throw error;
        }
    }
    async lock(tx, key) { await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }
    // ---- 视图 ---------------------------------------------------------------
    settingView(row) {
        return { enabled: row.enabled, minorPerPoint: row.minorPerPoint, pointsExpiryMonths: row.pointsExpiryMonths,
            version: row.version, updatedAt: row.updatedAt.toISOString() };
    }
    tierView(row) {
        return { id: row.id, code: row.code, nameByLocale: row.nameByLocale, rank: row.rank,
            minLifetimeSpendMinor: Number(row.minLifetimeSpendMinor), minorPerPoint: row.minorPerPoint,
            benefits: row.benefits, status: row.status, version: row.version,
            createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    }
    ledgerView(row) {
        return { id: row.id, deltaPoints: row.deltaPoints, balanceAfter: row.balanceAfter, entryType: row.entryType,
            sourceType: row.sourceType, sourceRef: row.sourceRef, reasonCode: row.reasonCode, reason: row.reason,
            ruleVersion: row.ruleVersion, createdAt: row.createdAt.toISOString() };
    }
    /** 店铺口径行恒存在（迁移里插入 id=1）；这里再 upsert 一次，避免空库直连测试时读到 null。 */
    async setting(tx, now) {
        const existing = await tx.loyaltySetting.findUnique({ where: { id: 1 } });
        if (existing)
            return existing;
        return tx.loyaltySetting.create({ data: { id: 1, ...(now ? { updatedAt: now } : {}) } });
    }
    // ---- 后台：等级与口径 ---------------------------------------------------
    async adminOverview(supplied) {
        return this.identity.withPermission(supplied, null, 'members.manage', async (tx) => {
            const setting = await this.setting(tx);
            const tiers = await tx.membershipTier.findMany({ orderBy: { rank: 'asc' } });
            return { settings: this.settingView(setting), tiers: tiers.map(row => this.tierView(row)) };
        });
    }
    async updateSettings(supplied, csrfToken, expectedVersion, body, ctx) {
        return this.identity.withPermission(supplied, csrfToken, 'members.manage', async (tx, actor, _session, now) => {
            const patch = this.rule(() => normalizeSettingPatch(body));
            const current = await this.setting(tx, now);
            if (current.version !== expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const row = await tx.loyaltySetting.update({ where: { id: 1 },
                data: { ...patch, updatedAt: now, version: { increment: 1 } } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'loyalty.settings.updated', 'loyalty', 'success', Object.keys(patch).join(','));
            return this.settingView(row);
        });
    }
    async createTier(supplied, csrfToken, body, ctx) {
        return this.identity.withPermission(supplied, csrfToken, 'members.manage', async (tx, actor, _session, now) => {
            const input = this.rule(() => normalizeTierInput(body));
            // rank 与 code 都是唯一键：先查再插能把"哪个冲突了"说清楚，而不是笼统的 409。
            await this.lock(tx, 'loyalty-tiers');
            if (await tx.membershipTier.findUnique({ where: { code: input.code } }))
                throw new AuthError(409, 'TIER_CODE_TAKEN');
            if (await tx.membershipTier.findUnique({ where: { rank: input.rank } }))
                throw new AuthError(409, 'TIER_RANK_TAKEN');
            const row = await tx.membershipTier.create({ data: { code: input.code, nameByLocale: input.nameByLocale,
                    rank: input.rank, minLifetimeSpendMinor: BigInt(input.minLifetimeSpendMinor), minorPerPoint: input.minorPerPoint,
                    benefits: input.benefits, status: input.status, createdAt: now, updatedAt: now } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'loyalty.tier.created', row.id, 'success', input.code);
            return this.tierView(row);
        });
    }
    async updateTier(supplied, csrfToken, id, expectedVersion, body, ctx) {
        if (!UUID.test(id))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.identity.withPermission(supplied, csrfToken, 'members.manage', async (tx, actor, _session, now) => {
            const patch = this.rule(() => normalizeTierPatch(body));
            await this.lock(tx, 'loyalty-tiers');
            const row = await tx.membershipTier.findUnique({ where: { id } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            if (row.version !== expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            if (patch.code && patch.code !== row.code && await tx.membershipTier.findUnique({ where: { code: patch.code } })) {
                throw new AuthError(409, 'TIER_CODE_TAKEN');
            }
            if (patch.rank && patch.rank !== row.rank && await tx.membershipTier.findUnique({ where: { rank: patch.rank } })) {
                throw new AuthError(409, 'TIER_RANK_TAKEN');
            }
            const updated = await tx.membershipTier.update({ where: { id },
                data: { ...(patch.code === undefined ? {} : { code: patch.code }),
                    ...(patch.nameByLocale === undefined ? {} : { nameByLocale: patch.nameByLocale }),
                    ...(patch.rank === undefined ? {} : { rank: patch.rank }),
                    ...(patch.minLifetimeSpendMinor === undefined ? {} : { minLifetimeSpendMinor: BigInt(patch.minLifetimeSpendMinor) }),
                    ...(patch.minorPerPoint === undefined ? {} : { minorPerPoint: patch.minorPerPoint }),
                    ...(patch.benefits === undefined ? {} : { benefits: patch.benefits }),
                    ...(patch.status === undefined ? {} : { status: patch.status }),
                    updatedAt: now, version: { increment: 1 } } });
            // 退役等级不主动清空会员归属：历史归属要留着，等级重新启用即可复原。
            await this.identity.recordAudit(tx, ctx, actor.id, 'loyalty.tier.updated', id, 'success', Object.keys(patch).join(','));
            return this.tierView(updated);
        });
    }
    // ---- 后台：人工调整 -----------------------------------------------------
    /**
     * 人工调整积分：必须带幂等键与原因。
     *
     * 幂等键冲突时不是简单返回旧记录，而是先核对请求内容：同一个键配不同金额说明调用方
     * 用错了键，这时返回 409 比"悄悄按旧结果成功"更安全。
     */
    async adjustPoints(supplied, csrfToken, memberId, idempotencyKey, body, ctx) {
        if (!UUID.test(memberId))
            throw new AuthError(422, 'VALIDATION_ERROR');
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
            throw new AuthError(422, 'VALIDATION_ERROR');
        }
        return this.identity.withPermission(supplied, csrfToken, 'points.adjust', async (tx, actor, _session, now) => {
            const input = this.rule(() => normalizeAdjustment(body));
            const key = `admin-adjust:${idempotencyKey}`;
            await this.lock(tx, `member-points:${memberId}`);
            // 先清出到期积分再算可用余额：过期的点不能拿来抵扣。
            await sweepExpiredPointsInTx(tx, memberId, now);
            const replay = await tx.pointLedger.findUnique({ where: { idempotencyKey: key } });
            if (replay) {
                if (replay.memberId !== memberId || replay.deltaPoints !== input.deltaPoints) {
                    throw new AuthError(409, 'IDEMPOTENCY_KEY_REUSED');
                }
                return this.ledgerView(replay);
            }
            const member = await tx.memberProfile.findUnique({ where: { id: memberId } });
            if (!member)
                throw new AuthError(404, 'NOT_FOUND');
            const account = await this.account(tx, memberId, now);
            const balance = this.rule(() => applyDelta(account.balance, input.deltaPoints));
            await tx.pointAccount.update({ where: { id: account.id }, data: { balance, updatedAt: now, version: { increment: 1 } } });
            const row = await tx.pointLedger.create({ data: { id: randomUUID(), memberId, deltaPoints: input.deltaPoints,
                    balanceAfter: balance, entryType: 'adjust', sourceType: 'manual', reasonCode: input.reasonCode,
                    reason: input.reason, actorId: actor.id, ruleVersion: LOYALTY_RULE_VERSION, idempotencyKey: key, createdAt: now } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'member.points.adjusted', memberId, 'success', `${input.deltaPoints}:${input.reasonCode}`);
            return this.ledgerView(row);
        });
    }
    async account(tx, memberId, now) {
        const existing = await tx.pointAccount.findUnique({ where: { memberId } });
        if (existing)
            return existing;
        return tx.pointAccount.create({ data: { memberId, createdAt: now, updatedAt: now } });
    }
    // ---- 后台：某位会员的账 ------------------------------------------------
    /**
     * 后台读某位会员的积分账（余额 + 最近流水）。
     *
     * 读只要 members.manage，与调整的 points.adjust 分开：能看见账不等于能改账。
     * 顾客邮箱按 customers.read_pii 决定给原文还是遮蔽值，与会员列表口径一致。
     */
    async adminMemberPoints(supplied, memberId, limit, cursor) {
        if (!UUID.test(memberId))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return this.identity.withPermission(supplied, null, 'members.manage', async (tx, actor) => {
            const member = await tx.memberProfile.findUnique({ where: { id: memberId },
                include: { customer: true, tier: true } });
            if (!member)
                throw new AuthError(404, 'NOT_FOUND');
            // 读也要先清到期：否则「账上 500 点」里有一部分其实已经不能用了。
            await sweepExpiredPointsInTx(tx, memberId, new Date());
            if (cursor && !await tx.pointLedger.findFirst({ where: { id: cursor, memberId } })) {
                throw new AuthError(422, 'VALIDATION_ERROR');
            }
            const rows = await tx.pointLedger.findMany({ where: { memberId },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            const visible = rows.slice(0, limit);
            const hasMore = rows.length > limit;
            const account = await tx.pointAccount.findUnique({ where: { memberId } });
            const setting = await this.setting(tx);
            const pii = this.identity.hasPermission(actor, 'customers.read_pii');
            return {
                member: { id: member.id, memberNo: member.memberNo, status: member.status,
                    joinedAt: member.joinedAt.toISOString(), lifetimeSpendMinor: Number(member.lifetimeSpendMinor),
                    tier: member.tier === null ? null : { id: member.tier.id, code: member.tier.code,
                        rank: member.tier.rank, nameByLocale: member.tier.nameByLocale },
                    customer: { id: member.customer.id, displayName: member.customer.displayName,
                        email: member.customer.emailNormalized === null ? null
                            : pii ? member.customer.emailNormalized : maskEmail(member.customer.emailNormalized) } },
                balance: account?.balance ?? 0, accountStatus: account?.status ?? 'active',
                minorPerPoint: member.tier?.minorPerPoint ?? setting.minorPerPoint,
                enabled: setting.enabled,
                items: visible.map(row => this.ledgerView(row)), hasMore, nextCursor: hasMore ? visible.at(-1).id : null
            };
        });
    }
    // ---- 前台：本人积分 -----------------------------------------------------
    /** 会员只看自己的账：余额、等级与最近流水。 */
    async memberPoints(token, limit, cursor) {
        return this.db.$transaction(async (tx) => {
            const { member, now } = await resolveMemberSession(tx, token);
            // 读到期的账：清扫在同一个事务里完成，前端拿到的余额与流水永远是一致的。
            await sweepExpiredPointsInTx(tx, member.id, now);
            const setting = await this.setting(tx);
            const tier = member.tierId === null ? null : await tx.membershipTier.findUnique({ where: { id: member.tierId } });
            if (cursor && !await tx.pointLedger.findFirst({ where: { id: cursor, memberId: member.id } })) {
                throw new AuthError(422, 'VALIDATION_ERROR');
            }
            const rows = await tx.pointLedger.findMany({ where: { memberId: member.id },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            const visible = rows.slice(0, limit);
            const hasMore = rows.length > limit;
            const account = await tx.pointAccount.findUnique({ where: { memberId: member.id } });
            return { balance: account?.balance ?? 0, accountStatus: account?.status ?? 'active',
                lifetimeSpendMinor: Number(member.lifetimeSpendMinor),
                tier: tier === null ? null : { code: tier.code, rank: tier.rank, nameByLocale: tier.nameByLocale,
                    benefits: tier.benefits, minorPerPoint: tier.minorPerPoint ?? setting.minorPerPoint },
                minorPerPoint: tier?.minorPerPoint ?? setting.minorPerPoint,
                pointsExpiryMonths: setting.pointsExpiryMonths, enabled: setting.enabled,
                items: visible.map(row => this.ledgerView(row)), hasMore, nextCursor: hasMore ? visible.at(-1).id : null };
        });
    }
}
/**
 * 订单完成时的积分发放（在调用方事务内执行）。
 *
 * 只有「会员订单」才积分：访客订单没有会员归属，不按邮箱反推——邮箱匹配已经在登录时
 * 通过 OrderMemberLink 建立了关系，这里只认已经建立的关联。
 *
 * 口径：按本次订单的商品金额（小计减折扣）除以该会员**当时**等级的换算率，
 * 向下取整；等级升级只影响之后的订单。累计消费与等级归属在同一事务推进，
 * 幂等键 `order:{id}:earn` 保证重复调用不会重复发放。
 */
export async function awardOrderPointsInTx(tx, orderId, now) {
    const order = await tx.shopOrder.findUnique({ where: { id: orderId } });
    if (!order || order.orderStatus !== 'completed')
        return { awarded: 0 };
    const eligibility = Math.max(0, order.subtotalMinor - order.discountMinor);
    const link = await tx.orderMemberLink.findFirst({ where: { orderId }, orderBy: { linkedAt: 'asc' } });
    if (!link)
        return { awarded: 0 };
    const setting = await tx.loyaltySetting.findUnique({ where: { id: 1 } });
    if (!setting?.enabled)
        return { awarded: 0 };
    await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${'member-points:' + link.memberId}))::text`;
    // 先把到期积分清掉，再累加本次：否则旧积分已经过期，新账却按虚高的余额入账。
    await sweepExpiredPointsInTx(tx, link.memberId, now);
    const member = await tx.memberProfile.findUnique({ where: { id: link.memberId } });
    if (!member || member.status !== 'active')
        return { awarded: 0 };
    const key = `order:${orderId}:earn`;
    if (await tx.pointLedger.findUnique({ where: { idempotencyKey: key } }))
        return { awarded: 0 };
    const tiers = await tx.membershipTier.findMany({ where: { status: 'active' } });
    const spendBefore = Number(member.lifetimeSpendMinor);
    const spendAfter = spendBefore + eligibility;
    const tierBefore = resolveTier(tiers, spendBefore);
    const tierAfter = resolveTier(tiers, spendAfter);
    const points = earnPoints(eligibility, tierBefore?.minorPerPoint ?? setting.minorPerPoint);
    await tx.memberProfile.update({ where: { id: member.id },
        data: { lifetimeSpendMinor: BigInt(spendAfter), ...(tierAfter === null ? {} : { tierId: tierAfter.id }) } });
    if (points <= 0)
        return { awarded: 0 };
    const existing = await tx.pointAccount.findUnique({ where: { memberId: member.id } });
    const account = existing ?? await tx.pointAccount.create({ data: { memberId: member.id, createdAt: now, updatedAt: now } });
    const balance = applyDelta(account.balance, points);
    await tx.pointAccount.update({ where: { id: account.id }, data: { balance, updatedAt: now, version: { increment: 1 } } });
    await tx.pointLedger.create({ data: { id: randomUUID(), memberId: member.id, deltaPoints: points, balanceAfter: balance,
            entryType: 'earn', sourceType: 'order', sourceRef: order.publicOrderNumber, reasonCode: 'order_completed',
            // 到期是发放时的快照：之后调整有效期只影响新发的积分。
            expiresAt: expiryDate(now, setting.pointsExpiryMonths),
            ruleVersion: LOYALTY_RULE_VERSION, idempotencyKey: key, createdAt: now } });
    return { awarded: points };
}
/**
 * 积分到期的懒清扫（在调用方事务内执行）。
 *
 * 为什么不在定时任务里扫：生产上 worker 可能没起，而「账上还有多少点能用」这件事
 * 任何时候被读到都必须是对的。所以凡是读余额（会员中心、后台看账）或改余额
 * （发放、人工调整）的地方，都先跑一遍这里——扫出来的只是应得的那几笔 expire 流水。
 *
 * 三条保证：
 * 1. 幂等：每笔 expire 的幂等键是 `expire:{原 earn 行 id}`，且 FIFO 会先把已有 expire
 *    当作扣减消耗掉，所以同一笔积分最多过期一次，重复调用不产生新流水。
 * 2. 可追溯：expire 行用 sourceRef 指回原 earn 行，余额从不清零重记。
 * 3. 不越过余额：FIFO 的剩余量本身等于账户余额，applyDelta 仍会兜底拒绝负数。
 */
export async function sweepExpiredPointsInTx(tx, memberId, now) {
    // 先锁再读：两个并发的读同时扫到同一笔到期，也不会各写一条 expire。
    await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${'member-points:' + memberId}))::text`;
    const rows = await tx.pointLedger.findMany({ where: { memberId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    // 绝大多数会员没有任何带到期时间的发放：不必建账户、不必再查。
    if (!rows.some(row => row.expiresAt !== null))
        return 0;
    const due = dueExpiry(rows.map(row => ({ id: row.id, deltaPoints: row.deltaPoints, entryType: row.entryType,
        sourceRef: row.sourceRef, expiresAt: row.expiresAt })), now);
    if (!due.length)
        return 0;
    const existing = await tx.pointAccount.findUnique({ where: { memberId } });
    const account = existing ?? await tx.pointAccount.create({ data: { memberId, createdAt: now, updatedAt: now } });
    let balance = account.balance;
    for (const part of due) {
        balance = applyDelta(balance, -part.points);
        await tx.pointLedger.create({ data: { id: randomUUID(), memberId, deltaPoints: -part.points, balanceAfter: balance,
                entryType: 'expire', sourceType: 'system', sourceRef: part.entryId, reasonCode: 'points_expired',
                ruleVersion: LOYALTY_RULE_VERSION, idempotencyKey: `expire:${part.entryId}`, createdAt: now } });
    }
    await tx.pointAccount.update({ where: { id: account.id }, data: { balance, updatedAt: now, version: { increment: 1 } } });
    return due.reduce((sum, part) => sum + part.points, 0);
}
/**
 * 下单扣积分（在调用方事务内执行）。
 *
 * 与发放、到期共用同一把会员级锁：三个动作不可能交错出一个「看起来够扣、实际已过期」的余额。
 * 幂等键绑订单，重复下单不会重复扣；扣减先清到期，过期的点绝不能拿来抵扣。
 */
export async function redeemOrderPointsInTx(tx, orderId, memberId, publicOrderNumber, points, ruleVersion, now) {
    if (points <= 0)
        return;
    await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${'member-points:' + memberId}))::text`;
    await sweepExpiredPointsInTx(tx, memberId, now);
    const key = `order:${orderId}:redeem`;
    if (await tx.pointLedger.findUnique({ where: { idempotencyKey: key } }))
        return;
    const member = await tx.memberProfile.findUnique({ where: { id: memberId } });
    if (!member || member.status !== 'active')
        throw new AuthError(403, 'POINTS_MEMBER_UNAVAILABLE');
    const existing = await tx.pointAccount.findUnique({ where: { memberId } });
    const account = existing ?? await tx.pointAccount.create({ data: { memberId, createdAt: now, updatedAt: now } });
    // applyDelta 会挡住余额不足；这里不再单独查余额，避免锁内多读一次仍可能被并发绕过。
    const balance = applyDelta(account.balance, -points);
    await tx.pointAccount.update({ where: { id: account.id }, data: { balance, updatedAt: now, version: { increment: 1 } } });
    await tx.pointLedger.create({ data: { id: randomUUID(), memberId, deltaPoints: -points, balanceAfter: balance,
            entryType: 'redeem', sourceType: 'order', sourceRef: publicOrderNumber, reasonCode: 'order_points_used',
            ruleVersion: ruleVersion || LOYALTY_REDEEM_RULE_VERSION, idempotencyKey: key, createdAt: now } });
}
/**
 * 取消或整单退款时补回实扣点数（在调用方事务内执行）。
 *
 * 补回是一笔新的追加流水，不改写原扣减行；幂等键绑订单，取消与退款同时发生也只补一次。
 * 补偿积分不设到期：顾客等了很久才拿到退款，不该因为原发放早已到期而拿不回点数。
 */
export async function restoreOrderPointsInTx(tx, orderId, now, reasonCode = 'order_refunded') {
    const order = await tx.shopOrder.findUnique({ where: { id: orderId } });
    if (!order || order.pointsRedeemed <= 0)
        return;
    const link = await tx.orderMemberLink.findFirst({ where: { orderId }, orderBy: { linkedAt: 'asc' } });
    const memberId = order.pointsMemberId ?? link?.memberId;
    if (!memberId)
        return;
    await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${'member-points:' + memberId}))::text`;
    const key = `order:${orderId}:points_refund`;
    if (await tx.pointLedger.findUnique({ where: { idempotencyKey: key } }))
        return;
    const existing = await tx.pointAccount.findUnique({ where: { memberId } });
    const account = existing ?? await tx.pointAccount.create({ data: { memberId, createdAt: now, updatedAt: now } });
    const balance = applyDelta(account.balance, order.pointsRedeemed);
    await tx.pointAccount.update({ where: { id: account.id }, data: { balance, updatedAt: now, version: { increment: 1 } } });
    await tx.pointLedger.create({ data: { id: randomUUID(), memberId, deltaPoints: order.pointsRedeemed, balanceAfter: balance,
            entryType: 'reversal', sourceType: 'order', sourceRef: order.publicOrderNumber, reasonCode,
            ruleVersion: order.pointsRuleVersion ?? LOYALTY_REDEEM_RULE_VERSION, idempotencyKey: key, createdAt: now } });
}
