import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from './controller.js';
import { ManagementHttp } from './management-http.js';
import { IdentityService } from './service.js';
type RoleBody = { name?: string; description?: string | null; permissionCodes?: string[] };
@Controller('admin/roles')
export class RolesController extends ManagementHttp {
  constructor(@Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  @Get()
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.service().listRoles(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
  }
  @Get(':id')
  async detail(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.service().getRole(cookie(request, 'ez_admin_session'), uuid(id)));
  }
  @Post()
  async create(@Body() body: RoleBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'RoleWriteRequest', body);
    this.send(response, request, 201, await service.writeRole(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), null, null, body, this.context(request)));
  }
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: RoleBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'RolePatchRequest', body);
    this.send(response, request, 200, await service.writeRole(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }
}
