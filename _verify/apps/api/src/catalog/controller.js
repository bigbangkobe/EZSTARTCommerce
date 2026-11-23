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
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { cookie, header, uuid } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
let CatalogController = class CatalogController extends ManagementHttp {
    catalog;
    constructor(catalog, identity) {
        super(identity);
        this.catalog = catalog;
    }
    catalogService() { if (!this.catalog)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.catalog; }
    writeContext(request) { return this.context(request); }
    query(query) {
        if (query === undefined)
            return null;
        if (typeof query !== 'string' || query.length > 200)
            throw new AuthError(422, 'VALIDATION_ERROR');
        const value = query.trim();
        return value.length ? value : null;
    }
    async categories(request, response) {
        this.send(response, request, 200, await this.catalogService().listCategories(cookie(request, 'ez_admin_session')));
    }
    async category(id, request, response) {
        this.send(response, request, 200, await this.catalogService().getCategory(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async createCategory(body, request, response) {
        await this.write(request, 'CategoryWriteRequest', body);
        this.send(response, request, 201, await this.catalogService().createCategory(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.writeContext(request)));
    }
    async updateCategory(id, body, request, response) {
        await this.write(request, 'CategoryPatchRequest', body);
        this.send(response, request, 200, await this.catalogService().updateCategory(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.writeContext(request)));
    }
    async brands(request, response) {
        this.send(response, request, 200, await this.catalogService().listBrands(cookie(request, 'ez_admin_session')));
    }
    async brand(id, request, response) {
        this.send(response, request, 200, await this.catalogService().getBrand(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async createBrand(body, request, response) {
        await this.write(request, 'BrandWriteRequest', body);
        this.send(response, request, 201, await this.catalogService().createBrand(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.writeContext(request)));
    }
    async updateBrand(id, body, request, response) {
        await this.write(request, 'BrandPatchRequest', body);
        this.send(response, request, 200, await this.catalogService().updateBrand(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.writeContext(request)));
    }
    async products(limit, cursor, query, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.catalogService().listProducts(cookie(request, 'ez_admin_session'), page.limit, page.cursor, this.query(query)));
    }
    async product(id, request, response) {
        this.send(response, request, 200, await this.catalogService().getProduct(cookie(request, 'ez_admin_session'), uuid(id)));
    }
    async createProduct(body, request, response) {
        await this.write(request, 'ProductWriteRequest', body);
        this.send(response, request, 201, await this.catalogService().createProduct(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), body, this.writeContext(request)));
    }
    async updateProduct(id, body, request, response) {
        await this.write(request, 'ProductPatchRequest', body);
        this.send(response, request, 200, await this.catalogService().updateProduct(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), this.version(request), body, this.writeContext(request)));
    }
    async publish(id, body, request, response) {
        await this.write(request, 'ProductPublishRequest', body);
        this.send(response, request, 200, await this.catalogService().publishProduct(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body, this.writeContext(request)));
    }
    async unpublish(id, body, request, response) {
        await this.write(request, 'ReasonRequest', body);
        this.send(response, request, 200, await this.catalogService().unpublishProduct(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), uuid(id), body, this.writeContext(request)));
    }
};
__decorate([
    Get('categories'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "categories", null);
__decorate([
    Get('categories/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "category", null);
__decorate([
    Post('categories'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "createCategory", null);
__decorate([
    Patch('categories/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "updateCategory", null);
__decorate([
    Get('brands'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "brands", null);
__decorate([
    Get('brands/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "brand", null);
__decorate([
    Post('brands'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "createBrand", null);
__decorate([
    Patch('brands/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "updateBrand", null);
__decorate([
    Get('products'),
    __param(0, Query('limit')),
    __param(1, Query('cursor')),
    __param(2, Query('q')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "products", null);
__decorate([
    Get('products/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "product", null);
__decorate([
    Post('products'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "createProduct", null);
__decorate([
    Patch('products/:id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "updateProduct", null);
__decorate([
    Post('products/:id/publish'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "publish", null);
__decorate([
    Post('products/:id/unpublish'),
    __param(0, Param('id')),
    __param(1, Body()),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], CatalogController.prototype, "unpublish", null);
CatalogController = __decorate([
    Controller('admin'),
    __param(0, Inject('CATALOG')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], CatalogController);
export { CatalogController };
