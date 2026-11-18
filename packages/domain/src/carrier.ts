import { createHmac, timingSafeEqual } from 'node:crypto';

/** 承运商回传事件闭集；不接收 purchase/cancelled 等由内部状态机独占的状态。 */
export const CARRIER_STATUSES = ['in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned'] as const;
export type CarrierStatus = typeof CARRIER_STATUSES[number];

export const CARRIER_SIGNATURE_VERSION = 'v1';
const EVENT_ID = /^[A-Za-z0-9_.:-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^v1=[0-9a-f]{64}$/;
const CARRIER_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BODY_KEYS = new Set(['eventId', 'shipmentId', 'status', 'occurredAt', 'trackingNumber', 'note']);
const MAX_SKEW_SECONDS = 300;
const MAX_FUTURE_MS = 60_000;

export class CarrierRuleError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export interface CarrierStatusEventInput {
  eventId: string;
  shipmentId: string;
  status: CarrierStatus;
  occurredAt: Date;
  trackingNumber: string | null;
  note: string | null;
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const inner = value[key];
    sorted[key] = inner && typeof inner === 'object' && !Array.isArray(inner)
      ? sortObject(inner as Record<string, unknown>) : inner;
  }
  return sorted;
}

/** 签名覆盖原始 body 的规范化 JSON（键排序、无空格），避免字段顺序造成歧义。 */
export function canonicalCarrierBody(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CarrierRuleError('VALIDATION_ERROR');
  return JSON.stringify(sortObject(body as Record<string, unknown>));
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new CarrierRuleError('VALIDATION_ERROR');
  const text = value.trim();
  if (!text.length || text.length > max || CONTROL.test(text)) throw new CarrierRuleError('VALIDATION_ERROR');
  return text;
}

/** 领域层再验一次：契约挡 PII，这里挡伪装字段、未来时间与格式漂移。 */
export function normalizeCarrierEvent(body: unknown, now = new Date()): CarrierStatusEventInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CarrierRuleError('VALIDATION_ERROR');
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!BODY_KEYS.has(key)) throw new CarrierRuleError('VALIDATION_ERROR');
  const { eventId, shipmentId, status, occurredAt } = input;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw new CarrierRuleError('VALIDATION_ERROR');
  if (typeof shipmentId !== 'string' || !UUID.test(shipmentId)) throw new CarrierRuleError('VALIDATION_ERROR');
  if (typeof status !== 'string' || !CARRIER_STATUSES.includes(status as CarrierStatus))
    throw new CarrierRuleError('VALIDATION_ERROR');
  if (typeof occurredAt !== 'string' || occurredAt.length > 40) throw new CarrierRuleError('VALIDATION_ERROR');
  const at = new Date(occurredAt);
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + MAX_FUTURE_MS)
    throw new CarrierRuleError('VALIDATION_ERROR');
  return { eventId, shipmentId, status: status as CarrierStatus, occurredAt: at,
    trackingNumber: optionalText(input.trackingNumber, 160), note: optionalText(input.note, 500) };
}

/** 验签与防重放：时间戳参与 HMAC，超出五分钟的回调一律拒绝。 */
export function verifyCarrierSignature(secret: string, canonical: string, signature: string | null,
  timestamp: string | null, now = new Date()): void {
  if (typeof timestamp !== 'string' || !/^[0-9]{10}$/.test(timestamp)) throw new CarrierRuleError('INVALID_SIGNATURE');
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now.getTime() / 1000 - seconds) > MAX_SKEW_SECONDS)
    throw new CarrierRuleError('INVALID_SIGNATURE');
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) throw new CarrierRuleError('INVALID_SIGNATURE');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${canonical}`).digest('hex');
  const supplied = signature.slice(CARRIER_SIGNATURE_VERSION.length + 1);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex')))
    throw new CarrierRuleError('INVALID_SIGNATURE');
}

/** 只留签名前缀用于审计；完整 HMAC 不落库，泄露后也不能重放（还有时间戳与 eventId）。 */
export function signatureRef(signature: string): string {
  return `${CARRIER_SIGNATURE_VERSION}=${signature.slice(3, 19)}`;
}

/** 从实例环境变量读取已登记承运商密钥；任何格式异常都按未配置处理，绝不降级为放行。 */
export function carrierWebhookSecrets(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env['CARRIER_WEBHOOK_SECRETS'];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [code, secret] of Object.entries(parsed as Record<string, unknown>)) {
      if (!CARRIER_CODE.test(code) || typeof secret !== 'string' || secret.length < 32) return {};
      result[code] = secret;
    }
    return result;
  } catch { return {}; }
}
