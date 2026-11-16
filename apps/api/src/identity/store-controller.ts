import { Body, Controller, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, type ApiRequest } from './controller.js';
import { ManagementHttp } from './management-http.js';
import { IdentityService } from './service.js';
import type { MarketInput, ReviewDecision } from '../../../../packages/domain/src/store.js';

type StoreBody = { displayName?: string; locales?: string[]; defaultLocale?: string; baseCurrency?: string; timezone?: string;
  marketProfiles?: MarketInput[]; featureFlags?: Record<string, boolean>;
  brandAssets?: { logoMediaId?: string | null; faviconMediaId?: string | null } };
type ReviewBody = { decision: ReviewDecision; evidenceReference: string; reason: string; validUntil: string | null; confirmedMarketCode: string };

@Controller('admin/store-config')
export class StoreController extends ManagementHttp {
  constructor(@Inject('IDENTITY') identity: IdentityService | null) { super(identity); }

  @Get()
  async read(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.service().storeConfiguration(cookie(request, 'ez_admin_session')));
  }

  @Patch()
  async update(@Body() body: StoreBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'StoreConfigPatchRequest', body);
    this.send(response, request, 200, await service.updateStoreConfiguration(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), this.version(request), body, this.context(request)));
  }

  @Post('markets/:marketCode/reviews')
  async review(@Param('marketCode') marketCode: string, @Body() body: ReviewBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const service = await this.write(request, 'MarketReviewRequest', body);
    const result = await service.recordMarketReview(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'),
      marketCode, this.version(request), body, this.context(request));
    this.send(response, request, 200, result.data, result.version);
  }
}
