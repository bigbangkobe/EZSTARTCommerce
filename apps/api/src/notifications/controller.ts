import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { header, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { NotificationService } from './service.js';

/**
 * 后台邮件自检（M10 批次七C）。
 *
 * 只有两条路：发起（notifications.manage）与看结果（notifications.read）。
 * 发起走 CSRF + Origin + 契约校验；实际投递由 worker 完成——如果 worker 没在跑，
 * 任务会一直停在 pending，这本身就是答案：链路没通。
 */
@Controller('admin')
export class MailTestController extends ManagementHttp {
  constructor(@Inject('MAIL_TEST') private readonly mailTest: NotificationService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private mailService() { if (!this.mailTest) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.mailTest; }

  private cookieSession(request: ApiRequest) {
    const value = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('ez_admin_session='));
    const token = value?.slice('ez_admin_session='.length);
    if (!token || token.length !== 43) throw new AuthError(401, 'UNAUTHORIZED');
    return token;
  }

  @Get('mail/test')
  async list(@Query('limit') limit: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    // 自检记录就几条：只取最近 limit 条，没有下一页游标。
    const page = this.pagination(limit, undefined);
    this.send(response, request, 200, await this.mailService().listTests(this.cookieSession(request), page.limit));
  }

  @Post('mail/test')
  async create(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'MailTestRequest', body);
    this.send(response, request, 202, await this.mailService().sendTest(
      this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
  }
}
