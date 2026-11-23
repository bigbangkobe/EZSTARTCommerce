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
 * 支付渠道回调入口（公开路由）。
 *
 * 无管理员会话、无 CSRF：身份只由渠道签名与时间窗证明。
 * 三条必须守住的东西：
 * 1. 验签用**原始字节**，不能用解析后的 JSON 重新序列化——字段顺序一变签名就废。
 * 2. 验签失败返回 400；但“单号找不到”返回 202，让渠道停止重试，由对账补。
 * 3. 任何分支都不回显内部状态以外的信息，避免泄露订单/渠道是否存在。
 */
import { Controller, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
function headerMap(request) {
    const output = {};
    for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string')
            output[name.toLowerCase()] = value;
        else if (Array.isArray(value))
            output[name.toLowerCase()] = value[0] ?? '';
    }
    return output;
}
let PaymentWebhookController = class PaymentWebhookController extends ManagementHttp {
    payments;
    constructor(payments, identity) {
        super(identity);
        this.payments = payments;
    }
    async receive(providerCode, env, request, response) {
        if (!this.payments)
            throw new AuthError(503, 'SERVICE_NOT_READY');
        // 环境只用于选配置与密钥；伪造 env 只会在验签阶段失败，拿不到任何额外信息。
        const environment = env === 'sandbox' ? 'sandbox' : 'production';
        const rawBody = request.rawBody;
        if (!rawBody || !rawBody.length)
            throw new AuthError(400, 'WEBHOOK_BODY_MISSING');
        if (rawBody.length > 256 * 1024)
            throw new AuthError(413, 'WEBHOOK_BODY_TOO_LARGE');
        const result = await this.payments.handleWebhook(providerCode, environment, headerMap(request), rawBody, this.context(request));
        // 202：已接收。deferred 与 duplicate 同样回 202，避免渠道对同一事件反复重推。
        this.send(response, request, 202, { received: true, kind: result.kind });
    }
};
__decorate([
    Post(':providerCode'),
    __param(0, Param('providerCode')),
    __param(1, Query('env')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], PaymentWebhookController.prototype, "receive", null);
PaymentWebhookController = __decorate([
    Controller('webhooks/payments'),
    __param(0, Inject('PAYMENTS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], PaymentWebhookController);
export { PaymentWebhookController };
