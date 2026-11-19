import type { Prisma } from '../../../../packages/database/src/client.js';
import { contentReleaseToken, normalizeBlocks, visibleBlocks, type PageSnapshot } from '../../../../packages/domain/src/content.js';
import { isPreviewLive, PREVIEW_TOKEN_PATTERN } from '../../../../packages/domain/src/preview.js';
import { effectiveReviewStatus, normalizeMarketCode, SUPPORTED_LOCALES, StoreRuleError } from '../../../../packages/domain/src/store.js';
import { digestPreviewToken, lookupRedirect } from '../content/preview.js';
import {
  assertMerchandisingPageKey, sectionTitle, type MerchandisingPageKey, type MerchandisingSection,
} from '../../../../packages/domain/src/merchandising.js';
import { fulfilledSales30d, selectProducts, sellableByIds, sellablePool } from '../merchandising/resolve.js';
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

const PUBLIC_FLAGS = ['guestCheckout', 'memberOtpLogin', 'codPayment', 'onlinePayment', 'ageVerification', 'analyticsEnabled'] as const;

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
        market: market ? { marketCode: market.marketCode } : null, features,
        // 内容发布标记：主题把它当区块埋点的 publishVersionId，任何内容发布都会换代。
        contentRelease: await this.contentRelease(tx) };
    });
  }

  /** 内容换代计数器（cr-N）。没有发布过内容时仍给 cr-0，让埋点字段始终是合法值。 */
  private async contentRelease(tx: Tx): Promise<string> {
    const row = await tx.contentRelease.findUnique({ where: { id: 1 }, select: { seq: true } });
    return contentReleaseToken(row?.seq ?? 0);
  }

  private pageView(row: Prisma.ContentPageGetPayload<{ include: { translations: true; publishedVersion: true } }>,
    locale: string, fallback: string) {
    const snapshot = row.publishedVersion?.snapshot as unknown as PageSnapshot | undefined;
    if (!snapshot || !row.publishedVersion) return null;
    const translation = snapshot.translations.find(item => item.locale === locale)
      ?? snapshot.translations.find(item => item.locale === fallback) ?? snapshot.translations[0];
    if (!translation) return null;
    return {
      pageKey: row.pageKey, pageType: row.pageType,
      locale: translation.locale, slug: translation.slug, title: translation.title,
      seoTitle: translation.seoTitle, seoDescription: translation.seoDescription, indexable: translation.indexable,
      // 隐藏区块不下发：接口不是预览通道，未完成内容不该出现在公开响应里。
      // 公开响应也不带 visible 标记——能出现的就是可见的，多一个字段只会让人误以为可以切换。
      blocks: visibleBlocks(snapshot.blocks ?? []).map(block => ({ id: block.id, type: block.type,
        position: block.position, config: block.config })),
      alternates: snapshot.translations.map(item => ({ locale: item.locale, slug: item.slug })),
      version: row.publishedVersion.version,
    };
  }


  /**
   * 预览外链（M04 第二批）：返回**草稿**内容，但只给可见区块。
   * 预览是「发布后会是什么样」的检查，不是编辑器——隐藏区块仍然不该出现在预览里。
   * token 不存在与已过期同样返回 404：不区分原因，不给探测留信号。
   */
  async getPreview(token: string) {
    if (!PREVIEW_TOKEN_PATTERN.test(token)) throw new AuthError(404, 'NOT_FOUND');
    return this.run(async tx => {
      const row = await tx.contentPreviewToken.findUnique({ where: { tokenHash: digestPreviewToken(token) },
        include: { page: { include: { translations: true } } } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      // 失效判定用数据库时间：多实例部署时各机器时钟可能漂移，预览有效期不该因此变长。
      const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      if (!isPreviewLive(row.expiresAt, rows[0]?.now ?? new Date())) throw new AuthError(404, 'NOT_FOUND');
      const translation = row.page.translations.find(item => item.locale === row.locale);
      if (!translation) throw new AuthError(404, 'NOT_FOUND');
      let blocks: ReturnType<typeof normalizeBlocks> = [];
      try { blocks = normalizeBlocks(row.page.blocks); } catch { blocks = []; }
      return {
        pageKey: row.page.pageKey, pageType: row.page.pageType, locale: row.locale,
        slug: translation.slug, title: translation.title, seoTitle: translation.seoTitle,
        seoDescription: translation.seoDescription, indexable: false,
        blocks: visibleBlocks(blocks).map(block => ({ id: block.id, type: block.type, position: block.position, config: block.config })),
        alternates: row.page.translations.map(item => ({ locale: item.locale, slug: item.slug })),
        version: row.page.version, preview: true as const, viewport: row.viewport,
        expiresAt: row.expiresAt.toISOString(),
      };
    });
  }

  /** 旧地址解析：返回最终目标（已把链走完），查不到就是 null。 */
  async redirect(rawPath: string) {
    return this.run(async tx => ({ redirect: await lookupRedirect(tx, rawPath) }));
  }

  /**
   * 全量重定向清单：给前台入口层做一次缓存后本地匹配，避免每个请求都回源。
   * 门店级重定向数量很小（改 slug 才产生），上限 500 条足以覆盖多年运营。
   */
  async listRedirects() {
    return this.run(async tx => {
      const rows = await tx.seoRedirect.findMany({ select: { fromPath: true, toPath: true, statusCode: true },
        orderBy: { createdAt: 'desc' }, take: 500 });
      return { items: rows };
    });
  }

  /**
   * 内容页读取：只看 publishedSlug（发布时才写入、撤下时清空）。
   * 草稿 slug 永远不会命中，因此「保存草稿」不会泄漏未发布内容。
   */
  async getPage(slug: string, localeInput: string | null) {
    return this.run(async tx => {
      const settings = await this.settings(tx);
      const locale = this.locale(settings, localeInput);
      const rows = await tx.contentPageTranslation.findMany({ where: { publishedSlug: slug },
        include: { page: { include: { translations: true, publishedVersion: true } } } });
      const rank = (value: string) => value === locale ? 0 : value === settings.defaultLocale ? 1 : 2;
      const ordered = rows.filter(row => row.page.publishedVersion).sort((left, right) =>
        rank(left.locale) - rank(right.locale) || left.pageId.localeCompare(right.pageId));
      for (const candidate of ordered) {
        const view = this.pageView(candidate.page, locale, settings.defaultLocale);
        if (view) return { ...view, contentRelease: await this.contentRelease(tx) };
      }
      throw new AuthError(404, 'NOT_FOUND');
    });
  }

  /** 已发布内容页清单（导航与站点地图用）：只给地址与索引资格，不含正文。 */
  async listPages(localeInput: string | null) {
    return this.run(async tx => {
      const settings = await this.settings(tx);
      const locale = this.locale(settings, localeInput);
      const rows = await tx.contentPage.findMany({ where: { status: 'published', publishedVersionId: { not: null } },
        include: { translations: true, publishedVersion: true }, orderBy: [{ position: 'asc' }, { pageKey: 'asc' }] });
      const items = rows.map(row => this.pageView(row, locale, settings.defaultLocale)).filter(view => view !== null)
        .map(view => ({ pageKey: view.pageKey, pageType: view.pageType, locale: view.locale, slug: view.slug,
          title: view.title, indexable: view.indexable, alternates: view.alternates }));
      return { items, locale, contentRelease: await this.contentRelease(tx) };
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

  /**
   * 首页陈列（M04 第三批）：读发布快照，商品在读取时重新过一遍可售资格。
   * 手工区块里已失效的商品直接不出现（后台 issues 会提示运营替换）；
   * 动态区块排除不合格商品后由后续候选补足，因此展示数量仍能维持到 limit。
   */
  async merchandising(pageKeyInput: string, localeInput: string | null, marketInput: string | null) {
    let pageKey: MerchandisingPageKey;
    try { pageKey = assertMerchandisingPageKey(pageKeyInput); }
    catch { throw new AuthError(404, 'NOT_FOUND'); }
    return this.run(async tx => {
      const settings = await this.settings(tx);
      const locale = this.locale(settings, localeInput);
      const market = this.market(settings, marketInput);
      // 没有可售市场时前台是关的：陈列也不该把商品端出来。
      if (!market) throw new AuthError(404, 'NOT_FOUND');
      const layout = await tx.merchandisingLayout.findUnique({ where: { pageKey } });
      if (!layout || layout.status !== 'published' || !layout.publishedSnapshot) throw new AuthError(404, 'NOT_FOUND');
      const snapshot = layout.publishedSnapshot as unknown as { sections?: MerchandisingSection[]; version?: number };
      const scope = { marketCode: market.marketCode, eligibleProductIds: market.eligibleProductIds, now: new Date() };
      const sections = [];
      for (const section of (snapshot.sections ?? []).filter(item => item.visible)) {
        // 手工区块按配置的 id 取（顺序即优先级）；动态区块按规则在候选池里排序。
        const rows = section.sortMode === 'manual'
          ? await sellableByIds(tx, scope, section.productIds)
          : await sellablePool(tx, scope, section.categoryIds);
        const eligibleIds = new Set(rows.map(row => row.id));
        const units = section.sortMode === 'fulfilled_sales_30d'
          ? await fulfilledSales30d(tx, rows.map(row => row.id), scope.now) : new Map<string, number>();
        const selection = selectProducts(section, rows, units, eligibleIds);
        sections.push({ sectionId: section.sectionId, type: section.type,
          title: sectionTitle(section, locale, settings.defaultLocale), sortMode: section.sortMode,
          products: selection.rows.map(row => this.publicView(row, locale, settings.defaultLocale)) });
      }
      return { pageKey, version: snapshot.version ?? layout.version, locale, marketCode: market.marketCode, sections };
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
