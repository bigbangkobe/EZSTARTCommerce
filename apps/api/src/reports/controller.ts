import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { ReportsService } from './service.js';

/**
 * 交易经营报表（M14）。读报表要 reports.view；导出与下载要 reports.export。
 * 报表不返回任何顾客/订单明细——只有按币种分组的聚合数值与覆盖率说明。
 */
@Controller('admin')
export class ReportsController extends ManagementHttp {
  constructor(@Inject('REPORTS') private readonly reports: ReportsService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private reportsService() { if (!this.reports) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.reports; }

  private idempotency(request: ApiRequest) {
    const key = header(request, 'idempotency-key');
    if (key.length < 16 || key.length > 128) throw new AuthError(422, 'VALIDATION_ERROR');
    return key;
  }

  private optional(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 64) throw new AuthError(422, 'VALIDATION_ERROR');
    return value.length ? value : undefined;
  }

  @Get('reports/:reportKey')
  async report(@Param('reportKey') reportKey: string, @Query('from') from: unknown, @Query('to') to: unknown,
    @Query('timezone') timezone: unknown, @Query('marketCode') marketCode: unknown,
    @Query('paymentMethodCode') paymentMethodCode: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const result = await this.reportsService().report(cookie(request, 'ez_admin_session'), reportKey, {
      from, to, timezone,
      ...(this.optional(marketCode) ? { marketCode: this.optional(marketCode) } : {}),
      ...(this.optional(paymentMethodCode) ? { paymentMethodCode: this.optional(paymentMethodCode) } : {}),
    });
    this.send(response, request, 200, result);
  }

  @Post('report-exports')
  async createExport(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReportExportRequest', body);
    const data = await this.reportsService().createExport(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), this.idempotency(request), body, this.context(request));
    this.send(response, request, 202, data);
  }

  @Get('report-exports/:id')
  async getExport(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.reportsService().getExport(cookie(request, 'ez_admin_session'), id));
  }

  @Get('report-exports/:id/download')
  async download(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const { fileName, content } = await this.reportsService().downloadExport(cookie(request, 'ez_admin_session'), id);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/["\r\n]/g, '_')}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.end(content);
  }
}
