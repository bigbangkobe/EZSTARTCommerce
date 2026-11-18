/**
 * 交易经营报表（M14 第一批）纯规则层。
 *
 * 只回答四件事：有哪些报表、筛选条件怎么校验、时间怎么归属到店铺本地日、
 * 报表/导出的数值怎么口径化。不碰数据库、不碰网络——所有函数输入输出都是普通值，
 * 便于逐条断言，也让「同一个筛选在页面与导出里必须一致」有单一实现。
 *
 * 四条口径（对应 docs/modules/M14_REPORTS.md 的指标口径初稿）：
 * 1. 下单按 placedAt、线上收款按 paidAt、COD 收款按 paidAt（collected）、
 *    退款按 executedAt——同一笔订单在不同报表里可以按不同的权威时间落在不同日。
 * 2. 订单额是「成功创建的订单」，包含之后取消的订单；取消额、退款额另列，
 *    测试/重复幂等请求不重复计数（由订单号唯一保证）。
 * 3. 已收金额只计 succeeded/collected 与 COD collected；待收 COD、unknown、
 *    failed、cancelled 一律不计。净销售额 = 已收商品金额 - 成功商品退款。
 * 4. 金额是整数分且按币种分组，绝不跨币种相加；报表与导出都不放 PII。
 */

export class ReportRuleError extends Error {
  constructor(readonly field: string, readonly code = 'VALIDATION_ERROR') { super(field); }
}

/** 指标定义版本：口径或维度变了必须升版本，历史导出要能解释当时的算法。 */
export const REPORT_METRIC_VERSION = '1.0';
/** 漏斗口径版本：归因规则（服务端订单权威、24h 窗口、小样本保护）变更时升级。 */
export const FUNNEL_METRIC_VERSION = '1.0';
/** 导出短时下载有效期（分钟）。 */
export const REPORT_EXPORT_TTL_MINUTES = 30;
/** 小样本保护阈值：某个维度下的订单数低于此值时，比率不展示，避免反推出个体。 */
export const REPORT_MIN_SAMPLE = 20;
/** 单次报表最大跨度（天）：防止一次扫全库，也符合经营报表按区间查看的习惯。 */
export const REPORT_MAX_RANGE_DAYS = 366;

export const REPORT_KEYS = [
  'sales_summary', 'orders_by_status', 'orders_by_payment', 'orders_by_method',
  'product_sales', 'inventory', 'coupons', 'members', 'funnel',
] as const;
export type ReportKey = typeof REPORT_KEYS[number];

export const REPORT_EXPORT_FORMATS = ['csv'] as const;
export type ReportExportFormat = typeof REPORT_EXPORT_FORMATS[number];

/** 状态闭集与权威时间字段：报表只认这些值，未知状态进「其他」而不是被静默丢弃。 */
export const PAID_PAYMENT_STATUSES = ['succeeded', 'collected'] as const;
export const COD_PAYMENT_STATUSES = ['collected'] as const;
export const REFUNDED_STATUS = 'refunded';
export const CANCELLED_ORDER_STATUS = 'cancelled';

export interface ReportFilters {
  from: string;
  to: string;
  timezone: string;
  marketCode: string | null;
  paymentMethodCode: string | null;
  /** 漏斗专用筛选（经营报表忽略这些字段）。 */
  locale: string | null;
  deviceClass: string | null;
  source: string | null;
  /** 漏斗分组维度：step（默认，五步汇总）/ device / source / locale / day。 */
  groupBy: string | null;
}

/** 漏斗允许的分组维度闭集：不含任何 PII 维度键。 */
export const FUNNEL_GROUP_BY = ['step', 'device', 'source', 'locale', 'day'] as const;

export interface ReportRowInput {
  dimensions: Record<string, string | null>;
  metrics: Record<string, number>;
}

function fail(field: string, code = 'VALIDATION_ERROR'): never { throw new ReportRuleError(field, code); }

/** 时区必须是 IANA 标识：非法时区会让 Intl 抛 RangeError，必须先挡住再报 422。 */
export function assertTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) fail('timezone');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value }); } catch { fail('timezone'); }
  return value;
}

/** date-time 必须是 UTC 时刻（带 Z 或偏移）；本地时间字符串没有唯一时刻，会导致跨时区对账偏差。 */
export function assertInstant(value: unknown, field: 'from' | 'to'): Date {
  if (typeof value !== 'string' || value.length < 20 || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) fail(field);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(field);
  return date;
}

function optionalCode(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(field);
  return value;
}

/**
 * 校验并规范化筛选：页面与导出共用这一份实现，保证「导出结果与页面筛选一致」。
 * from/to 是含起不含止的 UTC 时刻；市场/付款方式是可选维度，不允许夹带 PII。
 */
export function normalizeReportFilters(raw: Record<string, unknown>): { filters: ReportFilters; from: Date; to: Date } {
  const from = assertInstant(raw['from'], 'from');
  const to = assertInstant(raw['to'], 'to');
  if (from.getTime() >= to.getTime()) fail('to');
  if ((to.getTime() - from.getTime()) / 86_400_000 > REPORT_MAX_RANGE_DAYS) fail('to');
  const timezone = assertTimezone(raw['timezone']);
  const deviceClass = optionalCode(raw['deviceClass'], 'deviceClass');
  if (deviceClass && !['desktop', 'mobile', 'tablet'].includes(deviceClass)) fail('deviceClass');
  const groupByRaw = optionalCode(raw['groupBy'], 'groupBy');
  if (groupByRaw && !FUNNEL_GROUP_BY.includes(groupByRaw as never)) fail('groupBy');
  return {
    from, to,
    filters: {
      from: from.toISOString(), to: to.toISOString(), timezone,
      marketCode: optionalCode(raw['marketCode'], 'marketCode'),
      paymentMethodCode: optionalCode(raw['paymentMethodCode'], 'paymentMethodCode'),
      locale: optionalCode(raw['locale'], 'locale'),
      deviceClass,
      source: optionalCode(raw['source'], 'source'),
      groupBy: groupByRaw,
    },
  };
}

export function assertReportKey(value: unknown): ReportKey {
  if (typeof value !== 'string' || !REPORT_KEYS.includes(value as ReportKey)) fail('reportKey');
  return value as ReportKey;
}

export function assertReportFormat(value: unknown): ReportExportFormat {
  if (typeof value !== 'string' || !REPORT_EXPORT_FORMATS.includes(value as ReportExportFormat)) fail('format');
  return value as ReportExportFormat;
}

/** UTC 时刻 → 店铺本地日（YYYY-MM-DD）。跨日切分、夏令时都由 Intl 处理，不自己加减小时。 */
export function localDay(timezone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).reduce<Record<string, string>>((acc, part) =>
    (part.type === 'literal' ? acc : { ...acc, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 在 UTC 半开区间 [from, to) 内。未填时间的行不计入对应口径。 */
export function within(instant: Date | null | undefined, from: Date, to: Date): boolean {
  if (!instant) return false;
  const value = instant.getTime();
  return value >= from.getTime() && value < to.getTime();
}

/** 整数求和且只在同币种内相加；调用方按 currency 分组后再调用。 */
export function sumMinor(values: readonly number[]): number {
  return values.reduce((total, value) => {
    if (!Number.isSafeInteger(value)) fail('amountMinor');
    return total + value;
  }, 0);
}

/** 比率保留两位小数（万分位四舍五入）；分母为 0 返回 null，不展示误导性百分比。 */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

/**
 * 小样本比率：样本数低于阈值时返回 null（"数据不足"，不是 0%）。
 * 仅用于 P1 陈列/漏斗等可能被反推出个体行为的场景；经营聚合（券使用率等）用 ratio 即可。
 */
export function smallSampleRatio(numerator: number, denominator: number, sampleSize = denominator): number | null {
  if (sampleSize < REPORT_MIN_SAMPLE) return null;
  return ratio(numerator, denominator);
}

/** 平均金额用整数除法（向下取整），与财务口径一致，不产生浮点分。 */
export function averageMinor(totalMinor: number, count: number): number | null {
  if (count <= 0 || !Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(count)) return null;
  return Math.floor(totalMinor / count);
}

/** 维度行累加器：同一维度键值合并指标，顺序稳定（先出现先输出）。 */
export class RowAccumulator {
  private readonly rows = new Map<string, ReportRowInput>();
  add(dimensions: Record<string, string | null>, metrics: Record<string, number>): void {
    const key = JSON.stringify(dimensions);
    const current = this.rows.get(key);
    if (!current) { this.rows.set(key, { dimensions, metrics: { ...metrics } }); return; }
    for (const [name, value] of Object.entries(metrics)) {
      current.metrics[name] = (current.metrics[name] ?? 0) + value;
    }
  }
  list(): ReportRowInput[] { return [...this.rows.values()]; }
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** RFC 4180 字段转义；以公式符号开头的单元格前置单引号，防止导出文件在表格软件里执行公式。 */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** UTF-8 BOM 让 Excel 正确识别中文；换行统一 CRLF。 */
export function csvDocument(lines: readonly (readonly (string | number | boolean | null)[])[]): string {
  return '\ufeff' + lines.map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 导出前导注释：筛选、时区、币种、口径版本、数据更新时间、采集/覆盖状态都在文件里，便于事后复核。 */
export function exportPreamble(filters: ReportFilters, reportKey: ReportKey, currencies: readonly string[],
  generatedAt: string, coverageNote: string): string[][] {
  return [
    ['EZSTART 经营报表导出'],
    ['报表', reportKey],
    ['筛选条件', JSON.stringify(filters)],
    ['店铺时区', filters.timezone],
    ['币种（分，不跨币种相加）', currencies.join(' ')],
    ['指标口径版本', REPORT_METRIC_VERSION],
    ['生成时间(UTC)', generatedAt],
    ['数据覆盖', coverageNote],
    [],
  ];
}
