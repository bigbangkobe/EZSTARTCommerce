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
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 后台专题接口（M04 第五批）。
 * 权限沿用内容域（content.read / content.write）：专题是策展内容，不是商品目录本身。
 */
let CollectionsController = class CollectionsController extends ManagementHttp {
    collections;
    constructor(collections, identity) {
        super(identity);
        this.collections = collections;
    }
    serviceOrFail() { if (!this.collections)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.collections; }
    async list(request, response) {
        this.send(response, request, 200, await this.serviceOrFail().list(cookie(request, 'ez_admin_session')));
    }
    async get(id, request, response) {
        this.send(response, request, 200, await this.serviceOrFail().get(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async create(body, request, response) {
        await this.write(request, 'CollectionWriteRequest', body);
        this.send(response, request, 201, await this.serviceOrFail().create(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async update(id, body, request, response) {
        await this.write(request, 'CollectionPatchRequest', body);
        this.send(response, request, 200, await this.serviceOrFail().update(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    async remove(id, request, response) {
        await this.guardWrite(request);
        await this.serviceOrFail().remove(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.context(request));
        this.send(response, request, 204, null);
    }
};
__decorate([
    Get('collections'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], CollectionsController.prototype, "list", null);
__decorate([
    Get('collections/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], CollectionsController.prototype, "get", null);
__decorate([
    Post('collections'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CollectionsController.prototype, "create", null);
__decorate([
    Patch('collections/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CollectionsController.prototype, "update", null);
__decorate([
    Delete('collections/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], CollectionsController.prototype, "remove", null);
CollectionsController = __decorate([
    Controller('admin'),
    __param(0, Inject('COLLECTIONS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], CollectionsController);
export { CollectionsController };
