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
import { Body, Controller, Get, Inject, Param, Post, Patch, Query, Req, Res } from '@nestjs/common';
import { cookie, header } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
let MerchandisingController = class MerchandisingController extends ManagementHttp {
    merchandising;
    constructor(merchandising, identity) {
        super(identity);
        this.merchandising = merchandising;
    }
    layouts() { if (!this.merchandising)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.merchandising; }
    /** 商品选择器：不合格商品带原因返回，后台据此禁用选项而不是等保存才报错。 */
    async products(query, limit, categoryId, collectionId, request, response) {
        const page = this.pagination(limit, undefined);
        const id = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
        this.send(response, request, 200, await this.layouts().products(cookie(request, 'ez_admin_session'), typeof query === 'string' && query.trim() ? query.trim().slice(0, 200) : null, page.limit, id(categoryId), id(collectionId)));
    }
    /** 页面选择器：首页 + 启用中的分类与专题，带各自版面状态（none 表示还没开始配）。 */
    async pages(request, response) {
        this.send(response, request, 200, await this.layouts().pages(cookie(request, 'ez_admin_session')));
    }
    async layout(pageKey, request, response) {
        this.send(response, request, 200, await this.layouts().get(cookie(request, 'ez_admin_session'), pageKey));
    }
    /** 保存草稿：expectedVersion=0 表示还没建过。保存不改线上快照。 */
    async save(pageKey, body, request, response) {
        await this.write(request, 'MerchandisingWriteRequest', body);
        this.send(response, request, 200, await this.layouts().save(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), pageKey, body, this.context(request)));
    }
    async publish(pageKey, body, request, response) {
        await this.write(request, 'MerchandisingPublishRequest', body);
        this.send(response, request, 200, await this.layouts().publish(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), pageKey, body, this.context(request)));
    }
    async unpublish(pageKey, body, request, response) {
        await this.write(request, 'MerchandisingWithdrawRequest', body);
        this.send(response, request, 200, await this.layouts().unpublish(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), pageKey, body, this.context(request)));
    }
};
__decorate([
    Get('products'),
    __param(0, Query('q')),
    __param(1, Query('limit')),
    __param(2, Query('categoryId')),
    __param(3, Query('collectionId')),
    __param(4, Req()),
    __param(5, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MerchandisingController.prototype, "products", null);
__decorate([
    Get('pages'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], MerchandisingController.prototype, "pages", null);
__decorate([
    Get(':pageKey'),
    __param(0, Param('pageKey')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], MerchandisingController.prototype, "layout", null);
__decorate([
    Patch(':pageKey'),
    __param(0, Param('pageKey')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MerchandisingController.prototype, "save", null);
__decorate([
    Post(':pageKey/publish'),
    __param(0, Param('pageKey')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MerchandisingController.prototype, "publish", null);
__decorate([
    Post(':pageKey/unpublish'),
    __param(0, Param('pageKey')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MerchandisingController.prototype, "unpublish", null);
MerchandisingController = __decorate([
    Controller('admin/merchandising'),
    __param(0, Inject('MERCHANDISING')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], MerchandisingController);
export { MerchandisingController };
