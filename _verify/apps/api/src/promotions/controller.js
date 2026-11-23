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
import { cookie, header } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 优惠券后台（M11）。
 *
 * 读要 coupons.read；建、改、停用要 coupons.manage + CSRF + Origin；
 * 批量发放要 coupons.issue + CSRF + Origin + 发放幂等键，创建后须复核人数再确认发放。
 * 会员专属券的等级资格在报价时校验，顾客限额在会员场景走 memberId 摘要。
 */
let PromotionsController = class PromotionsController extends ManagementHttp {
    promotions;
    constructor(promotions, identity) {
        super(identity);
        this.promotions = promotions;
    }
    promotionsService() { if (!this.promotions)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.promotions; }
    query(value, max = 80) {
        if (value === undefined)
            return null;
        if (typeof value !== 'string' || value.length > max)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    async list(limit, cursor, q, status, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.promotionsService().list(cookie(request, 'ez_admin_session'), page.limit, page.cursor, { q: this.query(q), status: this.query(status, 16) }));
    }
    async create(body, request, response) {
        await this.write(request, 'CouponWriteRequest', body);
        this.send(response, request, 201, await this.promotionsService().create(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async get(id, request, response) {
        this.send(response, request, 200, await this.promotionsService().get(cookie(request, 'ez_admin_session'), id));
    }
    async update(id, body, request, response) {
        await this.write(request, 'CouponPatchRequest', body);
        this.send(response, request, 200, await this.promotionsService().update(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), id, this.version(request), body, this.context(request)));
    }
    async redemptions(id, limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.promotionsService().redemptions(cookie(request, 'ez_admin_session'), id, page.limit, page.cursor));
    }
    async disable(id, body, request, response) {
        await this.write(request, 'ReasonRequest', body);
        const key = request.headers['idempotency-key'];
        this.send(response, request, 200, await this.promotionsService().disable(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), id, typeof key === 'string' ? key : undefined, body, this.context(request)));
    }
    async createBatch(body, request, response) {
        await this.write(request, 'CouponBatchRequest', body);
        this.send(response, request, 201, await this.promotionsService().createBatch(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async issueBatch(id, body, request, response) {
        await this.write(request, 'CouponBatchIssueRequest', body);
        const key = request.headers['idempotency-key'];
        this.send(response, request, 202, await this.promotionsService().issueBatch(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), id, typeof key === 'string' ? key : undefined, body, this.context(request)));
    }
};
__decorate([
    Get('coupons'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('q')),
    __param(3, Query('status')),
    __param(4, Req()),
    __param(5, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PromotionsController.prototype, "list", null);
__decorate([
    Post('coupons'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PromotionsController.prototype, "create", null);
__decorate([
    Get('coupons/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], PromotionsController.prototype, "get", null);
__decorate([
    Patch('coupons/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PromotionsController.prototype, "update", null);
__decorate([
    Get('coupons/:id/redemptions'),
    __param(0, Param('id')),
    __param(1, Query('limit')),
    __param(2, Query('cursor')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PromotionsController.prototype, "redemptions", null);
__decorate([
    Post('coupons/:id/disable'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PromotionsController.prototype, "disable", null);
__decorate([
    Post('coupon-batches'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PromotionsController.prototype, "createBatch", null);
__decorate([
    Post('coupon-batches/:id/issue'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PromotionsController.prototype, "issueBatch", null);
PromotionsController = __decorate([
    Controller('admin'),
    __param(0, Inject('PROMOTIONS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], PromotionsController);
export { PromotionsController };
