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
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ManagementHttp } from './management-http.js';
import { cookie, header, uuid } from './controller.js';
import { AuthError } from './service.js';
let StaffController = class StaffController extends ManagementHttp {
    constructor(identity) { super(identity); }
    async list(limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.service().listStaff(cookie(request, 'ez_admin_session'), page.limit, page.cursor));
    }
    async detail(id, request, response) {
        this.send(response, request, 200, await this.service().getStaff(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async update(id, body, request, response) {
        const service = await this.write(request, 'AdminUserPatchRequest', body);
        this.send(response, request, 200, await service.updateStaff(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    async sessions(id, limit, cursor, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.service().staffSessions(cookie(request, 'ez_admin_session'), uuid(id), page.limit, page.cursor));
    }
    async revokeAll(id, body, request, response) {
        const service = await this.write(request, 'ReasonRequest', body);
        this.send(response, request, 200, await service.revokeStaffSessions(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body.reason, this.context(request)));
    }
    async invite(body, request, response) {
        const service = await this.write(request, 'AdminUserInviteRequest', body);
        const data = await service.inviteStaff(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request));
        this.send(response, request, 201, data);
    }
    async invitation(id, request, response) {
        this.send(response, request, 200, await this.service().getInvitation(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async change(id, body, request, response, action) {
        const service = await this.write(request, 'ReasonRequest', body);
        const match = /^"([1-9][0-9]*)"$/.exec(header(request, 'if-match'));
        const version = Number(match?.[1]);
        if (!match || !Number.isSafeInteger(version))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const key = header(request, 'idempotency-key');
        if (action === 'resend' && (key.length < 16 || key.length > 128))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const data = await service.changeInvitation(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), version, action, body.reason, key, this.context(request));
        this.send(response, request, 200, data);
    }
    resend(id, body, request, response) {
        return this.change(id, body, request, response, 'resend');
    }
    revoke(id, body, request, response) {
        return this.change(id, body, request, response, 'revoke');
    }
};
__decorate([
    Get(),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "detail", null);
__decorate([
    Patch(':id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "update", null);
__decorate([
    Get(':id/sessions'),
    __param(0, Param('id')),
    __param(1, Query('limit')),
    __param(2, Query('cursor')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "sessions", null);
__decorate([
    Post(':id/sessions/revoke'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "revokeAll", null);
__decorate([
    Post(),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "invite", null);
__decorate([
    Get(':id/invitation'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "invitation", null);
__decorate([
    Post(':id/invitation/resend'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "resend", null);
__decorate([
    Post(':id/invitation/revoke'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "revoke", null);
StaffController = __decorate([
    Controller('admin/users'),
    __param(0, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object])
], StaffController);
export { StaffController };
