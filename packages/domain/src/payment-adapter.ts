/**
 * 支付适配器契约与纯规则（M08 扩展）。
 *
 * 这一层只做两件事：定义"一个支付渠道必须提供什么"，以及把渠道给的脏数据
 * 归一化成内部可判定的形状。**不碰 IO、不发请求、不读环境变量**——真正的
 * 适配器实现放在 apps/api/src/payments/adapters，密钥解析放在 SecretResolver。
 *
 * 四条底线：
 * 1. 渠道原始状态字符串绝不直接落库：必须先过 normalizeAdapterStatus。
 * 2. 没见过的渠道状态一律归为 unknown，不抛错——崩了比不知道更糟；
 *    unknown 只允许由查询收敛，后台没有人工出口（沿用 payments.ts 的规则）。
 * 3. 密钥只以 secret:// 引用在业务层流转，明文只在 AdapterContext 内存里短暂存在。
 * 4. 落 metadata 之前必须过 assertNoSecretShape，防止密钥被顺手带进日志表。
 */
import type { PaymentChannel } from './payments.js';

export class PaymentAdapterError extends Error {
  constructor(readonly code: string, readonly field?: string) {
    super(field ? `${code}:${field}` : code);
    this.name = 'PaymentAdapterError';
  }
}

function fail(code: string, field?: string): never {
  throw new PaymentAdapterError(code, field);
}

// ---------------------------------------------------------------------------
// 状态归一化
// ---------------------------------------------------------------------------

export type AdapterStatus = 'pending' | 'authorized' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export const ADAPTER_STATUSES: readonly AdapterStatus[] = [
  'pending', 'authorized', 'succeeded', 'failed', 'cancelled', 'unknown',
];

/**
 * 常见渠道状态别名。新增渠道时优先用第二参数传自己的映射表，
 * 不要往这里堆——这张表只收"跨渠道通用"的叫法。
 */
const STATUS_ALIASES: Readonly<Record<string, AdapterStatus>> = {
  pending: 'pending',
  processing: 'pending',
  created: 'pending',
  initiated: 'pending',
  awaiting_payment: 'pending',
  requires_action: 'pending',
  authorized: 'authorized',
  requires_capture: 'authorized',
  success: 'succeeded',
  succeeded: 'succeeded',
  paid: 'succeeded',
  captured: 'succeeded',
  completed: 'succeeded',
  trade_success: 'succeeded',
  failed: 'failed',
  failure: 'failed',
  declined: 'failed',
  rejected: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired: 'cancelled',
  voided: 'cancelled',
  unknown: 'unknown',
};

/**
 * 渠道状态归一化。**永不抛错**：无法识别时返回 unknown。
 * 理由：渠道新增状态不应让回调 5xx，否则会触发重试风暴；
 * 记 unknown + 告警 + 定时查询收敛，是唯一安全的降级路径。
 */
export function normalizeAdapterStatus(
  raw: unknown,
  extra?: Readonly<Record<string, AdapterStatus>>,
): AdapterStatus {
  if (typeof raw !== 'string') return 'unknown';
  const key = raw.trim().toLowerCase();
  if (!key.length || key.length > 64) return 'unknown';
  if (extra && Object.prototype.hasOwnProperty.call(extra, key)) {
    return extra[key] as AdapterStatus;
  }
  return STATUS_ALIASES[key] ?? 'unknown';
}

/** 只有 succeeded 能推进为已收款；其余状态由调用方按状态机处理。 */
export function isSettled(status: AdapterStatus): boolean {
  return status === 'succeeded';
}

// ---------------------------------------------------------------------------
// 幂等键
// ---------------------------------------------------------------------------

const PROVIDER_CODE = /^[a-z][a-z0-9_]{1,40}$/;
const EVENT_ID = /^[A-Za-z0-9._:@-]{1,120}$/;

/**
 * 回调幂等键：`provider:eventId`，直接作为 PaymentEvent.dedupeKey。
 * 渠道不给 eventId 时，调用方必须用 (单号+状态+时间戳) 派生，不允许留空——
 * 空键会让唯一约束失效，重复回调就会重复入账。
 */
export function webhookEventKey(providerCode: string, eventId: string): string {
  if (typeof providerCode !== 'string' || !PROVIDER_CODE.test(providerCode)) {
    fail('WEBHOOK_PROVIDER_INVALID', 'providerCode');
  }
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
    fail('WEBHOOK_EVENT_ID_INVALID', 'eventId');
  }
  return `${providerCode}:${eventId}`;
}

/** 渠道缺 eventId 时的兜底派生：同单同状态同秒视为同一事件。 */
export function derivedEventId(providerTransactionId: string, status: AdapterStatus, occurredAt: Date): string {
  if (!EVENT_ID.test(providerTransactionId)) fail('WEBHOOK_EVENT_ID_INVALID', 'providerTransactionId');
  if (Number.isNaN(occurredAt.getTime())) fail('WEBHOOK_EVENT_ID_INVALID', 'occurredAt');
  const stamp = occurredAt.toISOString().replace(/[-:.]/g, '').slice(0, 15);
  return `${providerTransactionId}.${status}.${stamp}`;
}

// ---------------------------------------------------------------------------
// 金额一致性
// ---------------------------------------------------------------------------

export interface WebhookAmountInput {
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly expectedAmountMinor: number;
  readonly expectedCurrency: string;
}

/**
 * 回调金额校验。缺金额、缺币种、不一致，全部拒绝推进状态。
 * 宁可人工对账，也不能凭一条没有金额的回调把钱记进来。
 */
export function assertWebhookAmount(input: WebhookAmountInput): void {
  const { amountMinor, currency, expectedAmountMinor, expectedCurrency } = input;
  if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    fail('WEBHOOK_AMOUNT_MISSING', 'amountMinor');
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    fail('WEBHOOK_CURRENCY_INVALID', 'currency');
  }
  if (currency !== expectedCurrency) fail('WEBHOOK_CURRENCY_MISMATCH', 'currency');
  if (amountMinor !== expectedAmountMinor) fail('WEBHOOK_AMOUNT_MISMATCH', 'amountMinor');
}

// ---------------------------------------------------------------------------
// 密钥引用
// ---------------------------------------------------------------------------

export type SecretScheme = 'aws-sm' | 'ssm' | 'env' | 'file';

export const SECRET_SCHEMES: readonly SecretScheme[] = ['aws-sm', 'ssm', 'env', 'file'];

const SECRET_REF = /^secret:\/\/(aws-sm|ssm|env|file)\/([A-Za-z0-9._/-]{1,200})$/;

export interface SecretTarget {
  readonly scheme: SecretScheme;
  readonly name: string;
}

/**
 * 解析 `secret://<scheme>/<name>`。
 * 比 payments.ts 里那条更严格：scheme 必须落在四种之内，否则无法解析就等于无法收款。
 */
export function secretRefTarget(ref: unknown): SecretTarget {
  if (typeof ref !== 'string') fail('SECRET_REFERENCE_INVALID', 'secretRef');
  const match = SECRET_REF.exec(ref.trim());
  if (!match) fail('SECRET_REFERENCE_INVALID', 'secretRef');
  return { scheme: match[1] as SecretScheme, name: match[2] as string };
}

/**
 * 生产环境只允许走云密钥服务。
 * env 会被 `docker inspect` 看到，file 会进备份包——两者在单机生产都等于明文。
 */
export function assertSecretSchemeAllowed(scheme: SecretScheme, environment: 'sandbox' | 'production'): void {
  if (environment !== 'production') return;
  if (scheme === 'env' || scheme === 'file') fail('SECRET_SCHEME_NOT_ALLOWED_IN_PRODUCTION', 'secretRef');
}

// ---------------------------------------------------------------------------
// 收银台可见性
// ---------------------------------------------------------------------------

/**
 * 前台是否展示该支付方式。三道门：启用、连接已验证、环境匹配。
 * 配错凭据时最坏结果是"看不见"，不是"下单必失败"。
 */
export function checkoutVisible(input: {
  enabled: boolean;
  connectionStatus: string;
  environment: string;
  requestEnvironment: string;
}): boolean {
  if (!input.enabled) return false;
  if (input.connectionStatus !== 'verified') return false;
  return input.environment === input.requestEnvironment;
}

// ---------------------------------------------------------------------------
// 创建支付入参
// ---------------------------------------------------------------------------

const PAYMENT_NUMBER = /^PAY-\d{8}-[A-Z0-9]{6}$/;
const CURRENCY = /^[A-Z]{3}$/;

export interface CreatePaymentInput {
  /** 内部台账号，同时作为渠道侧幂等键。 */
  readonly paymentNumber: string;
  readonly orderNumber: string;
  /** minor units，禁止小数。 */
  readonly amountMinor: number;
  readonly currency: string;
  readonly returnUrl: string;
  readonly notifyUrl: string;
  readonly locale: string;
}

function assertUrl(value: unknown, field: string, requireHttps: boolean): string {
  if (typeof value !== 'string' || value.length > 500) fail('URL_INVALID', field);
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    fail('URL_INVALID', field);
  }
  if (!parsed) fail('URL_INVALID', field);
  if (parsed.protocol !== 'https:' && (requireHttps || parsed.protocol !== 'http:')) {
    fail('URL_INVALID', field);
  }
  if (!parsed.hostname) fail('URL_INVALID', field);
  return value;
}

export function assertCreatePaymentInput(
  input: Partial<CreatePaymentInput>,
  environment: 'sandbox' | 'production',
): CreatePaymentInput {
  const { paymentNumber, orderNumber, amountMinor, currency, returnUrl, notifyUrl, locale } = input;

  if (typeof paymentNumber !== 'string' || !PAYMENT_NUMBER.test(paymentNumber)) {
    fail('PAYMENT_NUMBER_INVALID', 'paymentNumber');
  }
  if (typeof orderNumber !== 'string' || !orderNumber.trim().length || orderNumber.length > 64) {
    fail('ORDER_NUMBER_INVALID', 'orderNumber');
  }
  // 金额只认正整数分：0 元单不该走线上支付，负数就是攻击。
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    fail('AMOUNT_INVALID', 'amountMinor');
  }
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) fail('CURRENCY_INVALID', 'currency');

  // 生产必须 https：回调地址走明文等于把订单信息裸奔在公网。
  const https = environment === 'production';
  const checkedReturn = assertUrl(returnUrl, 'returnUrl', https);
  const checkedNotify = assertUrl(notifyUrl, 'notifyUrl', https);

  if (typeof locale !== 'string' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(locale)) {
    fail('LOCALE_INVALID', 'locale');
  }

  return {
    paymentNumber,
    orderNumber: orderNumber.trim(),
    amountMinor,
    currency,
    returnUrl: checkedReturn,
    notifyUrl: checkedNotify,
    locale,
  };
}

// ---------------------------------------------------------------------------
// metadata 防泄漏
// ---------------------------------------------------------------------------

/** 常见密钥形状：Stripe、AWS Access Key、PEM 私钥头、Bearer Token。 */
const SECRET_SHAPES: readonly RegExp[] = [
  /sk_(live|test)_[A-Za-z0-9]{8,}/,
  /pk_(live|test)_[A-Za-z0-9]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

export function containsSecretShape(value: string): boolean {
  return SECRET_SHAPES.some(pattern => pattern.test(value));
}

/**
 * 落库/落日志前调用。递归检查字符串，命中即拒绝。
 * 这是最后一道闸：适配器作者不该被信任"我不会写错"。
 */
export function assertNoSecretShape(value: unknown, path = 'metadata', depth = 0): void {
  if (depth > 6) fail('METADATA_TOO_DEEP', path);
  if (typeof value === 'string') {
    if (containsSecretShape(value)) fail('METADATA_CONTAINS_SECRET', path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > 200) fail('METADATA_TOO_LARGE', path);
    value.forEach((entry, index) => assertNoSecretShape(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) fail('METADATA_TOO_LARGE', path);
  for (const [key, entry] of entries) {
    if (/secret|password|token|privatekey|apikey/i.test(key)) fail('METADATA_FORBIDDEN_KEY', `${path}.${key}`);
    assertNoSecretShape(entry, `${path}.${key}`, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// 适配器契约
// ---------------------------------------------------------------------------

export interface AdapterContext {
  readonly providerCode: string;
  readonly environment: 'sandbox' | 'production';
  /** 已解析的密钥：只在内存中存在，不得写日志、不得入库、不得进错误信息。 */
  readonly credentials: Readonly<Record<string, string>>;
  readonly publicConfig: Readonly<Record<string, string>>;
}

export interface CreatePaymentResult {
  /** 渠道侧单号；回调与对账都靠它匹配。 */
  readonly providerTransactionId: string;
  /** 收银台跳转地址；直连扣款类渠道为 null。 */
  readonly redirectUrl: string | null;
  readonly status: AdapterStatus;
  /** 渠道原始状态，仅用于排障，不落业务状态字段。 */
  readonly rawStatus: string;
}

export interface QueryPaymentResult {
  readonly status: AdapterStatus;
  readonly providerTransactionId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly rawStatus: string;
}

export interface RefundInput {
  readonly refundNumber: string;
  readonly providerTransactionId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string | null;
}

export interface RefundResult {
  readonly providerRefundId: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly amountMinor: number;
  readonly rawStatus: string;
}

export interface WebhookEvent {
  readonly providerTransactionId: string;
  /** 渠道回传的内部台账号；拿不到时为 null，靠 providerTransactionId 反查。 */
  readonly paymentNumber: string | null;
  readonly status: AdapterStatus;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly eventId: string;
  readonly occurredAt: Date;
}

export interface ConnectionCheck {
  readonly ok: boolean;
  /** 已脱敏的说明：不允许包含密钥、完整响应体、请求头。 */
  readonly detail: string;
}

export interface PaymentAdapter {
  readonly code: string;
  readonly channel: PaymentChannel;
  testConnection(ctx: AdapterContext): Promise<ConnectionCheck>;
  createPayment(ctx: AdapterContext, input: CreatePaymentInput): Promise<CreatePaymentResult>;
  queryPayment(ctx: AdapterContext, providerTransactionId: string): Promise<QueryPaymentResult>;
  refund(ctx: AdapterContext, input: RefundInput): Promise<RefundResult>;
  /** 验签失败必须抛错，绝不返回"疑似成功"。 */
  verifyWebhook(ctx: AdapterContext, headers: Record<string, string>, rawBody: Buffer): Promise<WebhookEvent>;
}
