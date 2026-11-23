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
import { cookie, header, uuid } from './controller.js';
import { ManagementHttp } from './management-http.js';
let RolesController = class RolesController extends ManagementHttp {
    constructor(identity) { super(identity); }
    async list(limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.service().listRoles(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
    }
    async detail(id, request, response) {
        this.send(response, request, 200, await this.service().getRole(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async create(body, request, response) {
        const service = await this.write(request, 'RoleWriteRequest', body);
        this.send(response, request, 201, await service.writeRole(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), null, null, body, this.context(request)));
    }
    async update(id, body, request, response) {
        const service = await this.write(request, 'RolePatchRequest', body);
        this.send(response, request, 200, await service.writeRole(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
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
], RolesController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], RolesController.prototype, "detail", null);
__decorate([
    Post(),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], RolesController.prototype, "create", null);
__decorate([
    Patch(':id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], RolesController.prototype, "update", null);
RolesController = __decorate([
    Controller('admin/roles'),
    __param(0, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object])
], RolesController);
export { RolesController };
