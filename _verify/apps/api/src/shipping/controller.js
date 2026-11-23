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
import { Body, Controller, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
let ShippingController = class ShippingController extends ManagementHttp {
    shipping;
    constructor(shipping, identity) {
        super(identity);
        this.shipping = shipping;
    }
    shippingService() { if (!this.shipping)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.shipping; }
    async zones(request, response) {
        this.send(response, request, 200, await this.shippingService().listZones(cookie(request, 'ez_admin_session')));
    }
    async zone(id, request, response) {
        this.send(response, request, 200, await this.shippingService().getZone(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async createZone(body, request, response) {
        await this.write(request, 'ShippingZoneWriteRequest', body);
        this.send(response, request, 201, await this.shippingService().createZone(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async updateZone(id, body, request, response) {
        await this.write(request, 'ShippingZonePatchRequest', body);
        this.send(response, request, 200, await this.shippingService().updateZone(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    async rates(request, response) {
        this.send(response, request, 200, await this.shippingService().listRates(cookie(request, 'ez_admin_session')));
    }
    async rate(id, request, response) {
        this.send(response, request, 200, await this.shippingService().getRate(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async createRate(body, request, response) {
        await this.write(request, 'ShippingRateWriteRequest', body);
        this.send(response, request, 201, await this.shippingService().createRate(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async updateRate(id, body, request, response) {
        await this.write(request, 'ShippingRatePatchRequest', body);
        this.send(response, request, 200, await this.shippingService().updateRate(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
    }
    async preview(body, request, response) {
        await this.write(request, 'ShippingQuotePreviewRequest', body);
        this.send(response, request, 200, await this.shippingService().preview(cookie(request, 'ez_admin_session'), body));
    }
};
__decorate([
    Get('zones'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "zones", null);
__decorate([
    Get('zones/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "zone", null);
__decorate([
    Post('zones'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "createZone", null);
__decorate([
    Patch('zones/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "updateZone", null);
__decorate([
    Get('rates'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "rates", null);
__decorate([
    Get('rates/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "rate", null);
__decorate([
    Post('rates'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "createRate", null);
__decorate([
    Patch('rates/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "updateRate", null);
__decorate([
    Post('quote-preview'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ShippingController.prototype, "preview", null);
ShippingController = __decorate([
    Controller('admin/shipping'),
    __param(0, Inject('SHIPPING')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], ShippingController);
export { ShippingController };
