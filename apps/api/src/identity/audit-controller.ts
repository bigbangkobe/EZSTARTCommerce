import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, type ApiRequest } from './controller.js';
import { ManagementHttp } from './management-http.js';
import { IdentityService } from './service.js';

/** 审计记录按设计只读：本控制器只暴露 GET，没有写入、修改或删除路由。 */
@Controller('admin/audit-logs')
export class AuditController extends ManagementHttp {
  constructor(@Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  @Get()
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.service().listAuditLogs(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
  }
}
