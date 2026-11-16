"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { permissionCodes: string[]; csrfToken: string };
type CaseItem = { orderItemId: string; sku: string; productName: string; variantName: string | null;
  orderedQuantity: number; requestedQuantity: number; approvedQuantity: number | null; amountMinor: number | null;
  disposed: string | null; receivedQuantity: number; inspectedQuantity: number };
type CaseRefund = { id: string; publicRefundNumber: string; status: string; amountMinor: number; currency: string;
  channel: string; createdAt: string; executedAt: string | null };
type ReturnParcel = { id: string; status: string; carrierCode: string | null; carrierName: string | null;
  trackingNumber: string | null; shippedAt: string | null; receivedAt: string | null; reference: string | null };
type CaseSummary = { id: string; publicCaseNumber: string; publicOrderNumber: string; caseType: string; status: string;
  reason: string; currency: string; orderTotalMinor: number; requestedRefundMinor: number | null;
  approvedRefundMinor: number | null; refundedMinor: number; refundableMinor: number; version: number;
  paymentStatus: string; createdAt: string; contactMasked: string | null };
type CaseDetail = CaseSummary & { orderId: string; orderStatus: string; pendingRefundMinor: number;
  items: CaseItem[]; refunds: CaseRefund[]; returns: ReturnParcel[];
  receipts: { id: string; receivedAt: string; reference: string | null;
    items: { orderItemId: string; quantity: number }[] }[];
  inspections: { id: string; orderItemId: string; quantity: number; disposition: string; note: string | null;
    createdAt: string }[];
  events: { id: string; type: string; fromStatus: string | null; toStatus: string; note: string | null;
    createdAt: string }[] };
type OrderLine = { id: string; sku: string; productName: string; variantName: string | null; quantity: number;
  lineTotalMinor: number };
type OrderDetail = { id: string; publicOrderNumber: string; currency: string; totalMinor: number;
  paymentStatus: string; orderStatus: string; version: number; lines: OrderLine[] };

const CASE_TYPE_LABEL: Record<string, string> = { cancel: '取消', refund: '退款', return: '退货', exchange: '换货' };
const STATUS_LABEL: Record<string, string> = { submitted: '待审核', under_review: '审核中', approved: '已批准',
  rejected: '已驳回', needs_information: '待补资料', return_in_transit: '退货在途', received_inspection: '已收货待质检',
  refund_pending: '退款处理中', refunded: '已退款', replacement_sent: '已补发', completed: '已结案', closed: '已关闭' };
const REFUND_LABEL: Record<string, string> = { requested: '待审批', approved: '已批准', processing: '处理中',
  refunded: '已退款', failed: '失败', rejected: '已驳回', cancelled: '已取消', unknown: '状态未知' };
const DISPOSITION_LABEL: Record<string, string> = { sellable: '可再售（入库）', damaged: '损坏', quarantine: '待检隔离',
  scrap: '报废' };

function money(minor: number, currency: string) {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}
function shortDate(value: string) {
  return new Date(value).toLocaleString();
}
/** 金额按“元”录入、按分提交：超过两位小数直接判为非法，不四舍五入。 */
function toMinor(value: string): number | null {
  const text = value.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const [major = '0', cents = ''] = text.split('.');
  return Number(major) * 100 + Number(cents.padEnd(2, '0'));
}

export function AfterSalesConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [selected, setSelected] = useState<CaseDetail | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [orderId, setOrderId] = useState('');
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canRead = permissions.includes('aftersales.read');
  const canManage = permissions.includes('aftersales.manage');
  const canApprove = permissions.includes('aftersales.approve');
  const canInspect = permissions.includes('aftersales.inspect');
  const canRefund = permissions.includes('refunds.create');
  const canApproveRefund = permissions.includes('refund.approve');
  const canExecuteRefund = permissions.includes('refund.execute');

  async function request<T>(path: string, method = 'GET', body?: object, version?: number): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '', 'Idempotency-Key': crypto.randomUUID() } : {}),
        ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = payload?.error?.code ?? '';
      if (response.status === 403) throw new Error(code === 'SELF_APPROVAL_FORBIDDEN'
        ? '不能批准自己申请的退款，请由另一位同事审批。' : '当前账号没有该操作权限。');
      if (response.status === 404) throw new Error('案件或订单不存在。');
      if (response.status === 409) throw new Error(code === 'VERSION_CONFLICT' ? '案件已被其他人修改，请刷新后重试。'
        : code === 'CASE_QUANTITY_EXCEEDED' ? '申请数量超过订单剩余可退数量。'
          : code === 'REFUND_EXCEEDS_BALANCE' ? '退款金额超过该笔付款的可退余额。'
            : code === 'INSPECTION_QUANTITY_EXCEEDED' ? '质检数量超过已收货且未质检的数量。'
              : code === 'REFUND_IN_PROGRESS' ? '还有在途退款，不能结案。'
                : code === 'PAID_ORDER_REQUIRES_REFUND' ? '订单已收款，请改走退款案件。'
                  : code === 'ORDER_ALREADY_SHIPPED' ? '订单已发货，不能按取消处理。'
                    : code === 'IDEMPOTENCY_CONFLICT' ? '同一幂等键已用于不同请求。'
                      : '当前状态不允许该操作，请刷新后确认。');
      if (response.status === 422) throw new Error(code === 'NOTHING_TO_REFUND' ? '这笔订单还没有已收款记录，不能退款。'
        : code === 'REFUND_REFERENCE_REQUIRED' ? '线下退款必须填写退款凭据号。' : '填写内容不符合要求，请检查后重试。');
      if (response.status === 503) throw new Error('该渠道没有可用的退款适配器，请走线下登记。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return ((await response.json()) as { data: T }).data;
  }

  async function reload(preferred?: string) {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (!current.permissionCodes.includes('aftersales.read')) return;
    const params = new URLSearchParams({ limit: '25' });
    if (query.trim()) params.set('q', query.trim());
    if (status) params.set('status', status);
    const list = await request<{ items: CaseSummary[] }>(`after-sales?${params.toString()}`);
    setCases(list.items);
    const nextId = preferred ?? selected?.id ?? list.items[0]?.id;
    if (nextId) setSelected(await request<CaseDetail>(`after-sales/${nextId}`));
    else setSelected(null);
  }
  useEffect(() => {
    const preset = new URLSearchParams(location.search).get('orderId');
    if (preset) setOrderId(preset);
    reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。'));
  }, []);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const message = await action(); await reload(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  async function openCase(id: string) {
    setBusy(true); setError(''); setNotice('');
    try { setSelected(await request<CaseDetail>(`after-sales/${id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败。'); }
    finally { setBusy(false); }
  }

  function loadOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = orderId.trim();
    if (!id) { setError('请先填写订单 ID。'); return; }
    void run(async () => { setOrder(await request<OrderDetail>(`orders/${id}`)); return '已载入订单，请选择申请行。'; });
  }

  function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!order) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const items = order.lines.map(line => ({ orderItemId: line.id,
      quantity: Number(values.get(`qty-${line.id}`) ?? 0) })).filter(item => Number.isInteger(item.quantity) && item.quantity > 0);
    if (!items.length) { setError('至少填写一个大于 0 的申请数量。'); return; }
    const requestedText = String(values.get('requested') ?? '').trim();
    const requested = requestedText ? toMinor(requestedText) : null;
    if (requestedText && requested === null) { setError('申请退款金额格式不正确，最多两位小数。'); return; }
    void run(async () => {
      const created = await request<CaseDetail>('after-sales', 'POST', { orderId: order.id,
        caseType: String(values.get('caseType') ?? ''), items, reasonCode: String(values.get('reasonCode') ?? '').trim() || null,
        reason: String(values.get('reason') ?? '').trim(), requestedRefundMinor: requested });
      form.reset();
      return `案件 ${created.publicCaseNumber} 已建立，等待审核。`;
    });
  }

  function approveCase() {
    if (!selected) return;
    void run(async () => {
      await request(`after-sales/${selected.id}/approve`, 'POST', { reason: 'Approved by aftersales desk',
        reasonCode: null }, selected.version);
      return '案件已批准。取消类会同时取消订单并释放库存预留。';
    });
  }

  function rejectCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const reason = String(new FormData(form).get('reason') ?? '').trim();
    if (!reason) { setError('请填写驳回原因。'); return; }
    void run(async () => {
      await request(`after-sales/${selected.id}/reject`, 'POST', { reason, reasonCode: null });
      form.reset();
      return '案件已驳回。';
    });
  }

  function registerReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const trackingNumber = String(values.get('trackingNumber') ?? '').trim();
    if (!trackingNumber) { setError('请填写退货物流单号。'); return; }
    void run(async () => {
      await request(`after-sales/${selected.id}/return-shipment`, 'POST', { trackingNumber,
        carrierCode: String(values.get('carrierCode') ?? '').trim() || null, shippedAt: new Date().toISOString() });
      form.reset();
      return '退货物流已登记，等待收货。';
    });
  }

  function receiveReturn() {
    if (!selected) return;
    // 默认整单收货：按案件申请数量收，后台再按实际数量修正。
    const items = selected.items.map(item => ({ orderItemId: item.orderItemId,
      quantity: item.requestedQuantity - item.receivedQuantity }))
      .filter(item => item.quantity > 0);
    if (!items.length) { setError('没有待收货的数量。'); return; }
    void run(async () => {
      await request(`after-sales/${selected.id}/receive-return`, 'POST', { receivedAt: new Date().toISOString(), items });
      return '退货已收货，尚未进入可售库存。';
    });
  }

  function inspectReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const items = selected.items.map(item => {
      const quantity = Number(values.get(`qty-${item.orderItemId}`) ?? 0);
      const disposition = String(values.get(`disposition-${item.orderItemId}`) ?? 'sellable');
      const note = String(values.get(`note-${item.orderItemId}`) ?? '').trim() || null;
      return { orderItemId: item.orderItemId, quantity, disposition, note };
    }).filter(item => Number.isInteger(item.quantity) && item.quantity > 0);
    if (!items.length) { setError('至少填写一个大于 0 的质检数量。'); return; }
    void run(async () => {
      await request(`after-sales/${selected.id}/inspect`, 'POST', { reason: 'Returned goods inspected',
        items });
      form.reset();
      return '质检已记录：只有「可再售」的数量回到可售库存。';
    });
  }

  function requestRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const amount = toMinor(String(values.get('amount') ?? ''));
    if (amount === null) { setError('退款金额格式不正确，最多两位小数。'); return; }
    void run(async () => {
      await request(`after-sales/${selected.id}/refund`, 'POST', { amountMinor: amount, currency: selected.currency,
        reasonCode: null, reason: String(values.get('reason') ?? '').trim() });
      form.reset();
      return '退款申请已提交，需由另一位同事批准。';
    });
  }

  function approveRefund(refund: CaseRefund) {
    void run(async () => {
      await request(`refunds/${refund.id}/approve`, 'POST', { reason: 'Approved by finance' });
      return `${refund.publicRefundNumber} 已批准，等待执行。`;
    });
  }

  function executeRefund(event: FormEvent<HTMLFormElement>, refund: CaseRefund) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (!reason) { setError('请填写退款凭据号（线下付款的转账/现金凭据）。'); return; }
    void run(async () => {
      await request(`refunds/${refund.id}/execute`, 'POST', { reason: 'Paid out to customer',
        reference: reason, occurredAt: new Date().toISOString() });
      return `${refund.publicRefundNumber} 已登记退款，钱已离开账户。`;
    });
  }

  function closeCase() {
    if (!selected) return;
    void run(async () => {
      await request(`after-sales/${selected.id}/close`, 'POST', { reason: 'Case resolved' }, selected.version);
      return '案件已结案。';
    });
  }

  const refundable = selected ? selected.items.reduce((sum, item) => sum + (item.amountMinor ?? 0), 0) : 0;

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>售后</h1></div>
      <div className="actions"><a href="/admin/orders">订单</a><a href="/admin/payments">付款</a>
        <a href="/admin/catalog">商品目录</a><a href="/admin/shipping">配送与结账</a><a href="/admin/settings">店铺设置</a>
        <button disabled={busy} onClick={() => void run(async () => '已刷新。')}>刷新</button></div></header>
    {error && <p className="error">{error}</p>}{notice && <p className="notice">{notice}</p>}
    {!canRead && <p className="error">当前账号没有售后读取权限（aftersales.read）。</p>}

    {canRead && <section>
      <h2>案件列表</h2>
      <form onSubmit={event => { event.preventDefault(); void run(async () => '已按条件筛选。'); }}>
        <label>搜索<small>案件号、订单号或原因</small><input value={query} maxLength={200}
          onChange={event => setQuery(event.target.value)} placeholder="AS-" /></label>
        <label>状态<select value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">全部</option>{Object.entries(STATUS_LABEL).map(([key, label]) =>
            <option key={key} value={key}>{label}</option>)}
        </select></label>
        <button disabled={busy}>筛选</button>
      </form>
      {cases.length === 0 ? <p>暂无售后案件。</p> : <ul>{cases.map(entry => <li key={entry.id}>
        <button className="secondary" disabled={busy} onClick={() => void openCase(entry.id)}>{entry.publicCaseNumber}</button>
        {' '}{CASE_TYPE_LABEL[entry.caseType] ?? entry.caseType} · {STATUS_LABEL[entry.status] ?? entry.status}
        {' · '}{entry.publicOrderNumber} · {money(entry.orderTotalMinor, entry.currency)}
        {entry.approvedRefundMinor !== null ? ` · 应退 ${money(entry.approvedRefundMinor, entry.currency)}` : ''}
        {' · '}{shortDate(entry.createdAt)}</li>)}</ul>}
    </section>}

    {canManage && <section>
      <h2>从订单新建案件</h2>
      <form onSubmit={loadOrder}>
        <label>订单 ID<small>可从订单页「售后」入口带过来</small>
          <input value={orderId} maxLength={64} onChange={event => setOrderId(event.target.value)} required /></label>
        <button disabled={busy}>载入订单</button>
      </form>
      {order && <form onSubmit={createCase}>
        <p>{order.publicOrderNumber} · {order.orderStatus} · 付款 {order.paymentStatus}
          · 总额 {money(order.totalMinor, order.currency)}</p>
        {order.lines.map(line => <label key={line.id}>{line.sku} 申请数量
          <small>订购 {line.quantity} · 行金额 {money(line.lineTotalMinor, order.currency)}</small>
          <input name={`qty-${line.id}`} type="number" min={0} max={line.quantity} defaultValue={0} /></label>)}
        <label>类型<select name="caseType" defaultValue="return">
          {Object.entries(CASE_TYPE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>原因<input name="reason" maxLength={1000} required /></label>
        <label>原因编码<input name="reasonCode" maxLength={80} placeholder="damaged / wrong_size" /></label>
        <label>申请退款金额<small>可留空，由服务端按行金额分摊；取消与换货不填</small>
          <input name="requested" inputMode="decimal" /></label>
        <button disabled={busy}>建立案件</button>
      </form>}
    </section>}

    {selected && <section>
      <h2>{selected.publicCaseNumber}</h2>
      <p>{CASE_TYPE_LABEL[selected.caseType] ?? selected.caseType} · {STATUS_LABEL[selected.status] ?? selected.status}
        {' · '}订单 {selected.publicOrderNumber}（{selected.orderStatus} / 付款 {selected.paymentStatus}）
        {' · '}版本 {selected.version}</p>
      <article>
        <h3>金额</h3>
        <p>订单总额 {money(selected.orderTotalMinor, selected.currency)}
          {selected.requestedRefundMinor !== null ? ` · 申请退款 ${money(selected.requestedRefundMinor, selected.currency)}` : ''}
          {selected.approvedRefundMinor !== null ? ` · 批准退款 ${money(selected.approvedRefundMinor, selected.currency)}` : ''}</p>
        <p>已退 {money(selected.refundedMinor, selected.currency)} · 在途 {money(selected.pendingRefundMinor, selected.currency)}
          · 可退余额 {money(selected.refundableMinor, selected.currency)}</p>
        <p><small>可退余额 = 实收 - 已退 - 在途；未收款的订单没有可退余额。</small></p>
      </article>
      <article>
        <h3>申请商品</h3>
        <ul>{selected.items.map(item => <li key={item.orderItemId}>{item.sku} — {item.productName}
          {item.variantName ? ` / ${item.variantName}` : ''} · 申请 {item.requestedQuantity}
          {item.approvedQuantity !== null ? ` / 批准 ${item.approvedQuantity}` : ''}
          {item.amountMinor !== null ? ` · ${money(item.amountMinor, selected.currency)}` : ''}
          {' · '}已收 {item.receivedQuantity} · 已检 {item.inspectedQuantity}
          {item.disposed ? ` · ${DISPOSITION_LABEL[item.disposed] ?? item.disposed}` : ''}</li>)}</ul>
      </article>

      {canApprove && ['submitted', 'under_review'].includes(selected.status) && <article>
        <h3>审核</h3>
        <p><small>批准会锁定数量与应退金额；取消类会同时取消订单并释放库存预留。</small></p>
        <button disabled={busy} onClick={approveCase}>批准案件</button>
        <form onSubmit={rejectCase}>
          <label>驳回原因<input name="reason" maxLength={1000} required /></label>
          <button disabled={busy}>驳回</button>
        </form>
      </article>}

      {canInspect && ['approved', 'return_in_transit'].includes(selected.status) && <article>
        <h3>退货物流</h3>
        <form onSubmit={registerReturn}>
          <label>承运商<input name="carrierCode" maxLength={80} placeholder="SF" /></label>
          <label>物流单号<input name="trackingNumber" maxLength={160} required /></label>
          <button disabled={busy}>登记退货物流</button>
        </form>
      </article>}

      {canInspect && selected.status === 'return_in_transit' && <article>
        <h3>收货</h3>
        <p><small>收货只登记数量，不动库存；质检后才决定能否再售。</small></p>
        <button disabled={busy} onClick={receiveReturn}>按申请数量全部收货</button>
      </article>}

      {canInspect && selected.status === 'received_inspection' && <article>
        <h3>质检与处置</h3>
        <form onSubmit={inspectReturn}>
          {selected.items.map(item => <div key={item.orderItemId}>
            <label>{item.sku} 质检数量<small>待检 {item.receivedQuantity - item.inspectedQuantity}</small>
              <input name={`qty-${item.orderItemId}`} type="number" min={0}
                max={item.receivedQuantity - item.inspectedQuantity} defaultValue={0} /></label>
            <label>处置<select name={`disposition-${item.orderItemId}`} defaultValue="sellable">
              {Object.entries(DISPOSITION_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label>备注<input name={`note-${item.orderItemId}`} maxLength={1000} /></label>
          </div>)}
          <button disabled={busy}>保存质检结果</button>
        </form>
      </article>}

      {canRefund && ['approved', 'return_in_transit', 'received_inspection', 'refund_pending'].includes(selected.status) && <article>
        <h3>申请退款</h3>
        <p><small>只能退已收到的钱；审批与执行由另一位同事完成。</small></p>
        <form onSubmit={requestRefund}>
          <label>金额<small>{selected.currency}；本案件应退上限
            {money(selected.approvedRefundMinor ?? refundable, selected.currency)}</small>
            <input name="amount" inputMode="decimal" required />
          </label>
          <label>原因<input name="reason" maxLength={1000} required /></label>
          <button disabled={busy}>提交退款申请</button>
        </form>
      </article>}

      {selected.refunds.length > 0 && <article>
        <h3>退款记录</h3>
        <ul>{selected.refunds.map(refund => <li key={refund.id}>
          {refund.publicRefundNumber} · {REFUND_LABEL[refund.status] ?? refund.status}
          {' · '}{money(refund.amountMinor, refund.currency)} · {refund.channel}
          {' · '}{shortDate(refund.createdAt)}
          {canApproveRefund && refund.status === 'requested' && <button className="secondary" disabled={busy}
            onClick={() => approveRefund(refund)}>批准</button>}
          {canExecuteRefund && refund.status === 'approved' && <form onSubmit={event => executeRefund(event, refund)}>
            <label>退款凭据<input name="reason" maxLength={200} required placeholder="PAYOUT-778" /></label>
            <button disabled={busy}>登记已退款</button>
          </form>}
        </li>)}</ul>
      </article>}

      {selected.returns.length > 0 && <article>
        <h3>退货物流</h3>
        <ul>{selected.returns.map(parcel => <li key={parcel.id}>
          {parcel.status === 'received' ? '已收货' : '在途'}
          {parcel.carrierCode ? ` · ${parcel.carrierCode}` : ''}
          {parcel.trackingNumber ? ` · ${parcel.trackingNumber}` : ''}
          {parcel.receivedAt ? ` · ${shortDate(parcel.receivedAt)}` : ''}</li>)}</ul>
      </article>}

      {canManage && ['approved', 'received_inspection', 'refunded', 'replacement_sent'].includes(selected.status) && <article>
        <h3>结案</h3>
        <p><small>还有在途退款时不能结案；结案不会改动订单与付款快照。</small></p>
        <button disabled={busy} onClick={closeCase}>结案</button>
      </article>}

      <article>
        <h3>时间线</h3>
        <ul>{selected.events.map(event => <li key={event.id}>
          {shortDate(event.createdAt)} · {event.fromStatus ?? '—'} → {event.toStatus}
          {event.note ? `（${event.note}）` : ''}</li>)}</ul>
      </article>
    </section>}
  </main>;
}
