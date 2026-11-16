import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ArgumentsHost, Catch, Controller, Get, HttpException, Inject, Module, Req, ServiceUnavailableException } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditController } from './identity/audit-controller.js';
import { RolesController } from './identity/roles-controller.js';
import { StoreController } from './identity/store-controller.js';
import { CatalogController } from './catalog/controller.js';
import { CatalogService } from './catalog/service.js';
import { CartController, CheckoutController } from './checkout/controller.js';
import { CartService } from './checkout/cart-service.js';
import { CheckoutService } from './checkout/service.js';
import { ShippingController } from './shipping/controller.js';
import { ShippingService } from './shipping/service.js';
import { MediaController, MediaObjectsController } from './media/controller.js';
import { mediaStorageConfig } from './media/config.js';
import { MediaService } from './media/service.js';
import { createMediaStorage, type MediaStorage } from './media/storage.js';
import { AfterSalesController } from './aftersales/controller.js';
import { AfterSalesService } from './aftersales/service.js';
import { OrdersController } from './orders/controller.js';
import { PaymentsController } from './payments/controller.js';
import { PaymentsService } from './payments/service.js';
import { OrdersService } from './orders/service.js';
import { StorefrontController } from './storefront/controller.js';
import { StorefrontService } from './storefront/service.js';
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
      413: ['PAYLOAD_TOO_LARGE', 'Request body is too large.'],
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

export interface AppOptions { mediaStorage?: MediaStorage }

export async function createApp(identity: IdentityService | null = null, options: AppOptions = {}) {
  // 媒体存储默认按环境配置构造；测试可以注入临时目录，避免把上传文件写进仓库。
  const mediaStorage = identity ? options.mediaStorage ?? createMediaStorage(mediaStorageConfig(process.env, identity.config.encryptionKey)) : null;
  // 结账依赖购物袋与配送配置：三个服务共享同一个 IdentityService 连接池。
  const shipping = identity ? new ShippingService(identity) : null;
  const cart = identity ? new CartService(identity) : null;
  const payments = identity ? new PaymentsService(identity) : null;
  const checkout = identity && cart && shipping && payments ? new CheckoutService(identity, cart, shipping, payments) : null;
  const orders = identity && shipping ? new OrdersService(identity, shipping) : null;
  const afterSales = identity ? new AfterSalesService(identity) : null;
  @Module({ controllers: [HealthController, IdentityController, StaffController, RolesController, AuditController, StoreController,
    CatalogController, MediaController, MediaObjectsController, StorefrontController, ShippingController, CartController, CheckoutController,
    OrdersController, PaymentsController, AfterSalesController],
    providers: [{ provide: 'IDENTITY', useValue: identity },
      { provide: 'CATALOG', useValue: identity ? new CatalogService(identity) : null },
      { provide: 'MEDIA', useValue: identity && mediaStorage ? new MediaService(identity, mediaStorage) : null },
      { provide: 'STOREFRONT', useValue: identity ? new StorefrontService(identity) : null },
      { provide: 'SHIPPING', useValue: shipping },
      { provide: 'CART', useValue: cart },
      { provide: 'CHECKOUT', useValue: checkout },
      { provide: 'ORDERS', useValue: orders },
      { provide: 'PAYMENTS', useValue: payments },
      { provide: 'AFTERSALES', useValue: afterSales }] })
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
