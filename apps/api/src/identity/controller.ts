import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parse, serialize } from 'cookie';
import { securityPolicy as policy } from '../../../../packages/config/src/security-policy.js';
import { IdentityContracts } from './contracts.js';
import { originAllowed } from './config.js';
import { AuthError, IdentityService } from './service.js';

export type ApiRequest = IncomingMessage & { requestId: string };
type CookieName = 'ez_admin_setup' | 'ez_admin_challenge' | 'ez_admin_session';

function cookies(name: CookieName, value: string, seconds: number) {
  return serialize(name, value, { httpOnly: true, secure: true, sameSite: name === 'ez_admin_session' ? 'lax' : 'strict',
    path: name === 'ez_admin_session' ? '/api/v1/admin' : '/api/v1/admin/auth/mfa', maxAge: seconds });
}
export function cookie(request: ApiRequest, name: CookieName) {
  const value = parse(request.headers.cookie ?? '')[name];
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AuthError(401, 'UNAUTHORIZED');
  return value;
}
export function header(request: ApiRequest, name: string) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}
export function uuid(value: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new AuthError(422, 'VALIDATION_ERROR');
  return value;
}

@Controller('admin/auth')
export class IdentityController {
  private readonly contracts = new IdentityContracts();
  constructor(@Inject('IDENTITY') private readonly identity: IdentityService | null) {}
  private service() {
    if (!this.identity) throw new AuthError(503, 'SERVICE_NOT_READY');
    return this.identity;
  }
  private context(request: ApiRequest) {
    // No trust-proxy by default: untrusted forwarding headers cannot bypass IP limits.
    return { requestId: request.requestId, ip: request.socket.remoteAddress ?? 'unknown' };
  }
  private async write(request: ApiRequest, schema: string, body: unknown) {
    const service = this.service();
    if (!originAllowed(service.config, header(request, 'origin'))) throw new AuthError(403, 'FORBIDDEN');
    await service.limitIp(this.context(request));
    this.contracts.assert(schema, body);
    return service;
  }
  private send(response: ServerResponse, request: ApiRequest, status: number, data: unknown, values: string[] = []) {
    if (values.length) response.setHeader('Set-Cookie', values);
    response.statusCode = status;
    if (status === 204) { response.end(); return; }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ data, meta: { requestId: request.requestId } }));
  }
  private challengeCookies(result: { purpose: string; challengeToken: string }) {
    const enrolling = result.purpose === 'enroll_mfa';
    return [cookies(enrolling ? 'ez_admin_setup' : 'ez_admin_challenge', result.challengeToken,
      enrolling ? policy.enrollmentChallengeSeconds : policy.loginChallengeSeconds),
    cookies(enrolling ? 'ez_admin_challenge' : 'ez_admin_setup', '', 0)];
  }
  private sessionCookies(sessionToken: string) {
    return [cookies('ez_admin_session', sessionToken, policy.absoluteSessionSeconds),
      cookies('ez_admin_setup', '', 0), cookies('ez_admin_challenge', '', 0)];
  }
  @Post('bootstrap')
  async bootstrap(@Body() body: { email: string; password: string; displayName: string; locale: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'BootstrapOwnerRequest', body);
    const result = await service.bootstrap(body, header(request, 'x-bootstrap-token'), this.context(request));
    this.send(response, request, 202, result.data, this.challengeCookies(result));
  }
  @Post('login')
  async login(@Body() body: { email: string; password: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'AdminLoginRequest', body);
    const result = await service.login(body, this.context(request));
    this.send(response, request, result.status, result.data, result.status === 202 ? this.challengeCookies(result) : this.sessionCookies(result.sessionToken));
  }
  @Post('invitations/accept')
  async acceptInvitation(@Body() body: { invitationToken: string; newPassword: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'AcceptAdminInvitationRequest', body);
    const result = await service.acceptStaffInvitation(body, this.context(request));
    this.send(response, request, result.status, result.data, result.status === 202 ? this.challengeCookies(result) : this.sessionCookies(result.sessionToken));
  }
  @Post('password-reset')
  async reset(@Body() body: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const completing = typeof body === 'object' && body !== null && 'resetToken' in body;
    const service = await this.write(request, completing ? 'PasswordResetCompleteRequest' : 'PasswordResetRequest', body);
    const result = completing
      ? await service.completePasswordReset(body as { resetToken: string; newPassword: string }, this.context(request))
      : await service.requestPasswordReset(body as { email: string }, this.context(request));
    this.send(response, request, 202, result);
  }
  @Post('mfa/enrollments')
  async start(@Body() body: { challengeId: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'StartMfaEnrollmentRequest', body);
    const result = await service.startEnrollment(body, cookie(request, 'ez_admin_setup'), this.context(request));
    this.send(response, request, 201, result);
  }
  @Post('mfa/enrollments/confirm')
  async confirm(@Body() body: { challengeId: string; enrollmentId: string; code: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'ConfirmMfaEnrollmentRequest', body);
    const result = await service.confirmEnrollment(body, cookie(request, 'ez_admin_setup'), this.context(request));
    this.send(response, request, 200, result.data, this.sessionCookies(result.sessionToken));
  }
  @Post('mfa/verify')
  async verify(@Body() body: { challengeId: string; code: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'MfaVerifyRequest', body);
    const result = await service.verifyMfa(body, cookie(request, 'ez_admin_challenge'), this.context(request));
    this.send(response, request, 200, result.data, this.sessionCookies(result.sessionToken));
  }
  @Get('session')
  async session(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.service().session(cookie(request, 'ez_admin_session')));
  }
  @Post('logout')
  async logout(@Body() body: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = this.service();
    if (!originAllowed(service.config, header(request, 'origin'))) throw new AuthError(403, 'FORBIDDEN');
    await service.limitIp(this.context(request));
    if (body && (typeof body !== 'object' || Object.keys(body).length)) throw new AuthError(422, 'VALIDATION_ERROR');
    await service.logout(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), this.context(request));
    this.send(response, request, 204, null, [cookies('ez_admin_session', '', 0)]);
  }
  @Get('sessions')
  async sessions(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    if ((limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit))) ||
      (cursor !== undefined && typeof cursor !== 'string')) throw new AuthError(422, 'VALIDATION_ERROR');
    const size = limit === undefined ? 25 : Number(limit);
    if (size < 1 || size > 100) throw new AuthError(422, 'VALIDATION_ERROR');
    const result = await this.service().sessions(cookie(request, 'ez_admin_session'), size, cursor ? uuid(cursor as string) : null);
    this.send(response, request, 200, result);
  }
  @Post('sessions/:id/revoke')
  async revoke(@Param('id') id: string, @Body() body: { reason: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'ReasonRequest', body);
    const result = await service.revokeSession(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body.reason, this.context(request));
    this.send(response, request, 200, result);
  }
  @Post('mfa/enrollment-authorizations')
  async authorize(@Body() body: { currentPassword: string; currentMfaCode?: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'AuthorizeMfaEnrollmentRequest', body);
    const result = await service.authorizeEnrollment(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request));
    this.send(response, request, 202, result.data, this.challengeCookies(result));
  }
}
