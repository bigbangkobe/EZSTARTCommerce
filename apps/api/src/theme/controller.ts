import { Body, Controller, Get, Inject, Post, Put, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import {
  ThemeService, type ThemePublishBody, type ThemeRollbackBody, type ThemeSaveBody,
} from './service.js';

@Controller('admin/theme')
export class ThemeController extends ManagementHttp {
  constructor(@Inject('THEME') private readonly theme: ThemeService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private themes() { if (!this.theme) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.theme; }

  @Get()
  async get(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.themes().get(cookie(request, 'ez_admin_session')));
  }

  /** 保存草稿：expectedVersion=1 表示还没有草稿。保存不改变线上主题。 */
  @Put()
  async save(@Body() body: ThemeSaveBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ThemeWriteRequest', body);
    this.send(response, request, 200, await this.themes().save(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Post('publish')
  async publish(@Body() body: ThemePublishBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ThemePublishRequest', body);
    this.send(response, request, 200, await this.themes().publish(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Post('unpublish')
  async unpublish(@Body() body: { reason: string; expectedVersion: number },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ThemeWithdrawRequest', body);
    this.send(response, request, 200, await this.themes().unpublish(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Post('rollback')
  async rollback(@Body() body: ThemeRollbackBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ThemeRollbackRequest', body);
    this.send(response, request, 200, await this.themes().rollback(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }
}
