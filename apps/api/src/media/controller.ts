import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_MEDIA_BYTES } from '../../../../packages/domain/src/media.js';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { MediaService, type UploadCompleteBody, type UploadTargetBody } from './service.js';
import { LocalMediaStorage } from './storage.js';

@Controller('admin/media')
export class MediaController extends ManagementHttp {
  constructor(@Inject('MEDIA') private readonly media: MediaService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private mediaService() { if (!this.media) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.media; }

  @Get()
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.mediaService().list(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.mediaService().get(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('upload-target')
  async uploadTarget(@Body() body: UploadTargetBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'MediaUploadTargetRequest', body);
    this.send(response, request, 201, await this.mediaService().createUploadTarget(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Post('complete')
  async complete(@Body() body: UploadCompleteBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'MediaUploadCompleteRequest', body);
    this.send(response, request, 201, await this.mediaService().completeUpload(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }
}

/**
 * 对象存储端点（非业务 API，不在 OpenAPI 契约内）。
 *
 * 授权只来自短时签名：浏览器拿到的 uploadUrl 就是一个能力凭证，
 * 因此这里不读会话 Cookie、也不要求 CSRF；越权风险由“短时 + 单对象 + 单方法”收敛。
 * 只有本地驱动需要它——S3 驱动由对象存储自己接收字节。
 */
@Controller('media')
export class MediaObjectsController {
  constructor(@Inject('MEDIA') private readonly media: MediaService | null) {}

  private storage() {
    if (!this.media) throw new AuthError(503, 'SERVICE_NOT_READY');
    const storage = this.media.storage;
    if (!(storage instanceof LocalMediaStorage)) throw new AuthError(404, 'NOT_FOUND');
    return storage;
  }

  private params(key: string, expires: string, signature: string) {
    // 缺参直接按无效签名处理，不区分“参数缺失”与“签名错误”，避免成为探测接口。
    if (!key || !expires || !signature) throw new AuthError(403, 'FORBIDDEN');
    return { key, expires, signature };
  }

  @Put('objects')
  async upload(@Req() request: IncomingMessage, @Query('key') key: string, @Query('expires') expires: string,
    @Query('signature') signature: string, @Res() response: ServerResponse) {
    const storage = this.storage();
    const params = this.params(key, expires, signature);
    try { storage.authorize('PUT', params.key, params.expires, params.signature, new Date()); }
    catch { throw new AuthError(403, 'FORBIDDEN'); }
    const declared = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_MEDIA_BYTES) throw new AuthError(413, 'PAYLOAD_TOO_LARGE');
    const body = await bodyBytes(request, MAX_MEDIA_BYTES);
    if (body.length !== declared) throw new AuthError(422, 'VALIDATION_ERROR');
    await storage.write(params.key, body);
    response.statusCode = 204;
    response.end();
  }

  @Get('objects')
  async read(@Query('key') key: string, @Query('expires') expires: string, @Query('signature') signature: string,
    @Res() response: ServerResponse) {
    const storage = this.storage();
    const params = this.params(key, expires, signature);
    try { storage.authorize('GET', params.key, params.expires, params.signature, new Date()); }
    catch { throw new AuthError(403, 'FORBIDDEN'); }
    const object = await this.media!.publicObject(params.key);
    if (!object) throw new AuthError(404, 'NOT_FOUND');
    const bytes = await storage.read(params.key);
    if (!bytes) throw new AuthError(404, 'NOT_FOUND');
    response.statusCode = 200;
    response.setHeader('Content-Type', object.contentType);
    response.setHeader('Content-Length', String(bytes.length));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // 私有对象：允许浏览器短期缓存，但禁止共享缓存代存。
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('ETag', `"${object.sha256}"`);
    response.end(bytes);
  }
}

/** 有上限的流式读取：超限立即失败，不把整个请求体读进内存。 */
async function bodyBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limit) throw new AuthError(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
