import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { ImportService, type CreateBody, type ExecuteBody } from './import-service.js';

/**
 * 商品批量导入（M05）后台入口。
 * 写动作（创建/校验/执行/取消）要会话 + CSRF + Origin；读取任务与错误报告只要会话权限。
 * 契约见 packages/contracts/openapi.yaml 的 /admin/import-jobs。
 */
@Controller('admin')
export class ImportController extends ManagementHttp {
  constructor(@Inject('IMPORT') private readonly imports: ImportService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private importService() { if (!this.imports) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.imports; }

  @Post('import-jobs')
  async create(@Body() body: CreateBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ImportCreateRequest', body);
    const key = header(request, 'idempotency-key') || undefined;
    this.send(response, request, 201, await this.importService().create(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), key, body, this.context(request)));
  }

  @Get('import-jobs/:id')
  async get(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.importService().get(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('import-jobs/:id/validate')
  async validateJob(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.guardWrite(request);
    this.send(response, request, 200, await this.importService().validateJob(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.context(request)));
  }

  @Post('import-jobs/:id/execute')
  async execute(@Param('id') id: string, @Body() body: ExecuteBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ImportExecuteRequest', body);
    const key = header(request, 'idempotency-key') || undefined;
    this.send(response, request, 202, await this.importService().execute(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), key, body, this.context(request)));
  }

  @Post('import-jobs/:id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { reason?: unknown }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.guardWrite(request);
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : 'cancelled by admin';
    if (!reason.length) throw new AuthError(422, 'VALIDATION_ERROR');
    this.send(response, request, 200, await this.importService().cancel(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), reason, this.context(request)));
  }

  @Get('import-jobs/:id/error-report')
  async errorReport(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.importService().errorReport(cookie(request, 'ez_admin_session'), uuid(id)));
  }
}
