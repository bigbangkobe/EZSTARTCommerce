import { IdentityContracts } from './contracts.js';
import { header, uuid } from './controller.js';
import { originAllowed } from './config.js';
import { AuthError } from './service.js';
export class ManagementHttp {
    identity;
    contracts = new IdentityContracts();
    constructor(identity) {
        this.identity = identity;
    }
    service() { if (!this.identity)
        throw new AuthError(503, 'SERVICE_NOT_READY'); return this.identity; }
    context(request) { return { requestId: request.requestId, ip: request.socket.remoteAddress ?? 'unknown' }; }
    /** 无请求体的写操作（如 DELETE）：只做来源与限流，不校验 body。 */
    async guardWrite(request) {
        const service = this.service();
        if (!originAllowed(service.config, header(request, 'origin')))
            throw new AuthError(403, 'FORBIDDEN');
        await service.limitIp(this.context(request));
        return service;
    }
    async write(request, schema, body) {
        const service = await this.guardWrite(request);
        this.contracts.assert(schema, body);
        return service;
    }
    send(response, request, status, data, etagVersion) {
        response.statusCode = status;
        // 204 不能带响应体：与契约一致，删掉资源后只回状态码。
        if (status === 204) {
            response.end();
            return;
        }
        // 资源版本既可能来自 data.version，也可能是外层返回的新版本（如审核后返回配置版本）。
        const version = etagVersion ?? (data && typeof data === 'object' && 'version' in data ? Number(data.version) : undefined);
        if (version !== undefined && Number.isSafeInteger(version) && version > 0)
            response.setHeader('ETag', `"${version}"`);
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ data, meta: { requestId: request.requestId } }));
    }
    version(request) {
        const match = /^"([1-9][0-9]*)"$/.exec(header(request, 'if-match'));
        const version = Number(match?.[1]);
        if (!match || !Number.isSafeInteger(version))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return version;
    }
    pagination(limit, cursor) {
        if (limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit)))
            throw new AuthError(422, 'VALIDATION_ERROR');
        const size = limit === undefined ? 25 : Number(limit);
        if (size < 1 || size > 100 || (cursor !== undefined && typeof cursor !== 'string'))
            throw new AuthError(422, 'VALIDATION_ERROR');
        return { limit: size, cursor: cursor ? uuid(cursor) : null };
    }
}
