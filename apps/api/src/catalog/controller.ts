import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { cookie, header, uuid, type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { CatalogService, type BrandBody, type CategoryBody, type ProductBody } from './service.js';

@Controller('admin')
export class CatalogController extends ManagementHttp {
  constructor(@Inject('CATALOG') private readonly catalog: CatalogService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }
  private catalogService() { if (!this.catalog) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.catalog; }
  private writeContext(request: ApiRequest) { return this.context(request); }
  private query(query: unknown) {
    if (query === undefined) return null;
    if (typeof query !== 'string' || query.length > 200) throw new AuthError(422, 'VALIDATION_ERROR');
    const value = query.trim(); return value.length ? value : null;
  }

  @Get('categories')
  async categories(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.catalogService().listCategories(cookie(request, 'ez_admin_session')));
  }

  @Get('categories/:id')
  async category(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.catalogService().getCategory(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('categories')
  async createCategory(@Body() body: CategoryBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'CategoryWriteRequest', body);
    this.send(response, request, 201, await this.catalogService().createCategory(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.writeContext(request)));
  }

  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() body: CategoryBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'CategoryPatchRequest', body);
    this.send(response, request, 200, await this.catalogService().updateCategory(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.writeContext(request)));
  }

  @Get('brands')
  async brands(@Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.catalogService().listBrands(cookie(request, 'ez_admin_session')));
  }

  @Get('brands/:id')
  async brand(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.catalogService().getBrand(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('brands')
  async createBrand(@Body() body: BrandBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'BrandWriteRequest', body);
    this.send(response, request, 201, await this.catalogService().createBrand(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.writeContext(request)));
  }

  @Patch('brands/:id')
  async updateBrand(@Param('id') id: string, @Body() body: BrandBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'BrandPatchRequest', body);
    this.send(response, request, 200, await this.catalogService().updateBrand(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.writeContext(request)));
  }

  @Get('products')
  async products(@Query('limit') limit: unknown, @Query('cursor') cursor: unknown, @Query('q') query: unknown,
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    const page = this.pagination(limit, cursor);
    this.send(response, request, 200, await this.catalogService().listProducts(cookie(request, 'ez_admin_session'),
      page.limit, page.cursor, this.query(query)));
  }

  @Get('products/:id')
  async product(@Param('id') id: string, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    this.send(response, request, 200, await this.catalogService().getProduct(cookie(request, 'ez_admin_session'), uuid(id)));
  }

  @Post('products')
  async createProduct(@Body() body: ProductBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ProductWriteRequest', body);
    this.send(response, request, 201, await this.catalogService().createProduct(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), body, this.writeContext(request)));
  }

  @Patch('products/:id')
  async updateProduct(@Param('id') id: string, @Body() body: ProductBody, @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ProductPatchRequest', body);
    this.send(response, request, 200, await this.catalogService().updateProduct(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.writeContext(request)));
  }

  @Post('products/:id/publish')
  async publish(@Param('id') id: string, @Body() body: { expectedVersion: number; marketCodes: string[]; publishedAt?: string | null },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ProductPublishRequest', body);
    this.send(response, request, 200, await this.catalogService().publishProduct(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), body, this.writeContext(request)));
  }

  @Post('products/:id/unpublish')
  async unpublish(@Param('id') id: string, @Body() body: { reason: string; reasonCode?: string | null },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    await this.write(request, 'ReasonRequest', body);
    this.send(response, request, 200, await this.catalogService().unpublishProduct(cookie(request, 'ez_admin_session'),
      header(request, 'x-csrf-token'), uuid(id), body, this.writeContext(request)));
  }
}
