var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { parse, serialize } from 'cookie';
import { securityPolicy as policy } from '../../../../packages/config/src/security-policy.js';
import { IdentityContracts } from './contracts.js';
import { originAllowed } from './config.js';
import { AuthError } from './service.js';
function cookies(name, value, seconds) {
    return serialize(name, value, { httpOnly: true, secure: true, sameSite: name === 'ez_admin_session' ? 'lax' : 'strict',
        path: name === 'ez_admin_session' ? '/api/v1/admin' : '/api/v1/admin/auth/mfa', maxAge: seconds });
}
export function cookie(request, name) {
    const value = parse(request.headers.cookie ?? '')[name];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
        throw new AuthError(401, 'UNAUTHORIZED');
    return value;
}
export function header(request, name) {
    const value = request.headers[name];
    return typeof value === 'string' ? value : '';
}
export function uuid(value) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
        throw new AuthError(422, 'VALIDATION_ERROR');
    return value;
}
let IdentityController = class IdentityController {
    identity;
    contracts = new IdentityContracts();
    constructor(identity) {
        this.identity = identity;
    }
    service() {
        if (!this.identity)
            throw new AuthError(503, 'SERVICE_NOT_READY');
        return this.identity;
    }
    context(request) {
        // No trust-proxy by default: untrusted forwarding headers cannot bypass IP limits.
        return { requestId: request.requestId, ip: request.socket.remoteAddress ?? 'unknown' };
    }
    async write(request, schema, body) {
        const service = this.service();
        if (!originAllowed(service.config, header(request, 'origin')))
            throw new AuthError(403, 'FORBIDDEN');
        await service.limitIp(this.context(request));
        this.contracts.assert(schema, body);
        return service;
    }
    send(response, request, status, data, values = []) {
        if (values.length)
            response.setHeader('Set-Cookie', values);
        response.statusCode = status;
        if (status === 204) {
            response.end();
            return;
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ data, meta: { requestId: request.requestId } }));
    }
    challengeCookies(result) {
        const enrolling = result.purpose === 'enroll_mfa';
        return [cookies(enrolling ? 'ez_admin_setup' : 'ez_admin_challenge', result.challengeToken, enrolling ? policy.enrollmentChallengeSeconds : policy.loginChallengeSeconds),
            cookies(enrolling ? 'ez_admin_challenge' : 'ez_admin_setup', '', 0)];
    }
    sessionCookies(sessionToken) {
        return [cookies('ez_admin_session', sessionToken, policy.absoluteSessionSeconds),
            cookies('ez_admin_setup', '', 0), cookies('ez_admin_challenge', '', 0)];
    }
    async bootstrap(body, request, response) {
        const service = await this.write(request, 'BootstrapOwnerRequest', body);
        const result = await service.bootstrap(body, header(request, 'x-bootstrap-token'), this.context(request));
        this.send(response, request, 202, result.data, this.challengeCookies(result));
    }
    async login(body, request, response) {
        const service = await this.write(request, 'AdminLoginRequest', body);
        const result = await service.login(body, this.context(request));
        this.send(response, request, result.status, result.data, result.status === 202 ? this.challengeCookies(result) : this.sessionCookies(result.sessionToken));
    }
    async acceptInvitation(body, request, response) {
        const service = await this.write(request, 'AcceptAdminInvitationRequest', body);
        const result = await service.acceptStaffInvitation(body, this.context(request));
        this.send(response, request, result.status, result.data, result.status === 202 ? this.challengeCookies(result) : this.sessionCookies(result.sessionToken));
    }
    async changePassword(body, request, response) {
        const service = await this.write(request, 'AdminPasswordChangeRequest', body);
        const data = await service.changePassword(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request));
        this.send(response, request, 200, data);
    }
    async reset(body, request, response) {
        const completing = typeof body === 'object' && body !== null && 'resetToken' in body;
        const service = await this.write(request, completing ? 'PasswordResetCompleteRequest' : 'PasswordResetRequest', body);
        const result = completing
            ? await service.completePasswordReset(body, this.context(request))
            : await service.requestPasswordReset(body, this.context(request));
        this.send(response, request, 202, result);
    }
    async start(body, request, response) {
        const service = await this.write(request, 'StartMfaEnrollmentRequest', body);
        const result = await service.startEnrollment(body, cookie(request, 'ez_admin_setup'), this.context(request));
        this.send(response, request, 201, result);
    }
    async confirm(body, request, response) {
        const service = await this.write(request, 'ConfirmMfaEnrollmentRequest', body);
        const result = await service.confirmEnrollment(body, cookie(request, 'ez_admin_setup'), this.context(request));
        this.send(response, request, 200, result.data, this.sessionCookies(result.sessionToken));
    }
    async verify(body, request, response) {
        const service = await this.write(request, 'MfaVerifyRequest', body);
        const result = await service.verifyMfa(body, cookie(request, 'ez_admin_challenge'), this.context(request));
        this.send(response, request, 200, result.data, this.sessionCookies(result.sessionToken));
    }
    async session(request, response) {
        this.send(response, request, 200, await this.service().session(cookie(request, 'ez_admin_session')));
    }
    async logout(body, request, response) {
        const service = this.service();
        if (!originAllowed(service.config, header(request, 'origin')))
            throw new AuthError(403, 'FORBIDDEN');
        await service.limitIp(this.context(request));
        if (body && (typeof body !== 'object' || Object.keys(body).length))
            throw new AuthError(422, 'VALIDATION_ERROR');
        await service.logout(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), this.context(request));
        this.send(response, request, 204, null, [cookies('ez_admin_session', '', 0)]);
    }
    async sessions(limit, cursor, request, response) {
        if ((limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit))) ||
            (cursor !== undefined && typeof cursor !== 'string'))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const size = limit === undefined ? 25 : Number(limit);
        if (size < 1 || size > 100)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const result = await this.service().sessions(cookie(request, 'ez_admin_session'), size, cursor ? uuid(cursor) : null);
        this.send(response, request, 200, result);
    }
    async revoke(id, body, request, response) {
        const service = await this.write(request, 'ReasonRequest', body);
        const result = await service.revokeSession(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body.reason, this.context(request));
        this.send(response, request, 200, result);
    }
    async authorize(body, request, response) {
        const service = await this.write(request, 'AuthorizeMfaEnrollmentRequest', body);
        const result = await service.authorizeEnrollment(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request));
        this.send(response, request, 202, result.data, this.challengeCookies(result));
    }
};
__decorate([
    Post('bootstrap'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "bootstrap", null);
__decorate([
    Post('login'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "login", null);
__decorate([
    Post('invitations/accept'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "acceptInvitation", null);
__decorate([
    Post('password'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "changePassword", null);
__decorate([
    Post('password-reset'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "reset", null);
__decorate([
    Post('mfa/enrollments'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "start", null);
__decorate([
    Post('mfa/enrollments/confirm'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "confirm", null);
__decorate([
    Post('mfa/verify'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "verify", null);
__decorate([
    Get('session'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "session", null);
__decorate([
    Post('logout'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "logout", null);
__decorate([
    Get('sessions'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "sessions", null);
__decorate([
    Post('sessions/:id/revoke'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "revoke", null);
__decorate([
    Post('mfa/enrollment-authorizations'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "authorize", null);
IdentityController = __decorate([
    Controller('admin/auth'),
    __param(0, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object])
], IdentityController);
export { IdentityController };
