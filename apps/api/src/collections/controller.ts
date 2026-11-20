import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { CollectionService, type CollectionBody } from './service.js';

/**
 * 后台专题接口（M04 第五批）。
 * 权限沿用内容域（content.read / content.write）：专题是策展内容，不是商品目录本身。
 */
@Controller('admin')
export class CollectionsController extends ManagementHttp {
  constructor(@Inject('COLLECTIONS') private readonly collections: CollectionService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private serviceOrFail() { if (!this.collections) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.collections; }

  @Get('collections')
  async list(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200,
      await this.serviceOrFail().list(cookie(request, 'ez_admin_session')));
  }

  @Get('collections/:id')
  async get(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200,
      await this.serviceOrFail().get(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('collections')
  async create(@Body() body: CollectionBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'CollectionWriteRequest', body);
    this.send(response, request, 201, await this.serviceOrFail().create(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.context(request)));
  }

  @Patch('collections/:id')
  async update(@Param('id') id: string, @Body() body: CollectionBody, @Req() request: ApiRequest,
    @Res() response: ServerResponse) {
    await this.write(request, 'CollectionPatchRequest', body);
    this.send(response, request, 200, await this.serviceOrFail().update(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.context(request)));
  }

  @Delete('collections/:id')
  async remove(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.guardWrite(request);
    await this.serviceOrFail().remove(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'),
      uuid(id), this.context(request));
    this.send(response, request, 204, null);
  }
}
