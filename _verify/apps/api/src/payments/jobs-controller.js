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
/**
 * 内部定时任务入口（对账）。
 *
 * 为什么是一个 HTTP 端点而不是在进程里 setTimeout：
 * 1. 定时执行不该和 Web 进程生命周期绑死——重启即丢、多副本会重复跑。
 * 2. 运维要能手动触发一次（"这笔钱到底到了没有"），端点天然支持。
 * 3. 跑多久、跑多少条都能从外部调，出问题时不必改代码重新发布。
 *
 * 鉴权只有一把共享令牌，且**默认关闭**：没配 `INTERNAL_JOB_TOKEN` 就整体 503。
 * 运维端点默认开放等于给攻击者一个免费的执行入口，宁可让运维多点一步配置。
 */
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
const MIN_TOKEN_LENGTH = 24;
function tokenMatches(provided, expected) {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // 长度不同直接false：timingSafeEqual 对不等长入参会抛错，不能靠它做长度检查。
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}
let InternalJobsController = class InternalJobsController extends ManagementHttp {
    payments;
    constructor(payments, identity) {
        super(identity);
        this.payments = payments;
    }
    async reconcile(body, request, response) {
        if (!this.payments)
            throw new AuthError(503, 'SERVICE_NOT_READY');
        const expected = process.env.INTERNAL_JOB_TOKEN ?? '';
        if (expected.length < MIN_TOKEN_LENGTH)
            throw new AuthError(503, 'JOB_ENDPOINT_DISABLED');
        const provided = request.headers['x-job-token'];
        if (typeof provided !== 'string' || !tokenMatches(provided, expected)) {
            throw new AuthError(401, 'UNAUTHORIZED');
        }
        const report = await this.payments.reconcile({
            ...(typeof body?.olderThanMinutes === 'number' ? { olderThanMinutes: body.olderThanMinutes } : {}),
            ...(typeof body?.limit === 'number' ? { limit: body.limit } : {}),
        });
        this.send(response, request, 200, report);
    }
};
__decorate([
    Post('reconcile'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], InternalJobsController.prototype, "reconcile", null);
InternalJobsController = __decorate([
    Controller('internal/jobs'),
    __param(0, Inject('PAYMENTS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], InternalJobsController);
export { InternalJobsController };
