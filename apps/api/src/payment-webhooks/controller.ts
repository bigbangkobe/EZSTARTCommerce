/**
 * 支付渠道回调入口（公开路由）。
 *
 * 无管理员会话、无 CSRF：身份只由渠道签名与时间窗证明。
 * 三条必须守住的东西：
 * 1. 验签用**原始字节**，不能用解析后的 JSON 重新序列化——字段顺序一变签名就废。
 * 2. 验签失败返回 400；但“单号找不到”返回 202，让渠道停止重试，由对账补。
 * 3. 任何分支都不回显内部状态以外的信息，避免泄露订单/渠道是否存在。
 */
import { Controller, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { PaymentsService } from '../payments/service.js';

type RawBodyRequest = ApiRequest & { rawBody?: Buffer };

function headerMap(request: ApiRequest): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') output[name.toLowerCase()] = value;
    else if (Array.isArray(value)) output[name.toLowerCase()] = value[0] ?? '';
  }
  return output;
}

@Controller('webhooks/payments')
export class PaymentWebhookController extends ManagementHttp {
  constructor(@Inject('PAYMENTS') private readonly payments: PaymentsService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }

  @Post(':providerCode')
  async receive(@Param('providerCode') providerCode: string, @Query('env') env: unknown,
    @Req() request: RawBodyRequest, @Res() response: ServerResponse) {
    if (!this.payments) throw new AuthError(503, 'SERVICE_NOT_READY');
    // 环境只用于选配置与密钥；伪造 env 只会在验签阶段失败，拿不到任何额外信息。
    const environment = env === 'sandbox' ? 'sandbox' : 'production';
    const rawBody = request.rawBody;
    if (!rawBody || !rawBody.length) throw new AuthError(400, 'WEBHOOK_BODY_MISSING');
    if (rawBody.length > 256 * 1024) throw new AuthError(413, 'WEBHOOK_BODY_TOO_LARGE');

    const result = await this.payments.handleWebhook(providerCode, environment, headerMap(request), rawBody,
      this.context(request));
    // 202：已接收。deferred 与 duplicate 同样回 202，避免渠道对同一事件反复重推。
    this.send(response, request, 202, { received: true, kind: result.kind });
  }
}
