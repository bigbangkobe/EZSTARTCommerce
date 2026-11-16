import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { parse, serialize } from 'cookie';
import type { ServerResponse } from 'node:http';
import { uuid, type ApiRequest } from '../identity/controller.js';
import { IdentityContracts } from '../identity/contracts.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { CartService } from './cart-service.js';
import { CheckoutService, type OrderBody, type QuoteBody } from './service.js';

const CART_COOKIE = 'ez_guest_cart';
const CSRF_COOKIE = 'ez_cart_csrf';
const CART_MAX_AGE = 30 * 86_400;

/**
 * 游客 cookie 的形状与后台会话一致（43 字符 base64url），但作用域完全不同：
 * 它只代表一个购物袋，永远不能读订单、顾客或后台资源。
 */
function cartToken(request: ApiRequest) {
  const value = parse(request.headers.cookie ?? '')[CART_COOKIE];
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AuthError(401, 'UNAUTHORIZED');
  return value;
}

/**
 * 双提交 CSRF：cookie 里的值与请求头必须一致。
 * 跨站请求能带上 cookie，但读不到值，也就伪造不出匹配的请求头。
 */
function assertCsrf(request: ApiRequest) {
  const expected = parse(request.headers.cookie ?? '')[CSRF_COOKIE];
  const supplied = request.headers['x-csrf-token'];
  if (!expected || typeof supplied !== 'string' || supplied.length !== 43 || expected.length !== 43) throw new AuthError(403, 'FORBIDDEN');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new AuthError(403, 'FORBIDDEN');
}

function cartCookies(token: string, csrfToken: string) {
  return [serialize(CART_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1', maxAge: CART_MAX_AGE }),
    serialize(CSRF_COOKIE, csrfToken, { httpOnly: false, secure: true, sameSite: 'lax', path: '/api/v1', maxAge: CART_MAX_AGE })];
}

@Controller('storefront/cart')
export class CartController extends ManagementHttp {
  private readonly schemas = new IdentityContracts();
  constructor(@Inject('CART') private readonly cart: CartService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private cartService() { if (!this.cart) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.cart; }

  @Post()
  async create(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    const result = await this.cartService().create(this.context(request));
    response.setHeader('Set-Cookie', cartCookies(result.token, result.csrfToken));
    this.send(response, request, 201, result.cart);
  }

  @Get()
  async get(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.cartService().get(cartToken(request)));
  }

  @Post('items')
  async add(@Body() body: { variantId: string; quantity: number }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    assertCsrf(request);
    this.schemas.assert('CartItemWriteRequest', body);
    this.send(response, request, 200, await this.cartService().addItem(cartToken(request), body, this.context(request)));
  }

  @Patch('items/:id')
  async update(@Param('id') id: string, @Body() body: { quantity: number }, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    assertCsrf(request);
    this.schemas.assert('CartItemUpdateRequest', body);
    this.send(response, request, 200, await this.cartService().updateItem(cartToken(request), uuid(id), body, this.context(request)));
  }

  @Delete('items/:id')
  async remove(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    assertCsrf(request);
    await this.cartService().removeItem(cartToken(request), uuid(id), this.context(request));
    this.send(response, request, 204, null);
  }
}

@Controller('storefront/checkout')
export class CheckoutController extends ManagementHttp {
  private readonly schemas = new IdentityContracts();
  constructor(@Inject('CHECKOUT') private readonly checkout: CheckoutService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private checkoutService() { if (!this.checkout) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.checkout; }

  @Post('quote')
  async quote(@Body() body: QuoteBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    assertCsrf(request);
    this.schemas.assert('CheckoutQuoteRequest', body);
    this.send(response, request, 200, await this.checkoutService().quote(cartToken(request), body, this.context(request)));
  }

  @Post('orders')
  async orders(@Body() body: OrderBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    assertCsrf(request);
    this.schemas.assert('CheckoutOrderRequest', body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') throw new AuthError(422, 'VALIDATION_ERROR');
    this.send(response, request, 201, await this.checkoutService().placeOrder(cartToken(request), key, body, this.context(request)));
  }
}
