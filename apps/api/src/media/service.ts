import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../../packages/database/src/client.js';
import { assertUploadComplete, assertUploadTarget, detectContentType, imageDimensions, isMediaObjectKey,
  mediaObjectKey, MEDIA_UPLOAD_TTL_SECONDS, MediaRuleError } from '../../../../packages/domain/src/media.js';
import { AuthError, IdentityService, type RequestContext } from '../identity/service.js';
import type { MediaStorage } from './storage.js';

type MediaRow = Prisma.MediaAssetGetPayload<{}>;

export interface UploadTargetBody { fileName: string; contentType: string; sizeBytes: number }
export interface UploadCompleteBody { objectKey: string; sha256: string }

/** 读取链接也是短时的：媒体是私有对象，不在公开互联网上长期可达。 */
const READ_TTL_MS = 10 * 60 * 1000;

/**
 * 媒体服务（M02）。
 *
 * 两阶段上传：先申请带签名的短时目标并落一条 pending 记录，再回读对象确认摘要。
 * 服务端从不信任客户端声明的摘要或 MIME：确认时自己算摘要、自己从文件头判断类型，
 * 因此“改后缀上传可执行内容”和“确认时掉包文件”都会在入库前失败。
 */
export class MediaService {
  constructor(private readonly identity: IdentityService, readonly storage: MediaStorage) {}

  private get db() { return this.identity.db; }

  private rule<T>(fn: () => T): T {
    try { return fn(); } catch (error) { if (error instanceof MediaRuleError) throw new AuthError(422, 'VALIDATION_ERROR'); throw error; }
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

  private view(row: MediaRow, now = new Date()) {
    return {
      id: row.id, objectKey: row.objectKey, contentType: row.contentType, sizeBytes: row.sizeBytes,
      sha256: row.sha256, width: row.width, height: row.height, originalFileName: row.originalFileName,
      status: row.status,
      // pending 行没有可读对象：此时给链接只会得到 404，因此明确返回 null。
      url: row.status === 'ready' ? this.storage.createReadTarget(row.objectKey, new Date(now.getTime() + READ_TTL_MS)).url : null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(supplied: string, limit: number, cursor: string | null) {
    return this.identity.withPermission(supplied, null, 'media.manage', async tx => {
      if (cursor && !await tx.mediaAsset.findUnique({ where: { id: cursor } })) throw new AuthError(422, 'VALIDATION_ERROR');
      const rows = await tx.mediaAsset.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const items = rows.slice(0, limit); const hasMore = rows.length > limit;
      return { items: items.map(row => this.view(row)), hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
    });
  }

  async get(supplied: string, id: string) {
    return this.identity.withPermission(supplied, null, 'media.manage', async tx => {
      const row = await tx.mediaAsset.findUnique({ where: { id } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      return this.view(row);
    });
  }

  async createUploadTarget(supplied: string, csrfValue: string, body: UploadTargetBody, ctx: RequestContext) {
    return this.identity.withPermission(supplied, csrfValue, 'media.manage', async (tx, actor, _session, now) => {
      const rule = this.rule(() => assertUploadTarget(body));
      const id = randomUUID();
      const expiresAt = new Date(now.getTime() + MEDIA_UPLOAD_TTL_SECONDS * 1000);
      const objectKey = mediaObjectKey(now, id, rule.extension);
      const row = await this.guarded(() => tx.mediaAsset.create({ data: {
        id, objectKey, contentType: rule.contentType, sizeBytes: rule.sizeBytes, originalFileName: rule.fileName,
        status: 'pending', uploadedBy: actor.id } }));
      await this.identity.recordAudit(tx, ctx, actor.id, 'media.upload_target.created', id);
      const target = this.storage.createUploadTarget(objectKey, rule.contentType, expiresAt);
      return { mediaId: id, objectKey, uploadUrl: target.url, method: target.method, headers: target.headers,
        expiresAt: target.expiresAt, maxSizeBytes: rule.sizeBytes };
    }, true);
  }

  /**
   * 确认上传。对象回读在事务外完成（S3 上是网络往返），事务只承担“校验后一次性转 ready”，
   * 避免长时间占用数据库连接；状态更新带 `status: 'pending'` 条件，重复确认自然失败。
   */
  async completeUpload(supplied: string, csrfValue: string, body: UploadCompleteBody, ctx: RequestContext) {
    if (!isMediaObjectKey(body.objectKey)) throw new AuthError(422, 'VALIDATION_ERROR');
    const stored = await this.storage.stat(body.objectKey);
    return this.identity.withPermission(supplied, csrfValue, 'media.manage', async (tx, actor) => {
      const row = await tx.mediaAsset.findUnique({ where: { objectKey: body.objectKey } });
      if (!row) throw new AuthError(404, 'NOT_FOUND');
      if (row.status !== 'pending') throw new AuthError(409, 'STATE_CONFLICT');
      this.rule(() => assertUploadComplete({ sizeBytes: row.sizeBytes, sha256: body.sha256 }, stored));
      // 真实类型必须与申请时一致：不允许申请 png 却上传 webp 后改库。
      const contentType = this.rule(() => detectContentType(stored!.prefix));
      if (contentType !== row.contentType) throw new AuthError(422, 'VALIDATION_ERROR');
      const size = this.rule(() => imageDimensions(stored!.prefix));
      const updated = await this.guarded(() => tx.mediaAsset.update({ where: { id: row.id }, data: {
        status: 'ready', sha256: stored!.sha256, width: size.width, height: size.height } }));
      await this.identity.recordAudit(tx, ctx, actor.id, 'media.uploaded', row.id);
      return this.view(updated);
    }, true);
  }

  /** 存储端点用：只有已确认的媒体才对外提供字节。 */
  async publicObject(objectKey: string): Promise<{ contentType: string; sha256: string } | null> {
    const row = await this.db.mediaAsset.findFirst({ where: { objectKey, status: 'ready' },
      select: { contentType: true, sha256: true } });
    // ready 行按数据库 CHECK 必有摘要；这里仍然显式收窄，避免把 null 当成 ETag 发出去。
    if (!row?.sha256) return null;
    return { contentType: row.contentType, sha256: row.sha256 };
  }
}
