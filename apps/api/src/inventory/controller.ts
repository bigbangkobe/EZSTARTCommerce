import { Body, Controller, Get, Inject, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { InventoryService } from './service.js';

/**
 * 库存后台（M12）。读接口只要 inventory.read；调整要 inventory.adjust + CSRF + Origin + Idempotency-Key，
 * 阈值要 inventory.manage + CSRF。没有“把现存量设成 X”的接口——只有增量流水。
 */
@Controller('admin')
export class InventoryController extends ManagementHttp {
  constructor(@Inject('INVENTORY') private readonly inventory: InventoryService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private inventoryService() { if (!this.inventory) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.inventory; }

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

  private flag(value: unknown) {
    if (value === undefined) return false;
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    throw new AuthError(422, 'VALIDATION_ERROR');
  }

  @Get('inventory')
  async list(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('q') q: unknown,
    @Query('variantId') variantId: unknown, @Query('lowStock') lowStock: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, undefined);
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor.trim().length)) throw new AuthError(422, 'VALIDATION_ERROR');
    this.send(response, request, 200, await this.inventoryService().list(cookie(request, 'ez_admin_session'),
      page.limit, typeof cursor === 'string' ? cursor.trim() : null,
      { q: this.query(q), variantId: this.query(variantId), lowStock: this.flag(lowStock) }));
  }

  @Get('inventory/movements')
  async movements(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('variantId') variantId: unknown,
    @Query('type') type: unknown, @Query('orderId') orderId: unknown, @Query('caseId') caseId: unknown,
    @Query('from') from: unknown, @Query('to') to: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.inventoryService().movements(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor, { variantId: this.query(variantId), type: this.query(type), orderId: this.query(orderId),
        caseId: this.query(caseId), from: this.query(from), to: this.query(to) }));
  }

  @Get('inventory/thresholds')
  async thresholds(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, undefined);
    this.send(response, request, 200, await this.inventoryService().listThresholds(cookie(request, 'ez_admin_session'),
      page.limit, typeof cursor === 'string' && cursor.trim().length ? cursor.trim() : null));
  }

  @Patch('inventory/thresholds')
  async setThreshold(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'InventoryThresholdRequest', body);
    this.send(response, request, 200, await this.inventoryService().setThreshold(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Post('inventory/adjustments')
  async adjust(@Body() body: Record<string, unknown>, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'InventoryAdjustmentRequest', body);
    this.send(response, request, 201, await this.inventoryService().adjust(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), this.idempotency(request), body, this.context(request)));
  }
}
