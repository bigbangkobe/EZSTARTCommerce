/**
 * 后台统一的“机器值 → 人话”映射。
 *
 * 订单状态、收款状态、履约状态都是接口里的机器值（cancelled / cod_due …），
 * 直接甩到界面上等于让店员猜。这里集中一份，工作台、订单页共用，避免各页各写一套。
 */
export type Tone = 'hot' | 'warn' | 'ok' | 'bad' | 'dead' | '';

type StatusLabel = { label: string; tone: Tone };

export const ORDER_STATUS: Record<string, StatusLabel> = {
  pending_payment: { label: '待付款', tone: 'warn' },
  awaiting_confirmation: { label: '待确认', tone: 'hot' },
  confirmed: { label: '已确认', tone: '' },
  processing: { label: '处理中', tone: '' },
  partially_shipped: { label: '部分发货', tone: '' },
  shipped: { label: '已发货', tone: 'ok' },
  completed: { label: '已完成', tone: 'ok' },
  cancelled: { label: '已取消', tone: 'dead' },
  on_hold: { label: '已挂起', tone: 'warn' },
};

export const PAYMENT_STATUS: Record<string, StatusLabel> = {
  created: { label: '待支付', tone: 'warn' },
  requires_action: { label: '待完成', tone: 'warn' },
  processing: { label: '处理中', tone: '' },
  succeeded: { label: '已支付', tone: 'ok' },
  failed: { label: '支付失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'dead' },
  unknown: { label: '状态未知', tone: 'dead' },
  cod_due: { label: '货到付款待收', tone: 'hot' },
  collected: { label: '已收款', tone: 'ok' },
  rejected: { label: '已拒付', tone: 'bad' },
  returned: { label: '已退款', tone: 'dead' },
};

export const FULFILLMENT_STATUS: Record<string, StatusLabel> = {
  unfulfilled: { label: '未发货', tone: '' },
  partially_fulfilled: { label: '部分发货', tone: '' },
  fulfilled: { label: '已发货', tone: 'ok' },
  returned: { label: '已退回', tone: 'dead' },
  cancelled: { label: '已取消', tone: 'dead' },
};

function pick(map: Record<string, StatusLabel>, value: string): StatusLabel {
  return map[value] ?? { label: value, tone: 'dead' };
}

export const orderStatus = (value: string) => pick(ORDER_STATUS, value);
export const paymentStatus = (value: string) => pick(PAYMENT_STATUS, value);
export const fulfillmentStatus = (value: string) => pick(FULFILLMENT_STATUS, value);

/** 金额按分存储，展示一律两位小数；币种异常时不抛错，退化成“HKD 358.00”。 */
export function money(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat('zh-HK', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
  } catch { return `${currency} ${(minor / 100).toFixed(2)}`; }
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 2026-11-21 17:11：本地时区、可排序、不出现 11/21/2026 这种美式写法。 */
export function dateTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateOnly(iso: string) {
  return dateTime(iso).slice(0, 10);
}
