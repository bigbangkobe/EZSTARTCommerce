import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { AfterSalesService, type CreateCaseBody, type CreateRefundBody } from './service.js';

/**
 * 售后与退款后台（M16）。读接口只认会话；所有写操作要求 CSRF + Origin，
 * 案件动作与退款动作都带 Idempotency-Key：金额与库存不能因为网络重试而做两次。
 */
@Controller('admin')
export class AfterSalesController extends ManagementHttp {
  constructor(@Inject('AFTERSALES') private readonly afterSales: AfterSalesService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private afterSalesService() { if (!this.afterSales) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.afterSales; }

  private idempotency(request: ApiRequest) {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') throw new AuthError(422, 'VALIDATION_ERROR');
    return key;
  }

  private query(value: unknown) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > 200) throw new AuthError(422, 'VALIDATION_ERROR');
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  @Get('after-sales')
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('status') status: unknown,
    @Query('caseType') caseType: unknown, @Query('orderId') orderId: unknown, @Query('q') q: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.afterSalesService().list(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor, { status: this.query(status), caseType: this.query(caseType),
        orderId: this.query(orderId), q: this.query(q) }));
  }

  @Post('after-sales')
  async create(@Body() body: CreateCaseBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'AfterSalesCreateRequest', body);
    this.send(response, request, 201, await this.afterSalesService().create(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), this.idempotency(request), body, this.context(request)));
  }

  @Get('after-sales/:id')
  async detail(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.afterSalesService().get(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('after-sales/:id/approve')
  async approve(@Param('id') id: string, @Body() body: { reason: string; reasonCode?: string | null },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReasonRequest', body);
    this.send(response, request, 200, await this.afterSalesService().approve(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), this.version(request), body,
      this.context(request)));
  }

  @Post('after-sales/:id/reject')
  async reject(@Param('id') id: string, @Body() body: { reason: string; reasonCode?: string | null },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReasonRequest', body);
    this.send(response, request, 200, await this.afterSalesService().reject(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('after-sales/:id/return-shipment')
  async registerReturn(@Param('id') id: string, @Body() body: Record<string, unknown>,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReturnShipmentRequest', body);
    this.send(response, request, 201, await this.afterSalesService().registerReturn(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('after-sales/:id/receive-return')
  async receiveReturn(@Param('id') id: string, @Body() body: Record<string, unknown>,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReturnReceiptRequest', body);
    this.send(response, request, 200, await this.afterSalesService().receiveReturn(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('after-sales/:id/inspect')
  async inspect(@Param('id') id: string, @Body() body: Record<string, unknown>,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReturnInspectionRequest', body);
    this.send(response, request, 200, await this.afterSalesService().inspect(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('after-sales/:id/refund')
  async refund(@Param('id') id: string, @Body() body: Record<string, unknown>,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'AfterSalesRefundRequest', body);
    this.send(response, request, 201, await this.afterSalesService().createCaseRefund(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('after-sales/:id/close')
  async close(@Param('id') id: string, @Body() body: { reason: string; reasonCode?: string | null },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReasonRequest', body);
    this.send(response, request, 200, await this.afterSalesService().close(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), this.version(request), body,
      this.context(request)));
  }

  // ---- 退款 -------------------------------------------------------------------

  @Get('refunds')
  async listRefunds(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('status') status: unknown,
    @Query('orderId') orderId: unknown, @Query('caseId') caseId: unknown, @Query('paymentId') paymentId: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.afterSalesService().listRefunds(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor, { status: this.query(status), orderId: this.query(orderId),
        caseId: this.query(caseId), paymentId: this.query(paymentId) }));
  }

  @Post('refunds')
  async createRefund(@Body() body: CreateRefundBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'RefundCreateRequest', body);
    this.send(response, request, 201, await this.afterSalesService().createRefund(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), this.idempotency(request), body, this.context(request)));
  }

  @Get('refunds/:id')
  async getRefund(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.afterSalesService().getRefund(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('refunds/:id/approve')
  async approveRefund(@Param('id') id: string, @Body() body: { reason: string; reasonCode?: string | null },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReasonRequest', body);
    this.send(response, request, 200, await this.afterSalesService().approveRefund(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('refunds/:id/reject')
  async rejectRefund(@Param('id') id: string, @Body() body: { reason: string; reasonCode?: string | null },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReasonRequest', body);
    this.send(response, request, 200, await this.afterSalesService().rejectRefund(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('refunds/:id/execute')
  async executeRefund(@Param('id') id: string, @Body() body: Record<string, unknown>,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'RefundExecuteRequest', body);
    this.send(response, request, 200, await this.afterSalesService().executeRefund(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }
}
