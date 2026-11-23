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
import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { cookie } from './controller.js';
import { ManagementHttp } from './management-http.js';
/** 审计记录按设计只读：本控制器只暴露 GET，没有写入、修改或删除路由。 */
let AuditController = class AuditController extends ManagementHttp {
    constructor(identity) { super(identity); }
    async list(limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.service().listAuditLogs(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
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
], AuditController.prototype, "list", null);
AuditController = __decorate([
    Controller('admin/audit-logs'),
    __param(0, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object])
], AuditController);
export { AuditController };
