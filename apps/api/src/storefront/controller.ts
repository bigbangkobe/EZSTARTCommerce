import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { StorefrontService } from './service.js';

/** 查询参数一律当作不可信输入：长度先收敛，语义再交给服务层判断。 */
function text(value: unknown, max: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) throw new AuthError(422, 'VALIDATION_ERROR');
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

@Controller('storefront')
export class StorefrontController extends ManagementHttp {
  constructor(@Inject('STOREFRONT') private readonly storefront: StorefrontService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private front() { if (!this.storefront) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.storefront; }

  @Get('config')
  async config(@Query('locale') locale: unknown, @Query('marketCode') marketCode: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.front().config(text(locale, 10), text(marketCode, 8)));
  }

  @Get('products')
  async products(@Query('locale') locale: unknown, @Query('marketCode') marketCode: unknown, @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown, @Query('q') query: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.front().listProducts(text(locale, 10), text(marketCode, 8),
      page.limit, page.cursor, text(query, 200)));
  }

  @Get('products/:slug')
  async product(@Param('slug') slug: string, @Query('locale') locale: unknown, @Query('marketCode') marketCode: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    if (!/^[^\s/]{1,180}$/.test(slug)) throw new AuthError(422, 'VALIDATION_ERROR');
    this.send(response, request, 200, await this.front().getProduct(slug, text(locale, 10), text(marketCode, 8)));
  }

  @Get('categories')
  async categories(@Query('locale') locale: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.front().listCategories(text(locale, 10)));
  }
}
