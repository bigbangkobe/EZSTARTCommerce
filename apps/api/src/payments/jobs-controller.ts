/**
 * 内部定时任务入口（对账）。
 *
 * 为什么是一个 HTTP 端点而不是在进程里 setTimeout：
 * 1. 定时执行不该和 Web 进程生命周期绑死——重启即丢、多副本会重复跑。
 * 2. 运维要能手动触发一次（"这笔钱到底到了没有"），端点天然支持。
 * 3. 跑多久、跑多少条都能从外部调，出问题时不必改代码重新发布。
 *
 * 鉴权只有一把共享令牌，且**默认关闭**：没配 `INTERNAL_JOB_TOKEN` 就整体 503。
 * 运维端点默认开放等于给攻击者一个免费的执行入口，宁可让运维多点一步配置。
 */
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { type ApiRequest } from '../identity/controller.js';
import { ManagementHttp } from '../identity/management-http.js';
import { AuthError, IdentityService } from '../identity/service.js';
import { PaymentsService, type ReconcileReport } from './service.js';

const MIN_TOKEN_LENGTH = 24;

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // 长度不同直接false：timingSafeEqual 对不等长入参会抛错，不能靠它做长度检查。
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

@Controller('internal/jobs')
export class InternalJobsController extends ManagementHttp {
  constructor(@Inject('PAYMENTS') private readonly payments: PaymentsService | null,
    @Inject('IDENTITY') identity: IdentityService | null) { super(identity); }

  @Post('reconcile')
  async reconcile(@Body() body: { olderThanMinutes?: unknown; limit?: unknown },
    @Req() request: ApiRequest, @Res() response: ServerResponse) {
    if (!this.payments) throw new AuthError(503, 'SERVICE_NOT_READY');

    const expected = process.env.INTERNAL_JOB_TOKEN ?? '';
    if (expected.length < MIN_TOKEN_LENGTH) throw new AuthError(503, 'JOB_ENDPOINT_DISABLED');
    const provided = request.headers['x-job-token'];
    if (typeof provided !== 'string' || !tokenMatches(provided, expected)) {
      throw new AuthError(401, 'UNAUTHORIZED');
    }

    const report: ReconcileReport = await this.payments.reconcile({
      ...(typeof body?.olderThanMinutes === 'number' ? { olderThanMinutes: body.olderThanMinutes } : {}),
      ...(typeof body?.limit === 'number' ? { limit: body.limit } : {}),
    });
    this.send(response, request, 200, report);
  }
}
