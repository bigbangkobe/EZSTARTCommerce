import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ArgumentsHost, Catch, Controller, Get, HttpException, Inject, Module, Req, ServiceUnavailableException } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditController } from './identity/audit-controller.js';
import { RolesController } from './identity/roles-controller.js';
import { StoreController } from './identity/store-controller.js';
import { StaffController } from './identity/staff-controller.js';
import { IdentityController } from './identity/controller.js';
import { AuthError, IdentityService } from './identity/service.js';
import { ContractValidationError } from './identity/contracts.js';

type ApiRequest = IncomingMessage & { requestId: string };

@Controller('health')
class HealthController {
  constructor(@Inject('IDENTITY') private readonly identity: IdentityService | null) {}
  @Get('live')
  live(@Req() request: ApiRequest) {
    return { data: { status: 'alive' as const }, meta: { requestId: request.requestId } };
  }

  @Get('ready')
  async ready(@Req() request: ApiRequest) {
    if (!this.identity || !await this.identity.ready()) throw new ServiceUnavailableException();
    return { data: { status: 'ready' as const }, meta: { requestId: request.requestId } };
  }
}

@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<ApiRequest>();
    const response = context.getResponse<ServerResponse>();
    request.requestId ??= randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    response.setHeader('Cache-Control', 'no-store');
    const status = exception instanceof AuthError ? exception.status : exception instanceof ContractValidationError ? 422 : exception instanceof HttpException ? exception.getStatus() : 500;
    const errors: Record<number, [string, string]> = {
      400: ['VALIDATION_ERROR', 'Invalid request.'],
      401: ['UNAUTHORIZED', 'Authentication required.'],
      403: ['FORBIDDEN', 'Access denied.'],
      404: ['NOT_FOUND', 'Resource not found.'],
      409: ['STATE_CONFLICT', 'State has changed.'],
      422: ['VALIDATION_ERROR', 'Invalid request.'],
      429: ['RATE_LIMITED', 'Please retry later.'],
      503: ['SERVICE_NOT_READY', 'Service is not ready.'],
    };
    const [defaultCode, message] = errors[status] ?? ['INTERNAL_ERROR', 'Request could not be completed.'];
    const code = exception instanceof AuthError ? exception.code : defaultCode;
    if (status === 429) response.setHeader('Retry-After', '900');
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: { code, message, fieldErrors: [], requestId: request.requestId } }));
  }
}

export async function createApp(identity: IdentityService | null = null) {
  @Module({ controllers: [HealthController, IdentityController, StaffController, RolesController, AuditController, StoreController], providers: [{ provide: 'IDENTITY', useValue: identity }] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false, bodyParser: true });
  app.setGlobalPrefix('api/v1');
  app.use((request: ApiRequest, response: ServerResponse, next: () => void) => {
    const incoming = request.headers['x-request-id'];
    request.requestId = typeof incoming === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
