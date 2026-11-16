import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { ManagementHttp } from './management-http.js';
import { cookie, header, uuid, type ApiRequest } from './controller.js';
import { AuthError, IdentityService } from './service.js';

@Controller('admin/users')
export class StaffController extends ManagementHttp {
  constructor(@Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  @Get()
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.service().listStaff(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
  }
  @Get(':id')
  async detail(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.service().getStaff(cookie(request, 'ez_admin_session'), uuid(id)));
  }
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: { displayName?: string; status?: string; roleIds?: string[] }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'AdminUserPatchRequest', body);
    this.send(response, request, 200, await service.updateStaff(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }
  @Get(':id/sessions')
  async sessions(@Param('id') id: string, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.service().staffSessions(cookie(request, 'ez_admin_session'), uuid(id), page.limit, page.cursor));
  }
  @Post(':id/sessions/revoke')
  async revokeAll(@Param('id') id: string, @Body() body: { reason: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'ReasonRequest', body);
    this.send(response, request, 200, await service.revokeStaffSessions(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body.reason, this.context(request)));
  }
  @Post()
  async invite(@Body() body: { email: string; displayName: string; locale: string; roleIds: string[] }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'AdminUserInviteRequest', body);
    const data = await service.inviteStaff(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request));
    this.send(response, request, 201, data);
  }
  @Get(':id/invitation')
  async invitation(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.service().getInvitation(cookie(request, 'ez_admin_session'), uuid(id)));
  }
  private async change(id: string, body: { reason: string }, request: ApiRequest, response: ServerResponse, action: 'resend' | 'revoke') {
    const service = await this.write(request, 'ReasonRequest', body);
    const match = /^"([1-9][0-9]*)"$/.exec(header(request, 'if-match'));
    const version = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(version)) throw new AuthError(422, 'VALIDATION_ERROR');
    const key = header(request, 'idempotency-key');
    if (action === 'resend' && (key.length < 16 || key.length > 128)) throw new AuthError(422, 'VALIDATION_ERROR');
    const data = await service.changeInvitation(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), version, action, body.reason, key, this.context(request));
    this.send(response, request, 200, data);
  }
  @Post(':id/invitation/resend')
  resend(@Param('id') id: string, @Body() body: { reason: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    return this.change(id, body, request, response, 'resend');
  }
  @Post(':id/invitation/revoke')
  revoke(@Param('id') id: string, @Body() body: { reason: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    return this.change(id, body, request, response, 'revoke');
  }
}
