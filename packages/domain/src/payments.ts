/**
 * 付款（M08）领域规则。
 *
 * 与其它领域模块一样，这里只有判定与规范化，不碰数据库。三条底线：
 * 1. 金额只认订单总额：少收、多收、跨币种一律拒绝，不做“四舍五入对上了”。
 * 2. 状态只能沿渠道允许的方向走：已收不能回到待收，未知不能被人工改成失败。
 * 3. 数据库只存凭证引用，引用必须是 URI 形状；明文密钥根本不进这条链路。
 */
export class PaymentRuleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * 声明式抛出：用函数声明（而不是箭头常量）才能让 TypeScript 认出“这里之后不可达”，
 * 分支里的类型收窄才不会退化成 unknown。
 */
function fail(code: string): never {
  throw new PaymentRuleError(code);
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type PaymentChannel = 'cod' | 'manual' | 'online';
export type PaymentStatus = 'pending' | 'authorized' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  | 'collected' | 'rejected' | 'returned';
export type PaymentOutcome = 'collected' | 'succeeded' | 'rejected' | 'cancelled' | 'returned';

export interface ProviderDefinition {
  readonly code: string;
  readonly channel: PaymentChannel;
  readonly label: string;
  /** 线上渠道必须配置凭证引用；线下（COD）不需要。 */
  readonly requiresSecret: boolean;
  /** 仅沙箱可用：生产环境不允许配置或解析该渠道。 */
  readonly sandboxOnly?: boolean;
}

/**
 * 已接入的支付方式白名单。新增服务商必须先在这里登记渠道类型与凭证要求，
 * 否则 PATCH /admin/payment-methods 会直接拒绝，避免配置出一个没有适配器的空壳渠道。
 *
 * `mock` 是支付适配器的联调通道，只在 sandbox 可用；它存在的意义是让
 * 创建支付→回调→退款整条链路在没有真实收单账号时也能被测试覆盖。
 */
export const providers: readonly ProviderDefinition[] = [
  { code: 'cod', channel: 'cod', label: 'Cash on delivery', requiresSecret: false },
  { code: 'manual_bank_transfer', channel: 'manual', label: 'Manual bank transfer', requiresSecret: false },
  { code: 'mock', channel: 'online', label: 'Mock gateway (sandbox only)', requiresSecret: false, sandboxOnly: true },
];

export function provider(code: string): ProviderDefinition {
  const found = providers.find(entry => entry.code === code);
  if (!found) fail('UNSUPPORTED_PAYMENT_PROVIDER');
  return found;
}

/** 每个渠道可以登记的结果：COD 没有“授权成功”，线上支付没有“拒收”。 */
const CHANNEL_OUTCOMES: Record<PaymentChannel, readonly PaymentOutcome[]> = {
  cod: ['collected', 'rejected', 'returned'],
  manual: ['collected', 'succeeded', 'cancelled', 'returned'],
  online: ['succeeded', 'cancelled', 'returned'],
};

/**
 * 状态机：只允许前进。`unknown` 没有人工出口——渠道没给结论时，
 * 后台不能把它改成失败或成功，必须先由服务端查询或回调给出结论。
 */
const TRANSITIONS: Record<string, Partial<Record<PaymentOutcome, PaymentStatus>>> = {
  pending: { collected: 'collected', succeeded: 'succeeded', rejected: 'rejected', cancelled: 'cancelled' },
  authorized: { collected: 'collected', succeeded: 'succeeded', cancelled: 'cancelled' },
  collected: { returned: 'returned' },
  succeeded: { returned: 'returned' },
  unknown: {},
};

export function nextPaymentStatus(current: string, outcome: PaymentOutcome, channel: string): PaymentStatus {
  const allowed = CHANNEL_OUTCOMES[channel as PaymentChannel];
  if (!allowed) fail('UNSUPPORTED_PAYMENT_PROVIDER');
  if (!allowed.includes(outcome)) fail('PAYMENT_OUTCOME_NOT_ALLOWED');
  if (current === 'unknown') fail('PAYMENT_STATUS_UNKNOWN_REQUIRES_PROVIDER');
  const next = TRANSITIONS[current]?.[outcome];
  if (!next) fail('PAYMENT_STATE_CONFLICT');
  return next;
}

/** 订单上的付款状态：由台账状态投影而来，不单独维护一套。 */
export function orderPaymentStatusFor(status: PaymentStatus): string {
  switch (status) {
    case 'collected': return 'collected';
    case 'succeeded': return 'succeeded';
    case 'rejected': return 'rejected';
    case 'returned': return 'returned';
    case 'cancelled': return 'cancelled';
    case 'failed': return 'failed';
    default: return 'processing';
  }
}

export interface OutcomeInput {
  outcome: PaymentOutcome;
  amountMinor: number;
  occurredAt: Date;
  reference: string | null;
  reason: string | null;
  expectedVersion: number;
}

function optionalText(value: string | null | undefined, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = value.trim();
  if (!text.length) return null;
  if (text.length > max || CONTROL.test(text)) fail(field);
  return text;
}

/** 收款/拒收/退回登记入参。拒收与退回必须写原因——钱去哪了要能解释。 */
export function normalizeOutcome(input: { outcome?: unknown; amountMinor?: unknown; occurredAt?: unknown;
  reference?: unknown; reason?: unknown; expectedVersion?: unknown }, now = new Date()): OutcomeInput {
  const outcome = input.outcome;
  if (typeof outcome !== 'string' || !['collected', 'succeeded', 'rejected', 'cancelled', 'returned'].includes(outcome)) {
    fail('VALIDATION_ERROR');
  }
  if (!Number.isSafeInteger(input.amountMinor) || (input.amountMinor as number) < 1) fail('VALIDATION_ERROR');
  if (typeof input.occurredAt !== 'string' || input.occurredAt.length > 40) fail('VALIDATION_ERROR');
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) fail('VALIDATION_ERROR');
  // 未来时间会被用来伪造“早就收到了”，只给一分钟时钟偏差。
  if (occurredAt.getTime() > now.getTime() + 60_000) fail('VALIDATION_ERROR');
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) fail('VALIDATION_ERROR');
  if (input.reference !== undefined && input.reference !== null && typeof input.reference !== 'string') fail('VALIDATION_ERROR');
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') fail('VALIDATION_ERROR');
  const reason = optionalText(input.reason as string | null | undefined, 1_000, 'VALIDATION_ERROR');
  if ((outcome === 'rejected' || outcome === 'returned') && !reason) fail('REASON_REQUIRED');
  return {
    outcome: outcome as PaymentOutcome,
    amountMinor: input.amountMinor as number,
    occurredAt,
    reference: optionalText(input.reference as string | null | undefined, 200, 'VALIDATION_ERROR'),
    reason,
    expectedVersion: input.expectedVersion as number,
  };
}

/** 金额必须与台账、订单总额、订单币种同时一致；三项任一不符就不入账。 */
export function assertPaymentAmount(input: { paymentAmountMinor: number; orderTotalMinor: number;
  amountMinor: number; currency: string; orderCurrency: string }) {
  if (input.currency !== input.orderCurrency) fail('PAYMENT_CURRENCY_MISMATCH');
  if (input.paymentAmountMinor !== input.orderTotalMinor) fail('PAYMENT_AMOUNT_MISMATCH');
  if (input.amountMinor !== input.orderTotalMinor) fail('PAYMENT_AMOUNT_MISMATCH');
}

/** 已取消的订单不再收钱；收款时间不能早于下单时间。 */
export function assertCollectable(order: { orderStatus: string; placedAt: Date }, occurredAt: Date) {
  if (order.orderStatus === 'cancelled') fail('ORDER_ALREADY_CANCELLED');
  if (occurredAt.getTime() < order.placedAt.getTime()) fail('PAYMENT_TIME_INVALID');
}

/** 货到付款是先交货再收钱：包裹没有离开仓库前不登记收款/拒收。 */
export function assertCodRequiresDispatch(channel: string, outcome: PaymentOutcome, dispatched: boolean) {
  if (channel !== 'cod') return;
  if (outcome === 'returned' && dispatched) return;
  if (!dispatched) fail('ORDER_NOT_SHIPPED');
}

/** If-Match 语义的版本核对；与订单模块保持同一套错误码。 */
export function assertVersion(expected: number, actual: number) {
  if (!Number.isSafeInteger(expected) || expected < 1) fail('VALIDATION_ERROR');
  if (expected !== actual) fail('VERSION_CONFLICT');
}

export interface MethodPatchInput {
  providerCode: string;
  environment: 'sandbox' | 'production';
  displayName: string;
  enabled: boolean;
  approvalReference: string | null;
  publicConfig: Record<string, string>;
  secretRef: string | null;
}

/** publicConfig 只接受显式白名单字段：这里放什么都不允许出现密钥形状的值。 */
const PUBLIC_CONFIG_KEYS = ['accountSummary', 'instructions', 'defaultCurrency', 'providerAccountRef'] as const;
const SECRET_REF = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._:/-]{1,200}$/;

export function normalizeMethodPatch(input: { providerCode?: unknown; environment?: unknown; enabled?: unknown;
  displayName?: unknown; approvalReference?: unknown; publicConfig?: unknown; secretRef?: unknown },
  existing: { displayName: string; publicConfig: Record<string, string>; secretRef: string | null;
    approvalReference: string | null } | null): MethodPatchInput {
  if (typeof input.providerCode !== 'string') fail('VALIDATION_ERROR');
  const definition = provider(input.providerCode);
  if (input.environment !== 'sandbox' && input.environment !== 'production') fail('VALIDATION_ERROR');
  // 沙箱专用渠道不能出现在生产配置里：假支付混进真实订单等于资损。
  if (definition.sandboxOnly && input.environment === 'production') fail('PAYMENT_PROVIDER_SANDBOX_ONLY');
  if (typeof input.enabled !== 'boolean') fail('VALIDATION_ERROR');

  const displayName = input.displayName === undefined
    ? existing?.displayName ?? definition.label
    : optionalText(input.displayName as string, 80, 'VALIDATION_ERROR');
  if (!displayName) fail('VALIDATION_ERROR');

  // 未提交批准依据表示“沿用原值”，显式传 null 表示撤销批准（同时必须停用）。
  const approvalReference = input.approvalReference === undefined
    ? existing?.approvalReference ?? null
    : optionalText(input.approvalReference as string | null, 200, 'VALIDATION_ERROR');

  // 凭证只收引用：`secret://prod/gateway` 可以，`sk_live_...` 这种真实密钥形状直接拒。
  let secretRef: string | null;
  if (input.secretRef === undefined) secretRef = existing?.secretRef ?? null;
  else if (input.secretRef === null) secretRef = null;
  else {
    const value = optionalText(input.secretRef as string, 256, 'SECRET_REFERENCE_INVALID');
    if (!value || !SECRET_REF.test(value)) fail('SECRET_REFERENCE_INVALID');
    secretRef = value;
  }
  if (definition.requiresSecret && input.enabled && !secretRef) fail('PAYMENT_CREDENTIAL_REQUIRED');

  const publicConfig = input.publicConfig === undefined ? existing?.publicConfig ?? {} : normalizePublicConfig(input.publicConfig);
  return { providerCode: definition.code, environment: input.environment, displayName, enabled: input.enabled,
    approvalReference, publicConfig, secretRef };
}

export function normalizePublicConfig(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('VALIDATION_ERROR');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 8) fail('VALIDATION_ERROR');
  const output: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!(PUBLIC_CONFIG_KEYS as readonly string[]).includes(key)) fail('PUBLIC_CONFIG_KEY_NOT_ALLOWED');
    if (typeof entry !== 'string') fail('VALIDATION_ERROR');
    const text = entry.trim();
    if (!text.length || text.length > 200 || CONTROL.test(text)) fail('VALIDATION_ERROR');
    output[key] = text;
  }
  return output;
}

/** 启用即对外承诺可收款：没有批准依据就不能打开。 */
export function assertEnableAllowed(input: { enabled: boolean; approvalReference: string | null }) {
  if (!input.enabled) return;
  if (!input.approvalReference) fail('PAYMENT_APPROVAL_REQUIRED');
}

/** 台账号：PAY-YYYYMMDD-XXXXXX，日期按店铺时区由调用方算好。 */
export function paymentNumber(day: string, suffix: string) {
  if (!/^\d{8}$/.test(day)) fail('VALIDATION_ERROR');
  if (!/^[A-Z0-9]{6}$/.test(suffix)) fail('VALIDATION_ERROR');
  return `PAY-${day}-${suffix}`;
}
