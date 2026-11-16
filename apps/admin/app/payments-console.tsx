"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { permissionCodes: string[]; csrfToken: string };
type Method = { id: string; providerCode: string; environment: string; displayName: string; enabled: boolean;
  approvalStatus: string; approvalReference: string | null; approvedAt: string | null;
  publicConfig: Record<string, string>; secretConfigured: boolean; secretFingerprint: string | null;
  connectionStatus: string; version: number };
type Payment = { id: string; publicPaymentNumber: string; orderId: string; publicOrderNumber: string;
  providerCode: string; environment: string; channel: string; status: string; amountMinor: number; currency: string;
  providerTransactionId: string | null; paidAt: string | null; returnedAt: string | null; reference: string | null;
  failureCode: string | null; failureMessage: string | null; version: number; createdAt: string;
  events?: { id: string; type: string; fromStatus: string | null; toStatus: string; source: string;
    occurredAt: string }[] };

const STATUSES = ['pending', 'collected', 'succeeded', 'rejected', 'returned', 'cancelled', 'failed', 'unknown', 'authorized'];
const STATUS_LABEL: Record<string, string> = { pending: '待收', collected: '已收', succeeded: '已到账', rejected: '拒收',
  returned: '已退回', cancelled: '已取消', failed: '失败', unknown: '未知（待渠道确认）', authorized: '已授权' };

function money(minor: number, currency: string) {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}
function shortDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

export function PaymentsConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [methods, setMethods] = useState<Method[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [selected, setSelected] = useState<Payment | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canConfigure = permissions.includes('payment.config');
  const canRead = permissions.includes('payments.read');

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
      if (response.status === 404) throw new Error('记录不存在。');
      if (response.status === 409) throw new Error(code === 'VERSION_CONFLICT' ? '配置已被其他人修改，请刷新后重试。'
        : code === 'PAYMENT_METHOD_IN_USE' ? '该渠道仍有待处理流水，不能停用。'
          : code === 'PAYMENT_APPROVAL_REQUIRED' ? '启用前必须填写批准依据。'
            : '当前状态不允许该操作，请刷新后确认。');
      if (response.status === 422) throw new Error(code === 'SECRET_REFERENCE_INVALID'
        ? '凭证只能填写 secret:// 或 env:// 形式的引用，不能直接粘贴密钥。'
        : code === 'PAYMENT_APPROVAL_REQUIRED' ? '启用前必须填写批准依据。'
          : '填写内容不符合要求，请检查后重试。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return ((await response.json()) as { data: T }).data;
  }

  async function reload(preferred?: string) {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (current.permissionCodes.includes('payment.config')) {
      const list = await request<{ items: Method[] }>('payment-methods');
      setMethods(list.items);
    }
    if (!current.permissionCodes.includes('payments.read')) return;
    const ledger = await request<{ items: Payment[] }>(`payments?limit=25${status ? `&status=${status}` : ''}`);
    setPayments(ledger.items);
    const nextId = preferred ?? selected?.id ?? ledger.items[0]?.id;
    if (nextId) setSelected(await request<Payment>(`payments/${nextId}`));
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

  async function openPayment(id: string) {
    setBusy(true); setError('');
    try { setSelected(await request<Payment>(`payments/${id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败。'); }
    finally { setBusy(false); }
  }

  function saveMethod(method: Method, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const secretRef = String(values.get('secretRef') ?? '').trim();
    const accountSummary = String(values.get('accountSummary') ?? '').trim();
    const body = { providerCode: method.providerCode, environment: method.environment,
      enabled: values.get('enabled') === 'on',
      displayName: String(values.get('displayName') ?? '').trim() || undefined,
      approvalReference: String(values.get('approvalReference') ?? '').trim() || null,
      ...(secretRef ? { secretRef } : {}),
      ...(accountSummary ? { publicConfig: { accountSummary } } : {}) };
    void run(async () => {
      await request('payment-methods', 'PATCH', body, method.version);
      form.reset();
      return `${method.providerCode} 配置已保存。`;
    });
  }

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>付款</h1></div>
      <div className="actions"><a href="/admin/orders">订单</a><a href="/admin/shipping">配送与结账</a>
        <a href="/admin/catalog">商品目录</a><a href="/admin/settings">店铺设置</a>
        <button disabled={busy} onClick={() => void run(async () => '已刷新。')}>刷新</button></div></header>
    {error && <p className="error">{error}</p>}{notice && <p className="notice">{notice}</p>}

    {canConfigure && <section>
      <h2>支付方式</h2>
      <p><small>启用必须有批准依据；凭证只接受 secret:// 或 env:// 引用，保存后不会再次显示，只显示是否已配置与指纹。</small></p>
      {methods.length === 0 ? <p>暂无已接入的支付方式。</p> : <ul>{methods.map(method => <li key={method.id}>
        <strong>{method.providerCode}</strong> · {method.environment} · {method.enabled ? '已启用' : '已停用'}
        {' · '}批准 {method.approvalStatus === 'approved' ? `已批准（${method.approvalReference ?? '—'}）` : '未批准'}
        {' · '}凭证 {method.secretConfigured ? `已配置（${method.secretFingerprint}）` : '未配置'}
        {' · '}版本 {method.version}
        <form onSubmit={event => saveMethod(method, event)}>
          <label>显示名称<input name="displayName" maxLength={80} defaultValue={method.displayName} /></label>
          <label>批准依据<small>例如业主审批单号；启用时必填</small>
            <input name="approvalReference" maxLength={200} defaultValue={method.approvalReference ?? ''} /></label>
          <label>凭证引用<small>secret://prod/gateway；不填表示沿用原值</small>
            <input name="secretRef" maxLength={256} placeholder="secret://" autoComplete="off" /></label>
          <label>收款说明<small>人工转账的到账账户摘要，会显示给顾客</small>
            <input name="accountSummary" maxLength={200} defaultValue={method.publicConfig['accountSummary'] ?? ''} /></label>
          <label className="check"><input type="checkbox" name="enabled" defaultChecked={method.enabled} />启用该方式</label>
          <button disabled={busy}>保存配置</button>
        </form>
      </li>)}</ul>}
    </section>}

    {!canRead && <p className="error">当前账号没有交易台账读取权限（payments.read）。</p>}
    {canRead && <section>
      <h2>交易台账</h2>
      <form onSubmit={event => { event.preventDefault(); void run(async () => '已按状态筛选。'); }}>
        <label>状态<select value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">全部</option>
          {STATUSES.map(value => <option key={value} value={value}>{STATUS_LABEL[value] ?? value}</option>)}
        </select></label>
        <button disabled={busy}>筛选</button>
      </form>
      {payments.length === 0 ? <p>暂无流水。</p> : <ul>{payments.map(payment => <li key={payment.id}>
        <button className="secondary" disabled={busy} onClick={() => void openPayment(payment.id)}>{payment.publicPaymentNumber}</button>
        {' '}{payment.publicOrderNumber} · {payment.channel} · {STATUS_LABEL[payment.status] ?? payment.status}
        {' · '}{money(payment.amountMinor, payment.currency)} · 到账 {shortDate(payment.paidAt)}
      </li>)}</ul>}
      <p><small>收款、拒收与退回在订单详情里登记；台账只记录已经发生的事实。</small></p>
    </section>}

    {selected && <section>
      <h2>{selected.publicPaymentNumber}</h2>
      <p>{STATUS_LABEL[selected.status] ?? selected.status} · {selected.channel} · {selected.providerCode}
        {' · '}{money(selected.amountMinor, selected.currency)} · 版本 {selected.version}</p>
      <article>
        <h3>流水</h3>
        <ul>
          <li>订单：{selected.publicOrderNumber}</li>
          <li>到账时间：{shortDate(selected.paidAt)}</li>
          <li>退回时间：{shortDate(selected.returnedAt)}</li>
          <li>参考号：{selected.reference ?? '—'}</li>
          <li>失败原因：{selected.failureCode ?? '—'}{selected.failureMessage ? `（${selected.failureMessage}）` : ''}</li>
        </ul>
      </article>
      <article>
        <h3>事件</h3>
        {(selected.events ?? []).length === 0 ? <p>暂无事件。</p> : <ul>{selected.events!.map(event => <li key={event.id}>
          {shortDate(event.occurredAt)} · {event.fromStatus ?? '—'} → {event.toStatus} · {event.type} · {event.source}
        </li>)}</ul>}
      </article>
    </section>}
  </main>;
}
