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
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 付款后台（M08）。读接口只认会话；配置与收款登记要求 CSRF + Origin，
 * 登记另需 Idempotency-Key 与 If-Match：没有这两样就无法证明“记的是哪一版、哪一次请求”。
 */
let PaymentsController = class PaymentsController extends ManagementHttp {
    payments;
    constructor(payments, identity) {
        super(identity);
        this.payments = payments;
    }
    paymentsService() { if (!this.payments)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.payments; }
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
    async methods(request, response) {
        this.send(response, request, 200, await this.paymentsService().listMethods(cookie(request, 'ez_admin_session')));
    }
    async updateMethod(body, request, response) {
        await this.write(request, 'PaymentMethodPatchRequest', body);
        this.send(response, request, 200, await this.paymentsService().updateMethod(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), this.version(request), body, this.context(request)));
    }
    /** 测试连接：只验证凭据可用，不发起真实支付；结果写回 connectionStatus。 */
    async testConnection(providerCode, environment, request, response) {
        this.send(response, request, 200, await this.paymentsService().testConnection(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), providerCode, typeof environment === 'string' ? environment : 'production', this.context(request)));
    }
    async list(limit, cursor, status, orderId, providerCode, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.paymentsService().listPayments(cookie(request, 'ez_admin_session'), page.limit, page.cursor, { status: this.query(status), orderId: this.query(orderId), providerCode: this.query(providerCode) }));
    }
    async detail(id, request, response) {
        this.send(response, request, 200, await this.paymentsService().getPayment(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async record(id, body, request, response) {
        await this.write(request, 'OrderPaymentResultRequest', body);
        // 契约同时声明了 If-Match 与 body.expectedVersion：两者都表示“我看到的那一版”。
        // 头部是权威值（与 PATCH 一致的乐观锁语义），body 仅在未带头部时兜底。
        const version = header(request, 'if-match') ? this.version(request) : undefined;
        this.send(response, request, 200, await this.paymentsService().recordOrderPayment(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), version === undefined ? body : { ...body, expectedVersion: version }, this.context(request)));
    }
};
__decorate([
    Get('payment-methods'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "methods", null);
__decorate([
    Patch('payment-methods'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "updateMethod", null);
__decorate([
    Post('payment-methods/:providerCode/connection-test'),
    __param(0, Param('providerCode')),
    __param(1, Query('environment')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "testConnection", null);
__decorate([
    Get('payments'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('status')),
    __param(3, Query('orderId')),
    __param(4, Query('providerCode')),
    __param(5, Req()),
    __param(6, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "list", null);
__decorate([
    Get('payments/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "detail", null);
__decorate([
    Post('orders/:id/payment-result'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "record", null);
PaymentsController = __decorate([
    Controller('admin'),
    __param(0, Inject('PAYMENTS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], PaymentsController);
export { PaymentsController };
