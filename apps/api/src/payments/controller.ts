import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { PaymentsService, type MethodPatchBody } from './service.js';

/**
 * 付款后台（M08）。读接口只认会话；配置与收款登记要求 CSRF + Origin，
 * 登记另需 Idempotency-Key 与 If-Match：没有这两样就无法证明“记的是哪一版、哪一次请求”。
 */
@Controller('admin')
export class PaymentsController extends ManagementHttp {
  constructor(@Inject('PAYMENTS') private readonly payments: PaymentsService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private paymentsService() { if (!this.payments) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.payments; }

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

  @Get('payment-methods')
  async methods(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.paymentsService().listMethods(cookie(request, 'ez_admin_session')));
  }

  @Patch('payment-methods')
  async updateMethod(@Body() body: MethodPatchBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'PaymentMethodPatchRequest', body);
    this.send(response, request, 200, await this.paymentsService().updateMethod(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), this.version(request), body, this.context(request)));
  }

  /** 测试连接：只验证凭据可用，不发起真实支付；结果写回 connectionStatus。 */
  @Post('payment-methods/:providerCode/connection-test')
  async testConnection(@Param('providerCode') providerCode: string, @Query('environment') environment: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.paymentsService().testConnection(
      cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), providerCode,
      typeof environment === 'string' ? environment : 'production', this.context(request)));
  }

  @Get('payments')
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('status') status: unknown,
    @Query('orderId') orderId: unknown, @Query('providerCode') providerCode: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.paymentsService().listPayments(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor, { status: this.query(status), orderId: this.query(orderId), providerCode: this.query(providerCode) }));
  }

  @Get('payments/:id')
  async detail(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.paymentsService().getPayment(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('orders/:id/payment-result')
  async record(@Param('id') id: string, @Body() body: Record<string, unknown>,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'OrderPaymentResultRequest', body);
    // 契约同时声明了 If-Match 与 body.expectedVersion：两者都表示“我看到的那一版”。
    // 头部是权威值（与 PATCH 一致的乐观锁语义），body 仅在未带头部时兜底。
    const version = header(request, 'if-match') ? this.version(request) : undefined;
    this.send(response, request, 200, await this.paymentsService().recordOrderPayment(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request),
      version === undefined ? body : { ...body, expectedVersion: version }, this.context(request)));
  }
}
