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
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 订单后台接口（M07）。所有写操作都要求会话 + CSRF + Origin，
 * 取消/改址/包裹/发货/签收另需 Idempotency-Key；发货还需要 If-Match 版本。
 */
let OrdersController = class OrdersController extends ManagementHttp {
    orders;
    constructor(orders, identity) {
        super(identity);
        this.orders = orders;
    }
    ordersService() { if (!this.orders)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.orders; }
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
    async list(limit, cursor, query, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.ordersService().list(cookie(request, 'ez_admin_session'), page.limit, page.cursor, this.query(query)));
    }
    async detail(id, request, response) {
        this.send(response, request, 200, await this.ordersService().get(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async cancel(id, body, request, response) {
        await this.write(request, 'OrderCancelRequest', body);
        this.send(response, request, 200, await this.ordersService().cancel(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async addressChange(id, body, request, response) {
        await this.write(request, 'OrderAddressChangeRequest', body);
        this.send(response, request, 200, await this.ordersService().changeAddress(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async note(id, body, request, response) {
        await this.write(request, 'OrderNoteRequest', body);
        this.send(response, request, 201, await this.ordersService().addNote(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body, this.context(request)));
    }
    async shipment(id, body, request, response) {
        await this.write(request, 'ShipmentCreateRequest', body);
        this.send(response, request, 201, await this.ordersService().createShipment(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
    async dispatch(id, body, request, response) {
        await this.write(request, 'ShipmentDispatchRequest', body);
        this.send(response, request, 200, await this.ordersService().dispatchShipment(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), this.version(request), body, this.context(request)));
    }
    async deliver(id, body, request, response) {
        await this.write(request, 'ShipmentDeliverRequest', body);
        this.send(response, request, 200, await this.ordersService().deliverShipment(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
    }
};
__decorate([
    Get('orders'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('q')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "list", null);
__decorate([
    Get('orders/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "detail", null);
__decorate([
    Post('orders/:id/cancel'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "cancel", null);
__decorate([
    Post('orders/:id/address-change'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "addressChange", null);
__decorate([
    Post('orders/:id/notes'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "note", null);
__decorate([
    Post('orders/:id/shipments'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "shipment", null);
__decorate([
    Post('shipments/:id/dispatch'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "dispatch", null);
__decorate([
    Post('shipments/:id/deliver'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], OrdersController.prototype, "deliver", null);
OrdersController = __decorate([
    Controller('admin'),
    __param(0, Inject('ORDERS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], OrdersController);
export { OrdersController };
