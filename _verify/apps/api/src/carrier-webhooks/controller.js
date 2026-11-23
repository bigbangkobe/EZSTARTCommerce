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
import { Body, Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { IdentityContracts } from '../identity/contracts.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
function header(request, name) {
    const value = request.headers[name];
    return typeof value === 'string' ? value : null;
}
/** 公开 HMAC webhook：无管理员会话、无 CSRF；身份由签名与时间窗证明。 */
let CarrierWebhookController = class CarrierWebhookController extends ManagementHttp {
    carrier;
    schemas = new IdentityContracts();
    constructor(carrier, identity) {
        super(identity);
        this.carrier = carrier;
    }
    carrierService() { if (!this.carrier)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.carrier; }
    async receive(carrierCode, body, request, response) {
        this.schemas.assert('CarrierStatusEventRequest', body);
        const ack = await this.carrierService().receive(carrierCode, body, header(request, 'x-carrier-signature'), header(request, 'x-carrier-timestamp'), this.context(request));
        this.send(response, request, 202, ack);
    }
};
__decorate([
    Post(':carrierCode'),
    __param(0, Param('carrierCode')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CarrierWebhookController.prototype, "receive", null);
CarrierWebhookController = __decorate([
    Controller('webhooks/carriers'),
    __param(0, Inject('CARRIER_WEBHOOKS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], CarrierWebhookController);
export { CarrierWebhookController };
