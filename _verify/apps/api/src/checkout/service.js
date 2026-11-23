import { createHash } from 'node:crypto';
import { assertCouponUsable } from '../../../../packages/domain/src/promotions.js';
import { LOYALTY_REDEEM_RULE_VERSION, LoyaltyRuleError, redeemPoints } from '../../../../packages/domain/src/loyalty.js';
import { redeemOrderPointsInTx, sweepExpiredPointsInTx } from '../members/loyalty-service.js';
import { assertQuoteActive, assertQuoteMath, assertQuoteVersion, CheckoutRuleError, normalizeAddress, normalizeContact, normalizeCouponCode, normalizePolicyAcceptances, orderRequestFingerprint, publicOrderNumber, quoteExpiry, QUOTE_TTL_SECONDS } from '../../../../packages/domain/src/checkout.js';
import { effectiveReviewStatus, normalizeMarketCode } from '../../../../packages/domain/src/store.js';
import { pickAttribution } from '../../../../packages/domain/src/placement.js';
import { availableChannelsFor, requiresPrepayment } from '../../../../packages/domain/src/payments.js';
import { AuthError } from '../identity/service.js';
import { resolveMemberSession } from '../members/session.js';
const RESERVATION_MINUTES = 30;
const CART_ITEM_INCLUDE = { variant: { include: { inventory: true, product: { include: { translations: true } } } } };
/**
 * 报价与下单（M06）。
 *
 * 报价是不可变快照：价格、名称、地址、配送与政策同意在报价时冻结，下单只校验
 * “快照是否仍然成立”（报价版本、有效期、当前价格、当前库存），不重新解释客户端输入。
 * 下单请求本身不接受任何金额字段——契约的 additionalProperties:false 会在入口拒绝它们。
 */
export class CheckoutService {
    identity;
    cartService;
    shipping;
    payments;
    promotions;
    constructor(identity, cartService, shipping, payments, promotions) {
        this.identity = identity;
        this.cartService = cartService;
        this.shipping = shipping;
        this.payments = payments;
        this.promotions = promotions;
    }
    get db() { return this.identity.db; }
    rule(fn) {
        try {
            return fn();
        }
        catch (error) {
            if (error instanceof CheckoutRuleError)
                throw new AuthError(error.code === 'VALIDATION_ERROR' ? 422 : 409, error.code);
            throw error;
        }
    }
    /** 积分规则的错误码有自己一套：余额不足是业务冲突（409），字段错误才是 422。 */
    loyalty(fn) {
        try {
            return fn();
        }
        catch (error) {
            if (error instanceof LoyaltyRuleError) {
                throw new AuthError(error.code === 'POINT_BALANCE_INSUFFICIENT' ? 409 : 422, error.code);
            }
            throw error;
        }
    }
    async lock(tx, key) { await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }
    async settings(tx) {
        const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
        const markets = await tx.marketProfile.findMany({ where: { storeConfigId: 1 }, orderBy: { marketCode: 'asc' } });
        const now = new Date();
        return { currency: row?.baseCurrency ?? 'HKD', locales: (row?.locales ?? ['zh-CN', 'zh-HK', 'en']),
            defaultLocale: row?.defaultLocale ?? 'zh-CN', timezone: row?.timezone ?? 'Asia/Hong_Kong',
            markets: markets.map(market => ({ marketCode: market.marketCode, enabled: market.enabled,
                reviewStatus: effectiveReviewStatus(market.reviewStatus, market.reviewValidUntil, now),
                eligibleProductIds: market.eligibleProductIds })) };
    }
    /** 市场必须是已启用且审核通过：未开通的市场不能报价，也不能静默换成别的市场。 */
    market(settings, input) {
        const code = (() => { try {
            return normalizeMarketCode(input);
        }
        catch {
            throw new AuthError(422, 'VALIDATION_ERROR');
        } })();
        const profile = settings.markets.find(market => market.marketCode === code);
        if (!profile)
            throw new AuthError(422, 'VALIDATION_ERROR');
        if (!profile.enabled || profile.reviewStatus !== 'approved')
            throw new AuthError(409, 'MARKET_NOT_AVAILABLE');
        return profile;
    }
    async quoteLines(tx, cart, marketCode, eligible, locale, fallback) {
        const rows = await tx.cartItem.findMany({ where: { cartId: cart.id }, include: CART_ITEM_INCLUDE, orderBy: [{ createdAt: 'asc' }] });
        if (!rows.length)
            throw new AuthError(422, 'VALIDATION_ERROR');
        if (rows.length > 50)
            throw new AuthError(422, 'VALIDATION_ERROR');
        // 优惠范围要按商品与分类判定：一次取齐，避免逐行查询。
        const categories = await tx.productCategory.findMany({ where: { productId: { in: rows.map(row => row.variant.productId) } } });
        const categoryIds = new Map();
        for (const link of categories)
            categoryIds.set(link.productId, [...(categoryIds.get(link.productId) ?? []), link.categoryId]);
        const now = Date.now();
        return rows.map((row) => {
            const variant = row.variant;
            const product = variant.product;
            const sellable = product.status === 'active' && (!product.publishedAt || product.publishedAt.getTime() <= now)
                && product.marketCodes.includes(marketCode) && (!eligible.length || eligible.includes(product.id)) && variant.status === 'active';
            if (!sellable || variant.currency !== cart.currency)
                throw new AuthError(409, 'CART_ITEM_UNAVAILABLE');
            const available = Math.max(0, (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0));
            if (available < row.quantity)
                throw new AuthError(409, 'OUT_OF_STOCK');
            const translation = product.translations.find(item => item.locale === locale)
                ?? product.translations.find(item => item.locale === fallback) ?? product.translations[0] ?? null;
            const variantName = Object.values((variant.optionValues ?? {})).join(' / ') || null;
            return { variant, productId: product.id, categoryIds: categoryIds.get(product.id) ?? [],
                // 商品级收款约束随行带出：报价阶段就要据此收窄可选支付方式。
                allowedChannels: product.allowedPaymentChannels,
                productName: translation?.name ?? product.baseSku ?? variant.sku, variantName,
                quantity: row.quantity, unitPriceMinor: variant.priceMinor, lineSubtotalMinor: variant.priceMinor * row.quantity };
        });
    }
    quoteView(row, paymentMethods = []) {
        const method = row.shippingMethodSnapshot;
        return { quoteId: row.id, version: row.version, expiresAt: row.expiresAt.toISOString(), currency: row.currency,
            lines: [...row.lines].map(line => ({ variantId: line.variantId, sku: line.sku, productName: line.productName,
                variantName: line.variantName ?? null, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor,
                lineSubtotalMinor: line.lineSubtotalMinor, lineDiscountMinor: line.lineDiscountMinor, lineTotalMinor: line.lineTotalMinor })),
            subtotalMinor: row.subtotalMinor, discountMinor: row.discountMinor, shippingMinor: row.shippingMinor,
            taxMinor: row.taxMinor, totalMinor: row.totalMinor,
            pointsRequested: row.pointsRequested, pointsRedeemed: row.pointsRedeemed,
            pointsValueMinor: row.pointsValueMinor, pointsRuleVersion: row.pointsRuleVersion,
            shippingMethod: { code: method.code, name: method.name, estimatedMinDays: method.estimatedMinDays ?? null,
                estimatedMaxDays: method.estimatedMaxDays ?? null },
            couponSummary: (row.couponSummary ?? null),
            ruleVersions: row.ruleVersions, warnings: row.warnings,
            // 本单可选收款方式：已按商品级约束收窄，前端据此渲染选择器。
            paymentMethods };
    }
    /**
     * 游客可选的配送方式列表：费用按购物袋当前小计算出，地址只取国家/区域码做区匹配。
     * 结账页据此渲染选项；报价仍以 quote 的服务端计算为准，这里只是展示口径。
     */
    async shippingMethods(token, query, ctx) {
        await this.identity.limitIp(ctx);
        const countryCode = typeof query.countryCode === 'string' ? query.countryCode.trim().toUpperCase() : '';
        if (!/^[A-Z]{2}$/.test(countryCode))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const regionCode = typeof query.regionCode === 'string' && query.regionCode.trim()
            ? query.regionCode.trim().slice(0, 80) : null;
        const locale = typeof query.locale === 'string' && query.locale.trim() ? query.locale.trim().slice(0, 10) : null;
        return this.db.$transaction(async (tx) => {
            const cart = await this.cartService.requireCart(tx, token);
            const view = await this.cartService.render(tx, cart);
            const settings = await this.settings(tx);
            const methods = await this.shipping.methodsFor(tx, { countryCode, regionCode }, view.subtotalMinor, view.currency, locale ?? cart.locale ?? settings.defaultLocale, settings.defaultLocale);
            return { items: methods };
        }, { timeout: 15_000 });
    }
    async quote(token, body, ctx, memberToken = null) {
        await this.identity.limitIp(ctx);
        return this.db.$transaction(async (tx) => {
            const cart = await this.cartService.requireCart(tx, token);
            if (cart.id !== body.cartId)
                throw new AuthError(422, 'VALIDATION_ERROR');
            const settings = await this.settings(tx);
            if (!settings.locales.includes(body.locale))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const market = this.market(settings, body.marketCode);
            const contact = this.rule(() => normalizeContact(body.contact));
            const address = this.rule(() => normalizeAddress(body.shippingAddress));
            const policyAcceptances = this.rule(() => normalizePolicyAcceptances(body.policyAcceptances));
            const couponCode = this.rule(() => normalizeCouponCode(body.couponCode));
            const lines = await this.quoteLines(tx, cart, market.marketCode, market.eligibleProductIds, body.locale, settings.defaultLocale);
            const subtotal = lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0);
            if (!Number.isInteger(subtotal) || subtotal <= 0)
                throw new AuthError(422, 'VALIDATION_ERROR');
            const methods = await this.shipping.methodsFor(tx, address, subtotal, cart.currency, body.locale, settings.defaultLocale);
            const method = methods.find(item => item.id === body.shippingMethodId);
            if (!method)
                throw new AuthError(422, 'VALIDATION_ERROR');
            const now = new Date();
            // 会员身份只影响「专属券资格与限额主体」：会话失效时降级为访客，不阻断普通报价。
            const member = couponCode ? await this.optionalMember(tx, memberToken) : null;
            // 优惠码算不出来就明确失败：静默按原价下单比拒绝更糟。
            const priced = await this.promotions.priceQuote(tx, { code: couponCode, currency: cart.currency, contact,
                lines: lines.map(line => ({ key: line.variant.id, productId: line.productId, categoryIds: line.categoryIds,
                    amountMinor: line.lineSubtotalMinor, quantity: line.quantity })), now,
                memberId: member?.id ?? null, memberTierId: member?.tierId ?? null });
            const warnings = [];
            const discountMinor = priced?.discountMinor ?? 0;
            let points = { points: 0, valueMinor: 0, cappedByAmount: false };
            let pointsMemberId = null;
            let pointsRuleVersion = null;
            const requestedPoints = body.pointsToUse ?? 0;
            if (requestedPoints > 0) {
                // 积分是会员权益：想用积分却没有有效会员会话时明确拒绝，不能悄悄按原价报价。
                if (!memberToken)
                    throw new AuthError(401, 'POINTS_MEMBER_REQUIRED');
                const { member } = await resolveMemberSession(tx, memberToken);
                const loyalty = await tx.loyaltySetting.findUnique({ where: { id: 1 } });
                if (!loyalty?.enabled)
                    throw new AuthError(409, 'POINTS_DISABLED');
                // 清到期后再读余额：已过期的点不能出现在「最多能用多少」里。
                await sweepExpiredPointsInTx(tx, member.id, now);
                const [account, tier] = await Promise.all([
                    tx.pointAccount.findUnique({ where: { memberId: member.id } }),
                    member.tierId === null ? Promise.resolve(null) : tx.membershipTier.findUnique({ where: { id: member.tierId } }),
                ]);
                points = this.loyalty(() => redeemPoints(requestedPoints, account?.balance ?? 0, tier?.minorPerPoint ?? loyalty.minorPerPoint, subtotal - discountMinor));
                if (points.cappedByAmount)
                    warnings.push('POINTS_LIMITED_BY_MERCHANDISE_AMOUNT');
                if (points.points > 0) {
                    pointsMemberId = member.id;
                    pointsRuleVersion = LOYALTY_REDEEM_RULE_VERSION;
                }
            }
            const amounts = { subtotalMinor: subtotal, discountMinor, shippingMinor: method.feeMinor, taxMinor: 0,
                pointsValueMinor: points.valueMinor,
                totalMinor: subtotal - discountMinor - points.valueMinor + method.feeMinor };
            this.rule(() => assertQuoteMath(amounts));
            await tx.checkoutQuote.updateMany({ where: { cartId: cart.id, status: 'active' }, data: { status: 'superseded' } });
            const rate = await tx.shippingRate.findUnique({ where: { id: method.id } });
            // 商品级收款约束在报价阶段就生效：前端拿到的就是收窄后的可选方式，
            // 而不是先让人选、下单再被拒。
            const allowedChannels = availableChannelsFor(lines.map(line => line.allowedChannels));
            const paymentMethods = await this.payments.availableMethods(tx, allowedChannels, Boolean(rate?.codEnabled));
            const row = await tx.checkoutQuote.create({ data: {
                    cartId: cart.id, version: 1, locale: body.locale, marketCode: market.marketCode, currency: cart.currency,
                    contact: contact, shippingAddress: address,
                    shippingMethodId: method.id, shippingMethodSnapshot: { code: method.code, name: method.name,
                        estimatedMinDays: method.estimatedMinDays, estimatedMaxDays: method.estimatedMaxDays,
                        fixedFeeMinor: rate?.fixedFeeMinor ?? method.feeMinor, freeAboveMinor: rate?.freeAboveMinor ?? null },
                    subtotalMinor: amounts.subtotalMinor, discountMinor: amounts.discountMinor, shippingMinor: amounts.shippingMinor,
                    taxMinor: amounts.taxMinor, totalMinor: amounts.totalMinor,
                    pointsRequested: requestedPoints, pointsRedeemed: points.points, pointsValueMinor: points.valueMinor,
                    pointsMemberId, pointsRuleVersion,
                    couponCode, ...(priced ? { couponId: priced.couponId,
                        couponSnapshot: priced.snapshot,
                        couponSummary: priced.summary,
                        couponCustomerKey: priced.customerKey } : {}),
                    ruleVersions: { price: 'catalog.v1', promotion: priced?.ruleVersion ?? 'none',
                        shipping: `rate:${rate?.version ?? 1}`, tax: null },
                    warnings, policyAcceptances: policyAcceptances,
                    expiresAt: quoteExpiry(now),
                    lines: { create: lines.map(line => ({ variantId: line.variant.id, sku: line.variant.sku, productName: line.productName,
                            variantName: line.variantName, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor,
                            lineSubtotalMinor: line.lineSubtotalMinor, lineDiscountMinor: priced?.lineDiscounts.get(line.variant.id) ?? 0,
                            lineTotalMinor: line.lineSubtotalMinor - (priced?.lineDiscounts.get(line.variant.id) ?? 0) })) },
                }, include: { lines: true } });
            await tx.guestCart.update({ where: { id: cart.id }, data: { marketCode: market.marketCode, locale: body.locale } });
            await this.identity.recordAudit(tx, ctx, null, 'checkout.quote.created', row.id);
            return this.quoteView(row, paymentMethods);
        }, { timeout: 15_000 });
    }
    paymentAction(locale, paymentStatus, accountSummary) {
        if (paymentStatus === 'cod_due') {
            const instructions = locale === 'en' ? 'Order confirmed. Pay in cash when the order is delivered.'
                : locale === 'zh-HK' ? '訂單已確認，將於送貨時以現金付款。' : '订单已确认，将在送货时现金付款。';
            return { type: 'instructions', redirectUrl: null, instructions };
        }
        // 人工转账：付款说明来自支付方式配置，未配置就不编造银行信息。
        if (paymentStatus === 'created' && accountSummary) {
            return { type: 'instructions', redirectUrl: null, instructions: accountSummary.slice(0, 2_000) };
        }
        return { type: 'none', redirectUrl: null, instructions: null };
    }
    orderView(row, accountSummary) {
        return { orderId: row.id, publicOrderNumber: row.publicOrderNumber, orderStatus: row.orderStatus,
            paymentStatus: row.paymentStatus, currency: row.currency, totalMinor: row.totalMinor,
            pointsRedeemed: row.pointsRedeemed, pointsValueMinor: row.pointsValueMinor,
            paymentAction: this.paymentAction(row.locale, row.paymentStatus, accountSummary) };
    }
    day(timezone, now) {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(now).reduce((acc, part) => (part.type === 'literal' ? acc : { ...acc, [part.type]: part.value }), {});
        return `${parts.year}${parts.month}${parts.day}`;
    }
    async reserve(tx, orderId, line, expiresAt) {
        // 条件更新就是并发闸门：扣不到行说明别人先买走了，事务整体回滚。
        const updated = await tx.$executeRaw `UPDATE "InventoryItem" SET "reserved" = "reserved" + ${line.quantity}
      WHERE "variantId" = ${line.variantId}::uuid AND "onHand" - "reserved" >= ${line.quantity}`;
        if (updated === 0)
            throw new AuthError(409, 'OUT_OF_STOCK');
        await tx.inventoryReservation.create({ data: { orderId, variantId: line.variantId, quantity: line.quantity, expiresAt } });
    }
    /**
     * 把购物袋里同变体的加购归因绑到本单订单行。
     * 每个订单行只取下单前 24 小时内最后一次交互；绑定时带 `orderItemId: null` 条件，
     * 并发重试也不会把同一行归因改到别的订单行上（orderItemId 唯一）。
     */
    async attributePlacement(tx, cartId, orderId, placedAt) {
        const [touches, items] = await Promise.all([
            tx.placementAttribution.findMany({ where: { cartId, orderItemId: null } }),
            tx.orderItem.findMany({ where: { orderId }, select: { id: true, variantId: true } }),
        ]);
        if (!touches.length || !items.length)
            return;
        for (const item of items) {
            if (!item.variantId)
                continue;
            const picked = pickAttribution(touches.filter(touch => touch.variantId === item.variantId)
                .map(touch => ({ id: touch.id, variantId: touch.variantId, occurredAt: touch.addedAt })), placedAt);
            if (!picked)
                continue;
            await tx.placementAttribution.updateMany({ where: { id: picked.id, orderItemId: null },
                data: { orderItemId: item.id, attributedAt: placedAt } });
        }
    }
    /**
     * 发起线上支付：用购物袋凭证定位归属，再交给支付服务调渠道。
     * 与下单同一把凭证——拿到别人的 orderId 也发不起来。
     */
    async startOnlinePayment(orderId, token, ctx) {
        const cartId = await this.db.$transaction(async (tx) => (await this.cartService.locate(tx, token)).id);
        return this.payments.onlineIntent(orderId, cartId, ctx);
    }
    async placeOrder(token, idempotencyKey, body, ctx, memberToken = null) {
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 128)
            throw new AuthError(422, 'VALIDATION_ERROR');
        if (body.customerNote !== undefined && body.customerNote !== null && body.customerNote.length > 1_000)
            throw new AuthError(422, 'VALIDATION_ERROR');
        await this.identity.limitIp(ctx);
        const digest = createHash('sha256').update(orderRequestFingerprint({ quoteId: body.quoteId,
            confirmedQuoteVersion: body.confirmedQuoteVersion, paymentMethodCode: body.paymentMethodCode,
            customerNote: body.customerNote ?? null })).digest('hex');
        // 订单号有随机后缀，极小概率撞号：只重试这一种冲突，其余错误原样抛出。
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await this.db.$transaction(async (tx) => {
                    // 先认购物袋再认幂等键：网络重试时购物袋已转换，但同一 key 必须还能拿回原订单。
                    const cart = await this.cartService.locate(tx, token);
                    await this.lock(tx, `idempotency:${idempotencyKey}`);
                    const existing = await tx.shopOrder.findUnique({ where: { idempotencyKey } });
                    if (existing) {
                        if (existing.requestDigest !== digest || existing.cartId !== cart.id)
                            throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
                        // 重放也可能补上关联：首次下单时会员 cookie 缺省，重试时才带上。
                        if (memberToken)
                            await this.linkMember(tx, existing.id, memberToken);
                        return this.orderView(existing);
                    }
                    if (cart.status !== 'active')
                        throw new AuthError(401, 'UNAUTHORIZED');
                    const quote = await tx.checkoutQuote.findUnique({ where: { id: body.quoteId }, include: { lines: true } });
                    // 两种失败原因分开报：排查「报价过期」和「拿别人的报价下单」时要能一眼区分。
                    if (!quote)
                        throw new AuthError(422, 'QUOTE_NOT_FOUND');
                    if (quote.cartId !== cart.id)
                        throw new AuthError(422, 'QUOTE_CART_MISMATCH');
                    this.rule(() => assertQuoteActive(quote.status, quote.expiresAt, new Date()));
                    this.rule(() => assertQuoteVersion(quote.version, body.confirmedQuoteVersion));
                    await this.lock(tx, `quote:${quote.id}`);
                    // 拿到锁后重读：并发同报价的两个请求只能有一个把 active 变成 consumed。
                    const fresh = await tx.checkoutQuote.findUnique({ where: { id: quote.id } });
                    if (!fresh || fresh.status !== 'active')
                        throw new AuthError(409, 'QUOTE_NOT_AVAILABLE');
                    const rate = await tx.shippingRate.findUnique({ where: { id: quote.shippingMethodId } });
                    if (!rate || !rate.enabled)
                        throw new AuthError(409, 'SHIPPING_UNAVAILABLE');
                    // 商品级收款约束：按购物袋里的商品取交集（空数组视为不限）。
                    // 用独立查询而不是复用下面的循环，是因为必须先于 resolveCheckout 得到结果。
                    const channelOwnerIds = quote.lines.map(line => line.variantId).filter((id) => Boolean(id));
                    const channelOwners = await tx.productVariant.findMany({ where: { id: { in: channelOwnerIds } },
                        select: { product: { select: { allowedPaymentChannels: true } } } });
                    if (channelOwners.length !== channelOwnerIds.length)
                        throw new AuthError(409, 'CART_ITEM_UNAVAILABLE');
                    const allowedChannels = availableChannelsFor(channelOwners.map(owner => owner.product.allowedPaymentChannels));
                    // 可售方式 = 已接入 + 已批准 + 已启用 + 落在商品允许范围内；COD 还需配送方式开启货到付款。
                    const method = await this.payments.resolveCheckout(tx, body.paymentMethodCode.trim().toLowerCase(), rate.codEnabled, allowedChannels);
                    const methodCode = method.definition.code;
                    // 线上网关：COD 记 cod_due（交货收钱），人工转账记 created（等到账）。
                    const paymentStatus = method.definition.channel === 'cod' ? 'cod_due' : 'created';
                    // 整单没有任何货到付款余地时，未收款不许发货（发货侧据此拦截）。
                    const prepaymentRequired = requiresPrepayment(allowedChannels);
                    const accountSummary = method.row.publicConfig.accountSummary ?? null;
                    const now = new Date();
                    for (const line of quote.lines) {
                        const variant = await tx.productVariant.findUnique({ where: { id: line.variantId }, include: { product: true } });
                        if (!variant || variant.status !== 'active' || variant.currency !== quote.currency
                            || variant.priceMinor !== line.unitPriceMinor)
                            throw new AuthError(409, 'PRICE_CHANGED');
                        const product = variant.product;
                        if (product.status !== 'active' || (product.publishedAt && product.publishedAt > now)
                            || !product.marketCodes.includes(quote.marketCode))
                            throw new AuthError(409, 'CART_ITEM_UNAVAILABLE');
                    }
                    const expiresAt = new Date(now.getTime() + RESERVATION_MINUTES * 60_000);
                    // 券必须在报价版本上仍然成立：规则被改过就要求重新报价，而不是沿用旧折扣。
                    let couponRow = null;
                    if (quote.couponId) {
                        couponRow = await tx.coupon.findUnique({ where: { id: quote.couponId } });
                        const snapshot = quote.couponSnapshot;
                        if (!couponRow || !snapshot || snapshot.ruleVersion !== couponRow.version)
                            throw new AuthError(409, 'COUPON_CHANGED');
                        this.rule(() => assertCouponUsable(couponRow, now, quote.currency));
                    }
                    const settings = await this.settings(tx);
                    const created = await tx.shopOrder.create({ data: {
                            publicOrderNumber: publicOrderNumber(this.day(settings.timezone, now), Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')),
                            idempotencyKey, requestDigest: digest, quoteId: quote.id, cartId: cart.id, shippingRateId: rate.id,
                            orderStatus: 'awaiting_confirmation', paymentStatus, currency: quote.currency,
                            subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor, shippingMinor: quote.shippingMinor,
                            taxMinor: quote.taxMinor, totalMinor: quote.totalMinor,
                            pointsRedeemed: quote.pointsRedeemed, pointsValueMinor: quote.pointsValueMinor,
                            pointsMemberId: quote.pointsMemberId, pointsRuleVersion: quote.pointsRuleVersion,
                            locale: quote.locale, marketCode: quote.marketCode,
                            contact: quote.contact, shippingAddress: quote.shippingAddress,
                            shippingMethodSnapshot: quote.shippingMethodSnapshot,
                            ...(quote.couponId ? { couponId: quote.couponId,
                                couponSnapshot: quote.couponSnapshot } : {}),
                            customerNote: body.customerNote ?? null, paymentMethodCode: methodCode,
                            requiresPrepayment: prepaymentRequired,
                            policyAcceptances: quote.policyAcceptances, placedAt: now,
                        } });
                    await tx.orderItem.createMany({ data: quote.lines.map(line => ({ orderId: created.id, variantId: line.variantId,
                            sku: line.sku, productName: line.productName, variantName: line.variantName, quantity: line.quantity,
                            unitPriceMinor: line.unitPriceMinor, lineSubtotalMinor: line.lineSubtotalMinor,
                            lineDiscountMinor: line.lineDiscountMinor, lineTotalMinor: line.lineTotalMinor })) });
                    // 订单行归因：只把下单前 24 小时内的最后一次区块交互绑到订单行；过期交互留台账不归因。
                    await this.attributePlacement(tx, cart.id, created.id, now);
                    // 台账与订单同事务：下单即有一条待收流水，收款登记只推进状态，不补造记录。
                    await this.payments.openLedger(tx, created, method.definition, method.row);
                    for (const line of quote.lines)
                        await this.reserve(tx, created.id, line, expiresAt);
                    if (quote.couponId && couponRow) {
                        // 专属券下单时复核资格：报价后会员会话失效或等级被改，不能沿用专属折扣。
                        const orderMember = await this.optionalMember(tx, memberToken);
                        await this.promotions.assertRedemptionEligible(tx, couponRow, orderMember?.tierId ?? null);
                        // 限额键用报价时冻结的值：换人登录/改联系方式都不能改变额度归属。
                        const frozenKey = quote.couponCustomerKey;
                        if (!frozenKey)
                            throw new AuthError(409, 'COUPON_CHANGED');
                        await this.promotions.reserve(tx, { orderId: created.id,
                            customerKey: frozenKey, now, expiresAt,
                            priced: { coupon: couponRow, couponId: couponRow.id, couponCode: couponRow.code,
                                discountMinor: quote.discountMinor, lineDiscounts: new Map(),
                                summary: { codeMasked: '', discountMinor: quote.discountMinor },
                                snapshot: quote.couponSnapshot,
                                ruleVersion: `coupon:${couponRow.id}:v${couponRow.version}`, customerKey: frozenKey } });
                    }
                    await tx.checkoutQuote.update({ where: { id: quote.id }, data: { status: 'consumed' } });
                    await tx.guestCart.update({ where: { id: cart.id }, data: { status: 'converted' } });
                    await tx.orderStatusEvent.create({ data: { orderId: created.id, fromStatus: null,
                            toStatus: 'awaiting_confirmation', reason: 'order_placed', actorType: 'customer' } });
                    // 已登录会员下单即建立关联：会员中心要能立刻看到这一单，而不是等下次登录按邮箱补齐。
                    const linkedMemberId = memberToken ? await this.linkMember(tx, created.id, memberToken) : null;
                    if (quote.pointsRedeemed > 0) {
                        // 积分按报价快照扣：换人登录或会话失效都必须拒绝，不能把 A 的点扣到 B 名下。
                        if (!linkedMemberId || linkedMemberId !== quote.pointsMemberId) {
                            throw new AuthError(403, 'POINTS_MEMBER_MISMATCH');
                        }
                        await redeemOrderPointsInTx(tx, created.id, linkedMemberId, created.publicOrderNumber, quote.pointsRedeemed, quote.pointsRuleVersion ?? LOYALTY_REDEEM_RULE_VERSION, now);
                    }
                    await this.identity.recordAudit(tx, ctx, null, 'checkout.order.created', created.id);
                    return this.orderView(created, accountSummary);
                }, { timeout: 15_000 });
            }
            catch (error) {
                const code = error.code;
                const target = String(error.meta?.target ?? '');
                if (code === 'P2002' && target.includes('publicOrderNumber') && attempt < 2)
                    continue;
                throw error;
            }
        }
        throw new AuthError(409, 'STATE_CONFLICT');
    }
    /**
     * 可选会员身份：只用于「专属券资格与限额主体」。会话无效时降级为 null（访客口径），
     * 不阻断普通报价；会员专属券随后会因等级为空被明确拒绝。
     */
    async optionalMember(tx, token) {
        if (!token)
            return null;
        try {
            const { member } = await resolveMemberSession(tx, token);
            return { id: member.id, tierId: member.tierId };
        }
        catch (error) {
            if (error instanceof AuthError)
                return null;
            throw error;
        }
    }
    /**
     * 会员关联是附加事实，不是结账前置条件：会员会话过期、被撤销或会员被停用时，
     * 订单照常成立，只是不产生关联（访客订单本来就允许存在）。
     */
    async linkMember(tx, orderId, token) {
        let memberId;
        try {
            memberId = (await resolveMemberSession(tx, token)).member.id;
        }
        catch (error) {
            if (error instanceof AuthError)
                return null;
            throw error;
        }
        await tx.orderMemberLink.createMany({ data: [{ orderId, memberId, source: 'checkout' }], skipDuplicates: true });
        return memberId;
    }
    /** 报价有效期用于前端倒计时与测试断言，不额外暴露内部字段。 */
    static quoteTtlSeconds = QUOTE_TTL_SECONDS;
}
