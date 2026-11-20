/**
 * Mock 支付网关（仅沙箱）。
 *
 * 它不是为了"假装能收款"，而是为了让 创建支付 → 回调 → 幂等 → 查询 → 退款
 * 整条链路在**没有真实收单账号**时就能被测试覆盖。三条与真实渠道对齐的地方：
 * 1. 回调必须带 HMAC 签名与时间窗，签名错一律抛——不给测试用例放水。
 * 2. 状态推进只发生在 verifyWebhook / queryPayment，创建时永远是 pending。
 * 3. 退款金额不能超过已收，不允许部分退款后再退到超额。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type AdapterContext, type AdapterStatus, type ConnectionCheck, type CreatePaymentInput,
  type CreatePaymentResult, type PaymentAdapter, type QueryPaymentResult, type RefundInput,
  type RefundResult, type WebhookEvent, PaymentAdapterError, normalizeAdapterStatus,
} from '../../../../../packages/domain/src/payment-adapter.js';

const SIGNATURE_WINDOW_SECONDS = 300;

interface MockPayment {
  providerTransactionId: string;
  amountMinor: number;
  currency: string;
  status: AdapterStatus;
  refundedMinor: number;
  paymentNumber: string;
}

function fail(code: string, field?: string): never {
  throw new PaymentAdapterError(code, field);
}

export class MockPaymentAdapter implements PaymentAdapter {
  readonly code = 'mock';
  readonly channel = 'online' as const;

  private readonly payments = new Map<string, MockPayment>();

  async testConnection(ctx: AdapterContext): Promise<ConnectionCheck> {
    const apiKey = ctx.credentials.apiKey ?? '';
    const merchantId = ctx.publicConfig.providerAccountRef ?? '';
    if (apiKey.length < 8) return { ok: false, detail: 'credentials.apiKey missing or too short' };
    if (!merchantId) return { ok: false, detail: 'publicConfig.providerAccountRef missing' };
    return { ok: true, detail: `merchant ${merchantId} reachable` };
  }

  async createPayment(ctx: AdapterContext, input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const existing = this.payments.get(input.paymentNumber);
    // 幂等：同一台账号重复创建必须返回同一笔渠道单，而不是再开一笔。
    if (existing) {
      return {
        providerTransactionId: existing.providerTransactionId,
        redirectUrl: this.redirectFor(ctx, existing.providerTransactionId),
        status: existing.status,
        rawStatus: existing.status.toUpperCase(),
      };
    }
    const providerTransactionId = `mock_${randomBytes(9).toString('hex')}`;
    this.payments.set(input.paymentNumber, {
      providerTransactionId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'pending',
      refundedMinor: 0,
      paymentNumber: input.paymentNumber,
    });
    return {
      providerTransactionId,
      redirectUrl: this.redirectFor(ctx, providerTransactionId),
      status: 'pending',
      rawStatus: 'PENDING',
    };
  }

  async queryPayment(_ctx: AdapterContext, providerTransactionId: string): Promise<QueryPaymentResult> {
    const found = this.byTransaction(providerTransactionId);
    // 查不到不代表失败：可能渠道侧还没落库。返回 unknown 让上层继续等待或人工核对。
    if (!found) {
      return { status: 'unknown', providerTransactionId, amountMinor: null, currency: null, rawStatus: 'NOT_FOUND' };
    }
    return {
      status: found.status,
      providerTransactionId: found.providerTransactionId,
      amountMinor: found.amountMinor,
      currency: found.currency,
      rawStatus: found.status.toUpperCase(),
    };
  }

  async refund(_ctx: AdapterContext, input: RefundInput): Promise<RefundResult> {
    const found = this.byTransaction(input.providerTransactionId);
    if (!found) fail('REFUND_PAYMENT_NOT_FOUND', 'providerTransactionId');
    if (found.status !== 'succeeded') fail('REFUND_NOT_SETTLED', 'providerTransactionId');
    if (input.currency !== found.currency) fail('REFUND_CURRENCY_MISMATCH', 'currency');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) fail('REFUND_AMOUNT_INVALID', 'amountMinor');
    if (found.refundedMinor + input.amountMinor > found.amountMinor) {
      fail('REFUND_EXCEEDS_CAPTURED', 'amountMinor');
    }
    found.refundedMinor += input.amountMinor;
    return {
      providerRefundId: `mockr_${randomBytes(6).toString('hex')}`,
      status: 'succeeded',
      amountMinor: input.amountMinor,
      rawStatus: 'REFUNDED',
    };
  }

  async verifyWebhook(ctx: AdapterContext, headers: Record<string, string>, rawBody: Buffer): Promise<WebhookEvent> {
    const secret = ctx.credentials.webhookSecret ?? '';
    if (secret.length < 8) fail('WEBHOOK_SECRET_MISSING', 'webhookSecret');

    const signature = (headers['x-mock-signature'] ?? '').trim();
    const timestamp = (headers['x-mock-timestamp'] ?? '').trim();
    if (!signature || !timestamp) fail('WEBHOOK_SIGNATURE_MISSING');

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) fail('WEBHOOK_TIMESTAMP_INVALID');
    const skew = Math.abs(Date.now() / 1000 - seconds);
    // 时间窗防止重放：过期签名一律拒绝，不做"宽松放行"。
    if (skew > SIGNATURE_WINDOW_SECONDS) fail('WEBHOOK_TIMESTAMP_EXPIRED');

    // 签名针对原始字节，不能先 JSON.parse 再序列化——字段顺序一变签名就废。
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) fail('WEBHOOK_SIGNATURE_INVALID');

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      fail('WEBHOOK_BODY_INVALID');
    }

    const providerTransactionId = typeof body.providerTransactionId === 'string' ? body.providerTransactionId : '';
    if (!providerTransactionId) fail('WEBHOOK_BODY_INVALID', 'providerTransactionId');

    const status = normalizeAdapterStatus(body.status);
    if (status === 'unknown') fail('WEBHOOK_STATUS_UNRECOGNISED', 'status');

    const amountMinor = typeof body.amountMinor === 'number' ? body.amountMinor : null;
    const currency = typeof body.currency === 'string' ? body.currency : null;
    const paymentNumber = typeof body.paymentNumber === 'string' ? body.paymentNumber : null;

    const found = this.byTransaction(providerTransactionId);
    if (found) {
      found.status = status;
    }

    const occurredAtRaw = typeof body.occurredAt === 'string' ? Date.parse(body.occurredAt) : Date.now();
    const occurredAt = new Date(Number.isNaN(occurredAtRaw) ? Date.now() : occurredAtRaw);

    return {
      providerTransactionId,
      paymentNumber,
      status,
      amountMinor,
      currency,
      eventId: typeof body.eventId === 'string' && body.eventId ? body.eventId : `${providerTransactionId}.${status}`,
      occurredAt,
    };
  }

  // ---- 测试辅助：只允许在沙箱/单测里推进状态 -------------------------------

  /** 模拟用户在收银台完成支付。 */
  simulatePaid(paymentNumber: string): void {
    const found = this.payments.get(paymentNumber);
    if (!found) fail('MOCK_PAYMENT_NOT_FOUND', 'paymentNumber');
    found.status = 'succeeded';
  }

  /** 模拟用户在收银台取消。 */
  simulateCancelled(paymentNumber: string): void {
    const found = this.payments.get(paymentNumber);
    if (!found) fail('MOCK_PAYMENT_NOT_FOUND', 'paymentNumber');
    found.status = 'cancelled';
  }

  /** 生成一条可直接用于测试的回调签名（仅沙箱）。 */
  signWebhook(secret: string, rawBody: string, at = new Date()): { signature: string; timestamp: string } {
    return {
      signature: `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
      timestamp: String(Math.floor(at.getTime() / 1000)),
    };
  }

  private redirectFor(ctx: AdapterContext, providerTransactionId: string): string {
    const base = ctx.publicConfig.checkoutBase ?? 'https://sandbox.invalid/mock-pay';
    return `${base}?ref=${encodeURIComponent(providerTransactionId)}`;
  }

  private byTransaction(providerTransactionId: string): MockPayment | null {
    for (const payment of this.payments.values()) {
      if (payment.providerTransactionId === providerTransactionId) return payment;
    }
    return null;
  }
}
