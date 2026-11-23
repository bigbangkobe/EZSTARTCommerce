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
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 售后与退款后台（M16）。读接口只认会话；所有写操作要求 CSRF + Origin，
 * 案件动作与退款动作都带 Idempotency-Key：金额与库存不能因为网络重试而做两次。
 */
let AfterSalesController = class AfterSalesController extends ManagementHttp {
    afterSales;
    constructor(afterSales, identity) {
        super(identity);
        this.afterSales = afterSales;
    }
    afterSalesService() { if (!this.afterSales)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.afterSales; }
    idempotency(request) {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string')
            throw new AuthError(422, 'VALIDATION_ERROR');
        return key;
    }
    query(value) {
        if (value === undefined)
            return null;
        if (typeof value !== 'string' || value.length > 200)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    async list(limit, cursor, status, caseType, orderId, q, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.afterSalesService().list(cookie(request, 'ez_admin_session'), page.limit, page.cursor, { status: this.query(status), caseType: this.query(caseType),
            orderId: this.query(orderId), q: this.query(q) }));
    }
    async create(body, request, response) {
        await this.write(request, 'AfterSalesCreateRequest', body);
        this.send(response, request, 201, await this.afterSalesService().create(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), this.idempotency(request), body, this.context(request)));
    }
    async detail(id, request, response) {
        this.send(response, request, 200, await this.afterSalesService().get(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async approve(id, body, request, response) {
        await this.write(request, 'ReasonRequest', body);
        this.send(response, request, 200, await this.afterSalesService().approve(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), this.version(request), body, this.context(request)));
    }
    async reject(id, body, request, response) {
        await this.write(request, 'ReasonRequest', body);
        this.send(response, request, 200, await this.afterSalesService().reject(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async registerReturn(id, body, request, response) {
        await this.write(request, 'ReturnShipmentRequest', body);
        this.send(response, request, 201, await this.afterSalesService().registerReturn(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async receiveReturn(id, body, request, response) {
        await this.write(request, 'ReturnReceiptRequest', body);
        this.send(response, request, 200, await this.afterSalesService().receiveReturn(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async inspect(id, body, request, response) {
        await this.write(request, 'ReturnInspectionRequest', body);
        this.send(response, request, 200, await this.afterSalesService().inspect(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async refund(id, body, request, response) {
        await this.write(request, 'AfterSalesRefundRequest', body);
        this.send(response, request, 201, await this.afterSalesService().createCaseRefund(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async close(id, body, request, response) {
        await this.write(request, 'ReasonRequest', body);
        this.send(response, request, 200, await this.afterSalesService().close(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), this.version(request), body, this.context(request)));
    }
    // ---- 退款 -------------------------------------------------------------------
    async listRefunds(limit, cursor, status, orderId, caseId, paymentId, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.afterSalesService().listRefunds(cookie(request, 'ez_admin_session'), page.limit, page.cursor, { status: this.query(status), orderId: this.query(orderId),
            caseId: this.query(caseId), paymentId: this.query(paymentId) }));
    }
    async createRefund(body, request, response) {
        await this.write(request, 'RefundCreateRequest', body);
        this.send(response, request, 201, await this.afterSalesService().createRefund(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), this.idempotency(request), body, this.context(request)));
    }
    async getRefund(id, request, response) {
        this.send(response, request, 200, await this.afterSalesService().getRefund(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async approveRefund(id, body, request, response) {
        await this.write(request, 'ReasonRequest', body);
        this.send(response, request, 200, await this.afterSalesService().approveRefund(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async rejectRefund(id, body, request, response) {
        await this.write(request, 'ReasonRequest', body);
        this.send(response, request, 200, await this.afterSalesService().rejectRefund(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async executeRefund(id, body, request, response) {
        await this.write(request, 'RefundExecuteRequest', body);
        this.send(response, request, 200, await this.afterSalesService().executeRefund(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
};
__decorate([
    Get('after-sales'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('status')),
    __param(3, Query('caseType')),
    __param(4, Query('orderId')),
    __param(5, Query('q')),
    __param(6, Req()),
    __param(7, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "list", null);
__decorate([
    Post('after-sales'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "create", null);
__decorate([
    Get('after-sales/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "detail", null);
__decorate([
    Post('after-sales/:id/approve'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "approve", null);
__decorate([
    Post('after-sales/:id/reject'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "reject", null);
__decorate([
    Post('after-sales/:id/return-shipment'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "registerReturn", null);
__decorate([
    Post('after-sales/:id/receive-return'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "receiveReturn", null);
__decorate([
    Post('after-sales/:id/inspect'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "inspect", null);
__decorate([
    Post('after-sales/:id/refund'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "refund", null);
__decorate([
    Post('after-sales/:id/close'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "close", null);
__decorate([
    Get('refunds'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('status')),
    __param(3, Query('orderId')),
    __param(4, Query('caseId')),
    __param(5, Query('paymentId')),
    __param(6, Req()),
    __param(7, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "listRefunds", null);
__decorate([
    Post('refunds'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "createRefund", null);
__decorate([
    Get('refunds/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "getRefund", null);
__decorate([
    Post('refunds/:id/approve'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "approveRefund", null);
__decorate([
    Post('refunds/:id/reject'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "rejectRefund", null);
__decorate([
    Post('refunds/:id/execute'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AfterSalesController.prototype, "executeRefund", null);
AfterSalesController = __decorate([
    Controller('admin'),
    __param(0, Inject('AFTERSALES')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], AfterSalesController);
export { AfterSalesController };
