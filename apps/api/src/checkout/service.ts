import { createHash } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import { assertCouponUsable } from '../../../../packages/domain/src/promotions.js';
import { assertQuoteActive, assertQuoteMath, assertQuoteVersion, CheckoutRuleError,
  normalizeAddress, normalizeContact, normalizeCouponCode, normalizePolicyAcceptances, orderRequestFingerprint,
  publicOrderNumber, quoteExpiry, QUOTE_TTL_SECONDS, type Address, type Contact } from '../../../../packages/domain/src/checkout.js';
import { effectiveReviewStatus, normalizeMarketCode } from '../../../../packages/domain/src/store.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import type { PaymentsService } from '../payments/service.js';
import type { PricedCoupon, PromotionsService } from '../promotions/service.js';
import type { ShippingService } from '../shipping/service.js';
import { CartService, type CartRow } from './cart-service.js';

type Tx = Prisma.TransactionClient;
const RESERVATION_MINUTES = 30;
const CART_ITEM_INCLUDE = { variant: { include: { inventory: true, product: { include: { translations: true } } } } } as const;
type CartItemRow = Prisma.CartItemGetPayload<{ include: typeof CART_ITEM_INCLUDE }>;
type QuoteRow = Prisma.CheckoutQuoteGetPayload<{ include: { lines: true } }>;

export interface QuoteBody {
  cartId: string; locale: string; marketCode: string; contact: Contact; shippingAddress: Address;
  shippingMethodId: string; couponCode?: string | null;
  policyAcceptances: { policyKey: string; version: string; accepted: true }[];
}
export interface OrderBody { quoteId: string; confirmedQuoteVersion: number; paymentMethodCode: string; customerNote?: string | null }

interface Settings {
  currency: string; locales: string[]; defaultLocale: string; timezone: string;
  markets: { marketCode: string; enabled: boolean; reviewStatus: string; eligibleProductIds: string[] }[];
}

/**
 * 报价与下单（M06）。
 *
 * 报价是不可变快照：价格、名称、地址、配送与政策同意在报价时冻结，下单只校验
 * “快照是否仍然成立”（报价版本、有效期、当前价格、当前库存），不重新解释客户端输入。
 * 下单请求本身不接受任何金额字段——契约的 additionalProperties:false 会在入口拒绝它们。
 */
export class CheckoutService {
  constructor(private readonly identity: IdentityService, private readonly cartService: CartService,
    private readonly shipping: ShippingService, private readonly payments: PaymentsService,
    private readonly promotions: PromotionsService) {}
  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof CheckoutRuleError) throw new AuthError(error.code === 'VALIDATION_ERROR' ? 422 : 409, error.code);
      throw error;
    }
  }

  private async lock(tx: Tx, key: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }

  private async settings(tx: Tx): Promise<Settings> {
    const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
    const markets = await tx.marketProfile.findMany({ where: { storeConfigId: 1 }, orderBy: { marketCode: 'asc' } });
    const now = new Date();
    return { currency: row?.baseCurrency ?? 'HKD', locales: (row?.locales ?? ['zh-CN', 'zh-HK', 'en']) as string[],
      defaultLocale: row?.defaultLocale ?? 'zh-CN', timezone: row?.timezone ?? 'Asia/Hong_Kong',
      markets: markets.map(market => ({ marketCode: market.marketCode, enabled: market.enabled,
        reviewStatus: effectiveReviewStatus(market.reviewStatus, market.reviewValidUntil, now),
        eligibleProductIds: market.eligibleProductIds })) };
  }

  /** 市场必须是已启用且审核通过：未开通的市场不能报价，也不能静默换成别的市场。 */
  private market(settings: Settings, input: string) {
    const code = (() => { try { return normalizeMarketCode(input); } catch { throw new AuthError(422, 'VALIDATION_ERROR'); } })();
    const profile = settings.markets.find(market => market.marketCode === code);
    if (!profile) throw new AuthError(422, 'VALIDATION_ERROR');
    if (!profile.enabled || profile.reviewStatus !== 'approved') throw new AuthError(409, 'MARKET_NOT_AVAILABLE');
    return profile;
  }

  private async quoteLines(tx: Tx, cart: CartRow, marketCode: string, eligible: string[], locale: string, fallback: string) {
    const rows = await tx.cartItem.findMany({ where: { cartId: cart.id }, include: CART_ITEM_INCLUDE, orderBy: [{ createdAt: 'asc' }] });
    if (!rows.length) throw new AuthError(422, 'VALIDATION_ERROR');
    if (rows.length > 50) throw new AuthError(422, 'VALIDATION_ERROR');
    // 优惠范围要按商品与分类判定：一次取齐，避免逐行查询。
    const categories = await tx.productCategory.findMany({ where: { productId: { in: rows.map(row => row.variant.productId) } } });
    const categoryIds = new Map<string, string[]>();
    for (const link of categories) categoryIds.set(link.productId, [...(categoryIds.get(link.productId) ?? []), link.categoryId]);
    const now = Date.now();
    return rows.map((row: CartItemRow) => {
      const variant = row.variant;
      const product = variant.product;
      const sellable = product.status === 'active' && (!product.publishedAt || product.publishedAt.getTime() <= now)
        && product.marketCodes.includes(marketCode) && (!eligible.length || eligible.includes(product.id)) && variant.status === 'active';
      if (!sellable || variant.currency !== cart.currency) throw new AuthError(409, 'CART_ITEM_UNAVAILABLE');
      const available = Math.max(0, (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0));
      if (available < row.quantity) throw new AuthError(409, 'OUT_OF_STOCK');
      const translation = product.translations.find(item => item.locale === locale)
        ?? product.translations.find(item => item.locale === fallback) ?? product.translations[0] ?? null;
      const variantName = Object.values((variant.optionValues ?? {}) as Record<string, string>).join(' / ') || null;
      return { variant, productId: product.id, categoryIds: categoryIds.get(product.id) ?? [],
        productName: translation?.name ?? product.baseSku ?? variant.sku, variantName,
        quantity: row.quantity, unitPriceMinor: variant.priceMinor, lineSubtotalMinor: variant.priceMinor * row.quantity };
    });
  }

  private quoteView(row: QuoteRow) {
    const method = row.shippingMethodSnapshot as { code: string; name: string; estimatedMinDays: number | null; estimatedMaxDays: number | null };
    return { quoteId: row.id, version: row.version, expiresAt: row.expiresAt.toISOString(), currency: row.currency,
      lines: [...row.lines].map(line => ({ variantId: line.variantId, sku: line.sku, productName: line.productName,
        variantName: line.variantName ?? null, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor,
        lineSubtotalMinor: line.lineSubtotalMinor, lineDiscountMinor: line.lineDiscountMinor, lineTotalMinor: line.lineTotalMinor })),
      subtotalMinor: row.subtotalMinor, discountMinor: row.discountMinor, shippingMinor: row.shippingMinor,
      taxMinor: row.taxMinor, totalMinor: row.totalMinor,
      shippingMethod: { code: method.code, name: method.name, estimatedMinDays: method.estimatedMinDays ?? null,
        estimatedMaxDays: method.estimatedMaxDays ?? null },
      couponSummary: (row.couponSummary ?? null) as { codeMasked: string; discountMinor: number } | null,
      ruleVersions: row.ruleVersions as Record<string, string | null>, warnings: row.warnings as string[] };
  }

  /**
   * 游客可选的配送方式列表：费用按购物袋当前小计算出，地址只取国家/区域码做区匹配。
   * 结账页据此渲染选项；报价仍以 quote 的服务端计算为准，这里只是展示口径。
   */
  async shippingMethods(token: string, query: { countryCode?: unknown; regionCode?: unknown; locale?: unknown },
    ctx: RequestContext) {
    await this.identity.limitIp(ctx);
    const countryCode = typeof query.countryCode === 'string' ? query.countryCode.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new AuthError(422, 'VALIDATION_ERROR');
    const regionCode = typeof query.regionCode === 'string' && query.regionCode.trim()
      ? query.regionCode.trim().slice(0, 80) : null;
    const locale = typeof query.locale === 'string' && query.locale.trim() ? query.locale.trim().slice(0, 10) : null;
    return this.db.$transaction(async tx => {
      const cart = await this.cartService.requireCart(tx, token);
      const view = await this.cartService.render(tx, cart);
      const settings = await this.settings(tx);
      const methods = await this.shipping.methodsFor(tx, { countryCode, regionCode }, view.subtotalMinor,
        view.currency, locale ?? cart.locale ?? settings.defaultLocale, settings.defaultLocale);
      return { items: methods };
    }, { timeout: 15_000 });
  }

  async quote(token: string, body: QuoteBody, ctx: RequestContext) {
    await this.identity.limitIp(ctx);
    return this.db.$transaction(async tx => {
      const cart = await this.cartService.requireCart(tx, token);
      if (cart.id !== body.cartId) throw new AuthError(422, 'VALIDATION_ERROR');
      const settings = await this.settings(tx);
      if (!settings.locales.includes(body.locale)) throw new AuthError(422, 'VALIDATION_ERROR');
      const market = this.market(settings, body.marketCode);
      const contact = this.rule(() => normalizeContact(body.contact));
      const address = this.rule(() => normalizeAddress(body.shippingAddress));
      const policyAcceptances = this.rule(() => normalizePolicyAcceptances(body.policyAcceptances));
      const couponCode = this.rule(() => normalizeCouponCode(body.couponCode));
      const lines = await this.quoteLines(tx, cart, market.marketCode, market.eligibleProductIds, body.locale, settings.defaultLocale);
      const subtotal = lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0);
      if (!Number.isInteger(subtotal) || subtotal <= 0) throw new AuthError(422, 'VALIDATION_ERROR');
      const methods = await this.shipping.methodsFor(tx, address, subtotal, cart.currency, body.locale, settings.defaultLocale);
      const method = methods.find(item => item.id === body.shippingMethodId);
      if (!method) throw new AuthError(422, 'VALIDATION_ERROR');
      // 优惠码算不出来就明确失败：静默按原价下单比拒绝更糟。
      const priced = await this.promotions.priceQuote(tx, { code: couponCode, currency: cart.currency, contact,
        lines: lines.map(line => ({ key: line.variant.id, productId: line.productId, categoryIds: line.categoryIds,
          amountMinor: line.lineSubtotalMinor, quantity: line.quantity })), now: new Date() });
      const warnings: string[] = [];
      const amounts = { subtotalMinor: subtotal, discountMinor: priced?.discountMinor ?? 0,
        shippingMinor: method.feeMinor, taxMinor: 0,
        totalMinor: subtotal - (priced?.discountMinor ?? 0) + method.feeMinor };
      this.rule(() => assertQuoteMath(amounts));
      await tx.checkoutQuote.updateMany({ where: { cartId: cart.id, status: 'active' }, data: { status: 'superseded' } });
      const rate = await tx.shippingRate.findUnique({ where: { id: method.id } });
      const row = await tx.checkoutQuote.create({ data: {
        cartId: cart.id, version: 1, locale: body.locale, marketCode: market.marketCode, currency: cart.currency,
        contact: contact as unknown as Prisma.InputJsonValue, shippingAddress: address as unknown as Prisma.InputJsonValue,
        shippingMethodId: method.id, shippingMethodSnapshot: { code: method.code, name: method.name,
          estimatedMinDays: method.estimatedMinDays, estimatedMaxDays: method.estimatedMaxDays,
          fixedFeeMinor: rate?.fixedFeeMinor ?? method.feeMinor, freeAboveMinor: rate?.freeAboveMinor ?? null },
        subtotalMinor: amounts.subtotalMinor, discountMinor: amounts.discountMinor, shippingMinor: amounts.shippingMinor,
        taxMinor: amounts.taxMinor, totalMinor: amounts.totalMinor,
        couponCode, ...(priced ? { couponId: priced.couponId,
          couponSnapshot: priced.snapshot as unknown as Prisma.InputJsonValue,
          couponSummary: priced.summary as unknown as Prisma.InputJsonValue } : {}),
        ruleVersions: { price: 'catalog.v1', promotion: priced?.ruleVersion ?? 'none',
          shipping: `rate:${rate?.version ?? 1}`, tax: null },
        warnings, policyAcceptances: policyAcceptances as unknown as Prisma.InputJsonValue,
        expiresAt: quoteExpiry(new Date()),
        lines: { create: lines.map(line => ({ variantId: line.variant.id, sku: line.variant.sku, productName: line.productName,
          variantName: line.variantName, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor,
          lineSubtotalMinor: line.lineSubtotalMinor, lineDiscountMinor: priced?.lineDiscounts.get(line.variant.id) ?? 0,
          lineTotalMinor: line.lineSubtotalMinor - (priced?.lineDiscounts.get(line.variant.id) ?? 0) })) },
      }, include: { lines: true } });
      await tx.guestCart.update({ where: { id: cart.id }, data: { marketCode: market.marketCode, locale: body.locale } });
      await this.identity.recordAudit(tx, ctx, null, 'checkout.quote.created', row.id);
      return this.quoteView(row);
    }, { timeout: 15_000 });
  }

  private paymentAction(locale: string, paymentStatus: string, accountSummary?: string | null) {
    if (paymentStatus === 'cod_due') {
      const instructions = locale === 'en' ? 'Order confirmed. Pay in cash when the order is delivered.'
        : locale === 'zh-HK' ? '訂單已確認，將於送貨時以現金付款。' : '订单已确认，将在送货时现金付款。';
      return { type: 'instructions' as const, redirectUrl: null, instructions };
    }
    // 人工转账：付款说明来自支付方式配置，未配置就不编造银行信息。
    if (paymentStatus === 'created' && accountSummary) {
      return { type: 'instructions' as const, redirectUrl: null, instructions: accountSummary.slice(0, 2_000) };
    }
    return { type: 'none' as const, redirectUrl: null, instructions: null };
  }

  private orderView(row: Prisma.ShopOrderGetPayload<{}>, accountSummary?: string | null) {
    return { orderId: row.id, publicOrderNumber: row.publicOrderNumber, orderStatus: row.orderStatus,
      paymentStatus: row.paymentStatus, currency: row.currency, totalMinor: row.totalMinor,
      paymentAction: this.paymentAction(row.locale, row.paymentStatus, accountSummary) };
  }

  private day(timezone: string, now: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).reduce<Record<string, string>>((acc, part) => (part.type === 'literal' ? acc : { ...acc, [part.type]: part.value }), {});
    return `${parts.year}${parts.month}${parts.day}`;
  }

  private async reserve(tx: Tx, orderId: string, line: { variantId: string; quantity: number }, expiresAt: Date) {
    // 条件更新就是并发闸门：扣不到行说明别人先买走了，事务整体回滚。
    const updated = await tx.$executeRaw`UPDATE "InventoryItem" SET "reserved" = "reserved" + ${line.quantity}
      WHERE "variantId" = ${line.variantId}::uuid AND "onHand" - "reserved" >= ${line.quantity}`;
    if (updated === 0) throw new AuthError(409, 'OUT_OF_STOCK');
    await tx.inventoryReservation.create({ data: { orderId, variantId: line.variantId, quantity: line.quantity, expiresAt } });
  }

  async placeOrder(token: string, idempotencyKey: string, body: OrderBody, ctx: RequestContext) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new AuthError(422, 'VALIDATION_ERROR');
    if (body.customerNote !== undefined && body.customerNote !== null && body.customerNote.length > 1_000) throw new AuthError(422, 'VALIDATION_ERROR');
    await this.identity.limitIp(ctx);
    const digest = createHash('sha256').update(orderRequestFingerprint({ quoteId: body.quoteId,
      confirmedQuoteVersion: body.confirmedQuoteVersion, paymentMethodCode: body.paymentMethodCode,
      customerNote: body.customerNote ?? null })).digest('hex');

    // 订单号有随机后缀，极小概率撞号：只重试这一种冲突，其余错误原样抛出。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.db.$transaction(async tx => {
          // 先认购物袋再认幂等键：网络重试时购物袋已转换，但同一 key 必须还能拿回原订单。
          const cart = await this.cartService.locate(tx, token);
          await this.lock(tx, `idempotency:${idempotencyKey}`);
          const existing = await tx.shopOrder.findUnique({ where: { idempotencyKey } });
          if (existing) {
            if (existing.requestDigest !== digest || existing.cartId !== cart.id) throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
            return this.orderView(existing);
          }
          if (cart.status !== 'active') throw new AuthError(401, 'UNAUTHORIZED');
          const quote = await tx.checkoutQuote.findUnique({ where: { id: body.quoteId }, include: { lines: true } });
          if (!quote || quote.cartId !== cart.id) throw new AuthError(422, 'VALIDATION_ERROR');
          this.rule(() => assertQuoteActive(quote.status, quote.expiresAt, new Date()));
          this.rule(() => assertQuoteVersion(quote.version, body.confirmedQuoteVersion));
          await this.lock(tx, `quote:${quote.id}`);
          // 拿到锁后重读：并发同报价的两个请求只能有一个把 active 变成 consumed。
          const fresh = await tx.checkoutQuote.findUnique({ where: { id: quote.id } });
          if (!fresh || fresh.status !== 'active') throw new AuthError(409, 'QUOTE_NOT_AVAILABLE');

          const rate = await tx.shippingRate.findUnique({ where: { id: quote.shippingMethodId } });
          if (!rate || !rate.enabled) throw new AuthError(409, 'SHIPPING_UNAVAILABLE');
          // 可售方式 = 已接入 + 已批准 + 已启用；COD 还需要配送方式本身开启货到付款。
          const method = await this.payments.resolveCheckout(tx, body.paymentMethodCode.trim().toLowerCase(), rate.codEnabled);
          const methodCode = method.definition.code;
          // 首期没有线上网关：COD 记 cod_due（交货收钱），人工转账记 created（等到账）。
          const paymentStatus = method.definition.channel === 'cod' ? 'cod_due' : 'created';
          const accountSummary = (method.row.publicConfig as Record<string, string>).accountSummary ?? null;

          const now = new Date();
          for (const line of quote.lines) {
            const variant = await tx.productVariant.findUnique({ where: { id: line.variantId }, include: { product: true } });
            if (!variant || variant.status !== 'active' || variant.currency !== quote.currency
              || variant.priceMinor !== line.unitPriceMinor) throw new AuthError(409, 'PRICE_CHANGED');
            const product = variant.product;
            if (product.status !== 'active' || (product.publishedAt && product.publishedAt > now)
              || !product.marketCodes.includes(quote.marketCode)) throw new AuthError(409, 'CART_ITEM_UNAVAILABLE');
          }

          const expiresAt = new Date(now.getTime() + RESERVATION_MINUTES * 60_000);
          // 券必须在报价版本上仍然成立：规则被改过就要求重新报价，而不是沿用旧折扣。
          let couponRow: Awaited<ReturnType<typeof tx.coupon.findUnique>> = null;
          if (quote.couponId) {
            couponRow = await tx.coupon.findUnique({ where: { id: quote.couponId } });
            const snapshot = quote.couponSnapshot as { ruleVersion?: number } | null;
            if (!couponRow || !snapshot || snapshot.ruleVersion !== couponRow.version) throw new AuthError(409, 'COUPON_CHANGED');
            this.rule(() => assertCouponUsable(couponRow!, now, quote.currency));
          }

          const settings = await this.settings(tx);
          const created = await tx.shopOrder.create({ data: {
            publicOrderNumber: publicOrderNumber(this.day(settings.timezone, now),
              Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')),
            idempotencyKey, requestDigest: digest, quoteId: quote.id, cartId: cart.id, shippingRateId: rate.id,
            orderStatus: 'awaiting_confirmation', paymentStatus, currency: quote.currency,
            subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor, shippingMinor: quote.shippingMinor,
            taxMinor: quote.taxMinor, totalMinor: quote.totalMinor, locale: quote.locale, marketCode: quote.marketCode,
            contact: quote.contact as Prisma.InputJsonValue, shippingAddress: quote.shippingAddress as Prisma.InputJsonValue,
            shippingMethodSnapshot: quote.shippingMethodSnapshot as Prisma.InputJsonValue,
            ...(quote.couponId ? { couponId: quote.couponId,
              couponSnapshot: quote.couponSnapshot as Prisma.InputJsonValue } : {}),
            customerNote: body.customerNote ?? null, paymentMethodCode: methodCode,
            policyAcceptances: quote.policyAcceptances as Prisma.InputJsonValue, placedAt: now,
          } });
          await tx.orderItem.createMany({ data: quote.lines.map(line => ({ orderId: created.id, variantId: line.variantId,
            sku: line.sku, productName: line.productName, variantName: line.variantName, quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor, lineSubtotalMinor: line.lineSubtotalMinor,
            lineDiscountMinor: line.lineDiscountMinor, lineTotalMinor: line.lineTotalMinor })) });
          // 台账与订单同事务：下单即有一条待收流水，收款登记只推进状态，不补造记录。
          await this.payments.openLedger(tx, created, method.definition, method.row);
          for (const line of quote.lines) await this.reserve(tx, created.id, line, expiresAt);
          if (quote.couponId && couponRow) {
            await this.promotions.reserve(tx, { orderId: created.id,
              customerKey: this.promotions.customerKey(quote.contact as unknown as Contact), now, expiresAt,
              priced: { coupon: couponRow, couponId: couponRow.id, couponCode: couponRow.code,
                discountMinor: quote.discountMinor, lineDiscounts: new Map(),
                summary: { codeMasked: '', discountMinor: quote.discountMinor },
                snapshot: quote.couponSnapshot as unknown as PricedCoupon['snapshot'],
                ruleVersion: `coupon:${couponRow.id}:v${couponRow.version}` } });
          }
          await tx.checkoutQuote.update({ where: { id: quote.id }, data: { status: 'consumed' } });
          await tx.guestCart.update({ where: { id: cart.id }, data: { status: 'converted' } });
          await tx.orderStatusEvent.create({ data: { orderId: created.id, fromStatus: null,
            toStatus: 'awaiting_confirmation', reason: 'order_placed', actorType: 'customer' } });
          await this.identity.recordAudit(tx, ctx, null, 'checkout.order.created', created.id);
          return this.orderView(created, accountSummary);
        }, { timeout: 15_000 });
      } catch (error) {
        const code = (error as { code?: string }).code;
        const target = String((error as { meta?: { target?: unknown } }).meta?.target ?? '');
        if (code === 'P2002' && target.includes('publicOrderNumber') && attempt < 2) continue;
        throw error;
      }
    }
    throw new AuthError(409, 'STATE_CONFLICT');
  }

  /** 报价有效期用于前端倒计时与测试断言，不额外暴露内部字段。 */
  static readonly quoteTtlSeconds = QUOTE_TTL_SECONDS;
}
