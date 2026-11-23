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
import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { parse } from 'cookie';
import { IdentityContracts } from '../identity/contracts.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
const CSRF_COOKIE = 'ez_cart_csrf';
const CART_COOKIE = 'ez_guest_cart';
/** 双提交 CSRF：与结账端点同一枚可读 cookie，跨站拿不到值就伪造不出匹配的头。 */
function assertCsrf(request) {
    const expected = parse(request.headers.cookie ?? '')[CSRF_COOKIE];
    const supplied = request.headers['x-csrf-token'];
    if (!expected || typeof supplied !== 'string' || supplied.length !== 43 || expected.length !== 43)
        throw new AuthError(403, 'FORBIDDEN');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)))
        throw new AuthError(403, 'FORBIDDEN');
}
function optionalCartToken(request) {
    const value = parse(request.headers.cookie ?? '')[CART_COOKIE];
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
/**
 * 第一方匿名事件采集（M14 第二批）。公开端点：无管理员会话、无会员身份。
 * 只收白名单事件（不含 purchase），受 CSRF + IP 限流 + 契约 + 店铺开关 + 同意状态约束。
 */
let AnalyticsController = class AnalyticsController extends ManagementHttp {
    analytics;
    schemas = new IdentityContracts();
    constructor(analytics, identity) {
        super(identity);
        this.analytics = analytics;
    }
    analyticsService() { if (!this.analytics)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.analytics; }
    async ingest(body, request, response) {
        assertCsrf(request);
        this.schemas.assert('AnalyticsEventBatch', body);
        const data = await this.analyticsService().ingest(optionalCartToken(request), body, this.context(request));
        this.send(response, request, 202, data);
    }
};
__decorate([
    Post('events'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], AnalyticsController.prototype, "ingest", null);
AnalyticsController = __decorate([
    Controller('storefront/analytics'),
    __param(0, Inject('ANALYTICS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], AnalyticsController);
export { AnalyticsController };
