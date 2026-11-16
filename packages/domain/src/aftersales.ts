/**
 * 售后与退款（M16 第一批）领域规则。
 *
 * 与其它领域模块一样，这里只有判定与规范化，不碰数据库。四条底线：
 * 1. 案件不改写订单与付款快照：申请数量、批准数量、金额分摊都是本模块自己的记录。
 * 2. 退款的金额上限来自“实际收到的钱减去已退与在途退款”，不来自订单总额。
 * 3. 未收款（含 COD 未收款）不能产生支付退款；拒收/退回不等于退款。
 * 4. 退回商品在质检前不进可售库存；只有 `sellable` 才加回 onHand。
 */
export class AfterSalesRuleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fail(code: string): never {
  throw new AfterSalesRuleError(code);
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const REASON_CODE = /^[a-z0-9][a-z0-9_]{0,79}$/;

export type CaseType = 'cancel' | 'refund' | 'return' | 'exchange';
export type CaseStatus = 'submitted' | 'under_review' | 'approved' | 'rejected' | 'needs_information'
  | 'return_in_transit' | 'received_inspection' | 'refund_pending' | 'refunded' | 'replacement_sent'
  | 'completed' | 'closed';
export type CaseAction = 'approve' | 'reject' | 'dispatch_return' | 'receive_return' | 'inspect'
  | 'request_refund' | 'refund_settled' | 'close';
export type RefundStatus = 'requested' | 'approved' | 'processing' | 'refunded' | 'failed' | 'rejected'
  | 'cancelled' | 'unknown';
export type RefundAction = 'approve' | 'reject' | 'execute' | 'fail' | 'cancel';
export type Disposition = 'sellable' | 'damaged' | 'quarantine' | 'scrap';

export const CASE_TYPES: readonly CaseType[] = ['cancel', 'refund', 'return', 'exchange'];
export const DISPOSITIONS: readonly Disposition[] = ['sellable', 'damaged', 'quarantine', 'scrap'];

/** 哪些动作可以从哪些状态发起：状态只能沿这张表前进，没有“直接改状态”的入口。 */
const CASE_ACTIONS: Record<CaseAction, readonly CaseStatus[]> = {
  approve: ['submitted', 'under_review'],
  reject: ['submitted', 'under_review'],
  dispatch_return: ['approved', 'return_in_transit'],
  receive_return: ['approved', 'return_in_transit'],
  inspect: ['received_inspection'],
  request_refund: ['approved', 'return_in_transit', 'received_inspection'],
  refund_settled: ['refund_pending'],
  close: ['approved', 'received_inspection', 'refunded', 'replacement_sent'],
};

const CASE_RESULT: Record<CaseAction, CaseStatus> = {
  approve: 'approved',
  reject: 'rejected',
  dispatch_return: 'return_in_transit',
  receive_return: 'received_inspection',
  inspect: 'received_inspection',
  request_refund: 'refund_pending',
  refund_settled: 'refunded',
  close: 'completed',
};

export function assertCaseAction(status: string, action: CaseAction) {
  if (!CASE_ACTIONS[action]) fail('VALIDATION_ERROR');
  if (!CASE_ACTIONS[action].includes(status as CaseStatus)) fail('CASE_STATE_CONFLICT');
}

export function statusAfterAction(action: CaseAction): CaseStatus {
  return CASE_RESULT[action];
}

export interface CaseLine {
  orderItemId: string;
  quantity: number;
}

/** 案件行：只能引用本订单的订单行，累计申请量不得超过订购量（一单多案也不行）。 */
export function normalizeCaseLines(orderLines: readonly { id: string; quantity: number }[],
  alreadyRequested: ReadonlyMap<string, number>, requested: unknown): CaseLine[] {
  if (!Array.isArray(requested) || !requested.length) fail('VALIDATION_ERROR');
  if (requested.length > 100) fail('VALIDATION_ERROR');
  const seen = new Set<string>();
  return requested.map(entry => {
    const line = entry as { orderItemId?: unknown; quantity?: unknown };
    if (!line || typeof line.orderItemId !== 'string' || !line.orderItemId.length) fail('VALIDATION_ERROR');
    if (seen.has(line.orderItemId)) fail('VALIDATION_ERROR');
    seen.add(line.orderItemId);
    const orderLine = orderLines.find(candidate => candidate.id === line.orderItemId) ?? fail('VALIDATION_ERROR');
    if (!Number.isInteger(line.quantity) || (line.quantity as number) < 1 || (line.quantity as number) > 99) {
      fail('VALIDATION_ERROR');
    }
    const remaining = orderLine.quantity - (alreadyRequested.get(orderLine.id) ?? 0);
    if ((line.quantity as number) > remaining) fail('CASE_QUANTITY_EXCEEDED');
    return { orderItemId: orderLine.id, quantity: line.quantity as number };
  });
}

/** 金额分摊：按订单行快照的行总额与数量等比折算，向下取整——平台不多退一分钱。 */
export function allocateLineAmount(lineTotalMinor: number, lineQuantity: number, caseQuantity: number): number {
  if (!Number.isSafeInteger(lineTotalMinor) || lineTotalMinor < 0) fail('VALIDATION_ERROR');
  if (!Number.isInteger(lineQuantity) || lineQuantity < 1) fail('VALIDATION_ERROR');
  if (!Number.isInteger(caseQuantity) || caseQuantity < 1 || caseQuantity > lineQuantity) fail('VALIDATION_ERROR');
  return Math.floor(lineTotalMinor * caseQuantity / lineQuantity);
}

/** 可退余额 = 实收 - 已退 - 在途（已申请/已批准/处理中/未知）。 */
export function refundableBalance(input: { collectedMinor: number; refundedMinor: number;
  pendingMinor: number }): number {
  const balance = input.collectedMinor - input.refundedMinor - input.pendingMinor;
  if (!Number.isSafeInteger(balance)) fail('VALIDATION_ERROR');
  return balance < 0 ? 0 : balance;
}

export function assertRefundWithinBalance(input: { availableMinor: number; amountMinor: number;
  currency: string; orderCurrency: string }) {
  if (input.currency !== input.orderCurrency) fail('REFUND_CURRENCY_MISMATCH');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) fail('VALIDATION_ERROR');
  if (input.amountMinor > input.availableMinor) fail('REFUND_EXCEEDS_BALANCE');
}

/**
 * 只有真正收到钱的流水才能退款：`returned` 代表钱已经线下退回，再退一次就是重复付款；
 * COD 未收款（pending）也必须拒绝，不能凭空造出一笔“退款”。
 */
export function assertRefundablePayment(status: string) {
  if (status === 'returned') fail('PAYMENT_ALREADY_RETURNED');
  if (status !== 'collected' && status !== 'succeeded') fail('NOTHING_TO_REFUND');
}

/** 取消类案件只处理“未发货且未收款”的订单；已收款必须走退款、已发货必须走退货。 */
export function assertCancelCaseOrder(order: { orderStatus: string; paymentStatus: string }) {
  if (order.paymentStatus === 'collected' || order.paymentStatus === 'succeeded') fail('PAID_ORDER_REQUIRES_REFUND');
  if (order.orderStatus === 'cancelled') fail('ORDER_ALREADY_CANCELLED');
  if (['shipped', 'partially_shipped', 'completed'].includes(order.orderStatus)) fail('ORDER_ALREADY_SHIPPED');
}

/** 可退款的案件类型：取消/换货不产生支付退款（换货是补发，不是退钱）。 */
export function assertCaseRefundable(caseType: string, status: string) {
  if (caseType === 'cancel') fail('CASE_NOT_REFUNDABLE');
  if (caseType === 'exchange') fail('CASE_NOT_REFUNDABLE');
  if (!['approved', 'return_in_transit', 'received_inspection', 'refund_pending'].includes(status)) {
    fail('CASE_NOT_APPROVED');
  }
}

/** 退款状态机：requested → approved → refunded；failed 可经重新批准重试，unknown 没有人工出口。 */
const REFUND_ACTIONS: Record<string, Partial<Record<RefundAction, RefundStatus>>> = {
  requested: { approve: 'approved', reject: 'rejected', cancel: 'cancelled' },
  approved: { execute: 'refunded', fail: 'failed', cancel: 'cancelled' },
  processing: { execute: 'refunded', fail: 'failed' },
  failed: { approve: 'approved', cancel: 'cancelled' },
  unknown: {},
};

export function nextRefundStatus(current: string, action: RefundAction): RefundStatus {
  if (!REFUND_ACTIONS[current]) fail('REFUND_STATE_CONFLICT');
  const next = REFUND_ACTIONS[current]![action];
  if (!next) {
    if (current === 'unknown') fail('REFUND_STATUS_UNKNOWN_REQUIRES_PROVIDER');
    fail('REFUND_STATE_CONFLICT');
  }
  return next;
}

export function restocksStock(disposition: string): boolean {
  return disposition === 'sellable';
}

export const MOVEMENT_TYPE: Record<Disposition, string> = {
  sellable: 'return_restock',
  damaged: 'return_damaged',
  quarantine: 'return_quarantine',
  scrap: 'return_scrap',
};

export function normalizeReason(value: unknown, max = 1_000): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text.length || text.length > max || CONTROL.test(text)) fail('VALIDATION_ERROR');
  return text;
}

export function normalizeReasonCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('VALIDATION_ERROR');
  const code = value.trim();
  if (!code.length) return null;
  if (!REASON_CODE.test(code)) fail('VALIDATION_ERROR');
  return code;
}

export function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('VALIDATION_ERROR');
  const text = value.trim();
  if (!text.length) return null;
  if (text.length > max || CONTROL.test(text)) fail('VALIDATION_ERROR');
  return text;
}

/** 履约类时间不能写进未来：收件时间造假会让库存与报表同时失真。 */
export function parseTimestamp(value: unknown, now = new Date(), field = 'VALIDATION_ERROR'): Date {
  if (typeof value !== 'string' || value.length > 40) fail(field);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(field);
  if (date.getTime() > now.getTime() + 60_000) fail(field);
  return date;
}

export interface RefundAmountInput {
  caseType: string;
  orderTotalMinor: number;
  requestedMinor: number | null;
  allocatedMinor: number;
  currency: string;
  orderCurrency: string;
}

/**
 * 案件批准时的应退金额：申请金额与行分摊取小者，且不能超过订单总额。
 * 真正的余额校验仍在创建退款时做——批准不等于已经把钱退出去。
 */
export function approvedAmount(input: RefundAmountInput): number {
  if (input.currency !== input.orderCurrency) fail('VALIDATION_ERROR');
  if (input.caseType === 'cancel' || input.caseType === 'exchange') return 0;
  const cap = Math.min(input.allocatedMinor, input.orderTotalMinor);
  const requested = input.requestedMinor === null ? cap : input.requestedMinor;
  if (requested < 0) fail('VALIDATION_ERROR');
  return Math.min(requested, cap);
}

/** 质检数量上限 = 已收货数量 - 已质检数量，重复质检会被挡住而不是把库存加两次。 */
export function assertInspectionQuantity(received: number, inspected: number, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) fail('VALIDATION_ERROR');
  if (quantity > received - inspected) fail('INSPECTION_QUANTITY_EXCEEDED');
}

export function caseNumber(day: string, suffix: string) {
  if (!/^\d{8}$/.test(day)) fail('VALIDATION_ERROR');
  if (!/^[A-Z0-9]{6}$/.test(suffix)) fail('VALIDATION_ERROR');
  return `AS-${day}-${suffix}`;
}

export function refundNumber(day: string, suffix: string) {
  if (!/^\d{8}$/.test(day)) fail('VALIDATION_ERROR');
  if (!/^[A-Z0-9]{6}$/.test(suffix)) fail('VALIDATION_ERROR');
  return `REF-${day}-${suffix}`;
}
