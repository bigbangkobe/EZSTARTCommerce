import { createHash, createHmac } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import type { Contact } from '../../../../packages/domain/src/checkout.js';
import {
  allocateDiscount, assertCouponUsable, assertMinSubtotal, assertUsageLimits, couponDiscount, couponSnapshot,
  eligibleLines, maskCouponCode, mergeCouponPatch, normalizeCoupon, PromotionRuleError,
  type CouponLine, type CouponRule,
} from '../../../../packages/domain/src/promotions.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';

type Tx = Prisma.TransactionClient;
type CouponRow = Prisma.CouponGetPayload<{}>;
type RedemptionRow = Prisma.CouponRedemptionGetPayload<{ include: { order: true } }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RULE_CODES = new Set(['COUPON_NOT_FOUND', 'COUPON_DISABLED', 'COUPON_NOT_STARTED', 'COUPON_EXPIRED',
  'COUPON_CURRENCY_MISMATCH', 'COUPON_MIN_SUBTOTAL_NOT_MET', 'COUPON_NOT_APPLICABLE', 'COUPON_LIMIT_REACHED',
  'COUPON_CUSTOMER_LIMIT_REACHED', 'COUPON_MEMBER_ONLY', 'COUPON_CHANGED', 'STATE_CONFLICT']);

export interface CouponFilters { q?: string | null; status?: string | null }

export interface QuoteCouponLine extends CouponLine { quantity: number }

export interface PricedCoupon {
  coupon: CouponRow; couponId: string; couponCode: string; discountMinor: number;
  lineDiscounts: Map<string, number>; summary: { codeMasked: string; discountMinor: number };
  snapshot: ReturnType<typeof couponSnapshot>; ruleVersion: string;
}

/**
 * 优惠券（M11）。
 *
 * 三条边界：
 * 1. 券只被报价与下单引用；任何规则修改都不会改写既有订单的金额或快照。
 * 2. 额度只在下单事务里预占，报价只做只读试算——报价成功不代表券一定留到最后。
 * 3. 顾客限额用 HMAC(联系方式)，不落原邮箱/电话；报表与审计都看不到原值。
 */
export class PromotionsService {
  constructor(private readonly identity: IdentityService) {}
  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof PromotionRuleError) throw new AuthError(RULE_CODES.has(error.code) ? 409 : 422, error.code);
      throw error;
    }
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') throw new AuthError(409, 'COUPON_CODE_TAKEN');
      if (code === 'P2003') throw new AuthError(422, 'VALIDATION_ERROR');
      if (code === 'P2025') throw new AuthError(404, 'NOT_FOUND');
      throw error;
    }
  }

  private async lock(tx: Tx, key: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }

  private key(value: string | undefined) {
    if (typeof value !== 'string' || value.length < 16 || value.length > 128) throw new AuthError(422, 'VALIDATION_ERROR');
    return value;
  }

  private ruleOf(row: CouponRow): CouponRule {
    return { code: row.code, status: row.status as CouponRule['status'],
      discountType: row.discountType as CouponRule['discountType'], discountValue: row.discountValue,
      currency: row.currency, validFrom: row.validFrom, validUntil: row.validUntil,
      minSubtotalMinor: row.minSubtotalMinor ?? null, totalLimit: row.totalLimit ?? null,
      perCustomerLimit: row.perCustomerLimit ?? null, eligibleProductIds: row.eligibleProductIds,
      eligibleCategoryIds: row.eligibleCategoryIds, memberTierIds: row.memberTierIds,
      refundPolicy: row.refundPolicy as CouponRule['refundPolicy'] };
  }

  /**
   * 访客限额键：实例密钥 HMAC(规范化邮箱或电话)。
   * 邮箱按小写、电话只留数字与开头 +，避免同一顾客因写法不同绕过“每人一次”。
   */
  customerKey(contact: Contact): string {
    const material = contact.email !== null
      ? `email:${contact.email.trim().toLowerCase()}`
      : `phone:${(contact.phone ?? '').replace(/[^\d+]/g, '')}`;
    return createHmac('sha256', this.identity.config.encryptionKey)
      .update(`${this.identity.config.instanceId}:coupon:${material}`).digest('hex');
  }

  private async usage(tx: Tx, couponId: string, customerKey: string | null = null) {
    const grouped = await tx.couponRedemption.groupBy({ by: ['status'],
      where: { couponId, ...(customerKey ? { customerKey } : {}) }, _count: { _all: true } });
    const count = (status: string) => grouped.find(item => item.status === status)?._count._all ?? 0;
    // 返还次数要连表算，Prisma 的 groupBy 表达不了“按券聚合的关联表行数”，这里用两条固定 SQL。
    const returned = customerKey
      ? await tx.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint AS "count" FROM "CouponQuotaReturn" q
          JOIN "CouponRedemption" r ON r."id" = q."redemptionId"
          WHERE r."couponId" = ${couponId}::uuid AND r."customerKey" = ${customerKey}`
      : await tx.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint AS "count" FROM "CouponQuotaReturn" q
          JOIN "CouponRedemption" r ON r."id" = q."redemptionId"
          WHERE r."couponId" = ${couponId}::uuid`;
    const returnedCount = Number(returned[0]?.count ?? 0);
    const reservedCount = count('reserved'); const redeemedCount = count('redeemed');
    return { reservedCount, redeemedCount, releasedCount: count('released'), expiredCount: count('expired'),
      returnedCount, usedCount: reservedCount + redeemedCount - returnedCount };
  }

  private view(row: CouponRow, usage: { reservedCount: number; redeemedCount: number; releasedCount: number;
    expiredCount: number; returnedCount: number; usedCount: number }) {
    return { id: row.id, code: row.code, codeMasked: maskCouponCode(row.code), status: row.status,
      discountType: row.discountType, discountValue: row.discountValue, currency: row.currency,
      validFrom: row.validFrom.toISOString(), validUntil: row.validUntil.toISOString(),
      minSubtotalMinor: row.minSubtotalMinor ?? null, totalLimit: row.totalLimit ?? null,
      perCustomerLimit: row.perCustomerLimit ?? null, eligibleProductIds: row.eligibleProductIds,
      eligibleCategoryIds: row.eligibleCategoryIds, memberTierIds: row.memberTierIds,
      refundPolicy: row.refundPolicy, version: row.version, createdBy: row.createdBy ?? null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), usage };
  }

  async list(supplied: string, limit: number, cursor: string | null, filters: CouponFilters) {
    const q = filters.q ?? null;
    if (q !== null && (typeof q !== 'string' || q.length > 80)) throw new AuthError(422, 'VALIDATION_ERROR');
    const status = filters.status ?? null;
    if (status !== null && status !== 'active' && status !== 'disabled') throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, null, 'coupons.read', async tx => {
      if (cursor && !await tx.coupon.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.coupon.findMany({ where: { ...(status ? { status } : {}),
        ...(q ? { code: { contains: q.trim().toUpperCase() } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const visible = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: await Promise.all(visible.map(async row => this.view(row, await this.usage(tx, row.id)))),
        hasMore, nextCursor: hasMore ? visible.at(-1)!.id : null };
    });
  }

  async get(supplied: string, id: string) {
    if (!UUID.test(id)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, null, 'coupons.read', async tx => {
      const row = await tx.coupon.findUnique({ where: { id } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      return this.view(row, await this.usage(tx, id));
    });
  }

  private async baseCurrency(tx: Tx) {
    const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
    return row?.baseCurrency ?? 'HKD';
  }

  async create(supplied: string, csrf: string | null, body: Record<string, unknown>, ctx: RequestContext) {
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'coupons.manage', async (tx, actor, _s, now) => {
      const currency = await this.baseCurrency(tx);
      const input = this.rule(() => normalizeCoupon(body, currency));
      this.assertTiers(input);
      const row = await tx.coupon.create({ data: { ...input, createdBy: actor.id, createdAt: now, updatedAt: now } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'coupon.created', row.id, 'success', row.code);
      return this.view(row, await this.usage(tx, row.id));
    }));
  }

  /** 会员专属券依赖 M10 会员目录；本实例还没有会员，宁可拒绝也不创建一张永远用不了的券。 */
  private assertTiers(input: { memberTierIds: string[] }) {
    if (input.memberTierIds.length) throw new AuthError(422, 'MEMBER_TIERS_UNAVAILABLE');
  }

  async update(supplied: string, csrf: string | null, id: string, expectedVersion: number,
    body: Record<string, unknown>, ctx: RequestContext) {
    if (!UUID.test(id)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'coupons.manage', async (tx, actor, _s, now) => {
      await this.lock(tx, `coupon:${id}`);
      const row = await tx.coupon.findUnique({ where: { id } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      if (row.version !== expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
      const input = this.rule(() => mergeCouponPatch(this.ruleOf(row), body));
      this.assertTiers(input);
      await tx.coupon.update({ where: { id }, data: { ...input, updatedAt: now, version: { increment: 1 } } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'coupon.updated', id, 'success', input.code);
      const updated = await tx.coupon.findUniqueOrThrow({ where: { id } });
      return this.view(updated, await this.usage(tx, id));
    }));
  }

  /** 停用本身幂等：重复调用只是确认它仍然停用，不会因为重试多出第二条审计。 */
  async disable(supplied: string, csrf: string | null, id: string, idempotencyKey: string | undefined,
    body: Record<string, unknown>, ctx: RequestContext) {
    if (!UUID.test(id)) throw new AuthError(422, 'VALIDATION_ERROR');
    this.key(idempotencyKey);
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    if (!reason.length || reason.length > 500) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.guarded(() => this.identity.withPermission(supplied, csrf, 'coupons.manage', async (tx, actor, _s, now) => {
      await this.lock(tx, `coupon:${id}`);
      const row = await tx.coupon.findUnique({ where: { id } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      if (row.status !== 'disabled') {
        await tx.coupon.update({ where: { id }, data: { status: 'disabled', updatedAt: now, version: { increment: 1 } } });
        await this.identity.recordAudit(tx, ctx, actor.id, 'coupon.disabled', id, 'success', reason);
      }
      const updated = await tx.coupon.findUniqueOrThrow({ where: { id } });
      return this.view(updated, await this.usage(tx, id));
    }));
  }

  async redemptions(supplied: string, id: string, limit: number, cursor: string | null) {
    if (!UUID.test(id)) throw new AuthError(422, 'VALIDATION_ERROR');
    return this.identity.withPermission(supplied, null, 'coupons.read', async tx => {
      const coupon = await tx.coupon.findUnique({ where: { id } });
      if (!coupon) throw new AuthError(404, 'NOT_FOUND');
      if (cursor && !await tx.couponRedemption.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.couponRedemption.findMany({ where: { couponId: id },
        include: { order: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const visible = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: visible.map(row => this.redemptionView(row)), hasMore,
        nextCursor: hasMore ? visible.at(-1)!.id : null };
    });
  }

  private redemptionView(row: RedemptionRow) {
    return { id: row.id, orderId: row.orderId, publicOrderNumber: row.order.publicOrderNumber,
      status: row.status, discountMinor: row.discountMinor, currency: row.currency,
      // 只出示不可逆摘要的前 8 位，够客服定位、又不构成联系方式泄露。
      customerRef: row.customerKey ? row.customerKey.slice(0, 8) : null,
      reservedAt: row.reservedAt.toISOString(), redeemedAt: row.redeemedAt?.toISOString() ?? null,
      releasedAt: row.releasedAt?.toISOString() ?? null, expiresAt: row.expiresAt?.toISOString() ?? null,
      ruleVersion: (row.ruleSnapshot as { ruleVersion?: number }).ruleVersion ?? null };
  }

  /**
   * 报价试算：只读，不占额度。返回按行的折扣分摊与完整规则快照，
   * 报价响应只暴露 codeMasked 与折扣金额。
   */
  async priceQuote(tx: Tx, input: { code: string | null; currency: string; contact: Contact;
    lines: readonly QuoteCouponLine[]; now: Date }): Promise<PricedCoupon | null> {
    if (input.code === null) return null;
    const row = await tx.coupon.findUnique({ where: { code: input.code } });
    if (!row) throw new AuthError(409, 'COUPON_NOT_FOUND');
    const rule = this.ruleOf(row);
    if (rule.memberTierIds.length) throw new AuthError(409, 'COUPON_MEMBER_ONLY');
    this.rule(() => assertCouponUsable(rule, input.now, input.currency));
    const subtotal = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
    this.rule(() => assertMinSubtotal(rule, subtotal));
    const eligible = eligibleLines(rule, input.lines);
    if (!eligible.length) throw new AuthError(409, 'COUPON_NOT_APPLICABLE');
    const eligibleSubtotal = eligible.reduce((sum, line) => sum + line.amountMinor, 0);
    const discountMinor = this.rule(() => couponDiscount(rule, eligibleSubtotal));
    if (discountMinor < 1) throw new AuthError(409, 'COUPON_NOT_APPLICABLE');
    const customerKey = this.customerKey(input.contact);
    const totalUsage = await this.usage(tx, row.id);
    const customerUsage = await this.usage(tx, row.id, customerKey);
    this.rule(() => assertUsageLimits(row, totalUsage.usedCount, customerUsage.usedCount));
    const allocations = this.rule(() => allocateDiscount(
      eligible.map(line => ({ key: line.key, amountMinor: line.amountMinor })), discountMinor));
    const lineDiscounts = new Map(input.lines.map(line => [line.key, allocations.get(line.key) ?? 0]));
    return { coupon: row, couponId: row.id, couponCode: row.code, discountMinor, lineDiscounts,
      summary: { codeMasked: maskCouponCode(row.code), discountMinor },
      snapshot: couponSnapshot({ ...rule, id: row.id, version: row.version }, discountMinor),
      ruleVersion: `coupon:${row.id}:v${row.version}` };
  }

  /**
   * 下单事务内预占。调用方必须已经写下订单行（金额来自报价快照），
   * 这里只做“券还可用吗”的复核与额度预占，任何不一致都会让整个订单回滚。
   */
  async reserve(tx: Tx, input: { priced: PricedCoupon; orderId: string; customerKey: string; now: Date;
    expiresAt: Date }) {
    const { priced } = input;
    await this.lock(tx, `coupon:${priced.couponId}`);
    const row = await tx.coupon.findUnique({ where: { id: priced.couponId } });
    if (!row) throw new AuthError(409, 'COUPON_NOT_FOUND');
    if (row.version !== priced.coupon.version) throw new AuthError(409, 'COUPON_CHANGED');
    const rule = this.ruleOf(row);
    this.rule(() => assertCouponUsable(rule, input.now, priced.coupon.currency));
    const totalUsage = await this.usage(tx, row.id);
    const customerUsage = await this.usage(tx, row.id, input.customerKey);
    this.rule(() => assertUsageLimits(row, totalUsage.usedCount, customerUsage.usedCount));
    const digest = createHash('sha256').update(`coupon.reserve\n${priced.couponId}\n${input.orderId}`).digest('hex');
    const redemption = await tx.couponRedemption.create({ data: { couponId: row.id, orderId: input.orderId,
      status: 'reserved', discountMinor: priced.discountMinor, currency: row.currency, customerKey: input.customerKey,
      codeSnapshot: row.code, ruleSnapshot: priced.snapshot as unknown as Prisma.InputJsonValue,
      dedupeKey: `coupon:reserve:${digest}`, reservedAt: input.now, expiresAt: input.expiresAt } });
    // 预占也要留事件：否则“这张券什么时候被占住”只能靠列上的时间猜。
    await tx.couponRedemptionEvent.create({ data: { redemptionId: redemption.id, fromStatus: null,
      toStatus: 'reserved', reason: 'order_reserved', actorType: 'customer', actorId: null,
      dedupeKey: `coupon:${redemption.id}:reserved`, createdAt: input.now } });
    return redemption;
  }

  /**
   * 批量发放依赖会员目录（M10）。本实例还没有会员，创建与执行都明确拒绝，
   * 而不是建一个空批次让人以为已经发出去了。
   */
  unavailableBatch() { throw new AuthError(422, 'MEMBER_AUDIENCE_UNAVAILABLE'); }
}
