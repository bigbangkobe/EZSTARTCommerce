import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { parse, serialize } from 'cookie';
import type { ServerResponse } from 'node:http';
import { header, uuid, type ApiRequest } from '../identity/controller.js';
import { IdentityContracts } from '../identity/contracts.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { LoyaltyService } from './loyalty-service.js';
import { MembersService } from './service.js';

const MEMBER_COOKIE = 'ez_member_session';
const SESSION_SECONDS = 43_200;

/**
 * 会员 cookie 与游客购物袋同形制（43 字符 base64url），但作用域完全不同：
 * 它只代表一个已验证会员，永远不能读后台资源，也不能替代访客结账。
 */
function memberToken(request: ApiRequest) {
  const value = parse(request.headers.cookie ?? '')[MEMBER_COOKIE];
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AuthError(401, 'UNAUTHORIZED');
  return value;
}

function sessionCookie(token: string, maxAge: number) {
  return serialize(MEMBER_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1', maxAge });
}

@Controller('storefront/member')
export class MemberController extends ManagementHttp {
  private readonly schemas = new IdentityContracts();
  constructor(@Inject('MEMBERS') private readonly members: MembersService | null,
    @Inject('LOYALTY') private readonly loyalty: LoyaltyService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private membersService() { if (!this.members) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.members; }

  @Post('otp/request')
  async requestOtp(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.schemas.assert('OtpRequest', body);
    this.send(response, request, 202, await this.membersService().requestOtp(
      body as { email: unknown; locale: unknown; purpose: unknown }, this.context(request)));
  }

  /** 验证成功才发 cookie；响应里的 csrfToken 由页面保存在内存中，用于登出。 */
  @Post('otp/verify')
  async verify(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.schemas.assert('OtpVerifyRequest', body);
    const result = await this.membersService().verifyOtp(body as { challengeId: string; code: string }, this.context(request));
    response.setHeader('Set-Cookie', sessionCookie(result.token, SESSION_SECONDS));
    this.send(response, request, 200, result.data);
  }

  @Post('logout')
  async logout(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    const token = memberToken(request);
    const supplied = header(request, 'x-csrf-token');
    if (supplied.length !== 64) throw new AuthError(403, 'FORBIDDEN');
    await this.membersService().logout(token, supplied);
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    this.send(response, request, 204, null);
  }

  @Get('profile')
  async profile(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.membersService().profile(memberToken(request)));
  }

  @Get('orders')
  async orders(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.membersService().memberOrders(memberToken(request), page.limit, page.cursor));
  }

  /** 会员只看自己的账：余额 + 最近流水，金额口径与后台一致。 */
  @Get('points')
  async points(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    if (!this.loyalty) throw new AuthError(503, 'SERVICE_NOT_READY');
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.loyalty.memberPoints(memberToken(request), page.limit, page.cursor));
  }
}

/**
 * 后台顾客与会员（M10）。
 *
 * 读要 customers.read_masked / members.manage；写要 customers.manage / members.manage、
 * CSRF、Origin 与 If-Match。完整邮箱、电话与内部备注只在拥有 customers.read_pii 时可见。
 */
@Controller('admin')
export class CustomersController extends ManagementHttp {
  constructor(@Inject('MEMBERS') private readonly members: MembersService | null,
    @Inject('LOYALTY') private readonly loyalty: LoyaltyService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private membersService() { if (!this.members) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.members; }

  private query(value: unknown, max = 80) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > max) throw new AuthError(422, 'VALIDATION_ERROR');
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  @Get('customers')
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('q') q: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.membersService().listCustomers(
      this.cookieSession(request), page.limit, page.cursor, this.query(q)));
  }

  @Post('customers')
  async create(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'CustomerWriteRequest', body);
    this.send(response, request, 201, await this.membersService().createCustomer(
      this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Get('customers/:id')
  async get(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.membersService().getCustomer(this.cookieSession(request), uuid(id)));
  }

  @Patch('customers/:id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'CustomerWriteRequest', body);
    this.send(response, request, 200, await this.membersService().updateCustomer(this.cookieSession(request),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }

  @Get('members')
  async members_(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.membersService().listMembers(this.cookieSession(request), page.limit, page.cursor));
  }

  @Post('members')
  async createMember(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'MemberWriteRequest', body);
    this.send(response, request, 201, await this.membersService().createMember(
      this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Patch('members/:id')
  async updateMember(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'MemberPatchRequest', body);
    this.send(response, request, 200, await this.membersService().updateMember(this.cookieSession(request),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }

  @Get('loyalty')
  async loyalty_(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.loyaltyService().adminOverview(this.cookieSession(request)));
  }

  @Patch('loyalty/settings')
  async updateLoyaltySettings(@Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'LoyaltySettingPatchRequest', body);
    this.send(response, request, 200, await this.loyaltyService().updateSettings(this.cookieSession(request),
      header(request, 'x-csrf-token'), this.version(request), body, this.context(request)));
  }

  @Post('loyalty/tiers')
  async createTier(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'MembershipTierWriteRequest', body);
    this.send(response, request, 201, await this.loyaltyService().createTier(
      this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Patch('loyalty/tiers/:id')
  async updateTier(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'MembershipTierPatchRequest', body);
    this.send(response, request, 200, await this.loyaltyService().updateTier(this.cookieSession(request),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }

  /** 后台看账：余额 + 最近流水。读只要 members.manage，改才要 points.adjust。 */
  @Get('members/:id/points')
  async memberPointsAdmin(@Param('id') id: string, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.loyaltyService().adminMemberPoints(
      this.cookieSession(request), uuid(id), page.limit, page.cursor));
  }

  /** 人工调整必须带幂等键：重试同一笔不会变成两次加减。 */
  @Post('members/:id/points-adjustments')
  async adjustPoints(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'PointsAdjustmentRequest', body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') throw new AuthError(422, 'VALIDATION_ERROR');
    this.send(response, request, 201, await this.loyaltyService().adjustPoints(this.cookieSession(request),
      header(request, 'x-csrf-token'), uuid(id), key, body, this.context(request)));
  }

  private loyaltyService() { if (!this.loyalty) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.loyalty; }

  /** 后台会话 cookie 名与身份模块一致；这里只取原文，校验仍由 withPermission 完成。 */
  private cookieSession(request: ApiRequest) {
    const value = parse(request.headers.cookie ?? '')['ez_admin_session'];
    if (!value || value.length !== 43) throw new AuthError(401, 'UNAUTHORIZED');
    return value;
  }
}
