import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { WorkbenchService } from './service.js';

/** 后台首页聚合（只读）。权限在服务层按块判定，见 WorkbenchService。 */
@Controller('admin')
export class WorkbenchController extends ManagementHttp {
  constructor(@Inject('WORKBENCH') private readonly workbench: WorkbenchService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private workbenchService() { if (!this.workbench) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.workbench; }

  @Get('workbench')
  async summary(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.workbenchService().summary(cookie(request, 'ez_admin_session')));
  }
}
