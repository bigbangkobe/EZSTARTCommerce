import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { PREVIEW_ROBOTS_HEADER, PREVIEW_TOKEN_PATTERN } from '../../../../packages/domain/src/preview.js';
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

  /**
   * 首页陈列：未发布时 404，前台据此退回主题默认布局（配置没做好不能把首页打空）。
   * 缓存 30 秒与重定向清单同档：陈列变更最多半分钟生效，但商品资格失效靠重新读取收敛。
   */
  @Get('merchandising/:pageKey')
  async merchandising(@Param('pageKey') pageKey: string, @Query('locale') locale: unknown,
    @Query('marketCode') marketCode: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(pageKey)) throw new AuthError(404, 'NOT_FOUND');
    response.setHeader('Cache-Control', 'public, max-age=30');
    this.send(response, request, 200, await this.front().merchandising(pageKey, text(locale, 10), text(marketCode, 8)));
  }

  @Get('pages')
  async pages(@Query('locale') locale: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.front().listPages(text(locale, 10)));
  }

  @Get('pages/:slug')
  async page(@Param('slug') slug: string, @Query('locale') locale: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    if (!/^[^\s/]{1,180}$/.test(slug)) throw new AuthError(422, 'VALIDATION_ERROR');
    this.send(response, request, 200, await this.front().getPage(slug, text(locale, 10)));
  }

  /**
   * 预览外链：草稿内容只在带有效 token 时下发，且明确禁止缓存与收录。
   * 这里不写埋点、不改发布标记：预览是只读检查，不能污染线上统计。
   */
  @Get('preview/:token')
  async preview(@Param('token') token: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    if (!PREVIEW_TOKEN_PATTERN.test(token)) throw new AuthError(404, 'NOT_FOUND');
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('X-Robots-Tag', PREVIEW_ROBOTS_HEADER);
    this.send(response, request, 200, await this.front().getPreview(token));
  }

  /** 重定向清单：前台入口层缓存 30 秒后在本地匹配，命中即 301，不再回源。 */
  @Get('redirects')
  async redirects(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    response.setHeader('Cache-Control', 'public, max-age=30');
    this.send(response, request, 200, await this.front().listRedirects());
  }

  /** 旧地址查询：只回最终目标，前台据此发 301；没有记录时 redirect=null。 */
  @Get('redirect')
  async redirect(@Query('path') path: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const value = text(path, 300);
    if (!value) throw new AuthError(422, 'VALIDATION_ERROR');
    this.send(response, request, 200, await this.front().redirect(value));
  }
}
