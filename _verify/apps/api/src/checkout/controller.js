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
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { parse, serialize } from 'cookie';
import { uuid } from '../identity/controller.js';
import { IdentityContracts } from '../identity/contracts.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
const CART_COOKIE = 'ez_guest_cart';
const MEMBER_COOKIE = 'ez_member_session';
const CSRF_COOKIE = 'ez_cart_csrf';
const CART_MAX_AGE = 30 * 86_400;
/**
 * 游客 cookie 的形状与后台会话一致（43 字符 base64url），但作用域完全不同：
 * 它只代表一个购物袋，永远不能读订单、顾客或后台资源。
 */
function cartToken(request) {
    const value = parse(request.headers.cookie ?? '')[CART_COOKIE];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
        throw new AuthError(401, 'UNAUTHORIZED');
    return value;
}
/**
 * 双提交 CSRF：cookie 里的值与请求头必须一致。
 * 跨站请求能带上 cookie，但读不到值，也就伪造不出匹配的请求头。
 */
function assertCsrf(request) {
    const expected = parse(request.headers.cookie ?? '')[CSRF_COOKIE];
    const supplied = request.headers['x-csrf-token'];
    if (!expected || typeof supplied !== 'string' || supplied.length !== 43 || expected.length !== 43)
        throw new AuthError(403, 'FORBIDDEN');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)))
        throw new AuthError(403, 'FORBIDDEN');
}
/**
 * 会员 cookie 是**可选**的：登录了就把订单归到会员，没登录照样能下单。
 * 形状不对一律当没有——结账不能因为一个坏 cookie 而失败。
 */
function optionalMemberToken(request) {
    const value = parse(request.headers.cookie ?? '')[MEMBER_COOKIE];
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function cartCookies(token, csrfToken) {
    return [serialize(CART_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1', maxAge: CART_MAX_AGE }),
        serialize(CSRF_COOKIE, csrfToken, { httpOnly: false, secure: true, sameSite: 'lax', path: '/api/v1', maxAge: CART_MAX_AGE })];
}
let CartController = class CartController extends ManagementHttp {
    cart;
    schemas = new IdentityContracts();
    constructor(cart, identity) {
        super(identity);
        this.cart = cart;
    }
    cartService() { if (!this.cart)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.cart; }
    async create(request, response) {
        const result = await this.cartService().create(this.context(request));
        response.setHeader('Set-Cookie', cartCookies(result.token, result.csrfToken));
        this.send(response, request, 201, result.cart);
    }
    async get(request, response) {
        this.send(response, request, 200, await this.cartService().get(cartToken(request)));
    }
    async add(body, request, response) {
        assertCsrf(request);
        this.schemas.assert('CartItemWriteRequest', body);
        this.send(response, request, 200, await this.cartService().addItem(cartToken(request), body, this.context(request)));
    }
    async update(id, body, request, response) {
        assertCsrf(request);
        this.schemas.assert('CartItemUpdateRequest', body);
        this.send(response, request, 200, await this.cartService().updateItem(cartToken(request), uuid(id), body, this.context(request)));
    }
    async remove(id, request, response) {
        assertCsrf(request);
        await this.cartService().removeItem(cartToken(request), uuid(id), this.context(request));
        this.send(response, request, 204, null);
    }
};
__decorate([
    Post(),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], CartController.prototype, "create", null);
__decorate([
    Get(),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], CartController.prototype, "get", null);
__decorate([
    Post('items'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CartController.prototype, "add", null);
__decorate([
    Patch('items/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CartController.prototype, "update", null);
__decorate([
    Delete('items/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], CartController.prototype, "remove", null);
CartController = __decorate([
    Controller('storefront/cart'),
    __param(0, Inject('CART')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], CartController);
export { CartController };
let CheckoutController = class CheckoutController extends ManagementHttp {
    checkout;
    schemas = new IdentityContracts();
    constructor(checkout, identity) {
        super(identity);
        this.checkout = checkout;
    }
    checkoutService() { if (!this.checkout)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.checkout; }
    async shippingMethods(countryCode, regionCode, locale, request, response) {
        this.send(response, request, 200, await this.checkoutService()
            .shippingMethods(cartToken(request), { countryCode, regionCode, locale }, this.context(request)));
    }
    async quote(body, request, response) {
        assertCsrf(request);
        this.schemas.assert('CheckoutQuoteRequest', body);
        this.send(response, request, 200, await this.checkoutService().quote(cartToken(request), body, this.context(request), optionalMemberToken(request)));
    }
    async orders(body, request, response) {
        assertCsrf(request);
        this.schemas.assert('CheckoutOrderRequest', body);
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string')
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.send(response, request, 201, await this.checkoutService().placeOrder(cartToken(request), key, body, this.context(request), optionalMemberToken(request)));
    }
    /** 下单后发起线上支付：返回收银台跳转地址。COD 订单调用会明确拒绝。 */
    async pay(orderId, request, response) {
        assertCsrf(request);
        this.send(response, request, 200, await this.checkoutService()
            .startOnlinePayment(orderId, cartToken(request), this.context(request)));
    }
};
__decorate([
    Get('shipping-methods'),
    __param(0, Query('countryCode')),
    __param(1, Query('regionCode')),
    __param(2, Query('locale')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CheckoutController.prototype, "shippingMethods", null);
__decorate([
    Post('quote'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CheckoutController.prototype, "quote", null);
__decorate([
    Post('orders'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CheckoutController.prototype, "orders", null);
__decorate([
    Post('orders/:orderId/pay'),
    __param(0, Param('orderId')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], CheckoutController.prototype, "pay", null);
CheckoutController = __decorate([
    Controller('storefront/checkout'),
    __param(0, Inject('CHECKOUT')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], CheckoutController);
export { CheckoutController };
