import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { OrdersService, type AddressChangeBody, type DeliverBody, type DispatchBody, type ShipmentBody } from './service.js';

/**
 * 订单后台接口（M07）。所有写操作都要求会话 + CSRF + Origin，
 * 取消/改址/包裹/发货/签收另需 Idempotency-Key；发货还需要 If-Match 版本。
 */
@Controller('admin')
export class OrdersController extends ManagementHttp {
  constructor(@Inject('ORDERS') private readonly orders: OrdersService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private ordersService() { if (!this.orders) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.orders; }

  private idempotency(request: ApiRequest) {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') throw new AuthError(422, 'VALIDATION_ERROR');
    return key;
  }

  private query(value: unknown) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > 200) throw new AuthError(422, 'VALIDATION_ERROR');
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  @Get('orders')
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('q') query: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.ordersService().list(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor, this.query(query)));
  }

  @Get('orders/:id')
  async detail(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.ordersService().get(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('orders/:id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { reasonCode?: string | null; reason: string;
    expectedVersion: number; customerNotified?: boolean }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'OrderCancelRequest', body);
    this.send(response, request, 200, await this.ordersService().cancel(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('orders/:id/address-change')
  async addressChange(@Param('id') id: string, @Body() body: AddressChangeBody,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'OrderAddressChangeRequest', body);
    this.send(response, request, 200, await this.ordersService().changeAddress(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('orders/:id/notes')
  async note(@Param('id') id: string, @Body() body: { note: string },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'OrderNoteRequest', body);
    this.send(response, request, 201, await this.ordersService().addNote(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), body, this.context(request)));
  }

  @Post('orders/:id/shipments')
  async shipment(@Param('id') id: string, @Body() body: ShipmentBody,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ShipmentCreateRequest', body);
    this.send(response, request, 201, await this.ordersService().createShipment(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }

  @Post('shipments/:id/dispatch')
  async dispatch(@Param('id') id: string, @Body() body: DispatchBody,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ShipmentDispatchRequest', body);
    this.send(response, request, 200, await this.ordersService().dispatchShipment(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), this.version(request), body, this.context(request)));
  }

  @Post('shipments/:id/deliver')
  async deliver(@Param('id') id: string, @Body() body: DeliverBody,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ShipmentDeliverRequest', body);
    this.send(response, request, 200, await this.ordersService().deliverShipment(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.idempotency(request), body, this.context(request)));
  }
}
