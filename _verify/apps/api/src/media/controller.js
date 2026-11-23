var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { MAX_MEDIA_BYTES } from '../../../../packages/domain/src/media.js';
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
import { LocalMediaStorage } from './storage.js';
let MediaController = class MediaController extends ManagementHttp {
    media;
    constructor(media, identity) {
        super(identity);
        this.media = media;
    }
    mediaService() { if (!this.media)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.media; }
    async list(limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.mediaService().list(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
    }
    async get(id, request, response) {
        this.send(response, request, 200, await this.mediaService().get(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async uploadTarget(body, request, response) {
        await this.write(request, 'MediaUploadTargetRequest', body);
        this.send(response, request, 201, await this.mediaService().createUploadTarget(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async complete(body, request, response) {
        await this.write(request, 'MediaUploadCompleteRequest', body);
        this.send(response, request, 201, await this.mediaService().completeUpload(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
};
__decorate([
    Get(),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MediaController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], MediaController.prototype, "get", null);
__decorate([
    Post('upload-target'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MediaController.prototype, "uploadTarget", null);
__decorate([
    Post('complete'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MediaController.prototype, "complete", null);
MediaController = __decorate([
    Controller('admin/media'),
    __param(0, Inject('MEDIA')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], MediaController);
export { MediaController };
/**
 * 对象存储端点（非业务 API，不在 OpenAPI 契约内）。
 *
 * 授权只来自短时签名：浏览器拿到的 uploadUrl 就是一个能力凭证，
 * 因此这里不读会话 Cookie、也不要求 CSRF；越权风险由“短时 + 单对象 + 单方法”收敛。
 * 只有本地驱动需要它——S3 驱动由对象存储自己接收字节。
 */
let MediaObjectsController = class MediaObjectsController {
    media;
    constructor(media) {
        this.media = media;
    }
    storage() {
        if (!this.media)
            throw new AuthError(503, 'SERVICE_NOT_READY');
        const storage = this.media.storage;
        if (!(storage instanceof LocalMediaStorage))
            throw new AuthError(404, 'NOT_FOUND');
        return storage;
    }
    params(key, expires, signature) {
        // 缺参直接按无效签名处理，不区分“参数缺失”与“签名错误”，避免成为探测接口。
        if (!key || !expires || !signature)
            throw new AuthError(403, 'FORBIDDEN');
        return { key, expires, signature };
    }
    async upload(request, key, expires, signature, response) {
        const storage = this.storage();
        const params = this.params(key, expires, signature);
        try {
            storage.authorize('PUT', params.key, params.expires, params.signature, new Date());
        }
        catch {
            throw new AuthError(403, 'FORBIDDEN');
        }
        const declared = Number(request.headers['content-length']);
        if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_MEDIA_BYTES)
            throw new AuthError(413, 'PAYLOAD_TOO_LARGE');
        const body = await bodyBytes(request, MAX_MEDIA_BYTES);
        if (body.length !== declared)
            throw new AuthError(422, 'VALIDATION_ERROR');
        await storage.write(params.key, body);
        response.statusCode = 204;
        response.end();
    }
    async read(key, expires, signature, response) {
        const storage = this.storage();
        const params = this.params(key, expires, signature);
        try {
            storage.authorize('GET', params.key, params.expires, params.signature, new Date());
        }
        catch {
            throw new AuthError(403, 'FORBIDDEN');
        }
        const object = await this.media.publicObject(params.key);
        if (!object)
            throw new AuthError(404, 'NOT_FOUND');
        const bytes = await storage.read(params.key);
        if (!bytes)
            throw new AuthError(404, 'NOT_FOUND');
        response.statusCode = 200;
        response.setHeader('Content-Type', object.contentType);
        response.setHeader('Content-Length', String(bytes.length));
        response.setHeader('X-Content-Type-Options', 'nosniff');
        // 私有对象：允许浏览器短期缓存，但禁止共享缓存代存。
        response.setHeader('Cache-Control', 'private, max-age=300');
        response.setHeader('ETag', `"${object.sha256}"`);
        response.end(bytes);
    }
};
__decorate([
    Put('objects'),
    __param(0, Req()),
    __param(1, Query('key')),
    __param(2, Query('expires')),
    __param(3, Query('signature')),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, String, String, String, Function]),
    __metadata("design:returntype", Promise)
], MediaObjectsController.prototype, "upload", null);
__decorate([
    Get('objects'),
    __param(0, Query('key')),
    __param(1, Query('expires')),
    __param(2, Query('signature')),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Function]),
    __metadata("design:returntype", Promise)
], MediaObjectsController.prototype, "read", null);
MediaObjectsController = __decorate([
    Controller('media'),
    __param(0, Inject('MEDIA')),
    __metadata("design:paramtypes", [Object])
], MediaObjectsController);
export { MediaObjectsController };
/** 有上限的流式读取：超限立即失败，不把整个请求体读进内存。 */
async function bodyBytes(request, limit) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > limit)
            throw new AuthError(413, 'PAYLOAD_TOO_LARGE');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
