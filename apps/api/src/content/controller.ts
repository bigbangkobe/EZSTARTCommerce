import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { ContentService, type PageBody, type PublishBody, type RollbackBody } from './service.js';

@Controller('admin')
export class ContentController extends ManagementHttp {
  constructor(@Inject('CONTENT') private readonly content: ContentService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private contentService() { if (!this.content) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.content; }

  @Get('pages')
  async pages(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.contentService().listPages(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor));
  }

  @Get('pages/:id')
  async page(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.contentService().getPage(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('pages')
  async createPage(@Body() body: PageBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'PageWriteRequest', body);
    this.send(response, request, 201, await this.contentService().createPage(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Patch('pages/:id')
  async updatePage(@Param('id') id: string, @Body() body: PageBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'PagePatchRequest', body);
    this.send(response, request, 200, await this.contentService().updatePage(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }

  @Post('pages/:id/publish')
  async publish(@Param('id') id: string, @Body() body: PublishBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'PagePublishRequest', body);
    const result = await this.contentService().publishPage(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), body, this.context(request));
    // 202 = 已登记定时计划但尚未生效；200 = 线上已经切到新版本。
    this.send(response, request, result.scheduled ? 202 : 200, result);
  }

  @Post('pages/:id/unpublish')
  async unpublish(@Param('id') id: string, @Body() body: { reason: string }, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'ReasonRequest', body);
    this.send(response, request, 200, await this.contentService().unpublishPage(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), body, this.context(request)));
  }

  @Post('pages/:id/rollback')
  async rollback(@Param('id') id: string, @Body() body: RollbackBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'PageRollbackRequest', body);
    this.send(response, request, 201, await this.contentService().rollbackPage(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), body, this.context(request)));
  }

  /**
   * 预览外链：返回 201 与一次性 token（只在这一次响应里出现，库里只有摘要）。
   * 前台路由是 /preview/{token}?locale=&viewport=，链接短期有效、noindex、不写埋点。
   */
  @Post('pages/:id/preview-token')
  async previewToken(@Param('id') id: string, @Body() body: { locale: string; viewport: string;
    expectedVersion: number; ttlMinutes?: number }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'PreviewRequest', body);
    this.send(response, request, 201, await this.contentService().createPreviewToken(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), body, this.context(request)));
  }

  @Get('redirects')
  async redirects(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.contentService().listRedirects(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor));
  }

  @Post('redirects')
  async createRedirect(@Body() body: { locale: string; fromPath: string; toPath: string; statusCode?: number },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'RedirectWriteRequest', body);
    this.send(response, request, 201, await this.contentService().createRedirect(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Delete('redirects/:id')
  async deleteRedirect(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.guardWrite(request);
    await this.contentService().deleteRedirect(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.context(request));
    this.send(response, request, 204, null);
  }
}
