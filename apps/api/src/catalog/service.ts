import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import { assertCategoryParent, assertMarketSelection, assertPublishable, normalizeAttributes, normalizeLabelTranslations,
  normalizeMedia, normalizeProductTranslations, normalizeVariants, publicationState, CatalogRuleError } from '../../../../packages/domain/src/catalog.js';
import { effectiveReviewStatus, normalizeMarketCode } from '../../../../packages/domain/src/store.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';

type Tx = Prisma.TransactionClient;
const includeProduct = { translations: true, variants: { include: { inventory: true } }, media: true, categories: true } as const;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof includeProduct }>;
type CategoryRow = Prisma.CategoryGetPayload<{ include: { translations: true } }>;
type BrandRow = Prisma.BrandGetPayload<{ include: { translations: true } }>;

export interface CategoryBody { parentId?: string | null; position?: number; enabled?: boolean;
  translations?: { locale: string; name: string; slug?: string | null; description?: string | null }[] }
export interface BrandBody { logoMediaId?: string | null; enabled?: boolean;
  translations?: { locale: string; name: string; slug?: string | null; description?: string | null }[] }
export interface ProductBody {
  baseSku?: string | null; brandId?: string | null; categoryIds?: string[]; marketCodes?: string[]; taxClassRef?: string | null;
  translations?: { locale: string; name: string; slug: string; shortDescription?: string | null; description?: string | null;
    seoTitle?: string | null; seoDescription?: string | null }[];
  variants?: { sku: string; optionValues: Record<string, string>; priceMinor: number; compareAtMinor?: number | null;
    currency: string; status?: 'active' | 'inactive' }[];
  media?: { mediaId: string; position: number; altByLocale?: Record<string, string> }[];
  attributes?: { attributeCode: string; value: string | number | boolean }[];
}

/**
 * 商品目录服务（M03）。
 *
 * 会话、权限与审计统一走 IdentityService 的授权边界；这里只负责目录规则与持久化。
 * 数据库唯一约束负责 SKU/slug 的并发冲突，业务规则负责“发布前的完整性”，
 * 两者缺一不可：只在应用层查重会在并发下产生重复，只靠约束则无法给出可读的 422。
 */
export class CatalogService {
  constructor(private readonly identity: IdentityService) {}

  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) { if (error instanceof CatalogRuleError) throw new AuthError(422, 'VALIDATION_ERROR'); throw error; }
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') throw new AuthError(409, 'STATE_CONFLICT');
      if (code === 'P2003') throw new AuthError(422, 'VALIDATION_ERROR');
      if (code === 'P2025') throw new AuthError(404, 'NOT_FOUND');
      throw error;
    }
  }

  private async lock(tx: Tx, key: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`; }

  private async storeContext(tx: Tx) {
    const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
    const markets = await tx.marketProfile.findMany({ where: { storeConfigId: 1 } });
    const now = new Date();
    return {
      locales: (row?.locales ?? ['zh-CN', 'zh-HK', 'en']) as string[],
      currency: row?.baseCurrency ?? 'HKD',
      markets: markets.map(market => {
        const status = effectiveReviewStatus(market.reviewStatus, market.reviewValidUntil, now);
        return { marketCode: market.marketCode, enabled: market.enabled && status === 'approved', reviewStatus: status,
          eligibleProductIds: market.eligibleProductIds };
      }),
    };
  }

  // ---- 分类 -----------------------------------------------------------------

  private categoryView(row: CategoryRow) {
    return { id: row.id, parentId: row.parentId ?? null, position: row.position, enabled: row.enabled,
      translations: [...row.translations].sort((a, b) => a.locale.localeCompare(b.locale)).map(translation => ({
        locale: translation.locale, name: translation.name, slug: translation.slug ?? null, description: translation.description ?? null,
      })),
      version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  async listCategories(supplied: string) {
    return this.identity.withPermission(supplied, null, 'catalog.read', async tx => {
      const rows = await tx.category.findMany({ include: { translations: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
      return { items: rows.map(row => this.categoryView(row)) };
    });
  }

  async getCategory(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'catalog.read', async tx => {
      const row = await tx.category.findUnique({ where: { id }, include: { translations: true } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      return this.categoryView(row);
    });
  }

  private async assertParent(tx: Tx, id: string | null, parentId: string | null) {
    const rows = await tx.category.findMany({ select: { id: true, parentId: true } });
    this.rule(() => assertCategoryParent(rows, id, parentId));
  }

  async createCategory(supplied: string, csrfValue: string, body: CategoryBody, ctx: RequestContext) {
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

  async updateCategory(supplied: string, csrfValue: string, id: string, version: number, body: CategoryBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
      await this.lock(tx, `category:${id}`);
      const existing = await tx.category.findUnique({ where: { id }, include: { translations: true } });
      if (!existing) throw new AuthError(404, 'NOT_FOUND');
      if (existing.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      const translations = body.translations ? this.rule(() => normalizeLabelTranslations(body.translations!, false)) : null;
      const parentId = body.parentId === undefined ? existing.parentId : body.parentId;
      if (parentId !== existing.parentId) await this.assertParent(tx, id, parentId);
      const row = await this.guarded(() => tx.category.update({ where: { id }, include: { translations: true }, data: {
        parentId, position: body.position ?? existing.position, enabled: body.enabled ?? existing.enabled, version: { increment: 1 },
        ...(translations ? { translations: { deleteMany: {}, create: translations } } : {}),
      } }));
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.category.updated', id);
      return this.categoryView(row);
    }, true);
  }

  // ---- 品牌 -----------------------------------------------------------------

  private brandView(row: BrandRow) {
    return { id: row.id, logoMediaId: row.logoMediaId ?? null, enabled: row.enabled,
      translations: [...row.translations].sort((a, b) => a.locale.localeCompare(b.locale)).map(translation => ({
        locale: translation.locale, name: translation.name, slug: translation.slug ?? null, description: translation.description ?? null,
      })),
      version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  async listBrands(supplied: string) {
    return this.identity.withPermission(supplied, null, 'catalog.read', async tx => {
      const rows = await tx.brand.findMany({ include: { translations: true }, orderBy: { createdAt: 'asc' } });
      return { items: rows.map(row => this.brandView(row)) };
    });
  }

  async getBrand(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'catalog.read', async tx => {
      const row = await tx.brand.findUnique({ where: { id }, include: { translations: true } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      return this.brandView(row);
    });
  }

  async createBrand(supplied: string, csrfValue: string, body: BrandBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
      const translations = this.rule(() => normalizeLabelTranslations(body.translations ?? [], false));
      const row = await this.guarded(() => tx.brand.create({ data: { logoMediaId: body.logoMediaId ?? null, enabled: body.enabled ?? true,
        translations: { create: translations } }, include: { translations: true } }));
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.brand.created', row.id);
      return this.brandView(row);
    }, true);
  }

  async updateBrand(supplied: string, csrfValue: string, id: string, version: number, body: BrandBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
      await this.lock(tx, `brand:${id}`);
      const existing = await tx.brand.findUnique({ where: { id }, include: { translations: true } });
      if (!existing) throw new AuthError(404, 'NOT_FOUND');
      if (existing.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      const translations = body.translations ? this.rule(() => normalizeLabelTranslations(body.translations!, false)) : null;
      const row = await this.guarded(() => tx.brand.update({ where: { id }, include: { translations: true }, data: {
        logoMediaId: body.logoMediaId === undefined ? existing.logoMediaId : body.logoMediaId,
        enabled: body.enabled ?? existing.enabled, version: { increment: 1 },
        ...(translations ? { translations: { deleteMany: {}, create: translations } } : {}),
      } }));
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.brand.updated', id);
      return this.brandView(row);
    }, true);
  }

  // ---- 商品 -----------------------------------------------------------------

  private productView(row: ProductRow) {
    return {
      id: row.id, baseSku: row.baseSku ?? null, brandId: row.brandId ?? null,
      categoryIds: row.categories.map(link => link.categoryId).sort(),
      marketCodes: [...row.marketCodes].sort(), status: row.status,
      translations: [...row.translations].sort((a, b) => a.locale.localeCompare(b.locale)).map(translation => ({
        locale: translation.locale, name: translation.name, slug: translation.slug,
        shortDescription: translation.shortDescription ?? null, description: translation.description ?? null,
        seoTitle: translation.seoTitle ?? null, seoDescription: translation.seoDescription ?? null,
      })),
      variants: [...row.variants].sort((a, b) => a.sku.localeCompare(b.sku)).map(variant => {
        const onHand = variant.inventory?.onHand ?? 0; const reserved = variant.inventory?.reserved ?? 0;
        return { id: variant.id, sku: variant.sku, optionValues: variant.optionValues as Record<string, string>,
          priceMinor: variant.priceMinor, compareAtMinor: variant.compareAtMinor ?? null, currency: variant.currency,
          status: variant.status, onHand, reserved, available: Math.max(0, onHand - reserved) };
      }),
      media: [...row.media].sort((a, b) => a.position - b.position).map(item => ({ mediaId: item.mediaId, position: item.position,
        altByLocale: item.altByLocale as Record<string, string> })),
      version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listProducts(supplied: string, limit: number, cursor: string | null, query: string | null) {
    return this.identity.withPermission(supplied, null, 'catalog.read', async tx => {
      if (cursor && !await tx.product.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const where: Prisma.ProductWhereInput = query ? { OR: [
        { baseSku: { contains: query, mode: 'insensitive' } },
        { translations: { some: { name: { contains: query, mode: 'insensitive' } } } },
        { variants: { some: { sku: { contains: query, mode: 'insensitive' } } } },
      ] } : {};
      const rows = await tx.product.findMany({ where, include: includeProduct, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const items = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: items.map(row => this.productView(row)), hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
    });
  }

  async getProduct(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'catalog.read', async tx => {
      const row = await tx.product.findUnique({ where: { id }, include: includeProduct });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      return this.productView(row);
    });
  }

  private async requireCategories(tx: Tx, ids: readonly string[]) {
    if (!ids.length) this.rule(() => { throw new CatalogRuleError('categoryIds'); });
    const unique = [...new Set(ids)];
    const found = await tx.category.count({ where: { id: { in: unique } } });
    if (found !== unique.length) this.rule(() => { throw new CatalogRuleError('categoryIds'); });
    return unique;
  }

  private async requireBrand(tx: Tx, brandId: string | null) {
    if (!brandId) return null;
    if (!await tx.brand.findUnique({ where: { id: brandId } })) this.rule(() => { throw new CatalogRuleError('brandId'); });
    return brandId;
  }

  private async requireMarkets(tx: Tx, codes: readonly string[]) {
    if (!codes.length) this.rule(() => { throw new CatalogRuleError('marketCodes'); });
    const normalized = codes.map(code => this.rule(() => normalizeMarketCode(code)));
    if (new Set(normalized).size !== normalized.length) this.rule(() => { throw new CatalogRuleError('marketCodes'); });
    const found = await tx.marketProfile.count({ where: { marketCode: { in: normalized } } });
    if (found !== normalized.length) this.rule(() => { throw new CatalogRuleError('marketCodes'); });
    return normalized;
  }

  async createProduct(supplied: string, csrfValue: string, body: ProductBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
      const store = await this.storeContext(tx);
      const translations = this.rule(() => normalizeProductTranslations(body.translations ?? []));
      const variants = this.rule(() => normalizeVariants(body.variants ?? [], store.currency));
      const attributes = this.rule(() => normalizeAttributes(body.attributes ?? []));
      const media = this.rule(() => normalizeMedia(body.media ?? []));
      const categoryIds = await this.requireCategories(tx, body.categoryIds ?? []);
      const marketCodes = await this.requireMarkets(tx, body.marketCodes ?? []);
      const brandId = await this.requireBrand(tx, body.brandId ?? null);
      const id = randomUUID();
      const row = await this.guarded(() => tx.product.create({ data: {
        id, status: 'draft', baseSku: body.baseSku?.trim() || null, brandId, taxClassRef: body.taxClassRef?.trim() || null,
        marketCodes, translations: { create: translations },
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
  async updateProduct(supplied: string, csrfValue: string, id: string, version: number, body: ProductBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.write', async (tx, actor) => {
      await this.lock(tx, `product:${id}`);
      const existing = await tx.product.findUnique({ where: { id }, include: includeProduct });
      if (!existing) throw new AuthError(404, 'NOT_FOUND');
      if (existing.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      const store = await this.storeContext(tx);

      const translations = body.translations ? this.rule(() => normalizeProductTranslations(body.translations!)) : null;
      const variants = body.variants ? this.rule(() => normalizeVariants(body.variants!, store.currency)) : null;
      const attributes = body.attributes ? this.rule(() => normalizeAttributes(body.attributes!)) : null;
      const media = body.media ? this.rule(() => normalizeMedia(body.media!)) : null;
      const categoryIds = body.categoryIds ? await this.requireCategories(tx, body.categoryIds) : null;
      const marketCodes = body.marketCodes ? await this.requireMarkets(tx, body.marketCodes) : null;
      const brandId = body.brandId === undefined ? undefined : await this.requireBrand(tx, body.brandId);

      if (variants) {
        const incoming = new Set(variants.map(variant => variant.sku));
        for (const current of existing.variants) {
          if (incoming.has(current.sku)) continue;
          if ((current.inventory?.onHand ?? 0) > 0) throw new AuthError(422, 'VARIANT_HAS_STOCK');
          await tx.productVariant.delete({ where: { id: current.id } });
        }
        const bySku = new Map(existing.variants.map(variant => [variant.sku, variant]));
        for (const variant of variants) {
          const current = bySku.get(variant.sku);
          if (current) await tx.productVariant.update({ where: { id: current.id }, data: { optionValues: variant.optionValues,
            priceMinor: variant.priceMinor, compareAtMinor: variant.compareAtMinor, currency: variant.currency, status: variant.status } });
          else await tx.productVariant.create({ data: { id: randomUUID(), productId: id, ...variant } });
        }
      }
      if (translations) { await tx.productTranslation.deleteMany({ where: { productId: id } }); await tx.productTranslation.createMany({ data: translations.map(translation => ({ productId: id, ...translation })) }); }
      if (media) { await tx.productMedia.deleteMany({ where: { productId: id } }); if (media.length) await tx.productMedia.createMany({ data: media.map(item => ({ id: randomUUID(), productId: id, ...item })) }); }
      if (attributes) { await tx.productAttribute.deleteMany({ where: { productId: id } }); if (attributes.length) await tx.productAttribute.createMany({ data: attributes.map(attribute => ({ id: randomUUID(), productId: id, ...attribute })) }); }
      if (categoryIds) { await tx.productCategory.deleteMany({ where: { productId: id } }); await tx.productCategory.createMany({ data: categoryIds.map(categoryId => ({ productId: id, categoryId })) }); }

      const row = await this.guarded(() => tx.product.update({ where: { id }, include: includeProduct, data: {
        ...(body.baseSku !== undefined ? { baseSku: body.baseSku?.trim() || null } : {}),
        ...(brandId !== undefined ? { brandId } : {}),
        ...(body.taxClassRef !== undefined ? { taxClassRef: body.taxClassRef?.trim() || null } : {}),
        ...(marketCodes ? { marketCodes } : {}),
        version: { increment: 1 },
      } }));
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.product.updated', id);
      return this.productView(row);
    }, true);
  }

  async publishProduct(supplied: string, csrfValue: string, id: string, body: { expectedVersion: number; marketCodes: string[]; publishedAt?: string | null }, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.publish', async (tx, actor, _session, now) => {
      await this.lock(tx, `product:${id}`);
      const product = await tx.product.findUnique({ where: { id }, include: includeProduct });
      if (!product) throw new AuthError(404, 'NOT_FOUND');
      if (product.version !== body.expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
      const store = await this.storeContext(tx);
      const marketCodes = await this.requireMarkets(tx, body.marketCodes);
      this.rule(() => assertPublishable({ translations: product.translations, variants: product.variants,
        enabledLocales: store.locales }));
      this.rule(() => assertMarketSelection(marketCodes, store.markets, id));
      const publishedAt = body.publishedAt ? new Date(body.publishedAt) : now;
      if (Number.isNaN(publishedAt.getTime())) throw new AuthError(422, 'VALIDATION_ERROR');
      const status = publicationState(publishedAt, now);
      const updated = await tx.product.update({ where: { id }, data: {
        status: status === 'active' ? 'active' : 'draft', marketCodes, publishedAt, version: { increment: 1 } } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.product.published', id, 'success', marketCodes.join(','));
      return { productId: id, version: updated.version, status, publishedAt: publishedAt.toISOString(), jobId: null };
    }, true);
  }

  async unpublishProduct(supplied: string, csrfValue: string, id: string, body: { reason: string; reasonCode?: string | null }, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.publish', async (tx, actor, _session, now) => {
      await this.lock(tx, `product:${id}`);
      const product = await tx.product.findUnique({ where: { id } });
      if (!product) throw new AuthError(404, 'NOT_FOUND');
      const updated = await tx.product.update({ where: { id }, data: { status: 'draft', publishedAt: null, version: { increment: 1 } } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.product.unpublished', id, 'success', body.reason);
      return { productId: id, status: updated.status, version: updated.version, unpublishedAt: now.toISOString() };
    }, true);
  }
}
