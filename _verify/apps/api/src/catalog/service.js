import { randomUUID } from 'node:crypto';
import { assertCategoryParent, assertMarketSelection, assertPublishable, normalizeAttributes, normalizeLabelTranslations, normalizeMedia, normalizeProductTranslations, normalizeVariants, publicationState, categoryPath, CatalogRuleError } from '../../../../packages/domain/src/catalog.js';
import { effectiveReviewStatus, normalizeMarketCode } from '../../../../packages/domain/src/store.js';
import { normalizeAllowedChannels } from '../../../../packages/domain/src/payments.js';
import { AuthError } from '../identity/service.js';
import { recordPathRedirect } from '../content/preview.js';
const includeProduct = { translations: true, variants: { include: { inventory: true } }, media: true, categories: true };
/**
 * 商品目录服务（M03）。
 *
 * 会话、权限与审计统一走 IdentityService 的授权边界；这里只负责目录规则与持久化。
 * 数据库唯一约束负责 SKU/slug 的并发冲突，业务规则负责“发布前的完整性”，
 * 两者缺一不可：只在应用层查重会在并发下产生重复，只靠约束则无法给出可读的 422。
 */
export class CatalogService {
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
            if (error instanceof CatalogRuleError)
                throw new AuthError(422, 'VALIDATION_ERROR');
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
                throw new AuthError(409, 'STATE_CONFLICT');
            if (code === 'P2003')
                throw new AuthError(422, 'VALIDATION_ERROR');
            if (code === 'P2025')
                throw new AuthError(404, 'NOT_FOUND');
            throw error;
        }
    }
    async lock(tx, key) { await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }
    async storeContext(tx) {
        const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
        const markets = await tx.marketProfile.findMany({ where: { storeConfigId: 1 } });
        const now = new Date();
        return {
            locales: (row?.locales ?? ['zh-CN', 'zh-HK', 'en']),
            currency: row?.baseCurrency ?? 'HKD',
            markets: markets.map(market => {
                const status = effectiveReviewStatus(market.reviewStatus, market.reviewValidUntil, now);
                return { marketCode: market.marketCode, enabled: market.enabled && status === 'approved', reviewStatus: status,
                    eligibleProductIds: market.eligibleProductIds };
            }),
        };
    }
    // ---- 分类 -----------------------------------------------------------------
    categoryView(row) {
        return { id: row.id, parentId: row.parentId ?? null, position: row.position, enabled: row.enabled,
            translations: [...row.translations].sort((a, b) => a.locale.localeCompare(b.locale)).map(translation => ({
                locale: translation.locale, name: translation.name, slug: translation.slug ?? null, description: translation.description ?? null,
            })),
            version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    }
    async listCategories(supplied) {
        return this.identity.withPermission(supplied, null, 'catalog.read', async (tx) => {
            const rows = await tx.category.findMany({ include: { translations: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
            return { items: rows.map(row => this.categoryView(row)) };
        });
    }
    async getCategory(supplied, id) {
        return this.identity.withPermission(supplied, null, 'catalog.read', async (tx) => {
            const row = await tx.category.findUnique({ where: { id }, include: { translations: true } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            return this.categoryView(row);
        });
    }
    async assertParent(tx, id, parentId) {
        const rows = await tx.category.findMany({ select: { id: true, parentId: true } });
        this.rule(() => assertCategoryParent(rows, id, parentId));
    }
    async createCategory(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
            const translations = this.rule(() => normalizeLabelTranslations(body.translations ?? [], false));
            const parentId = body.parentId ?? null;
            await this.assertParent(tx, null, parentId);
            const row = await this.guarded(() => tx.category.create({ data: { parentId, position: body.position ?? 0, enabled: body.enabled ?? true,
                    translations: { create: translations } }, include: { translations: true } }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.category.created', row.id);
            return this.categoryView(row);
        }, true);
    }
    async updateCategory(supplied, csrfValue, id, version, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
            await this.lock(tx, `category:${id}`);
            const existing = await tx.category.findUnique({ where: { id }, include: { translations: true } });
            if (!existing)
                throw new AuthError(404, 'NOT_FOUND');
            if (existing.version !== version)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const translations = body.translations ? this.rule(() => normalizeLabelTranslations(body.translations, false)) : null;
            const parentId = body.parentId === undefined ? existing.parentId : body.parentId;
            if (parentId !== existing.parentId)
                await this.assertParent(tx, id, parentId);
            const enabled = body.enabled ?? existing.enabled;
            const row = await this.guarded(() => tx.category.update({ where: { id }, include: { translations: true }, data: {
                    parentId, position: body.position ?? existing.position, enabled, version: { increment: 1 },
                    ...(translations ? { translations: { deleteMany: {}, create: translations } } : {}),
                } }));
            // 改 slug 要留下 301：分类地址比内容页更常被外部链接和搜索结果引用，
            // 改完不登记等于把已经积累的入站流量直接送进 404。
            const redirected = [];
            if (translations) {
                for (const previous of existing.translations) {
                    // 从来没填过 slug 就是「第一次有地址」，没有旧地址可言，不产生跳转。
                    if (!previous.slug)
                        continue;
                    const fromPath = this.sitePath(previous.locale, previous.slug);
                    // 旧地址表达不成站内路径（中文/空格 slug）：它从来没有被登记过，也就无需处理。
                    if (!fromPath)
                        continue;
                    const next = translations.find(item => item.locale === previous.locale) ?? null;
                    const toPath = next?.slug ? this.sitePath(previous.locale, next.slug) : null;
                    if (!toPath) {
                        // 这条地址已经没有可用去向（语言被删、slug 被清空、新 slug 无法表达成站内路径）：
                        // 指向它的 301 一起清理，否则会把访客从一个 404 送到另一个 404。
                        await tx.seoRedirect.deleteMany({ where: { categoryId: id, toPath: fromPath } });
                        continue;
                    }
                    if (toPath === fromPath)
                        continue;
                    await recordPathRedirect(tx, { locale: previous.locale, fromPath, toPath,
                        owner: { categoryId: id }, actorId: actor.id });
                    redirected.push(`${fromPath} -> ${toPath}`);
                }
            }
            // 停用即下线（前台按 404 处理）：指向这个分类的跳转全部摘掉，重新启用时地址由当前 slug 决定。
            if (existing.enabled && !enabled)
                await tx.seoRedirect.deleteMany({ where: { categoryId: id } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.category.updated', id, 'success', redirected.length ? redirected.join(' ') : undefined);
            return this.categoryView(row);
        }, true);
    }
    /** 分类的公开路径；slug 含中文/空格等无法表达成站内路径时返回 null（登记了也不会命中）。 */
    sitePath(locale, slug) {
        try {
            return categoryPath(locale, slug);
        }
        catch {
            return null;
        }
    }
    // ---- 品牌 -----------------------------------------------------------------
    brandView(row) {
        return { id: row.id, logoMediaId: row.logoMediaId ?? null, enabled: row.enabled,
            translations: [...row.translations].sort((a, b) => a.locale.localeCompare(b.locale)).map(translation => ({
                locale: translation.locale, name: translation.name, slug: translation.slug ?? null, description: translation.description ?? null,
            })),
            version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    }
    async listBrands(supplied) {
        return this.identity.withPermission(supplied, null, 'catalog.read', async (tx) => {
            const rows = await tx.brand.findMany({ include: { translations: true }, orderBy: { createdAt: 'asc' } });
            return { items: rows.map(row => this.brandView(row)) };
        });
    }
    async getBrand(supplied, id) {
        return this.identity.withPermission(supplied, null, 'catalog.read', async (tx) => {
            const row = await tx.brand.findUnique({ where: { id }, include: { translations: true } });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            return this.brandView(row);
        });
    }
    async createBrand(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
            const translations = this.rule(() => normalizeLabelTranslations(body.translations ?? [], false));
            const logoMediaId = await this.requireLogo(tx, body.logoMediaId ?? null);
            const row = await this.guarded(() => tx.brand.create({ data: { logoMediaId, enabled: body.enabled ?? true,
                    translations: { create: translations } }, include: { translations: true } }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.brand.created', row.id);
            return this.brandView(row);
        }, true);
    }
    async updateBrand(supplied, csrfValue, id, version, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
            await this.lock(tx, `brand:${id}`);
            const existing = await tx.brand.findUnique({ where: { id }, include: { translations: true } });
            if (!existing)
                throw new AuthError(404, 'NOT_FOUND');
            if (existing.version !== version)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const translations = body.translations ? this.rule(() => normalizeLabelTranslations(body.translations, false)) : null;
            const logoMediaId = body.logoMediaId === undefined ? undefined : await this.requireLogo(tx, body.logoMediaId);
            const row = await this.guarded(() => tx.brand.update({ where: { id }, include: { translations: true }, data: {
                    logoMediaId: logoMediaId === undefined ? existing.logoMediaId : logoMediaId,
                    enabled: body.enabled ?? existing.enabled, version: { increment: 1 },
                    ...(translations ? { translations: { deleteMany: {}, create: translations } } : {}),
                } }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.brand.updated', id);
            return this.brandView(row);
        }, true);
    }
    // ---- 商品 -----------------------------------------------------------------
    productView(row) {
        return {
            id: row.id, baseSku: row.baseSku ?? null, brandId: row.brandId ?? null,
            categoryIds: row.categories.map(link => link.categoryId).sort(),
            marketCodes: [...row.marketCodes].sort(), status: row.status,
            allowedPaymentChannels: [...row.allowedPaymentChannels].sort(),
            translations: [...row.translations].sort((a, b) => a.locale.localeCompare(b.locale)).map(translation => ({
                locale: translation.locale, name: translation.name, slug: translation.slug,
                shortDescription: translation.shortDescription ?? null, description: translation.description ?? null,
                seoTitle: translation.seoTitle ?? null, seoDescription: translation.seoDescription ?? null,
            })),
            variants: [...row.variants].sort((a, b) => a.sku.localeCompare(b.sku)).map(variant => {
                const onHand = variant.inventory?.onHand ?? 0;
                const reserved = variant.inventory?.reserved ?? 0;
                return { id: variant.id, sku: variant.sku, optionValues: variant.optionValues,
                    priceMinor: variant.priceMinor, compareAtMinor: variant.compareAtMinor ?? null, currency: variant.currency,
                    status: variant.status, onHand, reserved, available: Math.max(0, onHand - reserved) };
            }),
            media: [...row.media].sort((a, b) => a.position - b.position).map(item => ({ mediaId: item.mediaId, position: item.position,
                altByLocale: item.altByLocale })),
            version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
        };
    }
    async listProducts(supplied, limit, cursor, query) {
        return this.identity.withPermission(supplied, null, 'catalog.read', async (tx) => {
            if (cursor && !await tx.product.findUnique({ where: { id: cursor } }))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const where = query ? { OR: [
                    { baseSku: { contains: query, mode: 'insensitive' } },
                    { translations: { some: { name: { contains: query, mode: 'insensitive' } } } },
                    { variants: { some: { sku: { contains: query, mode: 'insensitive' } } } },
                ] } : {};
            const rows = await tx.product.findMany({ where, include: includeProduct, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            const items = rows.slice(0, limit);
            const hasMore = rows.length > limit;
            return { items: items.map(row => this.productView(row)), hasMore, nextCursor: hasMore ? items.at(-1).id : null };
        });
    }
    async getProduct(supplied, id) {
        return this.identity.withPermission(supplied, null, 'catalog.read', async (tx) => {
            const row = await tx.product.findUnique({ where: { id }, include: includeProduct });
            if (!row)
                throw new AuthError(404, 'NOT_FOUND');
            return this.productView(row);
        });
    }
    async requireCategories(tx, ids) {
        if (!ids.length)
            this.rule(() => { throw new CatalogRuleError('categoryIds'); });
        const unique = [...new Set(ids)];
        const found = await tx.category.count({ where: { id: { in: unique } } });
        if (found !== unique.length)
            this.rule(() => { throw new CatalogRuleError('categoryIds'); });
        return unique;
    }
    async requireBrand(tx, brandId) {
        if (!brandId)
            return null;
        if (!await tx.brand.findUnique({ where: { id: brandId } }))
            this.rule(() => { throw new CatalogRuleError('brandId'); });
        return brandId;
    }
    /** 只能引用本实例已确认的媒体；pending 对象没有可展示的字节，不能挂到商品或品牌上。 */
    async requireMedia(tx, ids) {
        const unique = [...new Set(ids)];
        if (!unique.length)
            return;
        const found = await tx.mediaAsset.count({ where: { id: { in: unique }, status: 'ready' } });
        if (found !== unique.length)
            this.rule(() => { throw new CatalogRuleError('media'); });
    }
    async requireLogo(tx, logoMediaId) {
        if (!logoMediaId)
            return null;
        await this.requireMedia(tx, [logoMediaId]);
        return logoMediaId;
    }
    async requireMarkets(tx, codes) {
        if (!codes.length)
            this.rule(() => { throw new CatalogRuleError('marketCodes'); });
        const normalized = codes.map(code => this.rule(() => normalizeMarketCode(code)));
        if (new Set(normalized).size !== normalized.length)
            this.rule(() => { throw new CatalogRuleError('marketCodes'); });
        const found = await tx.marketProfile.count({ where: { marketCode: { in: normalized } } });
        if (found !== normalized.length)
            this.rule(() => { throw new CatalogRuleError('marketCodes'); });
        return normalized;
    }
    async createProduct(supplied, csrfValue, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
            const store = await this.storeContext(tx);
            const translations = this.rule(() => normalizeProductTranslations(body.translations ?? []));
            const variants = this.rule(() => normalizeVariants(body.variants ?? [], store.currency));
            const attributes = this.rule(() => normalizeAttributes(body.attributes ?? []));
            const media = this.rule(() => normalizeMedia(body.media ?? []));
            const categoryIds = await this.requireCategories(tx, body.categoryIds ?? []);
            const marketCodes = await this.requireMarkets(tx, body.marketCodes ?? []);
            const brandId = await this.requireBrand(tx, body.brandId ?? null);
            const allowedPaymentChannels = this.rule(() => normalizeAllowedChannels(body.allowedPaymentChannels));
            await this.requireMedia(tx, media.map(item => item.mediaId));
            const id = randomUUID();
            const row = await this.guarded(() => tx.product.create({ data: {
                    id, status: 'draft', baseSku: body.baseSku?.trim() || null, brandId, taxClassRef: body.taxClassRef?.trim() || null,
                    marketCodes, allowedPaymentChannels, translations: { create: translations },
                    variants: { create: variants.map(variant => ({ id: randomUUID(), ...variant })) },
                    media: { create: media.map(item => ({ id: randomUUID(), ...item })) },
                    attributes: { create: attributes.map(attribute => ({ id: randomUUID(), ...attribute })) },
                    categories: { create: categoryIds.map(categoryId => ({ categoryId })) },
                }, include: includeProduct }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.product.created', id);
            return this.productView(row);
        }, true);
    }
    /**
     * PATCH 商品：整组替换提供的子集合（翻译/规格/图片/属性/分类/市场），未提供的保持原样。
     * 删除规格是危险操作：有现存库存的规格必须先调整库存，不能借编辑商品抹掉数量。
     */
    async updateProduct(supplied, csrfValue, id, version, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
            await this.lock(tx, `product:${id}`);
            const existing = await tx.product.findUnique({ where: { id }, include: includeProduct });
            if (!existing)
                throw new AuthError(404, 'NOT_FOUND');
            if (existing.version !== version)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const store = await this.storeContext(tx);
            const translations = body.translations ? this.rule(() => normalizeProductTranslations(body.translations)) : null;
            const variants = body.variants ? this.rule(() => normalizeVariants(body.variants, store.currency)) : null;
            const attributes = body.attributes ? this.rule(() => normalizeAttributes(body.attributes)) : null;
            const media = body.media ? this.rule(() => normalizeMedia(body.media)) : null;
            const categoryIds = body.categoryIds ? await this.requireCategories(tx, body.categoryIds) : null;
            const marketCodes = body.marketCodes ? await this.requireMarkets(tx, body.marketCodes) : null;
            const allowedPaymentChannels = body.allowedPaymentChannels === undefined ? null
                : this.rule(() => normalizeAllowedChannels(body.allowedPaymentChannels));
            const brandId = body.brandId === undefined ? undefined : await this.requireBrand(tx, body.brandId);
            if (media)
                await this.requireMedia(tx, media.map(item => item.mediaId));
            if (variants) {
                const incoming = new Set(variants.map(variant => variant.sku));
                for (const current of existing.variants) {
                    if (incoming.has(current.sku))
                        continue;
                    if ((current.inventory?.onHand ?? 0) > 0)
                        throw new AuthError(422, 'VARIANT_HAS_STOCK');
                    await tx.productVariant.delete({ where: { id: current.id } });
                }
                const bySku = new Map(existing.variants.map(variant => [variant.sku, variant]));
                for (const variant of variants) {
                    const current = bySku.get(variant.sku);
                    if (current)
                        await tx.productVariant.update({ where: { id: current.id }, data: { optionValues: variant.optionValues,
                                priceMinor: variant.priceMinor, compareAtMinor: variant.compareAtMinor, currency: variant.currency, status: variant.status } });
                    else
                        await tx.productVariant.create({ data: { id: randomUUID(), productId: id, ...variant } });
                }
            }
            if (translations) {
                await tx.productTranslation.deleteMany({ where: { productId: id } });
                await tx.productTranslation.createMany({ data: translations.map(translation => ({ productId: id, ...translation })) });
            }
            if (media) {
                await tx.productMedia.deleteMany({ where: { productId: id } });
                if (media.length)
                    await tx.productMedia.createMany({ data: media.map(item => ({ id: randomUUID(), productId: id, ...item })) });
            }
            if (attributes) {
                await tx.productAttribute.deleteMany({ where: { productId: id } });
                if (attributes.length)
                    await tx.productAttribute.createMany({ data: attributes.map(attribute => ({ id: randomUUID(), productId: id, ...attribute })) });
            }
            if (categoryIds) {
                await tx.productCategory.deleteMany({ where: { productId: id } });
                await tx.productCategory.createMany({ data: categoryIds.map(categoryId => ({ productId: id, categoryId })) });
            }
            const row = await this.guarded(() => tx.product.update({ where: { id }, include: includeProduct, data: {
                    ...(body.baseSku !== undefined ? { baseSku: body.baseSku?.trim() || null } : {}),
                    ...(brandId !== undefined ? { brandId } : {}),
                    ...(body.taxClassRef !== undefined ? { taxClassRef: body.taxClassRef?.trim() || null } : {}),
                    ...(marketCodes ? { marketCodes } : {}),
                    ...(allowedPaymentChannels ? { allowedPaymentChannels } : {}),
                    version: { increment: 1 },
                } }));
            await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.product.updated', id);
            return this.productView(row);
        }, true);
    }
    async publishProduct(supplied, csrfValue, id, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'catalog.publish', async (tx, actor, _session, now) => {
            await this.lock(tx, `product:${id}`);
            const product = await tx.product.findUnique({ where: { id }, include: includeProduct });
            if (!product)
                throw new AuthError(404, 'NOT_FOUND');
            if (product.version !== body.expectedVersion)
                throw new AuthError(409, 'VERSION_CONFLICT');
            const store = await this.storeContext(tx);
            const marketCodes = await this.requireMarkets(tx, body.marketCodes);
            this.rule(() => assertPublishable({ translations: product.translations, variants: product.variants,
                enabledLocales: store.locales }));
            this.rule(() => assertMarketSelection(marketCodes, store.markets, id));
            const publishedAt = body.publishedAt ? new Date(body.publishedAt) : now;
            if (Number.isNaN(publishedAt.getTime()))
                throw new AuthError(422, 'VALIDATION_ERROR');
            const status = publicationState(publishedAt, now);
            const updated = await tx.product.update({ where: { id }, data: {
                    status: status === 'active' ? 'active' : 'draft', marketCodes, publishedAt, version: { increment: 1 }
                } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.product.published', id, 'success', marketCodes.join(','));
            return { productId: id, version: updated.version, status, publishedAt: publishedAt.toISOString(), jobId: null };
        }, true);
    }
    async unpublishProduct(supplied, csrfValue, id, body, ctx) {
        return this.identity.withPermission(supplied, csrfValue, 'catalog.publish', async (tx, actor, _session, now) => {
            await this.lock(tx, `product:${id}`);
            const product = await tx.product.findUnique({ where: { id } });
            if (!product)
                throw new AuthError(404, 'NOT_FOUND');
            const updated = await tx.product.update({ where: { id }, data: { status: 'draft', publishedAt: null, version: { increment: 1 } } });
            await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.product.unpublished', id, 'success', body.reason);
            return { productId: id, status: updated.status, version: updated.version, unpublishedAt: now.toISOString() };
        }, true);
    }
}
