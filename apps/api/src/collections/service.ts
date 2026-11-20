import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  collectionPath, normalizeCollectionProducts, normalizeCollectionTranslations, CollectionRuleError,
} from '../../../../packages/domain/src/collections.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import { recordPathRedirect } from '../content/preview.js';

type Tx = Prisma.TransactionClient;
const includeCollection = { translations: true, products: { orderBy: { position: 'asc' } } } as const;
type CollectionRow = Prisma.CollectionGetPayload<{ include: typeof includeCollection }>;

/** 领域码 → HTTP：后台要能区分「slug 重复」「商品不存在」「商品重复」，而不是统一显示保存失败。 */
const COLLECTION_CODES = ['COLLECTION_LOCALE_DUPLICATE', 'COLLECTION_PRODUCT_DUPLICATE', 'COLLECTION_PRODUCT_NOT_FOUND'] as const;

export interface CollectionBody {
  position?: number; enabled?: boolean;
  translations?: { locale: string; name: string; slug?: string | null; description?: string | null }[];
  productIds?: string[];
}

/**
 * 专题服务（M04 第五批）。
 *
 * 专题是「运营挑的一组商品」，因此这里没有发布流程：启用 + 有 slug + 有商品，前台就能逛到。
 * 版面是专题页的排版方式而不是存在前提——没有版面时前台退回平铺商品（与分类页同口径）。
 *
 * slug 变更要登记 301：专题地址会出现在分享链接与印刷物料里，改完 slug 不能把旧地址变成死链。
 * 停用时清理指向该专题的跳转：否则访客会被 301 送到一个已经不存在的页面。
 */
export class CollectionService {
  constructor(private readonly identity: IdentityService) {}

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof CollectionRuleError) {
        const code = (COLLECTION_CODES as readonly string[]).includes(error.code) ? error.code : 'VALIDATION_ERROR';
        throw new AuthError(422, code);
      }
      throw error;
    }
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') throw new AuthError(409, 'SLUG_TAKEN');
      if (code === 'P2003') throw new AuthError(422, 'VALIDATION_ERROR');
      if (code === 'P2025') throw new AuthError(404, 'NOT_FOUND');
      throw error;
    }
  }

  /** advisory lock 返回 void：$queryRaw 反序列化不了，用 $executeRaw 只拿影响行数。 */
  private async lock(tx: Tx, key: string) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`; }

  private view(row: CollectionRow) {
    return {
      id: row.id, position: row.position, enabled: row.enabled, version: row.version,
      translations: [...row.translations].sort((left, right) => left.locale.localeCompare(right.locale))
        .map(translation => ({ locale: translation.locale, name: translation.name, slug: translation.slug ?? null,
          description: translation.description ?? null })),
      productIds: row.products.map(item => item.productId),
      productCount: row.products.length,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async load(tx: Tx, id: string): Promise<CollectionRow> {
    const row = await tx.collection.findUnique({ where: { id }, include: includeCollection });
    if (!row) throw new AuthError(404, 'NOT_FOUND');
    return row;
  }

  /** 商品必须真实存在：存进来一个已删除的 id，前台只会静默少一件，运营很难发现。 */
  private async assertProducts(tx: Tx, ids: readonly string[]) {
    if (!ids.length) return;
    const rows = await tx.product.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
    if (rows.length !== ids.length) throw new AuthError(422, 'COLLECTION_PRODUCT_NOT_FOUND');
  }

  async list(supplied: string) {
    return this.identity.withPermission(supplied, null, 'content.read', async tx => {
      const rows = await tx.collection.findMany({ include: includeCollection,
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
      return { items: rows.map(row => this.view(row)) };
    });
  }

  async get(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'content.read', async tx => this.view(await this.load(tx, id)));
  }

  async create(supplied: string, csrfValue: string, body: CollectionBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'content.write', async (tx, actor) => {
      const translations = this.rule(() => normalizeCollectionTranslations(body.translations ?? [], false));
      const productIds = this.rule(() => normalizeCollectionProducts(body.productIds));
      await this.assertProducts(tx, productIds);
      const row = await this.guarded(() => tx.collection.create({ data: {
        position: body.position ?? 0, enabled: body.enabled ?? true,
        translations: { create: translations },
        products: { create: productIds.map((productId, position) => ({ productId, position })) },
      }, include: includeCollection }));
      await this.identity.recordAudit(tx, ctx, actor.id, 'content.collection.created', row.id, 'success',
        `${translations.map(item => `${item.locale}:${item.slug ?? '-'}`).join(' ')}`);
      return this.view(row);
    }, true);
  }

  /**
   * 编辑：整体替换翻译与商品清单（有序）。
   * slug 变更按语言逐条比对旧值：只有「旧地址真实存在过」才登记 301，
   * 新建时补一个 slug 不该产生跳转。
   */
  async update(supplied: string, csrfValue: string, id: string, version: number, body: CollectionBody,
    ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'content.write', async (tx, actor, _session, now) => {
      await this.lock(tx, `collection:${id}`);
      const existing = await this.load(tx, id);
      if (existing.version !== version) throw new AuthError(409, 'VERSION_CONFLICT');
      const translations = body.translations === undefined ? null
        : this.rule(() => normalizeCollectionTranslations(body.translations, false));
      const productIds = body.productIds === undefined ? null : this.rule(() => normalizeCollectionProducts(body.productIds));
      if (productIds) await this.assertProducts(tx, productIds);
      const enabled = body.enabled ?? existing.enabled;

      const row = await this.guarded(() => tx.collection.update({ where: { id }, include: includeCollection, data: {
        position: body.position ?? existing.position, enabled, version: { increment: 1 }, updatedAt: now,
        ...(translations ? { translations: { deleteMany: {}, create: translations } } : {}),
        ...(productIds ? { products: { deleteMany: {}, create: productIds.map((productId, position) => ({ productId, position })) } } : {}),
      } }));

      if (translations) {
        for (const previous of existing.translations) {
          const next = translations.find(item => item.locale === previous.locale) ?? null;
          if (!previous.slug) continue;
          // 该语言被删掉或 slug 被清空：指向这条地址的 301 必须一起清理，避免送进 404。
          if (!next?.slug) {
            await tx.seoRedirect.deleteMany({ where: { collectionId: id, toPath: collectionPath(previous.locale, previous.slug) } });
            continue;
          }
          if (next.slug !== previous.slug) {
            await recordPathRedirect(tx, { locale: previous.locale,
              fromPath: collectionPath(previous.locale, previous.slug),
              toPath: collectionPath(previous.locale, next.slug),
              owner: { collectionId: id }, actorId: actor.id });
          }
        }
      }
      // 停用即下线：指向这个专题的跳转全部摘掉，重新启用时地址由当前 slug 决定。
      if (existing.enabled && !enabled) await tx.seoRedirect.deleteMany({ where: { collectionId: id } });

      await this.identity.recordAudit(tx, ctx, actor.id, 'content.collection.updated', id, 'success',
        `v${row.version} · ${row.products.length} products`);
      return this.view(row);
    }, true);
  }

  /**
   * 删除：专题本身可以删（策展位是临时性的），但商品与分类不受影响。
   * 跳转记录按 collectionId 置空后保留，历史链接仍然能跳到当时的地址。
   */
  async remove(supplied: string, csrfValue: string, id: string, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'content.write', async (tx, actor) => {
      await this.lock(tx, `collection:${id}`);
      const existing = await this.load(tx, id);
      await tx.seoRedirect.deleteMany({ where: { collectionId: id } });
      await tx.collection.delete({ where: { id } });
      await this.identity.recordAudit(tx, ctx, actor.id, 'content.collection.deleted', id, 'success',
        existing.translations.map(item => `${item.locale}:${item.slug ?? '-'}`).join(' '));
      return { id };
    }, true);
  }
}
