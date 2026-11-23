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
import { Body, Controller, Get, Inject, Post, Put, Req, Res } from '@nestjs/common';
import { cookie, header } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
let ThemeController = class ThemeController extends ManagementHttp {
    theme;
    constructor(theme, identity) {
        super(identity);
        this.theme = theme;
    }
    themes() { if (!this.theme)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.theme; }
    async get(request, response) {
        this.send(response, request, 200, await this.themes().get(cookie(request, 'ez_admin_session')));
    }
    /** 保存草稿：expectedVersion=1 表示还没有草稿。保存不改变线上主题。 */
    async save(body, request, response) {
        await this.write(request, 'ThemeWriteRequest', body);
        this.send(response, request, 200, await this.themes().save(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async publish(body, request, response) {
        await this.write(request, 'ThemePublishRequest', body);
        this.send(response, request, 200, await this.themes().publish(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async unpublish(body, request, response) {
        await this.write(request, 'ThemeWithdrawRequest', body);
        this.send(response, request, 200, await this.themes().unpublish(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async rollback(body, request, response) {
        await this.write(request, 'ThemeRollbackRequest', body);
        this.send(response, request, 200, await this.themes().rollback(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
};
__decorate([
    Get(),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], ThemeController.prototype, "get", null);
__decorate([
    Put(),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ThemeController.prototype, "save", null);
__decorate([
    Post('publish'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ThemeController.prototype, "publish", null);
__decorate([
    Post('unpublish'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ThemeController.prototype, "unpublish", null);
__decorate([
    Post('rollback'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ThemeController.prototype, "rollback", null);
ThemeController = __decorate([
    Controller('admin/theme'),
    __param(0, Inject('THEME')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], ThemeController);
export { ThemeController };
