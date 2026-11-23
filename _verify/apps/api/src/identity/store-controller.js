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
import { cookie, header } from './controller.js';
import { ManagementHttp } from './management-http.js';
let StoreController = class StoreController extends ManagementHttp {
    constructor(identity) { super(identity); }
    async read(request, response) {
        this.send(response, request, 200, await this.service().storeConfiguration(cookie(request, 'ez_admin_session')));
    }
    async update(body, request, response) {
        const service = await this.write(request, 'StoreConfigPatchRequest', body);
        this.send(response, request, 200, await service.updateStoreConfiguration(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), this.version(request), body, this.context(request)));
    }
    async review(marketCode, body, request, response) {
        const service = await this.write(request, 'MarketReviewRequest', body);
        const result = await service.recordMarketReview(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), marketCode, this.version(request), body, this.context(request));
        this.send(response, request, 200, result.data, result.version);
    }
};
__decorate([
    Get(),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], StoreController.prototype, "read", null);
__decorate([
    Patch(),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StoreController.prototype, "update", null);
__decorate([
    Post('markets/:marketCode/reviews'),
    __param(0, Param('marketCode')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StoreController.prototype, "review", null);
StoreController = __decorate([
    Controller('admin/store-config'),
    __param(0, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object])
], StoreController);
export { StoreController };
