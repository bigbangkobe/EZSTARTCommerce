/**
 * 顾客资料请求（隐私请求）的纯规则。
 *
 * 这套规则的核心不是「怎么处理」，而是「什么时候不许处理」：
 * 1. 未核验身份的请求不得进入 approved/completed——否则就是凭一封邮件导出别人的资料。
 * 2. 状态只能按固定方向前进，终态不可回退；「完成」必须留下完成时间与决定原因。
 * 3. 到期是受理时的快照（受理时间 + 店铺口径天数），逾期只影响提醒与排序，不会自动变成已完成。
 * 4. 删除/匿名化完成时必须记下保留例外依据：订单、支付、售后等交易事实不随请求消失。
 */

export class PrivacyRuleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PrivacyRuleError';
  }
}

export const PRIVACY_RULE_VERSION = 'privacy-v1';

export const PRIVACY_REQUEST_TYPES = ['access', 'export', 'correct', 'withdraw_marketing', 'delete', 'anonymize'] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_SOURCE_CHANNELS = ['email', 'phone', 'admin', 'storefront'] as const;
export type PrivacySourceChannel = (typeof PRIVACY_SOURCE_CHANNELS)[number];

/** received：已受理；verified：身份已核验；approved：已批准待处置；needs_information：等顾客补材料。 */
export const PRIVACY_STATUSES = ['received', 'verified', 'approved', 'needs_information', 'rejected', 'completed'] as const;
export type PrivacyStatus = (typeof PRIVACY_STATUSES)[number];

export const PRIVACY_DECISIONS = ['approved', 'rejected', 'needs_information', 'completed'] as const;
export type PrivacyDecision = (typeof PRIVACY_DECISIONS)[number];

const MAX_SCOPE_ITEMS = 20;
const MAX_SCOPE_LENGTH = 80;
const MAX_REF_LENGTH = 200;
const MAX_REASON_LENGTH = 1_000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: string): never { throw new PrivacyRuleError(code); }

function text(value: unknown, code: string, max: number): string {
  if (typeof value !== 'string') fail(code);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) fail(code);
  return trimmed;
}

function optionalText(value: unknown, code: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(code);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(code);
  return trimmed.length ? trimmed : null;
}

function timestamp(value: unknown, code: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail(code);
    return value;
  }
  if (typeof value !== 'string') fail(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(code);
  return parsed;
}

// ---- 受理 -------------------------------------------------------------------

export interface PrivacyRequestInput {
  requestType: PrivacyRequestType;
  sourceChannel: PrivacySourceChannel;
  /** 申请人自述身份：核验前只是线索，不是已确认的顾客。 */
  customerRef: string | null;
  /** 顾客要求处理的资料类别；去重后保留原顺序。 */
  scope: string[];
}

export function normalizePrivacyRequestInput(body: unknown): PrivacyRequestInput {
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const requestType = input.requestType;
  if (typeof requestType !== 'string' || !PRIVACY_REQUEST_TYPES.includes(requestType as PrivacyRequestType)) {
    fail('PRIVACY_REQUEST_TYPE_INVALID');
  }
  const sourceChannel = input.sourceChannel;
  if (typeof sourceChannel !== 'string' || !PRIVACY_SOURCE_CHANNELS.includes(sourceChannel as PrivacySourceChannel)) {
    fail('PRIVACY_SOURCE_CHANNEL_INVALID');
  }
  const scope = input.scope;
  if (!Array.isArray(scope)) fail('PRIVACY_SCOPE_INVALID');
  if (scope.length > MAX_SCOPE_ITEMS) fail('PRIVACY_SCOPE_INVALID');
  const items: string[] = [];
  for (const item of scope) {
    const trimmed = text(item, 'PRIVACY_SCOPE_INVALID', MAX_SCOPE_LENGTH);
    if (!items.includes(trimmed)) items.push(trimmed);
  }
  return { requestType: requestType as PrivacyRequestType, sourceChannel: sourceChannel as PrivacySourceChannel,
    customerRef: optionalText(input.customerRef, 'PRIVACY_CUSTOMER_REF_INVALID', MAX_REF_LENGTH), scope: items };
}

/** 受理日按 UTC 取，与会员号同口径：单号里的日期只是给人看的分组，不承载时区语义。 */
export function privacyDay(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('PRIVACY_TIME_INVALID');
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

export function privacyRequestNumber(day: string, sequence: number): string {
  if (!/^[0-9]{8}$/.test(day)) fail('PRIVACY_NUMBER_INVALID');
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9_999) fail('PRIVACY_NUMBER_INVALID');
  return `PR-${day}-${String(sequence).padStart(4, '0')}`;
}

export function normalizeDueDays(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 365) fail('PRIVACY_DUE_DAYS_INVALID');
  return value as number;
}

/** 到期时间是受理时的快照：之后改口径只影响新受理的请求。 */
export function dueAtFrom(receivedAt: Date, dueDays: number): Date {
  if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) fail('PRIVACY_TIME_INVALID');
  return new Date(receivedAt.getTime() + normalizeDueDays(dueDays) * DAY_MS);
}

/** 逾期天数：未到期返回 0。向下取整，所以「昨天到期」是逾期 1 天。 */
export function overdueDays(dueAt: Date, now: Date): number {
  if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime())) fail('PRIVACY_TIME_INVALID');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('PRIVACY_TIME_INVALID');
  const elapsed = now.getTime() - dueAt.getTime();
  return elapsed <= 0 ? 0 : Math.floor(elapsed / DAY_MS) || 1;
}

// ---- 状态机 -----------------------------------------------------------------

const TRANSITIONS: Record<PrivacyStatus, readonly PrivacyStatus[]> = {
  // 未核验也能直接拒绝（明显是骚扰或与本店无关），但拒绝不是处置，不接触任何资料。
  received: ['verified', 'rejected'],
  verified: ['approved', 'rejected', 'needs_information', 'completed'],
  // 人还是那个人，补的是材料不是身份：收到补充后直接决定，不重新核验。
  needs_information: ['approved', 'rejected', 'completed'],
  approved: ['completed'],
  rejected: [],
  completed: [],
};

export function canTransition(from: PrivacyStatus, to: PrivacyStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertPrivacyTransition(from: PrivacyStatus, to: PrivacyStatus): void {
  if (!PRIVACY_STATUSES.includes(from)) fail('PRIVACY_STATUS_INVALID');
  if (!PRIVACY_STATUSES.includes(to)) fail('PRIVACY_STATUS_INVALID');
  if (!canTransition(from, to)) fail('PRIVACY_STATUS_CONFLICT');
}

export function decisionStatus(decision: PrivacyDecision): PrivacyStatus {
  if (!PRIVACY_DECISIONS.includes(decision)) fail('PRIVACY_DECISION_INVALID');
  return decision;
}

export function isTerminal(status: PrivacyStatus): boolean {
  return status === 'rejected' || status === 'completed';
}

/** 进入处置阶段的两个状态：都要求先核验身份。 */
export function requiresVerifiedIdentity(status: PrivacyStatus): boolean {
  return status === 'approved' || status === 'completed';
}

// ---- 核验与决定 -------------------------------------------------------------

export interface PrivacyVerification {
  verificationMethod: string;
  evidenceRef: string;
  reason: string;
}

/** 核验只记录「核验通过」；核验不通过走决定 rejected，避免把「查无此人」写进核验记录。 */
export function normalizePrivacyVerification(body: unknown): PrivacyVerification {
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return { verificationMethod: text(input.verificationMethod, 'PRIVACY_VERIFICATION_INVALID', 80),
    evidenceRef: text(input.evidenceRef, 'PRIVACY_VERIFICATION_INVALID', MAX_REF_LENGTH),
    reason: text(input.reason, 'PRIVACY_VERIFICATION_INVALID', MAX_REASON_LENGTH) };
}

export interface PrivacyDecisionInput {
  decision: PrivacyDecision;
  reason: string;
  retentionExceptionRef: string | null;
  exportJobId: string | null;
}

/** 完成删除/匿名化必须记下保留例外：交易事实不随请求消失，依据要能指出来。 */
export const RETENTION_REQUIRED_TYPES: readonly PrivacyRequestType[] = ['delete', 'anonymize'];

export function normalizePrivacyDecision(body: unknown, requestType: PrivacyRequestType): PrivacyDecisionInput {
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const decision = input.decision;
  if (typeof decision !== 'string' || !PRIVACY_DECISIONS.includes(decision as PrivacyDecision)) fail('PRIVACY_DECISION_INVALID');
  const reason = text(input.reason, 'PRIVACY_DECISION_INVALID', MAX_REASON_LENGTH);
  const retentionExceptionRef = optionalText(input.retentionExceptionRef, 'PRIVACY_DECISION_INVALID', MAX_REF_LENGTH);
  const rawExport = input.exportJobId;
  let exportJobId: string | null = null;
  if (rawExport !== undefined && rawExport !== null) {
    if (typeof rawExport !== 'string' || !UUID.test(rawExport)) fail('PRIVACY_DECISION_INVALID');
    exportJobId = rawExport;
  }
  if (decision === 'completed' && RETENTION_REQUIRED_TYPES.includes(requestType) && !retentionExceptionRef) {
    fail('PRIVACY_RETENTION_EXCEPTION_REQUIRED');
  }
  return { decision: decision as PrivacyDecision, reason, retentionExceptionRef, exportJobId };
}

export interface PrivacyUpdateInput {
  ownerId: string | null | undefined;
  dueAt: Date | undefined;
  reason: string;
}

/** 改负责人或延期必须说明理由：队列上的每个日期变化都要能回答「谁改的、为什么」。 */
export function normalizePrivacyUpdate(body: unknown): PrivacyUpdateInput {
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const hasOwner = Object.prototype.hasOwnProperty.call(input, 'ownerId');
  const hasDue = Object.prototype.hasOwnProperty.call(input, 'dueAt');
  if (!hasOwner && !hasDue) fail('EMPTY_PATCH');
  let ownerId: string | null | undefined;
  if (hasOwner) {
    const raw = input.ownerId;
    if (raw === null) ownerId = null;
    else if (typeof raw === 'string' && UUID.test(raw)) ownerId = raw;
    else fail('PRIVACY_OWNER_INVALID');
  }
  const dueAt = hasDue ? timestamp(input.dueAt, 'PRIVACY_DUE_AT_INVALID') : undefined;
  return { ownerId, dueAt, reason: text(input.reason, 'PRIVACY_UPDATE_REASON_REQUIRED', MAX_REASON_LENGTH) };
}

/** 延期只能往后、且不超过一年：把到期日改到过去等于伪造逾期记录。 */
export function assertDueAtExtension(dueAt: Date, receivedAt: Date): void {
  const limit = receivedAt.getTime() + 366 * DAY_MS;
  if (dueAt.getTime() <= receivedAt.getTime() || dueAt.getTime() > limit) fail('PRIVACY_DUE_AT_INVALID');
}
