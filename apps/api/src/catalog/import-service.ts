import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  assertTransition, buildImportPlan, MAX_IMPORT_BYTES, normalizeMapping, parseCsv,
  previewRows, type ImportMode, type ImportCommitMode, type ImportPlan, type ImportStatus,
} from '../../../../packages/domain/src/import.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import type { MediaStorage } from '../media/storage.js';

type Tx = Prisma.TransactionClient;

export interface JobRow {
  id: string; status: ImportStatus; format: string; mode: ImportMode; commitMode: ImportCommitMode;
  fileObjectKey: string; fileSha256: string; columnMapping: Record<string, string>; localeSet: string[];
  mappingVersion: number; totalRows: number; validRows: number; invalidRows: number;
  createdCount: number; updatedCount: number; skippedCount: number; failedCount: number;
  idempotencyKey: string | null;
  preview: unknown; errorReport: unknown; createdAt: Date; completedAt: Date | null;
}

export interface CreateBody {
  fileObjectKey: string; fileSha256: string; format: 'csv' | 'xlsx'; mode: ImportMode; commitMode: ImportCommitMode;
  columnMapping: Record<string, string>; localeSet: string[];
}
export interface ExecuteBody { confirmedFileSha256: string; confirmedMappingVersion: number; expectedValidRows: number }

/** 契约 ImportJob：字段闭集，别多带（additionalProperties: false 会拒绝）。 */
function jobView(row: JobRow) {
  return { id: row.id, status: row.status, mode: row.mode, commitMode: row.commitMode,
    totalRows: row.totalRows, validRows: row.validRows, invalidRows: row.invalidRows,
    createdCount: row.createdCount, updatedCount: row.updatedCount, skippedCount: row.skippedCount, failedCount: row.failedCount,
    createdAt: row.createdAt.toISOString(), completedAt: row.completedAt === null ? null : row.completedAt.toISOString() };
}

const PREVIEW_VERSION = 1;
interface StoredPreview { version: number; fileSha256: string; mappingVersion: number; plan: ImportPlan }

/**
 * 商品批量导入（M05）。
 *
 * 两段式执行：先在事务里确认"要执行的就是操作员看过的那份"（文件摘要 / 映射版本 / 有效行数），
 * 再把逐商品写入放到独立事务里。`valid_rows` 允许部分成功，所以每个商品一次事务；
 * `atomic` 则全部商品共用一个事务，任一行失败整体回滚。
 * 导入是少数"部分成功是有价值"的操作，不能为了实现简单就把它变成全有或全无。
 */
export class ImportService {
  constructor(private readonly identity: IdentityService, private readonly storage: MediaStorage | null) {}

  private get db() { return this.identity.db; }

  private async load(tx: Tx, id: string, lock = false): Promise<JobRow> {
    const rows = lock
      ? await tx.$queryRaw<JobRow[]>`SELECT * FROM "ImportJob" WHERE "id" = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<JobRow[]>`SELECT * FROM "ImportJob" WHERE "id" = ${id}::uuid`;
    const row = rows[0];
    if (!row) throw new AuthError(404, 'NOT_FOUND');
    return row;
  }

  async create(supplied: string, csrfValue: string, idempotencyKey: string | undefined, body: CreateBody, ctx: RequestContext) {
    const sha = body.fileSha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new AuthError(422, 'VALIDATION_ERROR');
    if (body.format !== 'csv') throw new AuthError(422, 'IMPORT_FORMAT_UNSUPPORTED');
    return this.identity.withPermission(supplied, csrfValue, 'catalog.import', async (tx, actor) => {
      // 幂等键带作用域前缀：同一列同时服务「建任务」与「执行任务」两种请求，
      // 不区分作用域会让「建任务用的 key」在第一次执行时被当成冲突。
      const key = idempotencyKey === undefined ? null : `create:${idempotencyKey}`;
      if (key) {
        const existing = await tx.$queryRaw<JobRow[]>`SELECT * FROM "ImportJob" WHERE "idempotencyKey" = ${key}`;
        if (existing[0]) return jobView(existing[0]);
      }
      const id = randomUUID();
      const locales = `{${body.localeSet.join(',')}}`;
      await tx.$executeRaw`
        INSERT INTO "ImportJob" ("id","status","format","mode","commitMode","fileObjectKey","fileSha256","columnMapping","localeSet","mappingVersion","createdBy","idempotencyKey")
        VALUES (${id}::uuid, 'uploaded', ${body.format}, ${body.mode}, ${body.commitMode}, ${body.fileObjectKey}, ${sha},
          ${JSON.stringify(body.columnMapping)}::jsonb, ${locales}::text[], 1, ${actor.id}::uuid, ${key})`;
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.import.created', id);
      return jobView(await this.load(tx, id));
    }, true);
  }

  /** 导入文件的上传目标：与媒体共用签名通道，但前缀是 imports/、权限是 catalog.import。 */
  async createFileTarget(supplied: string, csrfValue: string) {
    if (!this.storage) throw new AuthError(503, 'SERVICE_NOT_READY');
    return this.identity.withPermission(supplied, csrfValue, 'catalog.import', async () => {
      const now = new Date();
      const key = `imports/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.csv`;
      const target = this.storage!.createUploadTarget(key, 'text/csv', new Date(now.getTime() + 15 * 60_000));
      return { objectKey: key, uploadUrl: target.url, method: target.method, headers: target.headers,
        expiresAt: target.expiresAt, maxSizeBytes: MAX_IMPORT_BYTES };
    }, true);
  }

  async get(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'catalog.import', async tx => jobView(await this.load(tx, id)));
  }

  /** 校验：只读文件、只算计划，不写任何商品。失败时任务停在原状态，可以重试或取消。 */
  async validateJob(supplied: string, csrfValue: string, id: string, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.import', async (tx, actor) => {
      const job = await this.load(tx, id, true);
      this.stateRule(() => assertTransition(job.status, 'validating'));
      if (!this.storage) throw new AuthError(503, 'SERVICE_NOT_READY');
      const bytes = await this.storage.read(job.fileObjectKey);
      if (!bytes) throw new AuthError(422, 'IMPORT_FILE_NOT_FOUND');
      if (bytes.length > MAX_IMPORT_BYTES) throw new AuthError(422, 'IMPORT_FILE_TOO_LARGE');
      const digest = createHashHex(bytes);
      if (digest !== job.fileSha256) throw new AuthError(409, 'IMPORT_FILE_DIGEST_MISMATCH');

      const csv = this.rule(() => parseCsv(bytes.toString('utf8')));
      const mapping = this.rule(() => normalizeMapping(job.columnMapping, csv.headers));
      const lookups = await this.lookups(tx, csv.rows.flatMap(row => {
        const header = mapping.get('variant_sku');
        const index = header === undefined ? -1 : csv.headers.indexOf(header);
        const value = index < 0 ? '' : (row.cells[index] ?? '').trim();
        return value ? [value] : [];
      }), job.localeSet);
      const currency = await this.storeCurrency(tx);
      const plan = this.rule(() => buildImportPlan({ csv, mapping, modes: { mode: job.mode, locales: job.localeSet, currency }, lookups }));

      const preview: StoredPreview = { version: PREVIEW_VERSION, fileSha256: job.fileSha256, mappingVersion: job.mappingVersion, plan };
      await tx.$executeRaw`
        UPDATE "ImportJob" SET "status" = 'ready', "totalRows" = ${plan.counters.totalRows}, "validRows" = ${plan.counters.validRows},
          "invalidRows" = ${plan.counters.invalidRows}, "preview" = ${JSON.stringify(preview)}::jsonb, "validatedAt" = now()
        WHERE "id" = ${id}::uuid`;
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.import.validated', id, 'success',
        `valid=${plan.counters.validRows} invalid=${plan.counters.invalidRows}`);
      return {
        jobId: id, fileSha256: job.fileSha256, mappingVersion: job.mappingVersion,
        totalRows: plan.counters.totalRows, validRows: plan.counters.validRows, invalidRows: plan.counters.invalidRows,
        newCount: plan.counters.newCount, updateCount: plan.counters.updateCount, skipCount: plan.counters.skipCount,
        previewRows: previewRows(plan),
      };
    }, true);
  }

  async execute(supplied: string, csrfValue: string, id: string, idempotencyKey: string | undefined, body: ExecuteBody, ctx: RequestContext) {
    // 第一段：确认执行的就是操作员看过的那份，并把任务推进到 processing（单独事务提交）。
    const started = await this.identity.withPermission(supplied, csrfValue, 'catalog.import', async (tx, actor) => {
      const row = await this.load(tx, id, true);
      const execKey = idempotencyKey === undefined ? null : `execute:${idempotencyKey}`;
      const stored = row.idempotencyKey ?? '';
      // 同一幂等键的重放直接回放结果：网络重试不该看到一个"已完成"的 409。
      if (execKey !== null && stored === execKey && ['processing', 'completed', 'completed_with_errors'].includes(row.status)) {
        return { row, replay: true };
      }
      if (row.status === 'completed' || row.status === 'completed_with_errors' || row.status === 'failed') {
        throw new AuthError(409, 'IMPORT_STATE_CONFLICT');
      }
      if (row.status !== 'ready') throw new AuthError(409, 'IMPORT_NOT_VALIDATED');
      // 只有「已有另一个执行键」才算冲突；建任务时写入的 create:… 与执行无关，不参与比较。
      if (execKey !== null && stored.startsWith('execute:') && stored !== execKey) throw new AuthError(409, 'IDEMPOTENCY_CONFLICT');
      if (body.confirmedFileSha256.toLowerCase() !== row.fileSha256) throw new AuthError(409, 'IMPORT_FILE_DIGEST_MISMATCH');
      if (body.confirmedMappingVersion !== row.mappingVersion) throw new AuthError(409, 'IMPORT_MAPPING_VERSION_STALE');
      if (body.expectedValidRows !== row.validRows) throw new AuthError(409, 'IMPORT_VALID_ROWS_MISMATCH');
      await tx.$executeRaw`UPDATE "ImportJob" SET "status" = 'processing', "idempotencyKey" = ${execKey ?? row.idempotencyKey} WHERE "id" = ${id}::uuid`;
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.import.started', id);
      return { row, replay: false };
    }, true);
    const job = started.row;
    if (started.replay) return jobView(job);

    const preview = job.preview as StoredPreview | null;
    if (!preview || preview.version !== PREVIEW_VERSION) throw new AuthError(409, 'IMPORT_PREVIEW_MISSING');
    const store = await this.db.storeConfig.findUnique({ where: { id: 1 } });
    const currency = store?.baseCurrency ?? 'HKD';
    let created = 0; let updated = 0; const failures: { rowNumber: number; code: string }[] = [];

    const apply = async (tx: Tx, plan: ImportPlan['products'][number]) => {
      await this.applyProduct(tx, plan, currency);
      if (plan.action === 'create') created += 1; else updated += 1;
    };

    if (job.commitMode === 'atomic') {
      try {
        await this.db.$transaction(async tx => {
          for (const plan of preview.plan.products) await apply(tx, plan);
        });
      } catch (error) {
        const code = error instanceof AuthError ? error.code : 'IMPORT_EXECUTION_FAILED';
        await this.finish(job, 'failed', { created: 0, updated: 0, failed: preview.plan.products.length, skipped: 0, code, ctx });
        throw error instanceof AuthError ? error : new AuthError(409, 'IMPORT_EXECUTION_FAILED');
      }
    } else {
      for (const plan of preview.plan.products) {
        try {
          await this.db.$transaction(tx => apply(tx, plan));
        } catch (error) {
          failures.push({ rowNumber: plan.rowNumbers[0] ?? 0, code: error instanceof AuthError ? error.code : 'IMPORT_ROW_FAILED' });
        }
      }
    }

    const status: ImportStatus = failures.length === 0 ? 'completed' : 'completed_with_errors';
    const row = await this.finish(job, status, { created, updated, failed: failures.length, skipped: preview.plan.counters.skipCount, ctx,
      errorReport: failures.length ? failures : undefined });
    return jobView(row);
  }

  private async finish(job: JobRow, status: ImportStatus,
    input: { created: number; updated: number; failed: number; skipped: number; ctx: RequestContext; code?: string; errorReport?: unknown }) {
    return this.db.$transaction(async tx => {
      const errorReport = input.errorReport ?? null;
      await tx.$executeRaw`
        UPDATE "ImportJob" SET "status" = ${status}, "createdCount" = ${input.created}, "updatedCount" = ${input.updated},
          "failedCount" = ${input.failed}, "skippedCount" = ${input.skipped},
          "errorReport" = ${errorReport === null ? null : JSON.stringify(errorReport)}::jsonb,
          "completedAt" = now()
        WHERE "id" = ${job.id}::uuid`;
      await this.identity.recordAudit(tx, input.ctx, null, `catalog.import.${status}`, job.id, 'success',
        input.code ?? `created=${input.created} updated=${input.updated} failed=${input.failed}`);
      return this.load(tx, job.id);
    });
  }

  /** 单个商品的落库：create 走嵌套写，update 走整组替换 + 规格按 SKU 增量。 */
  private async applyProduct(tx: Tx, plan: ImportPlan['products'][number], currency: string) {
    const translations = plan.translations.map(translation => ({
      locale: translation.locale, name: translation.name, slug: translation.slug,
      shortDescription: translation.shortDescription, description: translation.description }));
    const variants = plan.variants.map(variant => ({ ...variant, currency }));
    if (plan.action === 'update' && plan.existingProductId) {
      const id = plan.existingProductId;
      await tx.productTranslation.deleteMany({ where: { productId: id } });
      await tx.productTranslation.createMany({ data: translations.map(translation => ({ productId: id, ...translation })) });
      for (const variant of variants) {
        await tx.productVariant.upsert({ where: { sku: variant.sku },
          update: { optionValues: variant.optionValues, priceMinor: variant.priceMinor, compareAtMinor: variant.compareAtMinor,
            currency: variant.currency, status: variant.status },
          create: { id: randomUUID(), productId: id, ...variant } });
      }
      await tx.productCategory.deleteMany({ where: { productId: id } });
      if (plan.categoryIds.length) await tx.productCategory.createMany({ data: plan.categoryIds.map(categoryId => ({ productId: id, categoryId })) });
      await tx.product.update({ where: { id }, data: {
        ...(plan.baseSku ? { baseSku: plan.baseSku } : {}), brandId: plan.brandId, marketCodes: plan.marketCodes,
        version: { increment: 1 },
        ...(plan.publish ? { status: 'active', publishedAt: new Date() } : {}) } });
      return;
    }
    await tx.product.create({ data: {
      id: randomUUID(), status: plan.publish ? 'active' : 'draft',
      ...(plan.publish ? { publishedAt: new Date() } : {}),
      baseSku: plan.baseSku, brandId: plan.brandId, marketCodes: plan.marketCodes,
      translations: { create: translations },
      variants: { create: variants.map(variant => ({ id: randomUUID(), ...variant })) },
      categories: { create: plan.categoryIds.map(categoryId => ({ categoryId })) } } });
  }

  async cancel(supplied: string, csrfValue: string, id: string, reason: string, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'catalog.import', async (tx, actor) => {
      const job = await this.load(tx, id, true);
      this.stateRule(() => assertTransition(job.status, 'cancelled'));
      // cancelled 不是 completed：ImportJob_completed_check 只允许 completed/completed_with_errors
      // 写 completedAt，取消时必须保持 NULL，否则违反约束变 500。
      await tx.$executeRaw`UPDATE "ImportJob" SET "status" = 'cancelled' WHERE "id" = ${id}::uuid`;
      await this.identity.recordAudit(tx, ctx, actor.id, 'catalog.import.cancelled', id, 'success', reason);
      return { cancelled: true };
    }, true);
  }

  /** 错误报告：只回逐行错误，不回商品内容，避免把整份目录再传一遍。 */
  async errorReport(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'catalog.import', async tx => {
      const job = await this.load(tx, id);
      const preview = job.preview as StoredPreview | null;
      const rows = preview?.plan.rows.filter(row => row.action === 'reject' || row.warnings.length > 0) ?? [];
      return { jobId: id, totalRows: job.totalRows, invalidRows: job.invalidRows,
        rows: rows.slice(0, 2_000).map(row => ({ rowNumber: row.rowNumber, sku: row.sku, action: row.action,
          errors: row.errors, warnings: row.warnings })) };
    });
  }

  private rule<T>(fn: () => T): T {
    try { return fn(); }
    catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string') throw new AuthError(422, code.replace(/:[a-z_]+$/i, ''));
      throw error;
    }
  }

  /** 状态机冲突是 409（和订单、结算的既有口径一致），不能混进「字段不合法」的 422。 */
  private stateRule<T>(fn: () => T): T {
    try { return fn(); }
    catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string') throw new AuthError(409, code);
      throw error;
    }
  }

  private async storeCurrency(tx: Tx): Promise<string> {
    const row = await tx.storeConfig.findUnique({ where: { id: 1 } });
    return row?.baseCurrency ?? 'HKD';
  }

  /** 把导入需要的引用表一次性读进内存：分类按名称/slug/父子路径，品牌按三语名，市场只认已审核启用的。 */
  private async lookups(tx: Tx, skus: string[], locales: string[]) {
    const [variants, categories, brands, markets] = await Promise.all([
      skus.length ? tx.productVariant.findMany({ where: { sku: { in: skus } }, select: { sku: true, productId: true } }) : Promise.resolve([]),
      tx.category.findMany({ include: { translations: true } }),
      tx.brand.findMany({ include: { translations: true } }),
      tx.marketProfile.findMany(),
    ]);
    const existingBySku = new Map(variants.map(variant => [variant.sku, { productId: variant.productId }]));
    const categoryByPath = new Map<string, string>();
    const byId = new Map(categories.map(category => [category.id, category]));
    for (const category of categories) {
      const names = category.translations.filter(translation => locales.includes(translation.locale));
      for (const translation of names) {
        categoryByPath.set(translation.name, category.id);
        // 分类 slug 可能为空（尚未填写）：空 slug 不建索引，避免把 undefined 当成可用路径。
        if (translation.slug) categoryByPath.set(translation.slug, category.id);
        const parent = category.parentId ? byId.get(category.parentId) : null;
        const parentName = parent?.translations.find(item => item.locale === translation.locale)?.name;
        if (parentName) categoryByPath.set(`${parentName}/${translation.name}`, category.id);
      }
    }
    const brandByName = new Map<string, string>();
    for (const brand of brands) for (const translation of brand.translations) {
      if (locales.includes(translation.locale)) brandByName.set(translation.name, brand.id);
    }
    const now = new Date();
    const knownMarkets = new Set(markets
      .filter(market => market.enabled && market.reviewStatus === 'approved'
        && (market.reviewValidUntil === null || market.reviewValidUntil > now))
      .map(market => market.marketCode));
    return { existingBySku, categoryByPath, brandByName, knownMarkets };
  }
}

function createHashHex(bytes: Buffer): string {
  // 与媒体模块同一口径：服务端自己算，不信客户端声明的摘要。
  return createHash('sha256').update(bytes).digest('hex');
}
