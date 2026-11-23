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
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
let ContentController = class ContentController extends ManagementHttp {
    content;
    constructor(content, identity) {
        super(identity);
        this.content = content;
    }
    contentService() { if (!this.content)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.content; }
    async pages(limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.contentService().listPages(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
    }
    async page(id, request, response) {
        this.send(response, request, 200, await this.contentService().getPage(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async createPage(body, request, response) {
        await this.write(request, 'PageWriteRequest', body);
        this.send(response, request, 201, await this.contentService().createPage(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async updatePage(id, body, request, response) {
        await this.write(request, 'PagePatchRequest', body);
        this.send(response, request, 200, await this.contentService().updatePage(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    async publish(id, body, request, response) {
        await this.write(request, 'PagePublishRequest', body);
        const result = await this.contentService().publishPage(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body, this.context(request));
        // 202 = 已登记定时计划但尚未生效；200 = 线上已经切到新版本。
        this.send(response, request, result.scheduled ? 202 : 200, result);
    }
    async unpublish(id, body, request, response) {
        await this.write(request, 'ReasonRequest', body);
        this.send(response, request, 200, await this.contentService().unpublishPage(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body, this.context(request)));
    }
    async rollback(id, body, request, response) {
        await this.write(request, 'PageRollbackRequest', body);
        this.send(response, request, 201, await this.contentService().rollbackPage(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body, this.context(request)));
    }
    /**
     * 预览外链：返回 201 与一次性 token（只在这一次响应里出现，库里只有摘要）。
     * 前台路由是 /preview/{token}?locale=&viewport=，链接短期有效、noindex、不写埋点。
     */
    async previewToken(id, body, request, response) {
        await this.write(request, 'PreviewRequest', body);
        this.send(response, request, 201, await this.contentService().createPreviewToken(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body, this.context(request)));
    }
    async redirects(limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.contentService().listRedirects(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
    }
    async createRedirect(body, request, response) {
        await this.write(request, 'RedirectWriteRequest', body);
        this.send(response, request, 201, await this.contentService().createRedirect(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async deleteRedirect(id, request, response) {
        await this.guardWrite(request);
        await this.contentService().deleteRedirect(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.context(request));
        this.send(response, request, 204, null);
    }
};
__decorate([
    Get('pages'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "pages", null);
__decorate([
    Get('pages/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "page", null);
__decorate([
    Post('pages'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "createPage", null);
__decorate([
    Patch('pages/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "updatePage", null);
__decorate([
    Post('pages/:id/publish'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "publish", null);
__decorate([
    Post('pages/:id/unpublish'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "unpublish", null);
__decorate([
    Post('pages/:id/rollback'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "rollback", null);
__decorate([
    Post('pages/:id/preview-token'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "previewToken", null);
__decorate([
    Get('redirects'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "redirects", null);
__decorate([
    Post('redirects'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "createRedirect", null);
__decorate([
    Delete('redirects/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "deleteRedirect", null);
ContentController = __decorate([
    Controller('admin'),
    __param(0, Inject('CONTENT')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], ContentController);
export { ContentController };
