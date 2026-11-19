import { Body, Controller, Get, Inject, Param, Post, Patch, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { MerchandisingService, type LayoutBody, type LayoutPublishBody } from './service.js';

@Controller('admin/merchandising')
export class MerchandisingController extends ManagementHttp {
  constructor(@Inject('MERCHANDISING') private readonly merchandising: MerchandisingService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private layouts() { if (!this.merchandising) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.merchandising; }

  /** 商品选择器：不合格商品带原因返回，后台据此禁用选项而不是等保存才报错。 */
  @Get('products')
  async products(@Query('q') query: unknown, @Query('limit') limit: unknown, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    const page = this.pagination(limit, undefined);
    this.send(response, request, 200, await this.layouts().products(cookie(request, 'ez_admin_session'),
      typeof query === 'string' && query.trim() ? query.trim().slice(0, 200) : null, page.limit));
  }

  @Get(':pageKey')
  async layout(@Param('pageKey') pageKey: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.layouts().get(cookie(request, 'ez_admin_session'), pageKey));
  }

  /** 保存草稿：expectedVersion=0 表示还没建过。保存不改线上快照。 */
  @Patch(':pageKey')
  async save(@Param('pageKey') pageKey: string, @Body() body: LayoutBody,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'MerchandisingWriteRequest', body);
    this.send(response, request, 200, await this.layouts().save(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), pageKey, body, this.context(request)));
  }

  @Post(':pageKey/publish')
  async publish(@Param('pageKey') pageKey: string, @Body() body: LayoutPublishBody,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'MerchandisingPublishRequest', body);
    this.send(response, request, 200, await this.layouts().publish(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), pageKey, body, this.context(request)));
  }

  @Post(':pageKey/unpublish')
  async unpublish(@Param('pageKey') pageKey: string, @Body() body: { reason: string; expectedVersion: number },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'MerchandisingWithdrawRequest', body);
    this.send(response, request, 200, await this.layouts().unpublish(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), pageKey, body, this.context(request)));
  }
}
