import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { parse } from 'cookie';
import type { ServerResponse } from 'node:http';
import { type ApiRequest } from '../identity/controller.js';
import { IdentityContracts } from '../identity/contracts.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { AnalyticsService } from './service.js';

const CSRF_COOKIE = 'ez_cart_csrf';
const CART_COOKIE = 'ez_guest_cart';

/** 双提交 CSRF：与结账端点同一枚可读 cookie，跨站拿不到值就伪造不出匹配的头。 */
function assertCsrf(request: ApiRequest) {
  const expected = parse(request.headers.cookie ?? '')[CSRF_COOKIE];
  const supplied = request.headers['x-csrf-token'];
  if (!expected || typeof supplied !== 'string' || supplied.length !== 43 || expected.length !== 43) throw new AuthError(403, 'FORBIDDEN');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new AuthError(403, 'FORBIDDEN');
}

function optionalCartToken(request: ApiRequest): string | null {
  const value = parse(request.headers.cookie ?? '')[CART_COOKIE];
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/**
 * 第一方匿名事件采集（M14 第二批）。公开端点：无管理员会话、无会员身份。
 * 只收白名单事件（不含 purchase），受 CSRF + IP 限流 + 契约 + 店铺开关 + 同意状态约束。
 */
@Controller('storefront/analytics')
export class AnalyticsController extends ManagementHttp {
  private readonly schemas = new IdentityContracts();
  constructor(@Inject('ANALYTICS') private readonly analytics: AnalyticsService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private analyticsService() { if (!this.analytics) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.analytics; }

  @Post('events')
  async ingest(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    assertCsrf(request);
    this.schemas.assert('AnalyticsEventBatch', body);
    const data = await this.analyticsService().ingest(optionalCartToken(request), body, this.context(request));
    this.send(response, request, 202, data);
  }
}
