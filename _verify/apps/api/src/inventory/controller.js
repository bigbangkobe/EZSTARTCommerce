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
import { Body, Controller, Get, Inject, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { cookie, header } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 库存后台（M12）。读接口只要 inventory.read；调整要 inventory.adjust + CSRF + Origin + Idempotency-Key，
 * 阈值要 inventory.manage + CSRF。没有“把现存量设成 X”的接口——只有增量流水。
 */
let InventoryController = class InventoryController extends ManagementHttp {
    inventory;
    constructor(inventory, identity) {
        super(identity);
        this.inventory = inventory;
    }
    inventoryService() { if (!this.inventory)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.inventory; }
    idempotency(request) {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string')
            throw new AuthError(422, 'VALIDATION_ERROR');
        return key;
    }
    query(value) {
        if (value === undefined)
            return null;
        if (typeof value !== 'string' || value.length > 200)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    flag(value) {
        if (value === undefined)
            return false;
        if (value === '1' || value === 'true')
            return true;
        if (value === '0' || value === 'false')
            return false;
        throw new AuthError(422, 'VALIDATION_ERROR');
    }
    async list(limit, cursor, q, variantId, lowStock, request, response) {
        const page = this.pagination(limit, undefined);
        if (cursor !== undefined && (typeof cursor !== 'string' || !cursor.trim().length))
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.send(response, request, 200, await this.inventoryService().list(cookie(request, 'ez_admin_session'), page.limit, typeof cursor === 'string' ? cursor.trim() : null, { q: this.query(q), variantId: this.query(variantId), lowStock: this.flag(lowStock) }));
    }
    async movements(limit, cursor, variantId, type, orderId, caseId, from, to, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.inventoryService().movements(cookie(request, 'ez_admin_session'), page.limit, page.cursor, { variantId: this.query(variantId), type: this.query(type), orderId: this.query(orderId),
            caseId: this.query(caseId), from: this.query(from), to: this.query(to) }));
    }
    async thresholds(limit, cursor, request, response) {
        const page = this.pagination(limit, undefined);
        this.send(response, request, 200, await this.inventoryService().listThresholds(cookie(request, 'ez_admin_session'), page.limit, typeof cursor === 'string' && cursor.trim().length ? cursor.trim() : null));
    }
    async setThreshold(body, request, response) {
        await this.write(request, 'InventoryThresholdsPatchRequest', body);
        this.send(response, request, 200, await this.inventoryService().setThreshold(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.context(request)));
    }
    async adjust(body, request, response) {
        await this.write(request, 'InventoryAdjustmentRequest', body);
        this.send(response, request, 201, await this.inventoryService().adjust(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), this.idempotency(request), body, this.context(request)));
    }
};
__decorate([
    Get('inventory'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('q')),
    __param(3, Query('variantId')),
    __param(4, Query('lowStock')),
    __param(5, Req()),
    __param(6, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], InventoryController.prototype, "list", null);
__decorate([
    Get('inventory/movements'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('variantId')),
    __param(3, Query('type')),
    __param(4, Query('orderId')),
    __param(5, Query('caseId')),
    __param(6, Query('from')),
    __param(7, Query('to')),
    __param(8, Req()),
    __param(9, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], InventoryController.prototype, "movements", null);
__decorate([
    Get('inventory/thresholds'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], InventoryController.prototype, "thresholds", null);
__decorate([
    Patch('inventory/thresholds'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], InventoryController.prototype, "setThreshold", null);
__decorate([
    Post('inventory/adjustments'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], InventoryController.prototype, "adjust", null);
InventoryController = __decorate([
    Controller('admin'),
    __param(0, Inject('INVENTORY')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], InventoryController);
export { InventoryController };
