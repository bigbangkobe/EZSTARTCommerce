import { Body, Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { type ApiRequest } from '../identity/controller.js';
import { IdentityContracts } from '../identity/contracts.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { CarrierWebhookService } from './service.js';

function header(request: ApiRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

/** 公开 HMAC webhook：无管理员会话、无 CSRF；身份由签名与时间窗证明。 */
@Controller('webhooks/carriers')
export class CarrierWebhookController extends ManagementHttp {
  private readonly schemas = new IdentityContracts();
  constructor(@Inject('CARRIER_WEBHOOKS') private readonly carrier: CarrierWebhookService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private carrierService() { if (!this.carrier) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.carrier; }

  @Post(':carrierCode')
  async receive(@Param('carrierCode') carrierCode: string, @Body() body: Record<string, unknown>,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.schemas.assert('CarrierStatusEventRequest', body);
    const ack = await this.carrierService().receive(carrierCode, body,
      header(request, 'x-carrier-signature'), header(request, 'x-carrier-timestamp'), this.context(request));
    this.send(response, request, 202, ack);
  }
}
