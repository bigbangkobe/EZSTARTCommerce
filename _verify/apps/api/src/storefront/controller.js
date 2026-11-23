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
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { PREVIEW_ROBOTS_HEADER, PREVIEW_TOKEN_PATTERN } from '../../../../packages/domain/src/preview.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/** 查询参数一律当作不可信输入：长度先收敛，语义再交给服务层判断。 */
function text(value, max) {
    if (value === undefined)
        return null;
    if (typeof value !== 'string' || value.length > max)
        throw new AuthError(422, 'VALIDATION_ERROR');
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
}
let StorefrontController = class StorefrontController extends ManagementHttp {
    storefront;
    constructor(storefront, identity) {
        super(identity);
        this.storefront = storefront;
    }
    front() { if (!this.storefront)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.storefront; }
    async config(locale, marketCode, request, response) {
        this.send(response, request, 200, await this.front().config(text(locale, 10), text(marketCode, 8)));
    }
    async products(locale, marketCode, limit, cursor, query, request, response) {
        const page = this.pagination(limit, cursor);
        this.send(response, request, 200, await this.front().listProducts(text(locale, 10), text(marketCode, 8), page.limit, page.cursor, text(query, 200)));
    }
    async product(slug, locale, marketCode, request, response) {
        if (!/^[^\s/]{1,180}$/.test(slug))
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.send(response, request, 200, await this.front().getProduct(slug, text(locale, 10), text(marketCode, 8)));
    }
    async categories(locale, request, response) {
        this.send(response, request, 200, await this.front().listCategories(text(locale, 10)));
    }
    /**
     * 分类页：分类信息 + 已发布版面（没有版面就带平铺商品）。
     * 缓存与陈列同档 30 秒：分类改名/换版面最多半分钟生效，商品资格仍靠重新读取收敛。
     */
    async category(slug, locale, marketCode, request, response) {
        if (!/^[^\s/]{1,180}$/.test(slug))
            throw new AuthError(422, 'VALIDATION_ERROR');
        response.setHeader('Cache-Control', 'public, max-age=30');
        this.send(response, request, 200, await this.front().getCategory(slug, text(locale, 10), text(marketCode, 8)));
    }
    /** 专题列表：只列启用、有当前语言 slug、且至少有一件可售商品的专题。 */
    async collections(locale, marketCode, request, response) {
        this.send(response, request, 200, await this.front().listCollections(text(locale, 10), text(marketCode, 8)));
    }
    /**
     * 专题页：专题信息 + 已发布版面（没有版面就按编排顺序平铺商品）。
     * 缓存与分类页同档 30 秒：专题改名/换商品最多半分钟生效，商品资格靠重新读取收敛。
     */
    async collection(slug, locale, marketCode, request, response) {
        if (!/^[^\s/]{1,180}$/.test(slug))
            throw new AuthError(422, 'VALIDATION_ERROR');
        response.setHeader('Cache-Control', 'public, max-age=30');
        this.send(response, request, 200, await this.front().getCollection(slug, text(locale, 10), text(marketCode, 8)));
    }
    /**
     * 已发布主题：未发布时 404，前台回退内置默认主题。
     * 缓存 30 秒与陈列同档：主题变更最多半分钟生效。
     */
    async theme(request, response) {
        response.setHeader('Cache-Control', 'public, max-age=30');
        this.send(response, request, 200, await this.front().theme());
    }
    /**
     * 首页陈列：未发布时 404，前台据此退回主题默认布局（配置没做好不能把首页打空）。
     * 缓存 30 秒与重定向清单同档：陈列变更最多半分钟生效，但商品资格失效靠重新读取收敛。
     */
    async merchandising(pageKey, locale, marketCode, request, response) {
        if (!/^[a-z][a-z0-9-]{1,31}$/.test(pageKey))
            throw new AuthError(404, 'NOT_FOUND');
        response.setHeader('Cache-Control', 'public, max-age=30');
        this.send(response, request, 200, await this.front().merchandising(pageKey, text(locale, 10), text(marketCode, 8)));
    }
    async pages(locale, request, response) {
        this.send(response, request, 200, await this.front().listPages(text(locale, 10)));
    }
    async page(slug, locale, request, response) {
        if (!/^[^\s/]{1,180}$/.test(slug))
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.send(response, request, 200, await this.front().getPage(slug, text(locale, 10)));
    }
    /**
     * 预览外链：草稿内容只在带有效 token 时下发，且明确禁止缓存与收录。
     * 这里不写埋点、不改发布标记：预览是只读检查，不能污染线上统计。
     */
    async preview(token, request, response) {
        if (!PREVIEW_TOKEN_PATTERN.test(token))
            throw new AuthError(404, 'NOT_FOUND');
        response.setHeader('Cache-Control', 'no-store, max-age=0');
        response.setHeader('X-Robots-Tag', PREVIEW_ROBOTS_HEADER);
        this.send(response, request, 200, await this.front().getPreview(token));
    }
    /** 重定向清单：前台入口层缓存 30 秒后在本地匹配，命中即 301，不再回源。 */
    async redirects(request, response) {
        response.setHeader('Cache-Control', 'public, max-age=30');
        this.send(response, request, 200, await this.front().listRedirects());
    }
    /** 旧地址查询：只回最终目标，前台据此发 301；没有记录时 redirect=null。 */
    async redirect(path, request, response) {
        const value = text(path, 300);
        if (!value)
            throw new AuthError(422, 'VALIDATION_ERROR');
        this.send(response, request, 200, await this.front().redirect(value));
    }
};
__decorate([
    Get('config'),
    __param(0, Query('locale')),
    __param(1, Query('marketCode')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "config", null);
__decorate([
    Get('products'),
    __param(0, Query('locale')),
    __param(1, Query('marketCode')),
    __param(2, Query('limit')),
    __param(3, Query('cursor')),
    __param(4, Query('q')),
    __param(5, Req()),
    __param(6, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "products", null);
__decorate([
    Get('products/:slug'),
    __param(0, Param('slug')),
    __param(1, Query('locale')),
    __param(2, Query('marketCode')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "product", null);
__decorate([
    Get('categories'),
    __param(0, Query('locale')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "categories", null);
__decorate([
    Get('categories/:slug'),
    __param(0, Param('slug')),
    __param(1, Query('locale')),
    __param(2, Query('marketCode')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "category", null);
__decorate([
    Get('collections'),
    __param(0, Query('locale')),
    __param(1, Query('marketCode')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "collections", null);
__decorate([
    Get('collections/:slug'),
    __param(0, Param('slug')),
    __param(1, Query('locale')),
    __param(2, Query('marketCode')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "collection", null);
__decorate([
    Get('theme'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "theme", null);
__decorate([
    Get('merchandising/:pageKey'),
    __param(0, Param('pageKey')),
    __param(1, Query('locale')),
    __param(2, Query('marketCode')),
    __param(3, Req()),
    __param(4, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "merchandising", null);
__decorate([
    Get('pages'),
    __param(0, Query('locale')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "pages", null);
__decorate([
    Get('pages/:slug'),
    __param(0, Param('slug')),
    __param(1, Query('locale')),
    __param(2, Req()),
    __param(3, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "page", null);
__decorate([
    Get('preview/:token'),
    __param(0, Param('token')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "preview", null);
__decorate([
    Get('redirects'),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "redirects", null);
__decorate([
    Get('redirect'),
    __param(0, Query('path')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], StorefrontController.prototype, "redirect", null);
StorefrontController = __decorate([
    Controller('storefront'),
    __param(0, Inject('STOREFRONT')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], StorefrontController);
export { StorefrontController };
