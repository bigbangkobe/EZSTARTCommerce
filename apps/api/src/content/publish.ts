import type { Prisma } from '../../../../packages/database/src/client.js';
import {
  assertPublishable, contentReleaseToken, ContentRuleError, normalizeBlocks, pageSnapshot,
  type ContentBlock, type ContentTranslationInput, type PageSnapshot,
} from '../../../../packages/domain/src/content.js';
import { AuthError } from '../identity/service.js';
import { dropPageRedirects, livePagePaths, recordSlugRedirect } from './preview.js';

type Tx = Prisma.TransactionClient;

/** 店铺未配置时按三语处理：宁可发布前要求补齐，也不要静默少发一种语言。 */
export const CONTENT_DEFAULT_LOCALES = ['zh-CN', 'zh-HK', 'en'] as const;

export async function contentLocales(tx: Tx): Promise<string[]> {
  const row = await tx.storeConfig.findUnique({ where: { id: 1 }, select: { locales: true } });
  return row && row.locales.length ? [...row.locales] : [...CONTENT_DEFAULT_LOCALES];
}

/**
 * 领域规则 → HTTP 错误码。给后台可区分的码，而不是一律 VALIDATION_ERROR：
 * 「缺语言」「区块类型未注册」「没有可见区块」「定时时间已过」需要不同的修复动作。
 */
const RULE_CODES: Record<string, string> = {
  UNSUPPORTED_BLOCK_TYPE: 'CONTENT_BLOCK_UNSUPPORTED',
  NO_VISIBLE_BLOCK: 'CONTENT_NO_VISIBLE_BLOCK',
  DUPLICATE_BLOCK: 'CONTENT_BLOCK_DUPLICATE',
  DUPLICATE_LOCALE: 'CONTENT_LOCALE_DUPLICATE',
  SCHEDULE_IN_PAST: 'CONTENT_SCHEDULE_IN_PAST',
  SCHEDULE_TOO_FAR: 'CONTENT_SCHEDULE_TOO_FAR',
  SCHEDULE_NOT_ALLOWED: 'CONTENT_SCHEDULE_NOT_ALLOWED',
};

export function contentRule<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof ContentRuleError) throw new AuthError(422, RULE_CODES[error.code] ?? 'VALIDATION_ERROR');
    throw error;
  }
}

/** 行锁：同一页面的编辑/发布/回滚串行化，避免两个并发发布各写一个版本。 */
async function lockPage(tx: Tx, pageId: string) {
  const rows = await tx.$queryRaw<{ version: number; publishedVersionId: string | null; status: string }[]>`
    SELECT "version", "publishedVersionId", "status" FROM "ContentPage" WHERE "id" = ${pageId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new AuthError(404, 'NOT_FOUND');
  return row;
}

/** 内容换代计数器：只增不减，前台缓存与本批区块埋点都用 cr-N 判断内容是否换了。 */
async function bumpRelease(tx: Tx, now: Date): Promise<number> {
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    UPDATE "ContentRelease" SET "seq" = "seq" + 1, "updatedAt" = ${now} WHERE "id" = 1 RETURNING "seq"`;
  return rows[0]?.seq ?? 0;
}

function draftOf(translations: readonly { locale: string; title: string; slug: string; seoTitle: string | null;
  seoDescription: string | null; indexable: boolean }[]): ContentTranslationInput[] {
  return translations.map(translation => ({ locale: translation.locale, title: translation.title, slug: translation.slug,
    seoTitle: translation.seoTitle, seoDescription: translation.seoDescription, indexable: translation.indexable }))
    .sort((left, right) => left.locale.localeCompare(right.locale));
}

/** 发布用的快照校验：把库里存的区块再走一遍注册表，历史脏数据不能因为「已经存进去了」就上线。 */
export function snapshotFor(pageKey: string, pageType: string, translations: ContentTranslationInput[], blocks: unknown): PageSnapshot {
  return contentRule(() => pageSnapshot(pageKey, pageType, translations, normalizeBlocks(blocks)));
}

function visibleCount(blocks: readonly ContentBlock[]): number {
  return blocks.filter(block => block.visible).length;
}

export interface PublishCommand {
  pageId: string;
  expectedVersion: number;
  actorId: string | null;
  note: string | null;
  now: Date;
}

export interface PublishResult { version: number; releaseSeq: number; releaseToken: string }

/**
 * 立即发布：把当前草稿固化成不可变快照并切换线上指针。
 * 三语在同一事务里一起切换，前台不会看到「繁体新、英文旧」的混合版本。
 */
export async function publishPageVersion(tx: Tx, command: PublishCommand): Promise<PublishResult> {
  const locked = await lockPage(tx, command.pageId);
  if (locked.version !== command.expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
  const page = await tx.contentPage.findUnique({ where: { id: command.pageId }, include: { translations: true } });
  if (!page) throw new AuthError(404, 'NOT_FOUND');
  // 发布前记住每个语言「上一次在线」的地址：发布后旧地址就该 301 到新地址，而不是变死链。
  const previousSlugs = new Map(page.translations.map(translation => [translation.locale, translation.publishedSlug]));
  const locales = await contentLocales(tx);
  const translations = draftOf(page.translations);
  const blocks = contentRule(() => normalizeBlocks(page.blocks));
  const check = contentRule(() => assertPublishable(translations, blocks, locales));
  if (check.missingLocales.length) throw new AuthError(422, 'CONTENT_LOCALE_INCOMPLETE');
  const snapshot = snapshotFor(page.pageKey, page.pageType, translations, blocks);
  const version = page.version;

  // 旧版本降级但不删除：回滚要能从历史快照重建新版本。
  await tx.contentPageVersion.updateMany({ where: { pageId: page.id, status: 'published' }, data: { status: 'superseded' } });
  const created = await tx.contentPageVersion.create({ data: { pageId: page.id, version, status: 'published',
    snapshot: snapshot as unknown as Prisma.InputJsonValue, note: command.note, publishedAt: command.now,
    publishedBy: command.actorId } });
  for (const translation of page.translations) {
    await tx.contentPageTranslation.update({ where: { id: translation.id }, data: { publishedSlug: translation.slug } });
    const previous = previousSlugs.get(translation.locale) ?? null;
    if (previous && previous !== translation.slug) {
      await recordSlugRedirect(tx, { locale: translation.locale, fromSlug: previous, toSlug: translation.slug,
        pageId: page.id, actorId: command.actorId });
    }
  }
  await tx.contentPage.update({ where: { id: page.id }, data: { publishedVersionId: created.id, publishedAt: command.now,
    status: 'published', scheduledAt: null, version: version + 1, updatedBy: command.actorId } });
  const releaseSeq = await bumpRelease(tx, command.now);
  return { version, releaseSeq, releaseToken: contentReleaseToken(releaseSeq) };
}

/** 撤下：清空公开地址指针，历史版本行标 withdrawn（快照保留，可回滚重发）。 */
export async function withdrawPageVersion(tx: Tx, command: { pageId: string;
  actorId: string | null; now: Date }): Promise<{ releaseSeq: number; releaseToken: string }> {
  const locked = await lockPage(tx, command.pageId);
  if (!locked.publishedVersionId) throw new AuthError(409, 'STATE_CONFLICT');
  const translations = await tx.contentPageTranslation.findMany({ where: { pageId: command.pageId },
    select: { locale: true, publishedSlug: true } });
  // 页面要下线了：指向它的 301 必须一起清理，否则访客会被送到 404。
  await dropPageRedirects(tx, { pageId: command.pageId, paths: livePagePaths(translations) });
  await tx.contentPageVersion.update({ where: { id: locked.publishedVersionId }, data: { status: 'withdrawn' } });
  await tx.contentPageTranslation.updateMany({ where: { pageId: command.pageId }, data: { publishedSlug: null } });
  await tx.contentPage.update({ where: { id: command.pageId }, data: { publishedVersionId: null, publishedAt: null,
    status: 'withdrawn', scheduledAt: null, version: locked.version + 1, updatedBy: command.actorId } });
  const releaseSeq = await bumpRelease(tx, command.now);
  return { releaseSeq, releaseToken: contentReleaseToken(releaseSeq) };
}

/**
 * 回滚：用历史快照创建**新版本**，同时把草稿恢复成该快照。
 * 只切换线上指针而不恢复草稿的话，下一次「发布」会把更新的草稿悄悄盖回去。
 */
export async function rollbackPageVersion(tx: Tx, command: { pageId: string; sourceVersion: number;
  expectedVersion: number; actorId: string | null; reason: string; now: Date }): Promise<PublishResult> {
  const locked = await lockPage(tx, command.pageId);
  if (locked.version !== command.expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
  const page = await tx.contentPage.findUnique({ where: { id: command.pageId }, include: { translations: true } });
  const source = await tx.contentPageVersion.findFirst({ where: { pageId: command.pageId, version: command.sourceVersion } });
  if (!page || !source) throw new AuthError(404, 'NOT_FOUND');
  const raw = source.snapshot as unknown as PageSnapshot;
  const snapshot = snapshotFor(page.pageKey, page.pageType, raw.translations ?? [], raw.blocks ?? []);
  const locales = await contentLocales(tx);
  const check = contentRule(() => assertPublishable(snapshot.translations, snapshot.blocks, locales));
  if (check.missingLocales.length) throw new AuthError(422, 'CONTENT_LOCALE_INCOMPLETE');
  const version = page.version;

  // 草稿回到旧内容；不在快照里的语言行直接删掉，否则「已撤下语言」会继续占着 slug。
  const keep = new Set(snapshot.translations.map(translation => translation.locale));
  for (const translation of page.translations) {
    if (!keep.has(translation.locale)) await tx.contentPageTranslation.delete({ where: { id: translation.id } });
  }
  for (const translation of snapshot.translations) {
    await tx.contentPageTranslation.upsert({
      where: { pageId_locale: { pageId: page.id, locale: translation.locale } },
      create: { pageId: page.id, locale: translation.locale, title: translation.title, slug: translation.slug,
        seoTitle: translation.seoTitle, seoDescription: translation.seoDescription, indexable: translation.indexable,
        publishedSlug: translation.slug },
      update: { title: translation.title, slug: translation.slug, seoTitle: translation.seoTitle,
        seoDescription: translation.seoDescription, indexable: translation.indexable, publishedSlug: translation.slug },
    });
  }
  await tx.contentPage.update({ where: { id: page.id }, data: { blocks: snapshot.blocks as unknown as Prisma.InputJsonValue } });

  await tx.contentPageVersion.updateMany({ where: { pageId: page.id, status: 'published' }, data: { status: 'superseded' } });
  const created = await tx.contentPageVersion.create({ data: { pageId: page.id, version, status: 'published',
    snapshot: snapshot as unknown as Prisma.InputJsonValue, note: `rollback:${command.reason}`.slice(0, 1000),
    publishedAt: command.now, publishedBy: command.actorId } });
  await tx.contentPage.update({ where: { id: page.id }, data: { publishedVersionId: created.id, publishedAt: command.now,
    status: 'published', scheduledAt: null, version: version + 1, updatedBy: command.actorId } });
  const releaseSeq = await bumpRelease(tx, command.now);
  return { version, releaseSeq, releaseToken: contentReleaseToken(releaseSeq) };
}

/** 计划发布：只登记计划，不改线上指针；到点由 worker 调 publishPageVersion。 */
export async function schedulePage(tx: Tx, command: { pageId: string; expectedVersion: number; scheduledAt: Date;
  actorId: string | null }): Promise<void> {
  const locked = await lockPage(tx, command.pageId);
  if (locked.version !== command.expectedVersion) throw new AuthError(409, 'VERSION_CONFLICT');
  await tx.contentPage.update({ where: { id: command.pageId }, data: { status: 'scheduled',
    scheduledAt: command.scheduledAt, updatedBy: command.actorId } });
}

export function countVisible(blocks: unknown): number {
  try { return visibleCount(normalizeBlocks(blocks)); } catch { return 0; }
}
