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
import { cookie, header } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError } from '../identity/service.js';
/**
 * 交易经营报表（M14）。读报表要 reports.view；导出与下载要 reports.export。
 * 报表不返回任何顾客/订单明细——只有按币种分组的聚合数值与覆盖率说明。
 */
let ReportsController = class ReportsController extends ManagementHttp {
    reports;
    constructor(reports, identity) {
        super(identity);
        this.reports = reports;
    }
    reportsService() { if (!this.reports)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.reports; }
    idempotency(request) {
        const key = header(request, 'idempotency-key');
        if (key.length < 16 || key.length > 128)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return key;
    }
    optional(value) {
        if (value === undefined)
            return undefined;
        if (typeof value !== 'string' || value.length > 64)
            throw new AuthError(422, 'VALIDATION_ERROR');
        return value.length ? value : undefined;
    }
    async report(reportKey, from, to, timezone, marketCode, paymentMethodCode, locale, deviceClass, source, groupBy, pageKey, sectionKey, publishVersionId, request, response) {
        const result = await this.reportsService().report(cookie(request, 'ez_admin_session'), reportKey, {
            from, to, timezone,
            ...(this.optional(marketCode) ? { marketCode: this.optional(marketCode) } : {}),
            ...(this.optional(paymentMethodCode) ? { paymentMethodCode: this.optional(paymentMethodCode) } : {}),
            ...(this.optional(locale) ? { locale: this.optional(locale) } : {}),
            ...(this.optional(deviceClass) ? { deviceClass: this.optional(deviceClass) } : {}),
            ...(this.optional(source) ? { source: this.optional(source) } : {}),
            ...(this.optional(groupBy) ? { groupBy: this.optional(groupBy) } : {}),
            ...(this.optional(pageKey) ? { pageKey: this.optional(pageKey) } : {}),
            ...(this.optional(sectionKey) ? { sectionKey: this.optional(sectionKey) } : {}),
            ...(this.optional(publishVersionId) ? { publishVersionId: this.optional(publishVersionId) } : {}),
        });
        this.send(response, request, 200, result);
    }
    async createExport(body, request, response) {
        await this.write(request, 'ReportExportRequest', body);
        const data = await this.reportsService().createExport(cookie(request, 'ez_admin_session'), header(request, 'x-csrf-token'), this.idempotency(request), body, this.context(request));
        this.send(response, request, 202, data);
    }
    async getExport(id, request, response) {
        this.send(response, request, 200, await this.reportsService().getExport(cookie(request, 'ez_admin_session'), id));
    }
    async download(id, request, response) {
        const { fileName, content } = await this.reportsService().downloadExport(cookie(request, 'ez_admin_session'), id);
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/csv; charset=utf-8');
        response.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/["\r\n]/g, '_')}"`);
        response.setHeader('Cache-Control', 'no-store');
        response.end(content);
    }
};
__decorate([
    Get('reports/:reportKey'),
    __param(0, Param('reportKey')),
    __param(1, Query('from')),
    __param(2, Query('to')),
    __param(3, Query('timezone')),
    __param(4, Query('marketCode')),
    __param(5, Query('paymentMethodCode')),
    __param(6, Query('locale')),
    __param(7, Query('deviceClass')),
    __param(8, Query('source')),
    __param(9, Query('groupBy')),
    __param(10, Query('pageKey')),
    __param(11, Query('sectionKey')),
    __param(12, Query('publishVersionId')),
    __param(13, Req()),
    __param(14, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object, Object, Object, Object, Object, Object, Object, Object, Object, Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "report", null);
__decorate([
    Post('report-exports'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Function]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "createExport", null);
__decorate([
    Get('report-exports/:id'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "getExport", null);
__decorate([
    Get('report-exports/:id/download'),
    __param(0, Param('id')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Function]),
    __metadata("design:returntype", Promise)
], ReportsController.prototype, "download", null);
ReportsController = __decorate([
    Controller('admin'),
    __param(0, Inject('REPORTS')),
    __param(1, Inject('IDENTITY')),
    __metadata("design:paramtypes", [Object, Object])
], ReportsController);
export { ReportsController };
