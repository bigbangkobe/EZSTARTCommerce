"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { permissionCodes: string[]; csrfToken: string };
type OrderSummary = { id: string; publicOrderNumber: string; orderStatus: string; paymentStatus: string;
  currency: string; totalMinor: number; contactMasked: string | null; createdAt: string };
type Line = { id: string; sku: string; productName: string; variantName: string | null; quantity: number;
  unitPriceMinor: number; lineTotalMinor: number; shippedQuantity: number; allocatedQuantity: number };
type Shipment = { id: string; status: string; carrierCode: string | null; carrierName: string | null;
  trackingNumber: string | null; dispatchedAt: string | null; deliveredAt: string | null; version: number;
  items: { orderItemId: string; quantity: number }[] };
type Order = { id: string; publicOrderNumber: string; orderStatus: string; paymentStatus: string;
  fulfillmentStatus: string; currency: string; subtotalMinor: number; discountMinor: number; shippingMinor: number;
  taxMinor: number; totalMinor: number; version: number; paymentMethodCode: string; customerNote: string | null;
  placedAt: string; lines: Line[]; addressSnapshot: Record<string, string | null> | null;
  contact: { email: string | null; phone: string | null; fullName: string | null };
  cancellation: { cancelledAt: string; reasonCode: string | null; reason: string | null; customerNotified: boolean } | null;
  shipments: Shipment[]; statusHistory: { id: string; fromStatus: string | null; toStatus: string; reason: string | null;
    actorType: string; createdAt: string }[]; notes: { id: string; note: string; authorId: string | null; createdAt: string }[] };

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

/** 台账还停留在这些状态时才可以登记收款/拒收/退回。 */
const OPEN_PAYMENT_STATUSES = new Set(['cod_due', 'created', 'processing', 'requires_action', 'unknown']);

const SHIPMENT_LABEL: Record<string, string> = { created: '待发货', dispatched: '已发货', delivered: '已签收', cancelled: '已取消' };

export function OrdersConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canRead = permissions.includes('orders.read');
  const canCancel = permissions.includes('orders.cancel');
  const canChangeAddress = permissions.includes('orders.address_change');
  const canNote = permissions.includes('orders.update');
  const canShip = permissions.includes('shipments.manage');
  const canCollect = permissions.includes('payments.collect');

  async function request<T>(path: string, method = 'GET', body?: object, version?: number): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '', 'Idempotency-Key': crypto.randomUUID() } : {}),
      ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = payload?.error?.code ?? '';
      if (response.status === 403) throw new Error('当前账号没有该操作权限。');
      if (response.status === 404) throw new Error('订单不存在。');
      if (response.status === 409) throw new Error(code === 'VERSION_CONFLICT' ? '订单已被其他人修改，请刷新后重试。'
        : code === 'IDEMPOTENCY_CONFLICT' ? '同一幂等键已用于不同请求。'
          : code === 'SHIPMENT_QUANTITY_EXCEEDED' ? '包裹数量超过订单剩余可发数量。'
            : code === 'CUSTOMER_CONFIRMATION_REQUIRED' ? '费用发生变化，必须填写顾客确认依据。'
              : code === 'SHIPPING_UNAVAILABLE' ? '新地址不在任何启用配送方式覆盖范围内。'
                : '当前状态不允许该操作，请刷新后确认。');
      if (response.status === 422) throw new Error('填写内容不符合要求，请检查后重试。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return ((await response.json()) as { data: T }).data;
  }

  async function reload(preferred?: string) {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (!current.permissionCodes.includes('orders.read')) return;
    const list = await request<{ items: OrderSummary[] }>(`orders?limit=25${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`);
    setOrders(list.items);
    const nextId = preferred ?? selected?.id ?? list.items[0]?.id;
    if (nextId) setSelected(await request<Order>(`orders/${nextId}`));
    else setSelected(null);
  }
  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const message = await action(); await reload(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  async function openOrder(id: string) {
    setBusy(true); setError(''); setNotice('');
    try { setSelected(await request<Order>(`orders/${id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败。'); }
    finally { setBusy(false); }
  }

  function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const reason = String(values.get('reason') ?? '').trim();
    if (!reason) { setError('请填写取消原因。'); return; }
    void run(async () => {
      await request(`orders/${selected.id}/cancel`, 'POST', { reason, reasonCode: 'admin_cancelled',
        expectedVersion: selected.version, customerNotified: values.get('notified') === 'on' });
      form.reset();
      return '订单已取消，库存预留已释放。';
    });
  }

  function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const note = String(new FormData(form).get('note') ?? '').trim();
    if (!note) { setError('备注不能为空。'); return; }
    void run(async () => { await request(`orders/${selected.id}/notes`, 'POST', { note }); form.reset(); return '备注已保存。'; });
  }

  function addShipment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const items = selected.lines.map(line => ({ orderItemId: line.id, quantity: Number(values.get(`qty-${line.id}`) ?? 0) }))
      .filter(item => Number.isInteger(item.quantity) && item.quantity > 0);
    if (!items.length) { setError('至少填写一个大于 0 的发货数量。'); return; }
    void run(async () => {
      await request(`orders/${selected.id}/shipments`, 'POST', { items,
        carrierCode: String(values.get('carrierCode') ?? '').trim() || null,
        trackingNumber: String(values.get('trackingNumber') ?? '').trim() || null,
        note: String(values.get('shipNote') ?? '').trim() || null });
      form.reset();
      return '包裹已创建，尚未扣减库存。';
    });
  }

  function dispatch(shipment: Shipment) {
    void run(async () => {
      await request(`shipments/${shipment.id}/dispatch`, 'POST', { dispatchedAt: new Date().toISOString() }, shipment.version);
      return '包裹已发出，库存已扣减。';
    });
  }

  function deliver(shipment: Shipment) {
    void run(async () => {
      await request(`shipments/${shipment.id}/deliver`, 'POST', { deliveredAt: new Date().toISOString() }, shipment.version);
      return '已登记签收。货到付款订单仍需单独登记收款。';
    });
  }

  function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const amount = toMinor(String(values.get('amount') ?? ''));
    if (amount === null) { setError('金额格式不正确，最多两位小数。'); return; }
    const reason = String(values.get('reason') ?? '').trim();
    void run(async () => {
      await request(`orders/${selected.id}/payment-result`, 'POST', { outcome: String(values.get('outcome') ?? ''),
        amountMinor: amount, occurredAt: new Date().toISOString(),
        reference: String(values.get('reference') ?? '').trim() || null, reason: reason || null,
        expectedVersion: selected.version }, selected.version);
      form.reset();
      return '收款结果已登记，订单付款状态已更新。';
    });
  }

  function changeAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const address = { recipientName: String(values.get('recipientName') ?? '').trim() || null,
      phone: String(values.get('phone') ?? '').trim() || null,
      countryCode: String(values.get('countryCode') ?? '').trim().toUpperCase(),
      regionCode: String(values.get('regionCode') ?? '').trim() || null,
      city: String(values.get('city') ?? '').trim() || null, district: null,
      addressLine1: String(values.get('addressLine1') ?? '').trim(), addressLine2: null, postalCode: null };
    if (!address.countryCode || !address.addressLine1) { setError('国家代码与地址第一行为必填。'); return; }
    void run(async () => {
      await request(`orders/${selected.id}/address-change`, 'POST', { expectedVersion: selected.version, address,
        customerConfirmationRef: String(values.get('confirmation') ?? '').trim() || null });
      return '地址已更新，运费与总额已按当前配送配置重算。';
    });
  }

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>订单</h1></div>
      <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/shipping">配送与结账</a>
        <a href="/admin/payments">付款</a><a href="/admin/inventory">库存</a><a href="/admin/aftersales">售后</a><a href="/admin/coupons">优惠券</a><a href="/admin/members">会员与积分</a><a href="/admin/media">媒体库</a><a href="/admin/reports">报表</a><a href="/admin/settings">店铺设置</a>
        <button disabled={busy} onClick={() => void run(async () => '已刷新。')}>刷新</button></div></header>
    {error && <p className="error">{error}</p>}{notice && <p className="notice">{notice}</p>}
    {!canRead && <p className="error">当前账号没有订单读取权限（orders.read）。</p>}

    {canRead && <section>
      <h2>订单列表</h2>
      <form onSubmit={event => { event.preventDefault(); void run(async () => '已按关键字筛选。'); }}>
        <label>搜索<small>订单号或顾客备注</small><input value={query} maxLength={200}
          onChange={event => setQuery(event.target.value)} placeholder="EZ-" /></label>
        <button disabled={busy || !canRead}>搜索</button>
      </form>
      {orders.length === 0 ? <p>暂无订单。</p> : <ul>{orders.map(order => <li key={order.id}>
        <button className="secondary" disabled={busy} onClick={() => void openOrder(order.id)}>{order.publicOrderNumber}</button>
        {' '}{order.orderStatus} · {order.paymentStatus} · {money(order.totalMinor, order.currency)}
        {order.contactMasked ? ` · ${order.contactMasked}` : ''} · {shortDate(order.createdAt)}
      </li>)}</ul>}
    </section>}

    {selected && <section>
      <h2>{selected.publicOrderNumber}</h2>
      <p><a href={`/admin/aftersales?orderId=${selected.id}`}>为该订单建立售后案件</a></p>
      <p>{selected.orderStatus} · 付款 {selected.paymentStatus} · 履约 {selected.fulfillmentStatus}
        · 版本 {selected.version} · 下单 {shortDate(selected.placedAt)}</p>
      <article>
        <h3>金额</h3>
        <p>小计 {money(selected.subtotalMinor, selected.currency)} · 折扣 {money(selected.discountMinor, selected.currency)}
          · 运费 {money(selected.shippingMinor, selected.currency)} · 税 {money(selected.taxMinor, selected.currency)}</p>
        <p>总额 {money(selected.totalMinor, selected.currency)} · 付款方式 {selected.paymentMethodCode}</p>
        {selected.cancellation && <p>已取消：{selected.cancellation.reason ?? '未填写原因'}
          （{shortDate(selected.cancellation.cancelledAt)}）</p>}
      </article>
      <article>
        <h3>顾客与地址</h3>
        <p>联系人：{selected.contact.fullName ?? '—'} · {selected.contact.email ?? '—'} · {selected.contact.phone ?? '—'}</p>
        <p>地址：{selected.addressSnapshot
          ? [selected.addressSnapshot['recipientName'], selected.addressSnapshot['addressLine1'],
            selected.addressSnapshot['city'], selected.addressSnapshot['countryCode']].filter(Boolean).join(' / ')
          : '—'}</p>
        {selected.customerNote && <p>顾客备注：{selected.customerNote}</p>}
      </article>
      <article>
        <h3>商品行</h3>
        <ul>{selected.lines.map(line => <li key={line.id}>{line.sku} — {line.productName}
          {line.variantName ? ` / ${line.variantName}` : ''} × {line.quantity}
          （已发 {line.shippedQuantity}，已分配 {line.allocatedQuantity}）
          · {money(line.lineTotalMinor, selected.currency)}</li>)}</ul>
      </article>

      {canShip && selected.orderStatus !== 'cancelled' && selected.orderStatus !== 'completed' && <article>
        <h3>新建包裹</h3>
        <form onSubmit={addShipment}>
          {selected.lines.map(line => <label key={line.id}>{line.sku} 发货数量
            <small>可发 {line.quantity - line.allocatedQuantity}</small>
            <input name={`qty-${line.id}`} type="number" min={0} max={line.quantity - line.allocatedQuantity} defaultValue={0} /></label>)}
          <label>承运商代码<input name="carrierCode" maxLength={80} placeholder="SF" /></label>
          <label>追踪号<input name="trackingNumber" maxLength={160} /></label>
          <label>包裹备注<input name="shipNote" maxLength={1000} /></label>
          <button disabled={busy}>创建包裹</button>
        </form>
      </article>}

      <article>
        <h3>包裹</h3>
        {selected.shipments.length === 0 ? <p>尚未创建包裹。</p> : <ul>{selected.shipments.map(shipment => <li key={shipment.id}>
          {SHIPMENT_LABEL[shipment.status] ?? shipment.status}
          {shipment.carrierCode ? ` · ${shipment.carrierCode}` : ''}
          {shipment.trackingNumber ? ` · ${shipment.trackingNumber}` : ''}
          {' · '}{shipment.items.map(item => {
            const line = selected.lines.find(entry => entry.id === item.orderItemId);
            return `${line?.sku ?? item.orderItemId}×${item.quantity}`;
          }).join('，')}
          {canShip && shipment.status === 'created' && <button className="secondary" disabled={busy}
            onClick={() => dispatch(shipment)}>发货</button>}
          {canShip && shipment.status === 'dispatched' && <button className="secondary" disabled={busy}
            onClick={() => deliver(shipment)}>登记签收</button>}
        </li>)}</ul>}
        <p><small>发货才扣减库存；签收不改变付款状态。</small></p>
      </article>

      {canCollect && OPEN_PAYMENT_STATUSES.has(selected.paymentStatus) && selected.orderStatus !== 'cancelled' && <article>
        <h3>登记收款</h3>
        <p><small>只登记确实发生的收付：金额必须等于订单总额；拒收与退回必须写原因。货到付款需先发货。</small></p>
        <form onSubmit={recordPayment}>
          <label>结果<select name="outcome" defaultValue={selected.paymentMethodCode === 'manual_bank_transfer' ? 'succeeded' : 'collected'}>
            {selected.paymentMethodCode === 'manual_bank_transfer'
              ? <><option value="succeeded">已到账</option><option value="cancelled">取消</option><option value="returned">已退回</option></>
              : <><option value="collected">已收现金</option><option value="rejected">拒收</option><option value="returned">已退回</option></>}
          </select></label>
          <label>金额<small>{selected.currency}，必须等于总额</small>
            <input name="amount" defaultValue={(selected.totalMinor / 100).toFixed(2)} inputMode="decimal" required /></label>
          <label>参考号<input name="reference" maxLength={200} placeholder="收款单号 / 转账流水号" /></label>
          <label>原因<small>拒收或退回时必填</small><textarea name="reason" maxLength={1000} /></label>
          <button disabled={busy}>保存收款结果</button>
        </form>
      </article>}

      {canChangeAddress && selected.fulfillmentStatus === 'unfulfilled' && selected.orderStatus !== 'cancelled' && <article>
        <h3>修改收货地址</h3>
        <form onSubmit={changeAddress}>
          <label>收件人<input name="recipientName" maxLength={120} /></label>
          <label>电话<input name="phone" maxLength={32} /></label>
          <label>国家/地区代码<input name="countryCode" maxLength={2} required placeholder="HK" /></label>
          <label>区域代码<input name="regionCode" maxLength={80} /></label>
          <label>城市<input name="city" maxLength={120} /></label>
          <label>地址第一行<input name="addressLine1" maxLength={200} required /></label>
          <label>顾客确认依据<small>费用变化时必填，例如通话记录编号</small><input name="confirmation" maxLength={200} /></label>
          <button disabled={busy}>保存地址</button>
        </form>
      </article>}

      {canNote && <article>
        <h3>内部备注</h3>
        <form onSubmit={addNote}>
          <label>备注<textarea name="note" maxLength={1000} required /></label>
          <button disabled={busy}>保存备注</button>
        </form>
        {selected.notes.length > 0 && <ul>{selected.notes.map(note => <li key={note.id}>
          {shortDate(note.createdAt)} · {note.note}</li>)}</ul>}
      </article>}

      {canCancel && !['cancelled', 'shipped', 'partially_shipped', 'completed'].includes(selected.orderStatus) && <article>
        <h3>取消订单</h3>
        <p>取消会释放库存预留；已收款订单必须走售后退款，不能在这里直接取消。</p>
        <form onSubmit={cancel}>
          <label>取消原因<input name="reason" maxLength={1000} required /></label>
          <label className="check"><input type="checkbox" name="notified" />已通知顾客</label>
          <button disabled={busy}>取消订单</button>
        </form>
      </article>}

      <article>
        <h3>状态历史</h3>
        <ul>{selected.statusHistory.map(event => <li key={event.id}>
          {shortDate(event.createdAt)} · {event.fromStatus ?? '—'} → {event.toStatus}
          {event.reason ? `（${event.reason}）` : ''} · {event.actorType}</li>)}</ul>
      </article>
    </section>}
  </main>;
}
