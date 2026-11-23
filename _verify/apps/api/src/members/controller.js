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
import { parse, serialize } from 'cookie';
import { header, uuid } from '../identity/controller.js';
import { IdentityContracts } from '../identity/contracts.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
const MEMBER_COOKIE = 'ez_member_session';
const SESSION_SECONDS = 43_200;
/**
 * 会员 cookie 与游客购物袋同形制（43 字符 base64url），但作用域完全不同：
 * 它只代表一个已验证会员，永远不能读后台资源，也不能替代访客结账。
 */
function memberToken(request) {
    const value = parse(request.headers.cookie ?? '')[MEMBER_COOKIE];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
        throw new AuthError(401, 'UNAUTHORIZED');
    return value;
}
function sessionCookie(token, maxAge) {
    return serialize(MEMBER_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1', maxAge });
}
let MemberController = class MemberController extends ManagementHttp {
    members;
    loyalty;
    schemas = new IdentityContracts();
    constructor(members, loyalty, identity) {
        super(identity);
        this.members = members;
        this.loyalty = loyalty;
    }
    membersService() { if (!this.members)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.members; }
    async requestOtp(body, request, response) {
        this.schemas.assert('OtpRequest', body);
        this.send(response, request, 202, await this.membersService().requestOtp(body, this.context(request)));
    }
    /** 验证成功才发 cookie；响应里的 csrfToken 由页面保存在内存中，用于登出。 */
    async verify(body, request, response) {
        this.schemas.assert('OtpVerifyRequest', body);
        const result = await this.membersService().verifyOtp(body, this.context(request));
        response.setHeader('Set-Cookie', sessionCookie(result.token, SESSION_SECONDS));
        this.send(response, request, 200, result.data);
    }
    async logout(request, response) {
        const token = memberToken(request);
        const supplied = header(request, 'x-csrf-token');
        if (supplied.length !== 64)
            throw new AuthError(403, 'FORBIDDEN');
        await this.membersService().logout(token, supplied);
        response.setHeader('Set-Cookie', sessionCookie('', 0));
        this.send(response, request, 204, null);
    }
    async profile(request, response) {
        this.send(response, request, 200, await this.membersService().profile(memberToken(request)));
    }
    async orders(limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.membersService().memberOrders(memberToken(request), page.limit, page.cursor));
    }
    /** 会员只看自己的账：余额 + 最近流水，金额口径与后台一致。 */
    async points(limit, cursor, request, response) {
        if (!this.loyalty)
            throw new AuthError(503, 'SERVICE_NOT_READY');
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.loyalty.memberPoints(memberToken(request), page.limit, page.cursor));
    }
};
__decorate([
    Post('otp/request'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MemberController.prototype, "requestOtp", null);
__decorate([
    Post('otp/verify'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MemberController.prototype, "verify", null);
__decorate([
    Post('logout'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], MemberController.prototype, "logout", null);
__decorate([
    Get('profile'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], MemberController.prototype, "profile", null);
__decorate([
    Get('orders'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MemberController.prototype, "orders", null);
__decorate([
    Get('points'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MemberController.prototype, "points", null);
MemberController = __decorate([
    Controller('storefront/member'),
    __param(0, Inject('MEMBERS')),
    __param(1, Inject('LOYALTY')),
    __param(2, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object, Object])
], MemberController);
export { MemberController };
/**
 * 后台顾客与会员（M10）。
 *
 * 读要 customers.read_masked / members.manage；写要 customers.manage / members.manage、
 * CSRF、Origin 与 If-Match。完整邮箱、电话与内部备注只在拥有 customers.read_pii 时可见。
 */
let CustomersController = class CustomersController extends ManagementHttp {
    members;
    loyalty;
    constructor(members, loyalty, identity) {
        super(identity);
        this.members = members;
        this.loyalty = loyalty;
    }
    membersService() { if (!this.members)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.members; }
    query(value, max = 80) {
        if (value === undefined)
            return null;
        if (typeof value !== 'string' || value.length > max)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    async list(limit, cursor, q, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.membersService().listCustomers(this.cookieSession(request), page.limit, page.cursor, this.query(q)));
    }
    async create(body, request, response) {
        await this.write(request, 'CustomerWriteRequest', body);
        this.send(response, request, 201, await this.membersService().createCustomer(this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async get(id, request, response) {
        this.send(response, request, 200, await this.membersService().getCustomer(this.cookieSession(request), uuid(id)));
    }
    async update(id, body, request, response) {
        await this.write(request, 'CustomerWriteRequest', body);
        this.send(response, request, 200, await this.membersService().updateCustomer(this.cookieSession(request), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    async members_(limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.membersService().listMembers(this.cookieSession(request), page.limit, page.cursor));
    }
    async createMember(body, request, response) {
        await this.write(request, 'MemberWriteRequest', body);
        this.send(response, request, 201, await this.membersService().createMember(this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async updateMember(id, body, request, response) {
        await this.write(request, 'MemberPatchRequest', body);
        this.send(response, request, 200, await this.membersService().updateMember(this.cookieSession(request), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    async loyalty_(request, response) {
        this.send(response, request, 200, await this.loyaltyService().adminOverview(this.cookieSession(request)));
    }
    async updateLoyaltySettings(body, request, response) {
        await this.write(request, 'LoyaltySettingPatchRequest', body);
        this.send(response, request, 200, await this.loyaltyService().updateSettings(this.cookieSession(request), header(request, 'x-csrf-token'), this.version(request), body, this.context(request)));
    }
    async createTier(body, request, response) {
        await this.write(request, 'MembershipTierWriteRequest', body);
        this.send(response, request, 201, await this.loyaltyService().createTier(this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async updateTier(id, body, request, response) {
        await this.write(request, 'MembershipTierPatchRequest', body);
        this.send(response, request, 200, await this.loyaltyService().updateTier(this.cookieSession(request), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    /** 后台看账：余额 + 最近流水。读只要 members.manage，改才要 points.adjust。 */
    async memberPointsAdmin(id, limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.loyaltyService().adminMemberPoints(this.cookieSession(request), uuid(id), page.limit, page.cursor));
    }
    /** 人工调整必须带幂等键：重试同一笔不会变成两次加减。 */
    async adjustPoints(id, body, request, response) {
        await this.write(request, 'PointsAdjustmentRequest', body);
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string')
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.send(response, request, 201, await this.loyaltyService().adjustPoints(this.cookieSession(request), header(request, 'x-csrf-token'), uuid(id), key, body, this.context(request)));
    }
    loyaltyService() { if (!this.loyalty)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.loyalty; }
    /** 后台会话 cookie 名与身份模块一致；这里只取原文，校验仍由 withPermission 完成。 */
    cookieSession(request) {
        const value = parse(request.headers.cookie ?? '')['ez_admin_session'];
        if (!value || value.length !== 43)
            throw new AuthError(401, 'UNAUTHORIZED');
        return value;
    }
};
__decorate([
    Get('customers'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('q')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "list", null);
__decorate([
    Post('customers'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "create", null);
__decorate([
    Get('customers/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "get", null);
__decorate([
    Patch('customers/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "update", null);
__decorate([
    Get('members'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "members_", null);
__decorate([
    Post('members'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "createMember", null);
__decorate([
    Patch('members/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "updateMember", null);
__decorate([
    Get('loyalty'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "loyalty_", null);
__decorate([
    Patch('loyalty/settings'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "updateLoyaltySettings", null);
__decorate([
    Post('loyalty/tiers'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "createTier", null);
__decorate([
    Patch('loyalty/tiers/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "updateTier", null);
__decorate([
    Get('members/:id/points'),
    __param(0, Param('id')),
    __param(1, Query('limit')),
    __param(2, Query('cursor')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "memberPointsAdmin", null);
__decorate([
    Post('members/:id/points-adjustments'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CustomersController.prototype, "adjustPoints", null);
CustomersController = __decorate([
    Controller('admin'),
    __param(0, Inject('MEMBERS')),
    __param(1, Inject('LOYALTY')),
    __param(2, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object, Object])
], CustomersController);
export { CustomersController };
