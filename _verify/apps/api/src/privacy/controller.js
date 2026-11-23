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
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { parse } from 'cookie';
import { header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 后台顾客资料请求（M10 第六批）。
 *
 * 四个权限各自管一段，谁也不含谁：
 * - privacy.manage：受理、改负责人/延期、改口径
 * - privacy.read：看队列与详情
 * - privacy.verify：核验身份
 * - privacy.process：批准/拒绝/要求补充/标记完成
 * 写操作一律要 CSRF + Origin；改资源要 If-Match；核验与决定要幂等键。
 */
let PrivacyController = class PrivacyController extends ManagementHttp {
    privacy;
    constructor(privacy, identity) {
        super(identity);
        this.privacy = privacy;
    }
    privacyService() { if (!this.privacy)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.privacy; }
    cookieSession(request) {
        const value = parse(request.headers.cookie ?? '')['ez_admin_session'];
        if (!value || value.length !== 43)
            throw new AuthError(401, 'UNAUTHORIZED');
        return value;
    }
    idempotencyKey(request) {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || key.length < 16 || key.length > 128)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return key;
    }
    filter(value) {
        if (value === undefined)
            return null;
        if (typeof value !== 'string' || !value.length || value.length > 40)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return value;
    }
    async queue(limit, cursor, status, overdue, request, response) {
        const page = this.pagination(limit, cursor);
        if (overdue !== undefined && overdue !== 'true' && overdue !== 'false')
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.send(response, request, 200, await this.privacyService().queue(this.cookieSession(request), page.limit, page.cursor, this.filter(status), overdue === undefined ? null : overdue === 'true'));
    }
    async create(body, request, response) {
        await this.write(request, 'PrivacyRequestCreate', body);
        this.send(response, request, 201, await this.privacyService().create(this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async get(id, request, response) {
        this.send(response, request, 200, await this.privacyService().get(this.cookieSession(request), uuid(id)));
    }
    /** 改负责人或延期：都要写理由，且必须带「我读到的版本」，避免两个人同时改。 */
    async update(id, body, request, response) {
        await this.write(request, 'PrivacyRequestPatch', body);
        this.send(response, request, 200, await this.privacyService().update(this.cookieSession(request), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    async verify(id, body, request, response) {
        await this.write(request, 'PrivacyVerifyRequest', body);
        this.send(response, request, 200, await this.privacyService().verify(this.cookieSession(request), header(request, 'x-csrf-token'), uuid(id), this.idempotencyKey(request), body, this.context(request)));
    }
    async decide(id, body, request, response) {
        await this.write(request, 'PrivacyCompleteRequest', body);
        this.send(response, request, 200, await this.privacyService().decide(this.cookieSession(request), header(request, 'x-csrf-token'), uuid(id), this.idempotencyKey(request), body, this.context(request)));
    }
    /** 生成导出工件：明文不进响应，只有密文与哈希；重复提交刷新同一份工件。 */
    async createExport(id, body, request, response) {
        await this.write(request, 'PrivacyExportRequest', body);
        this.send(response, request, 201, await this.privacyService().createExport(this.cookieSession(request), header(request, 'x-csrf-token'), uuid(id), this.context(request)));
    }
    /** 下载是原始 JSON 附件，不走统一信封：前端拿到的是可交付给顾客的工件本身。 */
    async downloadExport(id, jobId, request, response) {
        const result = await this.privacyService().downloadExport(this.cookieSession(request), uuid(id), uuid(jobId), this.context(request));
        if (!result)
            throw new AuthError(404, 'NOT_FOUND');
        const bytes = Buffer.from(result.text, 'utf8');
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Content-Length', String(bytes.length));
        response.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('ETag', `"${result.sha256}"`);
        response.end(bytes);
    }
    async updateSettings(body, request, response) {
        await this.write(request, 'PrivacySettingPatchRequest', body);
        this.send(response, request, 200, await this.privacyService().updateSettings(this.cookieSession(request), header(request, 'x-csrf-token'), this.version(request), body, this.context(request)));
    }
};
__decorate([
    Get('privacy-requests'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('status')),
    __param(3, Query('overdue')),
    __param(4, Req()),
    __param(5, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "queue", null);
__decorate([
    Post('privacy-requests'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "create", null);
__decorate([
    Get('privacy-requests/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "get", null);
__decorate([
    Patch('privacy-requests/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "update", null);
__decorate([
    Post('privacy-requests/:id/verify'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "verify", null);
__decorate([
    Post('privacy-requests/:id/complete'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "decide", null);
__decorate([
    Post('privacy-requests/:id/export'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "createExport", null);
__decorate([
    Get('privacy-requests/:id/export/:jobId'),
    __param(0, Param('id')),
    __param(1, Param('jobId')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "downloadExport", null);
__decorate([
    Patch('privacy-settings'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PrivacyController.prototype, "updateSettings", null);
PrivacyController = __decorate([
    Controller('admin'),
    __param(0, Inject('PRIVACY')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], PrivacyController);
export { PrivacyController };
