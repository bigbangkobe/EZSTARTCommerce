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
import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { header } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 后台邮件自检（M10 批次七C）。
 *
 * 只有两条路：发起（notifications.manage）与看结果（notifications.read）。
 * 发起走 CSRF + Origin + 契约校验；实际投递由 worker 完成——如果 worker 没在跑，
 * 任务会一直停在 pending，这本身就是答案：链路没通。
 */
let MailTestController = class MailTestController extends ManagementHttp {
    mailTest;
    constructor(mailTest, identity) {
        super(identity);
        this.mailTest = mailTest;
    }
    mailService() { if (!this.mailTest)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.mailTest; }
    cookieSession(request) {
        const value = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('ez_admin_session='));
        const token = value?.slice('ez_admin_session='.length);
        if (!token || token.length !== 43)
            throw new AuthError(401, 'UNAUTHORIZED');
        return token;
    }
    async list(limit, request, response) {
        // 自检记录就几条：只取最近 limit 条，没有下一页游标。
        const page = this.pagination(limit, undefined);
        this.send(response, request, 200, await this.mailService().listTests(this.cookieSession(request), page.limit));
    }
    async create(body, request, response) {
        await this.write(request, 'MailTestRequest', body);
        this.send(response, request, 202, await this.mailService().sendTest(this.cookieSession(request), header(request, 'x-csrf-token'), body, this.context(request)));
    }
};
__decorate([
    Get('mail/test'),
    __param(0, Query('limit')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MailTestController.prototype, "list", null);
__decorate([
    Post('mail/test'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], MailTestController.prototype, "create", null);
MailTestController = __decorate([
    Controller('admin'),
    __param(0, Inject('MAIL_TEST')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], MailTestController);
export { MailTestController };
