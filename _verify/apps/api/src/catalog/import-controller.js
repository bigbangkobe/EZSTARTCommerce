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
import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 商品批量导入（M05）后台入口。
 * 写动作（创建/校验/执行/取消）要会话 + CSRF + Origin；读取任务与错误报告只要会话权限。
 * 契约见 packages/contracts/openapi.yaml 的 /admin/import-jobs。
 */
let ImportController = class ImportController extends ManagementHttp {
    imports;
    constructor(imports, identity) {
        super(identity);
        this.imports = imports;
    }
    importService() { if (!this.imports)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.imports; }
    /**
     * 导入文件的短时上传目标。与 /media/objects 同类的内部通道，不进 OpenAPI 业务契约
     * （业务契约描述的是任务与结果，不描述上传细节），权限仍是 catalog.import + CSRF + Origin。
     */
    async fileTarget(request, response) {
        await this.guardWrite(request);
        this.send(response, request, 201, await this.importService().createFileTarget(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token')));
    }
    async create(body, request, response) {
        await this.write(request, 'ImportCreateRequest', body);
        const key = header(request, 'idempotency-key') || undefined;
        this.send(response, request, 201, await this.importService().create(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), key, body, this.context(request)));
    }
    async get(id, request, response) {
        this.send(response, request, 200, await this.importService().get(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async validateJob(id, request, response) {
        await this.guardWrite(request);
        this.send(response, request, 200, await this.importService().validateJob(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.context(request)));
    }
    async execute(id, body, request, response) {
        await this.write(request, 'ImportExecuteRequest', body);
        const key = header(request, 'idempotency-key') || undefined;
        this.send(response, request, 202, await this.importService().execute(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), key, body, this.context(request)));
    }
    async cancel(id, body, request, response) {
        await this.guardWrite(request);
        const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : 'cancelled by admin';
        if (!reason.length)
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.send(response, request, 200, await this.importService().cancel(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), reason, this.context(request)));
    }
    async errorReport(id, request, response) {
        this.send(response, request, 200, await this.importService().errorReport(cookie(request, 'ez_admin_session'), uuid(id)));
    }
};
__decorate([
    Post('import-files'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], ImportController.prototype, "fileTarget", null);
__decorate([
    Post('import-jobs'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ImportController.prototype, "create", null);
__decorate([
    Get('import-jobs/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ImportController.prototype, "get", null);
__decorate([
    Post('import-jobs/:id/validate'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ImportController.prototype, "validateJob", null);
__decorate([
    Post('import-jobs/:id/execute'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ImportController.prototype, "execute", null);
__decorate([
    Post('import-jobs/:id/cancel'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ImportController.prototype, "cancel", null);
__decorate([
    Get('import-jobs/:id/error-report'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ImportController.prototype, "errorReport", null);
ImportController = __decorate([
    Controller('admin'),
    __param(0, Inject('IMPORT')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], ImportController);
export { ImportController };
