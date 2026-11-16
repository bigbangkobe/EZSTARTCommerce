import { Body, Controller, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { ShippingService, type RateBody, type ZoneBody } from './service.js';

@Controller('admin/shipping')
export class ShippingController extends ManagementHttp {
  constructor(@Inject('SHIPPING') private readonly shipping: ShippingService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private shippingService() { if (!this.shipping) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.shipping; }

  @Get('zones')
  async zones(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.shippingService().listZones(cookie(request, 'ez_admin_session')));
  }

  @Get('zones/:id')
  async zone(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.shippingService().getZone(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('zones')
  async createZone(@Body() body: ZoneBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ShippingZoneWriteRequest', body);
    this.send(response, request, 201, await this.shippingService().createZone(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Patch('zones/:id')
  async updateZone(@Param('id') id: string, @Body() body: ZoneBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ShippingZonePatchRequest', body);
    this.send(response, request, 200, await this.shippingService().updateZone(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }

  @Get('rates')
  async rates(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.shippingService().listRates(cookie(request, 'ez_admin_session')));
  }

  @Get('rates/:id')
  async rate(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.shippingService().getRate(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('rates')
  async createRate(@Body() body: RateBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ShippingRateWriteRequest', body);
    this.send(response, request, 201, await this.shippingService().createRate(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Patch('rates/:id')
  async updateRate(@Param('id') id: string, @Body() body: RateBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ShippingRatePatchRequest', body);
    this.send(response, request, 200, await this.shippingService().updateRate(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }

  @Post('quote-preview')
  async preview(@Body() body: { address: { countryCode: string; regionCode?: string | null; addressLine1: string };
    merchandiseSubtotalMinor: number; currency: string }, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ShippingQuotePreviewRequest', body);
    this.send(response, request, 200, await this.shippingService().preview(cookie(request, 'ez_admin_session'), body));
  }
}
