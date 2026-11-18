"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { permissionCodes: string[]; csrfToken: string };
type ReportRow = { dimensions: Record<string, string | null>; metrics: Record<string, number> };
type ReportResult = {
  reportKey: string; metricDefinitionVersion: string; generatedAt: string;
  from: string; to: string; timezone: string; currencies: string[];
  filters: Record<string, unknown>; totals: Record<string, number>; rows: ReportRow[];
  coverage: { sourceOrderCount: number; lastDataAt: string | null; complete: boolean; note: string };
};
type ReportExport = { id: string; reportKey: string; format: string; status: string;
  fileName: string | null; rowCount: number | null; downloadUrl: string | null;
  createdAt: string; expiresAt: string };

const REPORT_KEYS = [
  ['sales_summary', '销售汇总'],
  ['orders_by_status', '订单状态分布'],
  ['orders_by_payment', '付款状态分布'],
  ['orders_by_method', '付款方式分布'],
  ['product_sales', '商品销售排行'],
  ['inventory', '库存汇总'],
  ['coupons', '优惠券效果'],
  ['members', '会员概览'],
  ['funnel', '访问漏斗'],
] as const;

const METRIC_LABEL: Record<string, string> = {
  orderCount: '订单数', cancelledOrderCount: '取消订单', paymentCount: '收款笔数', refundCount: '退款笔数',
  placedMinor: '下单额', discountMinor: '优惠额', shippingMinor: '配送费', collectedMinor: '已收金额',
  codCollectedMinor: 'COD 已收', refundedMinor: '退款额', netSalesMinor: '净销售额', cancelledMinor: '取消额',
  quantity: '销量', lineCount: '订单行数', reservedCount: '发放数', redeemedCount: '核销数',
  usageRate: '使用率(%)', onHand: '在库', reserved: '预留', available: '可用',
  lowStockLevel: '低库存线', variantCount: '规格数', lowStockCount: '低库存数', outOfStockCount: '缺货数',
  registeredMembers: '新增会员', activeMembers: '活跃会员', pointsIssued: '发放积分',
  pointsRedeemed: '兑换积分', lifetimeSpendMinor: '累计消费', activeMembersCount: '活跃会员',
};
const DIM_LABEL: Record<string, string> = {
  day: '日期', status: '状态', method: '付款方式', sku: 'SKU', productName: '商品',
  code: '券码', tier: '会员等级', market: '市场', currency: '币种', locale: '语言',
};
const AMOUNT_KEYS = new Set(['placedMinor', 'discountMinor', 'shippingMinor', 'collectedMinor', 'codCollectedMinor',
  'refundedMinor', 'netSalesMinor', 'cancelledMinor', 'lifetimeSpendMinor']);

function defaultRange(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { from: iso(from), to: iso(to) };
}
function toUtc(local: string) {
  // 表单里是本地时间，转成 UTC 时刻交给服务端；时区归属由服务端的 timezone 参数负责。
  return new Date(local).toISOString();
}
function fmtValue(key: string, value: number, currency: string | null) {
  if (AMOUNT_KEYS.has(key) && currency) return `${currency} ${(value / 100).toFixed(2)}`;
  if (key === 'usageRate') return `${value}%`;
  return String(value);
}

export function ReportsConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [reportKey, setReportKey] = useState<string>('sales_summary');
  const range = useRef(defaultRange(30));
  const [from, setFrom] = useState(range.current.from);
  const [to, setTo] = useState(range.current.to);
  const [timezone, setTimezone] = useState('Asia/Hong_Kong');
  const [marketCode, setMarketCode] = useState('');
  const [paymentMethodCode, setPaymentMethodCode] = useState('');
  const [deviceClass, setDeviceClass] = useState('');
  const [source, setSource] = useState('');
  const [groupBy, setGroupBy] = useState('step');
  const [result, setResult] = useState<ReportResult | null>(null);
  const [exports, setExports] = useState<ReportExport[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canView = permissions.includes('reports.view');
  const canExport = permissions.includes('reports.export');

  async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '', 'Idempotency-Key': crypto.randomUUID() } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = payload?.error?.code ?? '';
      if (response.status === 403) throw new Error('当前账号没有该操作权限。');
      if (response.status === 422) throw new Error(code === 'EXPORT_FORMAT_UNSUPPORTED' ? '暂不支持该导出格式，请选择 CSV。'
        : '筛选条件不合法：结束时间须晚于开始时间，区间不超过一年，时区须为有效 IANA 标识。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return (await response.json()).data as T;
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const info = await request<Session>('auth/session');
        if (!active) return;
        session.current = info; setPermissions(info.permissionCodes);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : '加载会话失败。'); }
    })();
    return () => { active = false; };
  }, []);

  function queryString() {
    const params = new URLSearchParams({ from: toUtc(from), to: toUtc(to), timezone });
    if (marketCode) params.set('marketCode', marketCode);
    if (paymentMethodCode) params.set('paymentMethodCode', paymentMethodCode);
    if (reportKey === 'funnel') {
      if (deviceClass) params.set('deviceClass', deviceClass);
      if (source) params.set('source', source);
      if (groupBy) params.set('groupBy', groupBy);
    }
    return params.toString();
  }

  async function run(action: () => Promise<string>) {
    setBusy(true); setError(''); setNotice('');
    try { setNotice(await action()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败。'); }
    finally { setBusy(false); }
  }

  function load() {
    return run(async () => {
      const data = await request<ReportResult>(`reports/${reportKey}?${queryString()}`);
      setResult(data);
      return `已生成报表，口径版本 ${data.metricDefinitionVersion}。`;
    });
  }

  function quickRange(days: number) {
    const next = defaultRange(days);
    setFrom(next.from); setTo(next.to);
  }

  function exportCsv() {
    return run(async () => {
      const created = await request<ReportExport>('report-exports', 'POST', {
        reportKey, from: toUtc(from), to: toUtc(to), timezone,
        ...(marketCode ? { marketCode } : {}),
        ...(paymentMethodCode ? { paymentMethodCode } : {}),
        ...(reportKey === 'funnel' ? {
          ...(deviceClass ? { deviceClass } : {}),
          ...(source ? { source } : {}),
          ...(groupBy ? { groupBy } : {}),
        } : {}),
        format: 'csv',
      });
      setExports(previous => [created, ...previous.filter(item => item.id !== created.id)]);
      return created.downloadUrl ? '导出已就绪，可点击下载。' : '导出任务已创建。';
    });
  }

  if (!canView && permissions.length > 0) {
    return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
      <header><div><p className="eyebrow">店铺管理</p><h1>经营报表</h1></div>
        <div className="actions"><a href="/admin/orders">订单</a><a href="/admin/members">会员与积分</a><a href="/admin/settings">店铺设置</a></div></header>
      <p className="error">当前账号没有报表读取权限（reports.view）。</p></main>;
  }

  const currencies = result?.currencies ?? [];
  const currency = currencies.length === 1 ? currencies[0]! : null;

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>经营报表</h1></div>
      <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a>
        <a href="/admin/payments">付款</a><a href="/admin/inventory">库存</a><a href="/admin/coupons">优惠券</a>
        <a href="/admin/members">会员与积分</a><a href="/admin/settings">店铺设置</a></div></header>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <p><small>报表以订单、支付、退款与积分为准（服务端权威数据），不含顾客资料。金额按币种分别展示，不跨币种相加。</small></p>
    <p><small>访问漏斗依赖店铺「访问漏斗采集」开关与访客明示同意；成功下单由服务端订单归因，阶段转化率在样本不足 20 时不展示。</small></p>

    <form onSubmit={(event: FormEvent) => { event.preventDefault(); void load(); }}>
      <label>报表<select value={reportKey} onChange={event => setReportKey(event.target.value)}>
        {REPORT_KEYS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>开始<input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>结束<input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></label>
      <label>时区<input value={timezone} onChange={event => setTimezone(event.target.value)} maxLength={64} /></label>
      <label>市场<input value={marketCode} onChange={event => setMarketCode(event.target.value)} maxLength={16} placeholder="可选，如 HK" /></label>
      <label>付款方式<input value={paymentMethodCode} onChange={event => setPaymentMethodCode(event.target.value)} maxLength={32} placeholder="可选，如 cod" /></label>
      {reportKey === 'funnel' && <>
        <label>设备<select value={deviceClass} onChange={event => setDeviceClass(event.target.value)}>
          <option value="">全部</option><option value="desktop">桌面</option>
          <option value="mobile">手机</option><option value="tablet">平板</option>
        </select></label>
        <label>来源<input value={source} onChange={event => setSource(event.target.value)} maxLength={64} placeholder="可选，UTM 来源" /></label>
        <label>分组<select value={groupBy} onChange={event => setGroupBy(event.target.value)}>
          <option value="step">按步骤</option><option value="device">按设备</option>
          <option value="source">按来源</option><option value="locale">按语言</option><option value="day">按日期</option>
        </select></label>
      </>}
      <button disabled={busy} type="submit">生成报表</button>
      <button disabled={busy} type="button" onClick={() => quickRange(7)}>近7天</button>
      <button disabled={busy} type="button" onClick={() => quickRange(30)}>近30天</button>
      {canExport && <button disabled={busy} type="button" onClick={() => void exportCsv()}>导出 CSV</button>}
    </form>

    {result && <article>
      <h2>{REPORT_KEYS.find(([key]) => key === result.reportKey)?.[1] ?? result.reportKey}</h2>
      <p><small>口径版本 {result.metricDefinitionVersion} · 时区 {result.timezone} · 币种 {currencies.join(' / ') || '—'}
        {' · '}数据更新 {result.generatedAt ? new Date(result.generatedAt).toLocaleString() : '—'}</small></p>
      {Object.keys(result.totals).length > 0 && <table>
        <thead><tr><th>指标</th><th>合计</th></tr></thead>
        <tbody>{Object.entries(result.totals).map(([key, value]) =>
          <tr key={key}><td>{METRIC_LABEL[key] ?? key}</td><td>{fmtValue(key, value, currency)}</td></tr>)}</tbody>
      </table>}
      {result.rows.length > 0 && <table>
        <thead><tr>
          {Object.keys(result.rows[0]!.dimensions).map(key => <th key={`d-${key}`}>{DIM_LABEL[key] ?? key}</th>)}
          {Object.keys(result.rows[0]!.metrics).map(key => <th key={`m-${key}`}>{METRIC_LABEL[key] ?? key}</th>)}
        </tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index}>
          {Object.values(row.dimensions).map((value, i) => <td key={`d-${i}`}>{value ?? '—'}</td>)}
          {Object.entries(row.metrics).map(([key, value], i) => <td key={`m-${i}`}>{fmtValue(key, value, row.dimensions.currency ?? currency)}</td>)}
        </tr>)}</tbody>
      </table>}
      {result.rows.length === 0 && <p><small>该区间没有符合条件的聚合数据。</small></p>}
      <p><small>数据覆盖：{result.coverage.note}</small></p>
    </article>}

    {canExport && exports.length > 0 && <article>
      <h2>导出记录</h2>
      <table>
        <thead><tr><th>报表</th><th>状态</th><th>行数</th><th>文件</th><th>下载</th></tr></thead>
        <tbody>{exports.map(item => <tr key={item.id}>
          <td>{item.reportKey}</td><td>{item.status}</td><td>{item.rowCount ?? '—'}</td><td>{item.fileName ?? '—'}</td>
          <td>{item.downloadUrl ? <a href={item.downloadUrl}>下载 CSV</a> : '已过期'}</td>
        </tr>)}</tbody>
      </table>
    </article>}
  </main>;
}
