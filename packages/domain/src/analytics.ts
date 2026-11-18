/**
 * 访问漏斗事件采集（M14 第二批）纯规则层。
 *
 * 只回答五件事：有哪些事件名、事件/会话字段怎么校验、同意状态怎么门槛化、
 * 幂等键怎么生成、采集覆盖状态怎么判定。不碰数据库、不碰网络。
 *
 * 安全不变量（对应 docs/modules/M14_REPORTS.md 的采集与匿名要求）：
 * 1. 事件名是闭集，且**不含 purchase**——成交只认服务端订单（ShopOrder.cartId），
 *    浏览器的购买事件即使发来也必须在契约与领域两层拒绝，不能进经营/漏斗指标。
 * 2. sessionId 是随机高熵串，字段校验只认形态，绝不接受邮箱/电话/姓名派生值。
 * 3. consentState 必须是 granted 才计入漏斗；denied/unknown 事件可落库但不进指标
 *    （采集服务按开关决定是否落库）。
 * 4. 事件用 eventId 幂等；重复上报忽略，不二次计数。
 * 5. 所有字段都是页面标识/ anonymous 桶，不含联系方式、完整 URL 或支付凭证。
 */

import {
  assertEnvironment, assertPlacementId, assertPublishVersionId, assertSectionId, assertSectionKey,
  assertTrafficClass, PlacementRuleError,
} from './placement.js';

export class AnalyticsRuleError extends Error {
  constructor(readonly field: string, readonly code = 'VALIDATION_ERROR') { super(field); }
}
function fail(field: string, code = 'VALIDATION_ERROR'): never { throw new AnalyticsRuleError(field, code); }

/** 区块字段校验委托给 M14 P1 规则层，错误统一转成 ANALYTICS 的 422 字段错误。 */
function sectionField<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof PlacementRuleError) return fail(error.field, error.code);
    throw error;
  }
}

/** 采集事件 schema 版本：字段口径或事件语义变了必须升版本。 */
export const ANALYTICS_SCHEMA_VERSION = '1.0';

/** 浏览器可上报的事件闭集。purchase 不在其中——由服务端订单权威生成。 */
export const ANALYTICS_EVENT_NAMES = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout',
  'section_impression', 'section_click'] as const;
export type AnalyticsEventName = typeof ANALYTICS_EVENT_NAMES[number];
export const ANALYTICS_EVENT_NAME_SET = new Set<string>(ANALYTICS_EVENT_NAMES);

export const ANALYTICS_CONSENT_STATES = ['granted', 'denied', 'unknown'] as const;
export type AnalyticsConsentState = typeof ANALYTICS_CONSENT_STATES[number];

export const ANALYTICS_DEVICE_CLASSES = ['desktop', 'mobile', 'tablet'] as const;

/** 漏斗五步：前四步来自浏览器事件，purchase 来自服务端订单。顺序即漏斗顺序。 */
export const FUNNEL_STEPS = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'] as const;
export type FunnelStep = typeof FUNNEL_STEPS[number];

export interface AnalyticsEventInput {
  eventId: string;
  sessionId: string;
  eventName: AnalyticsEventName;
  occurredAt: string;
  schemaVersion: string;
  consentState: AnalyticsConsentState;
  pageKey: string | null;
  locale: string | null;
  deviceClass: string | null;
  marketCode: string | null;
  variantId: string | null;
  interactionId: string | null;
  source: string | null;
  /** 区块事件专用：区块实例/稳定键/展示位/发布版本，全部是匿名标识。 */
  sectionId: string | null;
  sectionKey: string | null;
  placementId: string | null;
  publishVersionId: string | null;
  environment: 'production' | 'preview' | 'staff' | 'sandbox';
  trafficClass: 'human' | 'suspected_bot';
}

function optionalText(value: unknown, field: string, max = 128): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) fail(field);
  return value;
}

/** 随机会话 ID：高熵、无分隔符也允许；形如邮箱/带 @ 的一律拒绝（不是随机会话）。 */
export function assertSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 128) fail('sessionId');
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('sessionId');
  if (value.includes('@') || value.includes('.')) fail('sessionId');
  return value;
}

/** 幂等键：16–128 字符，只允许 URL 安全字符（UUID/base64url）。 */
export function assertEventId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 128) fail('eventId');
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('eventId');
  return value;
}

export function assertEventName(value: unknown): AnalyticsEventName {
  if (typeof value !== 'string' || !ANALYTICS_EVENT_NAME_SET.has(value)) fail('eventName');
  return value as AnalyticsEventName;
}

/** purchase 明确拒绝：即便有人绕过契约直接打服务，也不能把浏览器成交当权威。 */
export function assertBrowserEventName(value: unknown): AnalyticsEventName {
  if (value === 'purchase') fail('eventName', 'PURCHASE_NOT_ACCEPTED');
  return assertEventName(value);
}

export function assertConsentState(value: unknown): AnalyticsConsentState {
  if (typeof value !== 'string' || !ANALYTICS_CONSENT_STATES.includes(value as AnalyticsConsentState)) fail('consentState');
  return value as AnalyticsConsentState;
}

export function assertInstant(value: unknown, field = 'occurredAt'): Date {
  if (typeof value !== 'string' || value.length < 20 || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) fail(field);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(field);
  // 拒绝过早/过远的事件：浏览器时钟错误不应该污染报表，也不该产生无限期保留的脏数据。
  const skewMs = 30 * 86_400_000;
  if (Math.abs(date.getTime() - Date.now()) > skewMs) fail(field);
  return date;
}

export function assertSchemaVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+\.\d+$/.test(value)) fail('schemaVersion');
  return value;
}

/** 设备类闭集；未知/缺失一律 null，进报表归到 unknown 而不是被静默丢弃。 */
export function assertDeviceClass(value: unknown): string | null {
  const text = optionalText(value, 'deviceClass', 16);
  if (text === null) return null;
  if (!ANALYTICS_DEVICE_CLASSES.includes(text as never)) fail('deviceClass');
  return text;
}

/** UTM 来源桶：只允许简单标识，拒绝完整 URL（URL 查询参数可能带 PII）。 */
export function assertSource(value: unknown): string | null {
  const text = optionalText(value, 'source', 128);
  if (text === null) return null;
  if (/[:\/?&#@.]/.test(text)) fail('source');
  return text;
}

/**
 * 规范化单条事件：只保留白名单字段，任何未知字段在契约层已被拒，这里再清一层。
 * occurredAt 保留原始 ISO 串（保留客户端时钟信息）与解析后的 Date 由调用方各取所需。
 */
export function normalizeAnalyticsEvent(raw: Record<string, unknown>): AnalyticsEventInput {
  const eventId = assertEventId(raw['eventId']);
  const sessionId = assertSessionId(raw['sessionId']);
  const eventName = assertBrowserEventName(raw['eventName']);
  const occurredAt = assertInstant(raw['occurredAt']);
  const schemaVersion = assertSchemaVersion(raw['schemaVersion']);
  const consentState = assertConsentState(raw['consentState']);
  // 区块事件必须带稳定区块键与发布版本：没有这两项无法跨版本比较，也不能进陈列指标。
  const sectionEvent = eventName === 'section_impression' || eventName === 'section_click';
  const sectionId = raw['sectionId'] === undefined || raw['sectionId'] === null || raw['sectionId'] === ''
    ? null : sectionField(() => assertSectionId(raw['sectionId']));
  const sectionKey = raw['sectionKey'] === undefined || raw['sectionKey'] === null || raw['sectionKey'] === ''
    ? null : sectionField(() => assertSectionKey(raw['sectionKey']));
  if (sectionEvent && (!sectionId || !sectionKey)) fail(sectionId ? 'sectionKey' : 'sectionId');
  return {
    eventId, sessionId, eventName, occurredAt: occurredAt.toISOString(), schemaVersion, consentState,
    pageKey: optionalText(raw['pageKey'], 'pageKey'),
    locale: optionalText(raw['locale'], 'locale', 32),
    deviceClass: assertDeviceClass(raw['deviceClass']),
    marketCode: optionalText(raw['marketCode'], 'marketCode', 32),
    variantId: optionalText(raw['variantId'], 'variantId'),
    interactionId: optionalText(raw['interactionId'], 'interactionId'),
    source: assertSource(raw['source']),
    sectionId, sectionKey,
    placementId: sectionField(() => assertPlacementId(raw['placementId'])),
    publishVersionId: sectionField(() => (raw['publishVersionId'] === undefined || raw['publishVersionId'] === null
      || raw['publishVersionId'] === '' ? null : assertPublishVersionId(raw['publishVersionId']))),
    environment: raw['environment'] === undefined ? 'production' : sectionField(() => assertEnvironment(raw['environment'])),
    trafficClass: raw['trafficClass'] === undefined ? 'human' : sectionField(() => assertTrafficClass(raw['trafficClass'])),
  };
}

/** 一次批量上报的事件数上限：防止一次请求塞入海量事件拖垮采集服务。 */
export const ANALYTICS_BATCH_MAX = 50;

export function normalizeAnalyticsBatch(raw: unknown): AnalyticsEventInput[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>)['events'])) fail('events');
  const events = (raw as Record<string, unknown>)['events'] as unknown[];
  if (events.length < 1 || events.length > ANALYTICS_BATCH_MAX) fail('events');
  return events.map(event => {
    if (!event || typeof event !== 'object') fail('events');
    return normalizeAnalyticsEvent(event as Record<string, unknown>);
  });
}

/** 只有明示同意的事件才进漏斗指标；unknown/denied 不算转化。 */
export function countsTowardFunnel(event: Pick<AnalyticsEventInput, 'consentState'>): boolean {
  return event.consentState === 'granted';
}

/** 漏斗步骤序号：purchase 恒为最后一步；未知步骤返回 -1（调用方据此忽略）。 */
export function funnelStepIndex(step: string): number {
  const index = FUNNEL_STEPS.indexOf(step as FunnelStep);
  return index;
}
