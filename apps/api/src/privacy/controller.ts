import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { parse } from 'cookie';
import type { ServerResponse } from 'node:http';
import { header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { PrivacyService } from './service.js';

/**
 * 后台顾客资料请求（M10 第六批）。
 *
 * 四个权限各自管一段，谁也不含谁：
 * - privacy.manage：受理、改负责人/延期、改口径
 * - privacy.read：看队列与详情
 * - privacy.verify：核验身份
 * - privacy.process：批准/拒绝/要求补充/标记完成
 * 写操作一律要 CSRF + Origin；改资源要 If-Match；核验与决定要幂等键。
 */
@Controller('admin')
export class PrivacyController extends ManagementHttp {
  constructor(@Inject('PRIVACY') private readonly privacy: PrivacyService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private privacyService() { if (!this.privacy) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.privacy; }

  private cookieSession(request: ApiRequest) {
    const value = parse(request.headers.cookie ?? '')['ez_admin_session'];
    if (!value || value.length !== 43) throw new AuthError(401, 'UNAUTHORIZED');
    return value;
  }

  private idempotencyKey(request: ApiRequest) {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) throw new AuthError(422, 'VALIDATION_ERROR');
    return key;
  }

  private filter(value: unknown) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !value.length || value.length > 40) throw new AuthError(422, 'VALIDATION_ERROR');
    return value;
  }

  @Get('privacy-requests')
  async queue(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('status') status: unknown,
    @Query('overdue') overdue: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    if (overdue !== undefined && overdue !== 'true' && overdue !== 'false') throw new AuthError(422, 'VALIDATION_ERROR');
    this.send(response, request, 200, await this.privacyService().queue(this.cookieSession(request),
      page.limit, page.cursor, this.filter(status), overdue === undefined ? null : overdue === 'true'));
  }

  @Post('privacy-requests')
  async create(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'PrivacyRequestCreate', body);
    this.send(response, request, 201, await this.privacyService().create(
      this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Get('privacy-requests/:id')
  async get(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.privacyService().get(this.cookieSession(request), uuid(id)));
  }

  /** 改负责人或延期：都要写理由，且必须带「我读到的版本」，避免两个人同时改。 */
  @Patch('privacy-requests/:id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'PrivacyRequestPatch', body);
    this.send(response, request, 200, await this.privacyService().update(this.cookieSession(request),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }

  @Post('privacy-requests/:id/verify')
  async verify(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'PrivacyVerifyRequest', body);
    this.send(response, request, 200, await this.privacyService().verify(this.cookieSession(request),
      header(request, 'x-csrf-token'), uuid(id), this.idempotencyKey(request), body, this.context(request)));
  }

  @Post('privacy-requests/:id/complete')
  async decide(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'PrivacyCompleteRequest', body);
    this.send(response, request, 200, await this.privacyService().decide(this.cookieSession(request),
      header(request, 'x-csrf-token'), uuid(id), this.idempotencyKey(request), body, this.context(request)));
  }

  /** 生成导出工件：明文不进响应，只有密文与哈希；重复提交刷新同一份工件。 */
  @Post('privacy-requests/:id/export')
  async createExport(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'PrivacyExportRequest', body);
    this.send(response, request, 201, await this.privacyService().createExport(this.cookieSession(request),
      header(request, 'x-csrf-token'), uuid(id), this.context(request)));
  }

  /** 下载是原始 JSON 附件，不走统一信封：前端拿到的是可交付给顾客的工件本身。 */
  @Get('privacy-requests/:id/export/:jobId')
  async downloadExport(@Param('id') id: string, @Param('jobId') jobId: string,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const result = await this.privacyService().downloadExport(this.cookieSession(request), uuid(id), uuid(jobId), this.context(request));
    if (!result) throw new AuthError(404, 'NOT_FOUND');
    const bytes = Buffer.from(result.text, 'utf8');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', String(bytes.length));
    response.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('ETag', `"${result.sha256}"`);
    response.end(bytes);
  }

  @Patch('privacy-settings')
  async updateSettings(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'PrivacySettingPatchRequest', body);
    this.send(response, request, 200, await this.privacyService().updateSettings(this.cookieSession(request),
      header(request, 'x-csrf-token'), this.version(request), body, this.context(request)));
  }
}
