import type { Prisma } from '../../../../packages/database/src/client.js';
import { effectiveReviewStatus, normalizeMarketCode, SUPPORTED_LOCALES, StoreRuleError } from '../../../../packages/domain/src/store.js';
import { AuthError, IdentityService } from '../identity/service.js';

type Tx = Prisma.TransactionClient;
const includeProduct = { translations: true, variants: { include: { inventory: true } }, media: true } as const;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof includeProduct }>;

interface StoreSettings {
  displayName: string; locales: string[]; defaultLocale: string; baseCurrency: string; timezone: string;
  featureFlags: Record<string, boolean>;
  markets: { marketCode: string; enabled: boolean; reviewStatus: string; eligibleProductIds: string[] }[];
}

const DEFAULT_SETTINGS: StoreSettings = {
  displayName: 'EZSTART Store', locales: [...SUPPORTED_LOCALES], defaultLocale: 'zh-CN', baseCurrency: 'HKD',
  timezone: 'Asia/Hong_Kong', featureFlags: {}, markets: [],
};

const PUBLIC_FLAGS = ['guestCheckout', 'memberOtpLogin', 'codPayment', 'onlinePayment', 'ageVerification'] as const;

/**
 * 前台只读目录（M02/M03 对外面）。
 *
 * 这里没有会话：所有过滤条件都必须在查询里表达，而不是“先取出来再在内存里隐藏”。
 * 可售 = 已发布（active 且到期生效）+ 当前市场开放 + 市场审核通过且未过期 + 在可售清单内。
 * 任何一项不满足都不会出现在列表里，也不会通过 slug 命中详情。
 */
export class StorefrontService {
  constructor(private readonly identity: IdentityService) {}
  private get db() { return this.identity.db; }

  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try { return await fn(this.db); }
    catch (error) { if (error instanceof StoreRuleError) throw new AuthError(422, 'VALIDATION_ERROR'); throw error; }
  }

  private async settings(tx: Tx): Promise<StoreSettings> {
    const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
    if (!row) return DEFAULT_SETTINGS;
    const markets = await tx.marketProfile.findMany({ where: { storeConfigId: row.id }, orderBy: { marketCode: 'asc' } });
    const now = new Date();
    return {
      displayName: row.displayName, locales: [...row.locales], defaultLocale: row.defaultLocale,
      baseCurrency: row.baseCurrency, timezone: row.timezone, featureFlags: row.featureFlags as Record<string, boolean>,
      markets: markets.map(market => ({ marketCode: market.marketCode, enabled: market.enabled,
        reviewStatus: effectiveReviewStatus(market.reviewStatus, market.reviewValidUntil, now),
        eligibleProductIds: market.eligibleProductIds })),
    };
  }

  private locale(settings: StoreSettings, input: string | null): string {
    if (!input) return settings.defaultLocale;
    if (!settings.locales.includes(input)) throw new AuthError(422, 'VALIDATION_ERROR');
    return input;
  }

  /**
   * 未指定市场时取字典序第一个可售市场，保证同一时刻前台看到的是同一市场。
   * 指定了市场就严格按该市场判断：不可售时返回 null（列表为空、详情 404），
   * 而不是静默回退到别的市场——否则顾客会看到没开通的市场价格。
   */
  private market(settings: StoreSettings, input: string | null) {
    const sellable = settings.markets.filter(market => market.enabled && market.reviewStatus === 'approved')
      .sort((left, right) => left.marketCode.localeCompare(right.marketCode));
    if (!input) return sellable[0] ?? null;
    const code = (() => { try { return normalizeMarketCode(input); } catch { throw new AuthError(422, 'VALIDATION_ERROR'); } })();
    if (!settings.markets.some(market => market.marketCode === code)) throw new AuthError(422, 'VALIDATION_ERROR');
    return sellable.find(market => market.marketCode === code) ?? null;
  }

  private localized<T extends { locale: string }>(translations: readonly T[], locale: string, fallback: string) {
    return translations.find(translation => translation.locale === locale)
      ?? translations.find(translation => translation.locale === fallback) ?? translations[0] ?? null;
  }

  async config(localeInput: string | null, marketInput: string | null) {
    return this.run(async tx => {
      const settings = await this.settings(tx);
      const locale = this.locale(settings, localeInput);
      const market = this.market(settings, marketInput);
      const features = Object.fromEntries(PUBLIC_FLAGS.map(flag => [flag, settings.featureFlags[flag] ?? false]));
      return { displayName: settings.displayName, locales: settings.locales, defaultLocale: settings.defaultLocale,
        locale, currency: settings.baseCurrency, timezone: settings.timezone,
        market: market ? { marketCode: market.marketCode } : null, features };
    });
  }

  private availability(row: ProductRow) {
    const variants = [...row.variants].filter(variant => variant.status === 'active')
      .sort((left, right) => left.sku.localeCompare(right.sku)).map(variant => ({
        id: variant.id, sku: variant.sku, optionValues: variant.optionValues as Record<string, string>,
        priceMinor: variant.priceMinor, compareAtMinor: variant.compareAtMinor ?? null, currency: variant.currency,
        available: Math.max(0, (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0)),
      }));
    return { variants, inStock: variants.some(variant => variant.available > 0) };
  }

  private publicView(row: ProductRow, locale: string, fallback: string) {
    const translation = this.localized(row.translations, locale, fallback);
    const { variants, inStock } = this.availability(row);
    return {
      id: row.id, slug: translation?.slug ?? row.id, name: translation?.name ?? '',
      shortDescription: translation?.shortDescription ?? null, description: translation?.description ?? null,
      seoTitle: translation?.seoTitle ?? null, seoDescription: translation?.seoDescription ?? null,
      variants,
      media: [...row.media].sort((left, right) => left.position - right.position)
        .map(item => ({ mediaId: item.mediaId, position: item.position, altByLocale: item.altByLocale as Record<string, string> })),
      inStock, displayStockState: inStock ? 'available' as const : 'sold_out' as const,
    };
  }

  async listProducts(localeInput: string | null, marketInput: string | null, limit: number, cursor: string | null, query: string | null) {
    return this.run(async tx => {
      const settings = await this.settings(tx);
      const locale = this.locale(settings, localeInput);
      const market = this.market(settings, marketInput);
      // 没有可售市场时前台是关闭的：返回空集合，而不是把全站商品都抛出去。
      if (!market) return { items: [], hasMore: false, nextCursor: null };
      if (cursor && !await tx.product.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const now = new Date();
      const where: Prisma.ProductWhereInput = {
        status: 'active', marketCodes: { has: market.marketCode },
        AND: [{ OR: [{ publishedAt: null }, { publishedAt: { lte: now } }] },
          ...(market.eligibleProductIds.length ? [{ id: { in: market.eligibleProductIds } }] : [])],
        ...(query ? { OR: [
          { translations: { some: { name: { contains: query, mode: 'insensitive' } } } },
          { translations: { some: { slug: { contains: query, mode: 'insensitive' } } } },
        ] } : {}),
      };
      const rows = await tx.product.findMany({ where, include: includeProduct, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const items = rows.slice(0, limit).map(row => this.publicView(row, locale, settings.defaultLocale));
      const hasMore = rows.length > limit;
      return { items, hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
    });
  }

  /**
   * slug 解析：优先命中当前语言的翻译，其次默认语言，再退到任意语言。
   * 回退只影响“命中哪条翻译”，商品本身仍要过可售过滤，因此不会泄露草稿。
   */
  async getProduct(slug: string, localeInput: string | null, marketInput: string | null) {
    return this.run(async tx => {
      const settings = await this.settings(tx);
      const locale = this.locale(settings, localeInput);
      const market = this.market(settings, marketInput);
      if (!market) throw new AuthError(404, 'NOT_FOUND');
      const candidates = await tx.productTranslation.findMany({ where: { slug }, select: { productId: true, locale: true } });
      if (!candidates.length) throw new AuthError(404, 'NOT_FOUND');
      const rank = (value: string) => value === locale ? 0 : value === settings.defaultLocale ? 1 : 2;
      const ordered = [...candidates].sort((left, right) => rank(left.locale) - rank(right.locale) || left.productId.localeCompare(right.productId));
      const now = new Date();
      for (const candidate of ordered) {
        const row = await tx.product.findFirst({ where: { id: candidate.productId, status: 'active',
          marketCodes: { has: market.marketCode }, AND: [{ OR: [{ publishedAt: null }, { publishedAt: { lte: now } }] },
            ...(market.eligibleProductIds.length ? [{ id: { in: market.eligibleProductIds } }] : [])] }, include: includeProduct });
        if (row) return this.publicView(row, locale, settings.defaultLocale);
      }
      throw new AuthError(404, 'NOT_FOUND');
    });
  }

  async listCategories(localeInput: string | null) {
    return this.run(async tx => {
      const settings = await this.settings(tx);
      const locale = this.locale(settings, localeInput);
      const rows = await tx.category.findMany({ where: { enabled: true }, include: { translations: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
      return { items: rows.map(row => {
        const translation = this.localized(row.translations, locale, settings.defaultLocale);
        return { id: row.id, parentId: row.parentId ?? null, position: row.position,
          name: translation?.name ?? '', slug: translation?.slug ?? null, description: translation?.description ?? null };
      }), locale };
    });
  }
}
