import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { PromotionsService } from './service.js';

/**
 * 优惠券后台（M11）。
 *
 * 读要 coupons.read；建、改、停用要 coupons.manage + CSRF + Origin；
 * 批量发放要 coupons.issue + CSRF + Origin + 发放幂等键，创建后须复核人数再确认发放。
 * 会员专属券的等级资格在报价时校验，顾客限额在会员场景走 memberId 摘要。
 */
@Controller('admin')
export class PromotionsController extends ManagementHttp {
  constructor(@Inject('PROMOTIONS') private readonly promotions: PromotionsService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private promotionsService() { if (!this.promotions) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.promotions; }

  private query(value: unknown, max = 80) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > max) throw new AuthError(422, 'VALIDATION_ERROR');
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  @Get('coupons')
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('q') q: unknown,
    @Query('status') status: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.promotionsService().list(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor, { q: this.query(q), status: this.query(status, 16) }));
  }

  @Post('coupons')
  async create(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'CouponWriteRequest', body);
    this.send(response, request, 201, await this.promotionsService().create(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Get('coupons/:id')
  async get(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.promotionsService().get(cookie(request, 'ez_admin_session'), id));
  }

  @Patch('coupons/:id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'CouponPatchRequest', body);
    this.send(response, request, 200, await this.promotionsService().update(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), id, this.version(request), body, this.context(request)));
  }

  @Get('coupons/:id/redemptions')
  async redemptions(@Param('id') id: string, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.promotionsService().redemptions(cookie(request, 'ez_admin_session'),
      id, page.limit, page.cursor));
  }

  @Post('coupons/:id/disable')
  async disable(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'ReasonRequest', body);
    const key = request.headers['idempotency-key'];
    this.send(response, request, 200, await this.promotionsService().disable(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), id, typeof key === 'string' ? key : undefined, body, this.context(request)));
  }

  @Post('coupon-batches')
  async createBatch(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'CouponBatchRequest', body);
    this.send(response, request, 201, await this.promotionsService().createBatch(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Post('coupon-batches/:id/issue')
  async issueBatch(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'CouponBatchIssueRequest', body);
    const key = request.headers['idempotency-key'];
    this.send(response, request, 202, await this.promotionsService().issueBatch(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), id, typeof key === 'string' ? key : undefined, body, this.context(request)));
  }
}
