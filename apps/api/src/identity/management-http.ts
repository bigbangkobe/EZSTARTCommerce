import type { ServerResponse } from 'node:http';
import { IdentityContracts } from './contracts.js';
import { header, uuid, type ApiRequest } from './controller.js';
import { originAllowed } from './config.js';
import { AuthError, IdentityService } from './service.js';

export class ManagementHttp {
  private readonly contracts = new IdentityContracts();
  constructor(private readonly identity: IdentityService | null) {}
  protected service() { if (!this.identity) throw new AuthError(503, 'SERVICE_NOT_READY'); return this.identity; }
  protected context(request: ApiRequest) { return { requestId: request.requestId, ip: request.socket.remoteAddress ?? 'unknown' }; }
  /** 无请求体的写操作（如 DELETE）：只做来源与限流，不校验 body。 */
  protected async guardWrite(request: ApiRequest) {
    const service = this.service();
    if (!originAllowed(service.config, header(request, 'origin'))) throw new AuthError(403, 'FORBIDDEN');
    await service.limitIp(this.context(request));
    return service;
  }
  protected async write(request: ApiRequest, schema: string, body: unknown) {
    const service = await this.guardWrite(request);
    this.contracts.assert(schema, body);
    return service;
  }
  protected send(response: ServerResponse, request: ApiRequest, status: number, data: unknown, etagVersion?: number) {
    response.statusCode = status;
    // 204 不能带响应体：与契约一致，删掉资源后只回状态码。
    if (status === 204) { response.end(); return; }
    // 资源版本既可能来自 data.version，也可能是外层返回的新版本（如审核后返回配置版本）。
    const version = etagVersion ?? (data && typeof data === 'object' && 'version' in data ? Number((data as { version: unknown }).version) : undefined);
    if (version !== undefined && Number.isSafeInteger(version) && version > 0) response.setHeader('ETag', `"${version}"`);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ data, meta: { requestId: request.requestId } }));
  }
  protected version(request: ApiRequest) {
    const match = /^"([1-9][0-9]*)"$/.exec(header(request, 'if-match')); const version = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(version)) throw new AuthError(422, 'VALIDATION_ERROR');
    return version;
  }
  protected pagination(limit: unknown, cursor: unknown) {
    if (limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit))) throw new AuthError(422, 'VALIDATION_ERROR');
    const size = limit === undefined ? 25 : Number(limit);
    if (size < 1 || size > 100 || (cursor !== undefined && typeof cursor !== 'string')) throw new AuthError(422, 'VALIDATION_ERROR');
    return { limit: size, cursor: cursor ? uuid(cursor as string) : null };
  }
}
