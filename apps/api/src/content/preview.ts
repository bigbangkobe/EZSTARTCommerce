import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import { contentPagePath, normalizeRedirectPath, resolveRedirect, slugChangePlan, type RedirectEntry } from '../../../../packages/domain/src/redirect.js';
import { AuthError } from '../identity/service.js';

type Tx = Prisma.TransactionClient;

/** 32 字节随机数 → base64url（43 字符）。token 只在签发响应里出现一次。 */
export function issuePreviewToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: digestPreviewToken(token) };
}

/** 入库与查询都用摘要：数据库被读走时拿不到可用链接。 */
export function digestPreviewToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 重定向表较小（门店级内容运维），一次读全量在内存里解析链，比递归 SQL 更容易证明无环。
 * 不按 locale 过滤：语言只是后台筛选标签，地址本身已经带了语言前缀，
 * 按标签过滤会让「标签填错」变成静默失效的重定向。
 */
async function redirectEntries(tx: Tx): Promise<RedirectEntry[]> {
  const rows = await tx.seoRedirect.findMany({ select: { fromPath: true, toPath: true, statusCode: true }, take: 500 });
  return rows;
}

/**
 * 旧地址 → 新地址登记（内容页 / 专题 / 分类共用）。
 * 失败即关闭：任何一步让链路成环时，宁可删掉这条重定向，也不把访客送进无限跳转。
 * owner 决定这条跳转归属于谁（内容页 / 专题 / 分类）：撤下时按归属清理，不会误删别人的跳转。
 * 三个归属字段互斥，由 DB 约束 seo_redirect_single_owner 保证。
 */
export async function recordPathRedirect(tx: Tx, command: { locale: string; fromPath: string; toPath: string;
  owner: { pageId?: string; collectionId?: string; categoryId?: string }; actorId: string | null }): Promise<void> {
  const { fromPath, toPath } = command;
  if (fromPath === toPath) return;
  const entries = await redirectEntries(tx);
  const plan = slugChangePlan(entries, fromPath, toPath);
  if (plan.remove.length) await tx.seoRedirect.deleteMany({ where: { fromPath: { in: plan.remove } } });
  for (const retarget of plan.retarget) {
    await tx.seoRedirect.updateMany({ where: { fromPath: retarget.fromPath }, data: { toPath: retarget.toPath } });
  }
  const pageId = command.owner.pageId ?? null;
  const collectionId = command.owner.collectionId ?? null;
  const categoryId = command.owner.categoryId ?? null;
  await tx.seoRedirect.upsert({
    where: { fromPath },
    create: { locale: command.locale, fromPath, toPath, statusCode: 301, pageId, collectionId, categoryId,
      createdBy: command.actorId },
    update: { toPath, statusCode: 301, pageId, collectionId, categoryId, createdBy: command.actorId },
  });

  const after = await redirectEntries(tx);
  if (!resolveRedirect(after, fromPath)) {
    // 记录后仍解析不出目标（成环/自跳）：删掉刚写的这条，保持「旧地址 404」而不是坏跳转。
    await tx.seoRedirect.deleteMany({ where: { fromPath } });
  }
}

/** 内容页 slug 变更：把「语言 + slug」翻译成公开路径后登记跳转。 */
export async function recordSlugRedirect(tx: Tx, command: { locale: string; fromSlug: string; toSlug: string;
  pageId: string; actorId: string | null }): Promise<void> {
  await recordPathRedirect(tx, { locale: command.locale,
    fromPath: contentPagePath(command.locale, command.fromSlug),
    toPath: contentPagePath(command.locale, command.toSlug),
    owner: { pageId: command.pageId }, actorId: command.actorId });
}

/** 撤下页面：指向它的重定向全部清理，避免 301 把访客送到一个已经不存在的地址。 */
export async function dropPageRedirects(tx: Tx, command: { pageId: string; paths: readonly string[] }): Promise<void> {
  await tx.seoRedirect.deleteMany({ where: { OR: [
    { pageId: command.pageId },
    ...(command.paths.length ? [{ toPath: { in: [...command.paths] } }] : []),
  ] } });
}

/** 页面当前在线的地址（撤下前先算出来，清指针后就查不到了）。 */
export function livePagePaths(translations: readonly { locale: string; publishedSlug: string | null }[]): string[] {
  return translations.filter(translation => translation.publishedSlug)
    .map(translation => contentPagePath(translation.locale, translation.publishedSlug!));
}

/** 公开查询：非法路径按 422 拒绝，查不到返回 null（前台按 404 处理）。 */
export async function lookupRedirect(tx: Tx, rawPath: string): Promise<{ toPath: string; statusCode: number } | null> {
  let path: string;
  try { path = normalizeRedirectPath(rawPath); } catch { throw new AuthError(422, 'VALIDATION_ERROR'); }
  const entries = await redirectEntries(tx);
  const target = resolveRedirect(entries, path);
  return target ? { toPath: target.toPath, statusCode: target.statusCode } : null;
}
