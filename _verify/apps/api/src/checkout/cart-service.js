import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CheckoutRuleError, MAX_CART_LINES, MAX_CART_QUANTITY, normalizeQuantity } from '../../../../packages/domain/src/checkout.js';
import { PLACEMENT_RULE_VERSION, PlacementRuleError, normalizeCartAttribution } from '../../../../packages/domain/src/placement.js';
import { AuthError } from '../identity/service.js';
const CART_DAYS = 30;
const variantInclude = { inventory: true, product: { include: { translations: true } } };
const includeItem = { variant: { include: variantInclude } };
/**
 * 游客购物袋（M06）。
 *
 * 身份只来自 cookie：库中保存 token 的 SHA-256 摘要，拿不到原文就无法冒用。
 * 购物袋不保存价格——价格每次读取都从当前变体重新取，避免“加购价”变成承诺价。
 * 未发布、已下架、跨币种或超出可售库存的变体直接拒收。
 */
export class CartService {
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
            if (error instanceof CheckoutRuleError)
                throw new AuthError(422, error.code);
            if (error instanceof PlacementRuleError)
                throw new AuthError(422, error.code);
            throw error;
        }
    }
    digest(token) { return createHash('sha256').update(token).digest('hex'); }
    /** 43 字符 base64url，与身份模块的 cookie 形状一致，便于统一校验。 */
    token() { return randomBytes(32).toString('base64url'); }
    async defaults(tx) {
        const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
        return { currency: row?.baseCurrency ?? 'HKD', locale: row?.defaultLocale ?? 'zh-CN' };
    }
    async create(ctx) {
        await this.identity.limitIp(ctx);
        const token = this.token();
        const csrfToken = this.token();
        return this.db.$transaction(async (tx) => {
            const { currency, locale } = await this.defaults(tx);
            const cart = await tx.guestCart.create({ data: { tokenDigest: this.digest(token), currency, locale,
                    expiresAt: new Date(Date.now() + CART_DAYS * 86_400_000) } });
            return { cart: await this.view(tx, cart), token, csrfToken };
        });
    }
    /**
     * 只校验 token 与过期时间，不要求仍在 active：幂等重试要能认出“已转换”的购物袋。
     * 是否允许继续加购/改数量由 requireCart 判断。
     */
    async locate(tx, token) {
        const digest = this.digest(token);
        const cart = await tx.guestCart.findUnique({ where: { tokenDigest: digest } });
        // 摘要比较仍走定长比较，避免给“token 是否存在”留下时间差。
        if (!cart || !timingSafeEqual(Buffer.from(cart.tokenDigest, 'hex'), Buffer.from(digest, 'hex')))
            throw new AuthError(401, 'UNAUTHORIZED');
        if (cart.expiresAt.getTime() <= Date.now())
            throw new AuthError(401, 'UNAUTHORIZED');
        return cart;
    }
    async cart(tx, token) {
        const cart = await this.locate(tx, token);
        if (cart.status !== 'active')
            throw new AuthError(401, 'UNAUTHORIZED');
        return cart;
    }
    /** 每次读取都把可售性与库存重新算一遍：购物袋里的行不是承诺，报价才是。 */
    async view(tx, cart) {
        const rows = await tx.cartItem.findMany({ where: { cartId: cart.id }, include: includeItem,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        const now = Date.now();
        const items = rows.map(row => {
            const variant = row.variant;
            const product = variant.product;
            const translation = product.translations.find(item => item.locale === (cart.locale ?? 'zh-CN'))
                ?? product.translations[0] ?? null;
            const availableQuantity = Math.max(0, (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0));
            const sellable = product.status === 'active' && (!product.publishedAt || product.publishedAt.getTime() <= now)
                && product.marketCodes.length > 0 && variant.status === 'active' && variant.currency === cart.currency;
            const available = sellable && availableQuantity >= row.quantity;
            return { id: row.id, variantId: variant.id, sku: variant.sku, productName: translation?.name ?? product.baseSku ?? '',
                variantName: Object.values((variant.optionValues ?? {})).join(' / ') || null,
                quantity: row.quantity, unitPriceMinor: variant.priceMinor, lineSubtotalMinor: variant.priceMinor * row.quantity,
                available, availableQuantity };
        });
        const warnings = [];
        if (items.some(item => !item.available))
            warnings.push('CART_ITEMS_UNAVAILABLE');
        return { cartId: cart.id, currency: cart.currency, locale: cart.locale ?? null,
            itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
            // 小计只汇总当前可售行：把不可售商品算进金额会给出无法兑现的总额。
            subtotalMinor: items.filter(item => item.available).reduce((sum, item) => sum + item.lineSubtotalMinor, 0),
            items, warnings, expiresAt: cart.expiresAt.toISOString() };
    }
    async get(token) {
        return this.db.$transaction(async (tx) => this.view(tx, await this.cart(tx, token)));
    }
    /** 结账服务复用同一套 token 解析：购物袋归属只在这里判断一次。 */
    async requireCart(tx, token) { return this.cart(tx, token); }
    async render(tx, cart) { return this.view(tx, cart); }
    async variantFor(tx, variantId, currency) {
        const variant = await tx.productVariant.findUnique({ where: { id: variantId }, include: variantInclude });
        if (!variant)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const product = variant.product;
        const now = Date.now();
        const sellable = product.status === 'active' && (!product.publishedAt || product.publishedAt.getTime() <= now)
            && product.marketCodes.length > 0 && variant.status === 'active';
        // 跨币种变体不能混进同一个购物袋：报价只有一个币种，混币种就是隐藏的换算。
        if (!sellable || variant.currency !== currency)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return variant;
    }
    async addItem(token, body, ctx) {
        await this.identity.limitIp(ctx);
        const quantity = this.rule(() => normalizeQuantity(body.quantity));
        return this.db.$transaction(async (tx) => {
            const cart = await this.cart(tx, token);
            await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${`cart:${cart.id}`}))::text`;
            const variant = await this.variantFor(tx, body.variantId, cart.currency);
            const existing = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } } });
            const total = (existing?.quantity ?? 0) + quantity;
            if (total > MAX_CART_QUANTITY)
                throw new AuthError(422, 'VALIDATION_ERROR');
            if (!existing && await tx.cartItem.count({ where: { cartId: cart.id } }) >= MAX_CART_LINES)
                throw new AuthError(422, 'VALIDATION_ERROR');
            const available = Math.max(0, (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0));
            if (available < total)
                throw new AuthError(409, 'OUT_OF_STOCK');
            if (existing)
                await tx.cartItem.update({ where: { id: existing.id }, data: { quantity: total } });
            else
                await tx.cartItem.create({ data: { cartId: cart.id, variantId: variant.id, quantity } });
            await this.recordAttribution(tx, cart, variant, body.attribution);
            return this.view(tx, cart);
        });
    }
    /**
     * 加购归因：只有明示同意的匿名区块交互才落库；服务端写入，浏览器不能直接造归因行。
     * 加购失败（库存/资格）时事务回滚，归因行也不会留下——加购与归因要么一起成功，要么都不算。
     */
    async recordAttribution(tx, cart, variant, raw) {
        const attribution = this.rule(() => normalizeCartAttribution(raw));
        if (!attribution)
            return;
        const now = new Date();
        // 会话快照补齐语言/设备/市场：报表按这些维度筛选时不必再回表。
        const session = attribution.sessionId
            ? await tx.analyticsSession.findUnique({ where: { sessionId: attribution.sessionId } })
            : null;
        await tx.placementAttribution.create({ data: {
                cartId: cart.id, variantId: variant.id, productId: variant.productId,
                sectionId: attribution.sectionId, sectionKey: attribution.sectionKey,
                placementId: attribution.placementId, publishVersionId: attribution.publishVersionId,
                interactionId: attribution.interactionId, pageKey: attribution.pageKey,
                sessionId: attribution.sessionId, locale: session?.locale ?? cart.locale,
                deviceClass: session?.deviceClass ?? null, marketCode: session?.marketCode ?? cart.marketCode,
                consentState: 'granted', ruleVersion: PLACEMENT_RULE_VERSION,
                // 未来时间戳（客户端时钟漂移）按服务端时间落库，避免归因时间晚于下单时间。
                addedAt: attribution.occurredAt.getTime() > now.getTime() ? now : attribution.occurredAt,
            } });
    }
    async line(tx, cartId, id) {
        const row = await tx.cartItem.findUnique({ where: { id }, include: includeItem });
        // 不属于本袋的行一律按不存在处理，不泄露别的袋子有哪些行。
        if (!row || row.cartId !== cartId)
            throw new AuthError(404, 'NOT_FOUND');
        return row;
    }
    async updateItem(token, id, body, ctx) {
        await this.identity.limitIp(ctx);
        const quantity = this.rule(() => normalizeQuantity(body.quantity));
        return this.db.$transaction(async (tx) => {
            const cart = await this.cart(tx, token);
            await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${`cart:${cart.id}`}))::text`;
            const row = await this.line(tx, cart.id, id);
            const available = Math.max(0, (row.variant.inventory?.onHand ?? 0) - (row.variant.inventory?.reserved ?? 0));
            if (available < quantity)
                throw new AuthError(409, 'OUT_OF_STOCK');
            await tx.cartItem.update({ where: { id }, data: { quantity } });
            return this.view(tx, cart);
        });
    }
    async removeItem(token, id, ctx) {
        await this.identity.limitIp(ctx);
        return this.db.$transaction(async (tx) => {
            const cart = await this.cart(tx, token);
            const row = await this.line(tx, cart.id, id);
            await tx.cartItem.delete({ where: { id: row.id } });
            return this.view(tx, cart);
        });
    }
}
