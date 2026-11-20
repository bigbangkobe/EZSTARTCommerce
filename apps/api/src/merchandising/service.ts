import { Prisma } from '../../../../packages/database/src/client.js';
import {
  assertMerchandisingPublishable, MerchandisingRuleError, merchandisingSnapshot, normalizeMerchandisingSections,
  parseMerchandisingPageKey, type MerchandisingPageRef, type MerchandisingSection,
} from '../../../../packages/domain/src/merchandising.js';
import { contentReleaseToken } from '../../../../packages/domain/src/content.js';
import { effectiveReviewStatus } from '../../../../packages/domain/src/store.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import { contentLocales } from '../content/publish.js';

type Tx = Prisma.TransactionClient;

/** 领域异常 → HTTP 码：每个码后台都能翻译成「改哪里」，不统一压成 VALIDATION_ERROR。 */
const MERCHANDISING_CODES = [
  'MERCHANDISING_PAGE_UNKNOWN', 'MERCHANDISING_SECTION_UNSUPPORTED', 'MERCHANDISING_SECTION_DUPLICATE',
  'MERCHANDISING_SORT_UNSUPPORTED', 'MERCHANDISING_MODE_CONFLICT', 'MERCHANDISING_PRODUCT_DUPLICATE',
  'MERCHANDISING_LIMIT_UNREACHABLE', 'MERCHANDISING_LOCALE_INCOMPLETE', 'MERCHANDISING_NO_VISIBLE_SECTION',
  'MERCHANDISING_COLLECTION_OUT_OF_SCOPE', 'MERCHANDISING_PRODUCT_INELIGIBLE', 'MERCHANDISING_PRODUCT_OUT_OF_SCOPE',
] as const;

function rule<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof MerchandisingRuleError) {
      const code = (MERCHANDISING_CODES as readonly string[]).includes(error.code) ? error.code : 'VALIDATION_ERROR';
      throw new AuthError(422, code);
    }
    throw error;
  }
}

export interface SectionInput {
  sectionId: string; type: string; visible: boolean; position?: number;
  titleByLocale?: Record<string, string>; sortMode: string; limit: number;
  productIds?: string[]; categoryIds?: string[]; collectionId?: string | null;
}
export interface LayoutBody { sections?: SectionInput[]; expectedVersion: number }
export interface LayoutPublishBody { expectedVersion: number; note?: string }

interface SellableMarket { marketCode: string; eligibleProductIds: string[] }

/**
 * 陈列版面服务（M04 第三批）。
 *
 * 后台只写草稿；线上陈列是发布时固化的 publishedSnapshot，前台只读它。
 * 保存草稿不会让首页提前变样，撤下也只是把线上快照摘掉，草稿仍留着可再发。
 *
 * 商品资格在每个读路径上重算：后台读草稿时给出 issues（提示运营替换），
 * 发布时阻断不合格的手工商品，前台读取时直接隐藏并让动态区块自动补位。
 *
 * 版本语义：没有草稿时视作版本 1；首次保存消耗版本 1 并落库为 2，
 * 之后每次保存/发布/撤下都 +1，因此两个运营同时首次保存时后到的那位会拿到 409。
 */
export class MerchandisingService {
  constructor(private readonly identity: IdentityService) {}

  private async releaseSeq(tx: Tx): Promise<number> {
    const row = await tx.contentRelease.findUnique({ where: { id: 1 } });
    return row?.seq ?? 0;
  }

  private async sellableMarkets(tx: Tx): Promise<SellableMarket[]> {
    const now = new Date();
    const rows = await tx.marketProfile.findMany({ where: { storeConfigId: 1 }, orderBy: { marketCode: 'asc' } });
    return rows.filter(row => row.enabled && effectiveReviewStatus(row.reviewStatus, row.reviewValidUntil, now) === 'approved')
      .map(row => ({ marketCode: row.marketCode, eligibleProductIds: [...row.eligibleProductIds] }));
  }

  /**
   * 商品对「至少一个可售市场」是否合格，并给出台面上能看懂的原因。
   * 与前台口径一致：active + 已到发布时刻 + 市场清单内（市场白名单非空时还必须在名单里）。
   */
  private async eligibility(tx: Tx, ids: readonly string[]): Promise<Map<string, string | null>> {
    const markets = await this.sellableMarkets(tx);
    const unique = [...new Set(ids.map(id => id.toLowerCase()))];
    const rows = unique.length ? await tx.product.findMany({ where: { id: { in: unique } },
      select: { id: true, status: true, publishedAt: true, marketCodes: true } }) : [];
    const now = new Date();
    const result = new Map<string, string | null>();
    for (const id of unique) {
      const row = rows.find(item => item.id === id);
      if (!row) { result.set(id, 'PRODUCT_NOT_FOUND'); continue; }
      if (row.status !== 'active') { result.set(id, 'PRODUCT_NOT_ACTIVE'); continue; }
      if (row.publishedAt && row.publishedAt.getTime() > now.getTime()) { result.set(id, 'PRODUCT_NOT_PUBLISHED'); continue; }
      const usable = markets.filter(market => row.marketCodes.includes(market.marketCode)
        && (market.eligibleProductIds.length === 0 || market.eligibleProductIds.includes(row.id)));
      result.set(id, usable.length ? null : 'PRODUCT_MARKET_INELIGIBLE');
    }
    return result;
  }

  private manualProducts(sections: readonly MerchandisingSection[]): { sectionId: string; productId: string }[] {
    return sections.filter(section => section.visible && section.sortMode === 'manual')
      .flatMap(section => section.productIds.map(productId => ({ sectionId: section.sectionId, productId })));
  }

  /**
   * 页面级范围校验：手工位必须属于这个分类/专题，否则页面上会出现「点进去发现不在这个范围」的商品，
   * 顾客会以为筛选坏了。跨范围推荐请用首页版面，不要在分类页/专题页混装。
   *
   * 专题页额外校验区块级 collectionId：在专题 A 的版面里再筛专题 B，候选池交集必然为空，
   * 这种配置存下来只会在前台变成一个空区块，不如保存时就拒绝。
   */
  private async assertPageScope(tx: Tx, ref: MerchandisingPageRef, sections: readonly MerchandisingSection[]) {
    if (!ref.targetId) return;
    const ids = [...new Set(this.manualProducts(sections).map(item => item.productId))];
    if (ref.kind === 'category') {
      if (!ids.length) return;
      const linked = await tx.productCategory.findMany({ where: { categoryId: ref.targetId, productId: { in: ids } },
        select: { productId: true } });
      const allowed = new Set(linked.map(row => row.productId));
      if (ids.some(id => !allowed.has(id))) throw new AuthError(422, 'MERCHANDISING_PRODUCT_OUT_OF_SCOPE');
      return;
    }
    if (ref.kind === 'collection') {
      if (sections.some(section => section.collectionId && section.collectionId !== ref.targetId)) {
        throw new AuthError(422, 'MERCHANDISING_COLLECTION_OUT_OF_SCOPE');
      }
      if (!ids.length) return;
      const linked = await tx.collectionProduct.findMany({ where: { collectionId: ref.targetId, productId: { in: ids } },
        select: { productId: true } });
      const allowed = new Set(linked.map(row => row.productId));
      if (ids.some(id => !allowed.has(id))) throw new AuthError(422, 'MERCHANDISING_PRODUCT_OUT_OF_SCOPE');
    }
  }

  /**
   * 解析并校验版面作用域：分类/专题版面必须指向一个真实存在的对象。
   * 用 id 而不是 slug 绑定，改名/改 slug 时已发布版面不会失联。
   */
  private async ref(tx: Tx, pageKeyInput: string): Promise<MerchandisingPageRef> {
    const ref = rule(() => parseMerchandisingPageKey(pageKeyInput));
    if (ref.kind === 'category' && !await tx.category.findUnique({ where: { id: ref.targetId! }, select: { id: true } })) {
      throw new AuthError(404, 'NOT_FOUND');
    }
    if (ref.kind === 'collection' && !await tx.collection.findUnique({ where: { id: ref.targetId! }, select: { id: true } })) {
      throw new AuthError(404, 'NOT_FOUND');
    }
    return ref;
  }

  private async view(tx: Tx, ref: MerchandisingPageRef, row: MerchandisingLayoutRow | null) {
    const release = await this.releaseSeq(tx);
    if (!row) return { pageKey: ref.pageKey, kind: ref.kind, targetId: ref.targetId, status: 'draft', version: 1,
      sections: [], issues: [],
      published: null, publishedAt: null, versions: [], contentRelease: contentReleaseToken(release), updatedAt: null };
    const locales = await contentLocales(tx);
    const sections = rule(() => normalizeMerchandisingSections(row.sections, locales));
    const issues = await this.eligibility(tx, this.manualProducts(sections).map(item => item.productId));
    return {
      pageKey: ref.pageKey, kind: ref.kind, targetId: ref.targetId, status: row.status, version: row.version,
      sections,
      // 线上版本号来自快照本身：草稿再改几版，都不会让「已发布版本」跟着跳。
      published: row.publishedSnapshot
        ? { version: Number((row.publishedSnapshot as { version?: number }).version ?? row.version),
          publishedAt: row.publishedAt?.toISOString() ?? null } : null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      versions: row.versions.map(version => ({ version: version.version,
        publishedAt: version.publishedAt.toISOString(), note: version.note })),
      // 只有手工区块会「配置了但当前不可售」：动态区块本来就会自己补位，不需要运营修复。
      issues: this.manualProducts(sections).map(item => ({ ...item, reason: issues.get(item.productId) ?? null }))
        .filter(item => item.reason !== null),
      contentRelease: contentReleaseToken(release),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async get(supplied: string, pageKey: string) {
    return this.identity.withPermission(supplied, null, 'content.read', async tx => {
      const ref = await this.ref(tx, pageKey);
      return this.view(tx, ref, await tx.merchandisingLayout.findUnique({ where: { pageKey: ref.pageKey },
        include: { versions: { orderBy: { version: 'desc' }, take: 20 } } }));
    });
  }

  /**
   * 版面清单：后台页面选择器的数据源。
   * 首页永远在列；分类只列启用中的（停用分类即使有版面，前台也不会对外提供）。
   * status='none' 表示还没有草稿——后台据此提示「选它就开始配」。
   */
  async pages(supplied: string) {
    return this.identity.withPermission(supplied, null, 'content.read', async tx => {
      const rows = await tx.merchandisingLayout.findMany({ select: { pageKey: true, kind: true, status: true, version: true,
        publishedSnapshot: true } });
      const byKey = new Map(rows.map(row => [row.pageKey, row]));
      const categories = await tx.category.findMany({ where: { enabled: true }, include: { translations: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
      const items: { pageKey: string; kind: string; targetId: string | null; name: string | null;
        status: string; version: number }[] = [{ pageKey: 'home', kind: 'home', targetId: null, name: null,
        status: byKey.get('home')?.status ?? 'none', version: byKey.get('home')?.version ?? 0 }];
      for (const category of categories) {
        const pageKey = `category:${category.id}`;
        const row = byKey.get(pageKey);
        items.push({ pageKey, kind: 'category', targetId: category.id, name: category.translations.find(item => item.locale === 'zh-HK')?.name
          ?? category.translations[0]?.name ?? category.id, status: row?.status ?? 'none', version: row?.version ?? 0 });
      }
      // 专题只列启用中的（停用专题前台不提供，给它排班只会让运营以为已经上线）。
      const collections = await tx.collection.findMany({ where: { enabled: true }, include: { translations: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
      for (const collection of collections) {
        const pageKey = `collection:${collection.id}`;
        const row = byKey.get(pageKey);
        items.push({ pageKey, kind: 'collection', targetId: collection.id,
          name: collection.translations.find(item => item.locale === 'zh-HK')?.name
            ?? collection.translations[0]?.name ?? collection.id, status: row?.status ?? 'none',
          version: row?.version ?? 0 });
      }
      return { items };
    });
  }

  /**
   * 保存草稿：expectedVersion 必须与库里一致（没有草稿时为 1）。
   * 保存不改 status/publishedSnapshot——线上陈列只会在 publish 时变。
   */
  async save(supplied: string, csrfValue: string, pageKey: string, body: LayoutBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'content.write', async (tx, actor, _session, now) => {
      const ref = await this.ref(tx, pageKey);
      const key = ref.pageKey;
      const locales = await contentLocales(tx);
      const sections = rule(() => normalizeMerchandisingSections(body.sections ?? [], locales));
      await this.assertPageScope(tx, ref, sections);
      // advisory lock 返回 void，$queryRaw 反序列化不了；用 $executeRaw 只拿影响行数。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchandising:${key}`}))`;
      const existing = await tx.merchandisingLayout.findUnique({ where: { pageKey: key } });
      if ((existing?.version ?? 1) !== body.expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
      const row = existing
        ? await tx.merchandisingLayout.update({ where: { id: existing.id },
          data: { sections: sections as unknown as Prisma.InputJsonValue, version: existing.version + 1,
            updatedBy: actor.id, updatedAt: now },
          include: { versions: { orderBy: { version: 'desc' }, take: 20 } } })
        : await tx.merchandisingLayout.create({ data: { pageKey: key, kind: ref.kind, status: 'draft', version: 2,
          sections: sections as unknown as Prisma.InputJsonValue, createdBy: actor.id, updatedBy: actor.id },
          include: { versions: true } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'merchandising.layout.saved', row.id, 'success',
        `v${row.version} · ${sections.length} sections`);
      return this.view(tx, ref, row);
    });
  }

  /**
   * 发布：先再验一遍手工商品资格（不能把已失效的配置推上线），
   * 再把草稿固化成快照、切换线上指针，并让内容发布标记 +1（区块埋点按新版本分组）。
   */
  async publish(supplied: string, csrfValue: string, pageKey: string, body: LayoutPublishBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor, _session, now) => {
      const ref = await this.ref(tx, pageKey);
      const key = ref.pageKey;
      const locales = await contentLocales(tx);
      // advisory lock 返回 void，$queryRaw 反序列化不了；用 $executeRaw 只拿影响行数。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchandising:${key}`}))`;
      const existing = await tx.merchandisingLayout.findUnique({ where: { pageKey: key } });
      if (!existing) throw new AuthError(404, 'NOT_FOUND');
      if (existing.version !== body.expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
      const sections = rule(() => normalizeMerchandisingSections(existing.sections, locales));
      await this.assertPageScope(tx, ref, sections);
      rule(() => assertMerchandisingPublishable(sections, locales));
      const issues = await this.eligibility(tx, this.manualProducts(sections).map(item => item.productId));
      if ([...issues.values()].some(reason => reason !== null)) throw new AuthError(422, 'MERCHANDISING_PRODUCT_INELIGIBLE');

      const version = existing.version + 1;
      const snapshot = merchandisingSnapshot(key, version, sections, now);
      // 先写版本行再切线上指针：两者在同一事务里，读回版面时版本历史已经包含这一次发布。
      await tx.merchandisingVersion.create({ data: { layoutId: existing.id, version,
        snapshot: snapshot as unknown as Prisma.InputJsonValue, note: body.note ?? null,
        publishedAt: now, publishedBy: actor.id } });
      const row = await tx.merchandisingLayout.update({ where: { id: existing.id },
        data: { status: 'published', version, publishedAt: now, publishedBy: actor.id,
          publishedSnapshot: snapshot as unknown as Prisma.InputJsonValue, updatedBy: actor.id, updatedAt: now },
        include: { versions: { orderBy: { version: 'desc' }, take: 20 } } });
      const release = await tx.$queryRaw<{ seq: number }[]>`
        UPDATE "ContentRelease" SET "seq" = "seq" + 1, "updatedAt" = ${now} WHERE "id" = 1 RETURNING "seq"`;
      await this.identity.recordAudit(tx, ctx, actor.id, 'merchandising.layout.published', existing.id, 'success', `v${version}`);
      const doc = await this.view(tx, ref, row);
      return { ...doc, releaseToken: contentReleaseToken(release[0]?.seq ?? 0) };
    });
  }

  /** 撤下：摘掉线上快照，草稿保留（下次改完可直接再发），内容发布标记同样 +1。 */
  async unpublish(supplied: string, csrfValue: string, pageKey: string,
    body: { reason: string; expectedVersion: number }, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'content.publish', async (tx, actor, _session, now) => {
      const ref = await this.ref(tx, pageKey);
      const key = ref.pageKey;
      // advisory lock 返回 void，$queryRaw 反序列化不了；用 $executeRaw 只拿影响行数。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchandising:${key}`}))`;
      const existing = await tx.merchandisingLayout.findUnique({ where: { pageKey: key } });
      if (!existing) throw new AuthError(404, 'NOT_FOUND');
      if (existing.version !== body.expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
      const row = await tx.merchandisingLayout.update({ where: { id: existing.id },
        data: { status: 'draft', version: existing.version + 1, publishedSnapshot: Prisma.DbNull, publishedAt: null,
          publishedBy: null, updatedBy: actor.id, updatedAt: now },
        include: { versions: { orderBy: { version: 'desc' }, take: 20 } } });
      const release = await tx.$queryRaw<{ seq: number }[]>`
        UPDATE "ContentRelease" SET "seq" = "seq" + 1, "updatedAt" = ${now} WHERE "id" = 1 RETURNING "seq"`;
      await this.identity.recordAudit(tx, ctx, actor.id, 'merchandising.layout.withdrawn', existing.id, 'success', body.reason);
      return { ...await this.view(tx, ref, row), releaseToken: contentReleaseToken(release[0]?.seq ?? 0) };
    });
  }

  /**
   * 商品选择器：只回摘要与资格原因，不把商品全字段抛给后台列表。
   * 不合格商品在 UI 里是禁选项——运营需要看到「为什么不能选」，而不是点了保存才报错。
   */
  async products(supplied: string, query: string | null, limit: number, categoryId: string | null = null,
    collectionId: string | null = null) {
    return this.identity.withPermission(supplied, null, 'content.read', async tx => {
      const markets = await this.sellableMarkets(tx);
      const where: Prisma.ProductWhereInput = {
        ...(query ? { translations: { some: { name: { contains: query, mode: 'insensitive' } } } } : {}),
        // 分类/专题版面只列本范围商品：选不到范围外的，也就不会到保存时才被拒。
        ...(categoryId ? { categories: { some: { categoryId } } } : {}),
        ...(collectionId ? { collections: { some: { collectionId } } } : {}),
      };
      const rows = await tx.product.findMany({
        where,
        include: { translations: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: limit });
      const now = new Date();
      const items = rows.map(row => {
        const reasons: string[] = [];
        if (row.status !== 'active') reasons.push('PRODUCT_NOT_ACTIVE');
        if (row.publishedAt && row.publishedAt.getTime() > now.getTime()) reasons.push('PRODUCT_NOT_PUBLISHED');
        const usable = markets.filter(market => row.marketCodes.includes(market.marketCode)
          && (market.eligibleProductIds.length === 0 || market.eligibleProductIds.includes(row.id)));
        if (!usable.length) reasons.push('PRODUCT_MARKET_INELIGIBLE');
        return { id: row.id,
          name: row.translations.find(item => item.locale === 'zh-HK')?.name ?? row.translations[0]?.name
            ?? row.baseSku ?? row.id,
          status: row.status, publishedAt: row.publishedAt?.toISOString() ?? null,
          markets: usable.map(market => market.marketCode), sellable: reasons.length === 0, reasons };
      });
      const categories = await tx.category.findMany({ where: { enabled: true }, include: { translations: true },
        orderBy: [{ position: 'asc' }] });
      const collections = await tx.collection.findMany({ where: { enabled: true }, include: { translations: true },
        orderBy: [{ position: 'asc' }] });
      return { items, markets: markets.map(market => market.marketCode),
        categories: categories.map(category => ({ id: category.id,
          name: category.translations.find(item => item.locale === 'zh-HK')?.name
            ?? category.translations[0]?.name ?? category.id })),
        collections: collections.map(collection => ({ id: collection.id,
          name: collection.translations.find(item => item.locale === 'zh-HK')?.name
            ?? collection.translations[0]?.name ?? collection.id })) };
    });
  }
}

type MerchandisingLayoutRow = Prisma.MerchandisingLayoutGetPayload<{ include: { versions: true } }>;
