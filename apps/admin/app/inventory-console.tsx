"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { permissionCodes: string[]; csrfToken: string };
type StockRow = { variantId: string; sku: string; productId: string; productName: string; productStatus: string;
  variantStatus: string; onHand: number; reserved: number; available: number; lowStockLevel: number;
  lowStockVersion: number; lowStockState: string; version: number; updatedAt: string };
type Movement = { id: string; variantId: string; type: string; quantity: number; stockDelta: number;
  onHandAfter: number | null; reason: string; reasonCode: string | null; reference: string | null;
  orderId: string | null; caseId: string | null; actorId: string | null; createdAt: string };

const STATE_LABEL: Record<string, string> = { ok: '正常', low: '低库存', out_of_stock: '已售罄' };
const TYPE_LABEL: Record<string, string> = { adjustment: '人工调整', return_restock: '退货入库',
  return_damaged: '退货损坏', return_quarantine: '退货隔离', return_scrap: '退货报废' };

function shortDate(value: string) {
  return new Date(value).toLocaleString();
}

export function InventoryConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canRead = permissions.includes('inventory.read');
  const canAdjust = permissions.includes('inventory.adjust');
  const canManage = permissions.includes('inventory.manage');
  const selected = rows.find(row => row.variantId === selectedId) ?? null;

  async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '', 'Idempotency-Key': crypto.randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = payload?.error?.code ?? '';
      if (response.status === 403) throw new Error('当前账号没有该操作权限。');
      if (response.status === 404) throw new Error('该 SKU 不存在。');
      if (response.status === 409) throw new Error(code === 'VERSION_CONFLICT' ? '这个 SKU 的库存刚被其他人改过，请刷新后重试。'
        : code === 'INSUFFICIENT_ON_HAND' ? '调减后已预留的商品会被吃掉，请先核对预留数量。'
          : code === 'IDEMPOTENCY_CONFLICT' ? '同一幂等键已用于不同请求。' : '当前状态不允许该操作，请刷新后确认。');
      if (response.status === 422) throw new Error('填写内容不符合要求，请检查后重试。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return ((await response.json()) as { data: T }).data;
  }

  async function loadMovements(variantId: string, type: string) {
    const params = new URLSearchParams({ limit: '20' });
    if (type) params.set('type', type);
    if (variantId) params.set('variantId', variantId);
    setMovements((await request<{ items: Movement[] }>(`inventory/movements?${params.toString()}`)).items);
  }

  async function reload(preferred?: string) {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (!current.permissionCodes.includes('inventory.read')) return;
    const params = new URLSearchParams({ limit: '25' });
    if (query.trim()) params.set('q', query.trim());
    if (lowStockOnly) params.set('lowStock', '1');
    const list = await request<{ items: StockRow[] }>(`inventory?${params.toString()}`);
    setRows(list.items);
    const nextId = preferred ?? (list.items.some(row => row.variantId === selectedId) ? selectedId : list.items[0]?.variantId ?? '');
    setSelectedId(nextId);
    await loadMovements(nextId, typeFilter);
  }

  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const message = await action(); await reload(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  function adjustStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const delta = Number(values.get('delta') ?? 0);
    if (!Number.isInteger(delta) || delta === 0) { setError('调整数量必须是非零整数：加库存填正数，减库存填负数。'); return; }
    const reason = String(values.get('reason') ?? '').trim();
    if (!reason) { setError('请填写调整原因。'); return; }
    void run(async () => {
      const result = await request<{ onHand: number; available: number; version: number; replay: boolean }>(
        'inventory/adjustments', 'POST', { variantId: selected.variantId, delta, reason,
          reasonCode: String(values.get('reasonCode') ?? '').trim() || null,
          reference: String(values.get('reference') ?? '').trim() || null,
          expectedVersion: selected.version });
      form.reset();
      return result.replay ? '这次请求与之前那次完全相同，已返回原流水，没有重复记账。'
        : `${selected.sku} 现存 ${result.onHand}，可售 ${result.available}，版本 ${result.version}。`;
    });
  }

  function saveThreshold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const level = Number(new FormData(form).get('lowStockLevel') ?? -1);
    if (!Number.isInteger(level) || level < 0) { setError('阈值必须是 0 或正整数。'); return; }
    void run(async () => {
      await request('inventory/thresholds', 'PATCH', { variantId: selected.variantId, lowStockLevel: level,
        expectedVersion: selected.lowStockVersion });
      form.reset();
      return '低库存阈值已保存；阈值只影响提醒，不影响可售数量。';
    });
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => '已按当前条件筛选。');
  }

  if (!canRead && permissions.length > 0) {
    return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
      <header><div><p className="eyebrow">店铺管理</p><h1>库存</h1></div>
        <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a>
          <a href="/admin/aftersales">售后</a><a href="/admin/coupons">优惠券</a><a href="/admin/members">会员与积分</a><a href="/admin/settings">店铺设置</a></div></header>
      <p className="error">当前账号没有库存读取权限（inventory.read）。</p></main>;
  }

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>库存</h1></div>
      <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a>
        <a href="/admin/payments">付款</a><a href="/admin/aftersales">售后</a><a href="/admin/coupons">优惠券</a><a href="/admin/members">会员与积分</a><a href="/admin/settings">店铺设置</a>
        <button disabled={busy} onClick={() => void run(async () => '已刷新。')}>刷新</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <p><small>可售数 = 现存 − 预留。没有“把现存改成 X”的入口：所有变化都是带原因的调整流水。</small></p>

    <form onSubmit={search}>
      <label>搜索 SKU 或商品名<input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></label>
      <label><input type="checkbox" checked={lowStockOnly} onChange={event => setLowStockOnly(event.target.checked)} />
        只看低库存</label>
      <button disabled={busy}>筛选</button>
    </form>

    <table>
      <thead><tr><th>SKU</th><th>商品</th><th>现存</th><th>预留</th><th>可售</th><th>状态</th><th>版本</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.variantId} aria-selected={row.variantId === selectedId}
        onClick={() => { setSelectedId(row.variantId); void loadMovements(row.variantId, typeFilter)
          .catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }}>
        <td>{row.sku}</td><td>{row.productName}</td><td>{row.onHand}</td><td>{row.reserved}</td>
        <td>{row.available}</td>
        <td>{STATE_LABEL[row.lowStockState] ?? row.lowStockState}{row.lowStockLevel > 0 ? `（阈值 ${row.lowStockLevel}）` : ''}</td>
        <td>{row.version}</td>
      </tr>)}</tbody>
    </table>
    {rows.length === 0 && <p><small>没有符合条件的 SKU。</small></p>}

    {selected && <section>
      <h2>{selected.sku} · {selected.productName}</h2>
      <p>现存 {selected.onHand} · 预留 {selected.reserved} · 可售 {selected.available}
        {' · '}商品 {selected.productStatus} / 变体 {selected.variantStatus}{' · '}库存版本 {selected.version}</p>
      <p><small>最近更新 {shortDate(selected.updatedAt)}</small></p>

      {canAdjust ? <article>
        <h3>库存调整</h3>
        <p><small>提交时会带上你看到的版本 {selected.version}；别人先改过就会失败，而不是覆盖。</small></p>
        <form onSubmit={adjustStock}>
          <label>调整数量<small>正数入库，负数出库；不能吃掉已预留的 {selected.reserved} 件</small>
            <input name="delta" type="number" step="1" required /></label>
          <label>原因<input name="reason" maxLength={1000} required placeholder="Opening stock / stocktake loss" /></label>
          <label>原因编码<input name="reasonCode" maxLength={80} placeholder="stocktake / damaged" /></label>
          <label>凭据<input name="reference" maxLength={200} placeholder="单据号或盘点表编号" /></label>
          <button disabled={busy}>记一笔调整</button>
        </form>
      </article> : <p><small>没有 inventory.adjust 权限，只能查看库存。</small></p>}

      {canManage ? <article>
        <h3>低库存阈值</h3>
        <p><small>当前 {selected.lowStockLevel}（阈值版本 {selected.lowStockVersion}）；0 表示只在售罄时提醒。</small></p>
        <form onSubmit={saveThreshold}>
          <label>阈值<input name="lowStockLevel" type="number" min={0} max={1000000} required
            defaultValue={selected.lowStockLevel} /></label>
          <button disabled={busy}>保存阈值</button>
        </form>
      </article> : null}
    </section>}

    <section>
      <h2>库存流水</h2>
      <p><small>流水只追加：退货入库与人工调整共用这一张表，谁改的、改了多少、改后是多少都留在这里。</small></p>
      <label>类型<select value={typeFilter} onChange={event => { const value = event.target.value;
        setTypeFilter(value);
        void loadMovements(selectedId, value).catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }}>
        <option value="">全部</option>
        {Object.entries(TYPE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <table>
        <thead><tr><th>时间</th><th>类型</th><th>变化</th><th>数量</th><th>改后现存</th><th>原因</th></tr></thead>
        <tbody>{movements.map(row => <tr key={row.id}>
          <td>{shortDate(row.createdAt)}</td>
          <td>{TYPE_LABEL[row.type] ?? row.type}</td>
          <td>{row.stockDelta > 0 ? `+${row.stockDelta}` : row.stockDelta}</td>
          <td>{row.quantity}</td>
          <td>{row.onHandAfter ?? '—'}</td>
          <td>{row.reason}{row.reasonCode ? `（${row.reasonCode}）` : ''}{row.reference ? ` · ${row.reference}` : ''}</td>
        </tr>)}</tbody>
      </table>
      {movements.length === 0 && <p><small>这个 SKU 还没有库存流水。</small></p>}
    </section>
  </main>;
}
