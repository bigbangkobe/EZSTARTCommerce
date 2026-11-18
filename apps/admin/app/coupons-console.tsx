"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { permissionCodes: string[]; csrfToken: string };
type Usage = { reservedCount: number; redeemedCount: number; releasedCount: number; expiredCount: number;
  returnedCount: number; usedCount: number };
type Coupon = { id: string; code: string; codeMasked: string; status: string; discountType: string;
  discountValue: number; currency: string; validFrom: string; validUntil: string;
  minSubtotalMinor: number | null; totalLimit: number | null; perCustomerLimit: number | null;
  eligibleProductIds: string[]; eligibleCategoryIds: string[]; memberTierIds: string[]; refundPolicy: string;
  version: number; createdBy: string | null; createdAt: string; updatedAt: string; usage: Usage };
type Redemption = { id: string; orderId: string; publicOrderNumber: string; status: string;
  discountMinor: number; currency: string; customerRef: string | null; reservedAt: string;
  redeemedAt: string | null; releasedAt: string | null; expiresAt: string | null; ruleVersion: number | null };
type Tier = { id: string; code: string; nameByLocale: Record<string, string>; rank: number; status: string };
type Batch = { id: string; couponId: string; channel: string; recipientCount: number; recipientMemberIds: string[];
  status: 'pending' | 'issued'; confirmedRecipientCount: number | null; issuedAt: string | null };

const STATUS_LABEL: Record<string, string> = { active: '启用', disabled: '停用' };
const REDEMPTION_LABEL: Record<string, string> = { reserved: '已预占', redeemed: '已核销',
  released: '已释放', expired: '已过期' };

function minor(minor: number, currency: string) {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}
function shortDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}
function toLocalInput(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function describeValue(coupon: Coupon) {
  return coupon.discountType === 'percent'
    ? `${(coupon.discountValue / 100).toFixed(0)}% 折扣`
    : `立减 ${minor(coupon.discountValue, coupon.currency)}`;
}

export function CouponsConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [rows, setRows] = useState<Coupon[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const canRead = permissions.includes('coupons.read');
  const canManage = permissions.includes('coupons.manage');
  const canIssue = permissions.includes('coupons.issue');
  const selected = rows.find(row => row.id === selectedId) ?? null;

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
      if (response.status === 404) throw new Error('这张优惠券不存在。');
      if (response.status === 409) throw new Error(code === 'COUPON_CODE_TAKEN' ? '这个券码已被占用，换一个再试。'
        : code === 'VERSION_CONFLICT' ? '规则刚被其他人改过，请刷新后重试。'
          : code === 'IDEMPOTENCY_CONFLICT' ? '同一幂等键已用于不同请求。'
            : '当前状态不允许该操作，请刷新后确认。');
      if (response.status === 422) throw new Error(code === 'MEMBER_TIER_UNKNOWN' ? '所选会员等级不存在，请刷新后重选。'
        : code === 'MEMBER_TIER_RETIRED' ? '所选等级已退役，不能用于新券。'
          : code === 'BATCH_MEMBER_UNKNOWN' ? '名单里有会员不存在，请核对会员 ID。'
            : code === 'BATCH_RECIPIENT_COUNT_CHANGED' ? '收件人数与建批时不一致，请重新建批后再发放。'
              : '填写内容不符合要求：固定金额上限 1,000,000（最小单位），百分比 1–100%，结束时间必须晚于开始时间。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return ((await response.json()) as { data: T }).data;
  }

  async function loadRedemptions(couponId: string) {
    if (!couponId) { setRedemptions([]); return; }
    setRedemptions((await request<{ items: Redemption[] }>(`coupons/${couponId}/redemptions?limit=20`)).items);
  }

  async function reload(preferred?: string) {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (!current.permissionCodes.includes('coupons.read')) return;
    const params = new URLSearchParams({ limit: '25' });
    if (query.trim()) params.set('q', query.trim());
    if (status) params.set('status', status);
    const list = await request<{ items: Coupon[] }>(`coupons?${params.toString()}`);
    setRows(list.items);
    const nextId = preferred ?? (list.items.some(row => row.id === selectedId) ? selectedId : list.items[0]?.id ?? '');
    setSelectedId(nextId);
    await loadRedemptions(nextId);
  }

  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);

  // 会员等级只用于创建专属券时的勾选；读不到就留空，不阻断券管理。
  useEffect(() => {
    request<{ tiers: Tier[] }>('loyalty').then(value => setTiers(Array.isArray(value?.tiers) ? value.tiers : [])).catch(() => setTiers([]));
  }, []);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const message = await action(); await reload(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  function createCoupon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const code = String(values.get('code') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(code)) { setError('券码只能包含大写字母、数字、- 和 _，且以字母或数字开头。'); return; }
    const discountType = String(values.get('discountType') ?? '');
    const rawValue = Number(values.get('discountValue') ?? 0);
    if (!Number.isFinite(rawValue) || rawValue <= 0) { setError('请填写有效的折扣力度。'); return; }
    const discountValue = discountType === 'percent' ? Math.round(rawValue * 100) : Math.round(rawValue);
    if (discountType === 'percent' && discountValue > 10000) { setError('百分比折扣不能超过 100%。'); return; }
    const from = String(values.get('validFrom') ?? '');
    const until = String(values.get('validUntil') ?? '');
    if (!from || !until) { setError('请填写生效与失效时间。'); return; }
    const minSubtotal = String(values.get('minSubtotalMinor') ?? '').trim();
    const totalLimit = String(values.get('totalLimit') ?? '').trim();
    const perCustomer = String(values.get('perCustomerLimit') ?? '').trim();
    void run(async () => {
      const created = await request<Coupon>('coupons', 'POST', {
        code, discountType, discountValue,
        validFrom: new Date(from).toISOString(), validUntil: new Date(until).toISOString(),
        ...(minSubtotal ? { minSubtotalMinor: Math.round(Number(minSubtotal)) } : {}),
        ...(totalLimit ? { totalLimit: Math.round(Number(totalLimit)) } : {}),
        ...(perCustomer ? { perCustomerLimit: Math.round(Number(perCustomer)) } : {}),
        refundPolicy: String(values.get('refundPolicy') ?? 'none'),
        memberTierIds: values.getAll('memberTiers').map(String),
      });
      form.reset();
      return `已创建优惠券 ${created.code}（${describeValue(created)}）。`;
    });
  }

  function disableCoupon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (!reason) { setError('请填写停用原因。'); return; }
    void run(async () => {
      await request<Coupon>(`coupons/${selected.id}/disable`, 'POST', { reason });
      return `已停用 ${selected.code}：不能再被新订单使用，但已下单的折扣保持原样。`;
    });
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => '已按当前条件筛选。');
  }

  function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const ids = String(values.get('recipientMemberIds') ?? '').split(/[\s,，]+/).map(s => s.trim()).filter(Boolean);
    if (!ids.length) { setError('请填写至少一位会员 ID。'); return; }
    const couponId = String(values.get('couponId') ?? '') || selected?.id || '';
    if (!couponId) { setError('请选择要发放的优惠券。'); return; }
    void run(async () => {
      const created = await request<Batch>('coupon-batches', 'POST', {
        couponId, channel: String(values.get('channel') ?? 'account_only'), recipientMemberIds: ids,
      });
      setBatch(created);
      return `已建批，冻结收件人数 ${created.recipientCount} 位；请核对后确认发放。`;
    });
  }

  function issueBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!batch) return;
    const count = Number(new FormData(event.currentTarget).get('confirmedRecipientCount'));
    if (!Number.isInteger(count) || count < 0) { setError('请填写正确的确认人数。'); return; }
    void run(async () => {
      const issued = await request<Batch>(`coupon-batches/${batch.id}/issue`, 'POST', { confirmedRecipientCount: count });
      setBatch(issued);
      return `已确认发放 ${issued.confirmedRecipientCount} 位会员，批次状态：${issued.status}。`;
    });
  }

  if (!canRead && permissions.length > 0) {
    return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
      <header><div><p className="eyebrow">店铺管理</p><h1>优惠券</h1></div>
        <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a>
          <a href="/admin/members">会员与积分</a><a href="/admin/settings">店铺设置</a></div></header>
      <p className="error">当前账号没有优惠券读取权限（coupons.read）。</p></main>;
  }

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>优惠券</h1></div>
      <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a>
        <a href="/admin/payments">付款</a><a href="/admin/inventory">库存</a><a href="/admin/aftersales">售后</a>
        <a href="/admin/members">会员与积分</a><a href="/admin/settings">店铺设置</a>
        <button disabled={busy} onClick={() => void run(async () => '已刷新。')}>刷新</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <p><small>每单最多用一张券，不叠加。报价只做试算，额度在下单时才预占；收款成功才核销，取消或超时自动释放。</small></p>

    <form onSubmit={search}>
      <label>搜索券码<input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></label>
      <label>状态<select value={status} onChange={event => setStatus(event.target.value)}>
        <option value="">全部</option>
        <option value="active">启用</option>
        <option value="disabled">停用</option>
      </select></label>
      <button disabled={busy}>筛选</button>
    </form>

    <table>
      <thead><tr><th>券码</th><th>折扣</th><th>有效期至</th><th>已用/总额度</th><th>每人限用</th><th>状态</th><th>版本</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} aria-selected={row.id === selectedId}
        onClick={() => { setSelectedId(row.id); void loadRedemptions(row.id)
          .catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }}>
        <td>{row.code}</td><td>{describeValue(row)}</td><td>{shortDate(row.validUntil)}</td>
        <td>{row.usage.usedCount}{row.totalLimit === null ? '' : ` / ${row.totalLimit}`}</td>
        <td>{row.perCustomerLimit ?? '不限'}</td>
        <td>{STATUS_LABEL[row.status] ?? row.status}</td>
        <td>{row.version}</td>
      </tr>)}</tbody>
    </table>
    {rows.length === 0 && <p><small>还没有符合条件的优惠券。</small></p>}

    {canManage ? <article>
      <h2>创建优惠券</h2>
      <p><small>券码全局唯一；创建后规则可改，但已经下单的折扣快照不会跟着改。</small></p>
      <form onSubmit={createCoupon}>
        <label>券码<input name="code" maxLength={80} required placeholder="WELCOME-10" /></label>
        <label>类型<select name="discountType" defaultValue="percent">
          <option value="percent">百分比折扣</option>
          <option value="fixed">固定金额立减</option>
        </select></label>
        <label>力度<small>百分比填 1–100（如 10 表示 10%）；固定金额填最小货币单位（如 100 = 1.00）</small>
          <input name="discountValue" type="number" min={1} required /></label>
        <label>生效时间<input name="validFrom" type="datetime-local" required /></label>
        <label>失效时间<input name="validUntil" type="datetime-local" required /></label>
        <label>最低消费（最小单位，可空）<input name="minSubtotalMinor" type="number" min={0} placeholder="5000" /></label>
        <label>总发放额度（可空 = 不限）<input name="totalLimit" type="number" min={1} placeholder="100" /></label>
        <label>每人限用次数（可空 = 不限）<input name="perCustomerLimit" type="number" min={1} placeholder="1" /></label>
        <label>整单退款后<select name="refundPolicy" defaultValue="none">
          <option value="none">不返还额度</option>
          <option value="restore">返还额度（生成返还记录，不改写原核销）</option>
        </select></label>
        <fieldset><legend>会员等级（可多选，留空 = 全场通用）</legend>
          {tiers.length === 0 ? <small>没有可读取的会员等级（需要 members.manage 权限），可先创建公开券。</small>
            : tiers.filter(tier => tier.status === 'active').map(tier => <label key={tier.id}>
              <input type="checkbox" name="memberTiers" value={tier.id} /> {tier.nameByLocale['zh-HK'] ?? tier.nameByLocale['zh-CN'] ?? tier.code}
            </label>)}
        </fieldset>
        <button disabled={busy}>创建</button>
      </form>
    </article> : <p><small>没有 coupons.manage 权限，只能查看优惠券。</small></p>}

    {selected && <section>
      <h2>{selected.code} · {describeValue(selected)}</h2>
      <p>状态 {STATUS_LABEL[selected.status] ?? selected.status} · 版本 {selected.version} · 退款策略 {selected.refundPolicy === 'restore' ? '整单退款返还额度' : '不返还'}</p>
      <p><small>有效期 {shortDate(selected.validFrom)} 至 {shortDate(selected.validUntil)}
        {selected.minSubtotalMinor !== null ? ` · 最低消费 ${minor(selected.minSubtotalMinor, selected.currency)}` : ''}
        {selected.eligibleProductIds.length + selected.eligibleCategoryIds.length > 0
          ? ` · 限 ${selected.eligibleProductIds.length} 个商品 / ${selected.eligibleCategoryIds.length} 个分类`
          : ' · 全场通用'}
        {selected.memberTierIds.length > 0 ? ` · 限 ${selected.memberTierIds.length} 个会员等级` : ''}</small></p>
      <p>用量：预占 {selected.usage.reservedCount} · 已核销 {selected.usage.redeemedCount} · 已释放 {selected.usage.releasedCount}
        {' · '}已过期 {selected.usage.expiredCount} · 已返还 {selected.usage.returnedCount}
        {' · '}<strong>占额度 {selected.usage.usedCount}</strong></p>
      <p><small>占额度 = 预占 + 已核销 − 已返还；只有它消耗总额度与每人限用。</small></p>

      {canManage && selected.status === 'active' && <article>
        <h3>停用</h3>
        <p><small>停用后立即不能用于新报价与下单；已进入订单的折扣按下单时的快照结算，不受影响。</small></p>
        <form onSubmit={disableCoupon}>
          <label>停用原因<input name="reason" maxLength={200} required placeholder="活动提前结束 / 券码外泄" /></label>
          <button disabled={busy}>停用这张券</button>
        </form>
      </article>}
    </section>}

    {canIssue && <section>
      <h2>批量发放</h2>
      <p><small>先建批冻结收件人数，再按人数复核确认发放。名单里的会员 ID 可从「会员与积分」页复制。</small></p>
      <form onSubmit={createBatch}>
        <label>优惠券<select name="couponId" defaultValue={selectedId}>
          {rows.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}
        </select></label>
        <label>发放渠道<select name="channel" defaultValue="account_only">
          <option value="account_only">仅入账户</option>
          <option value="email">邮件通知</option>
          <option value="sms">短信通知</option>
        </select></label>
        <label>会员 ID 列表<small>多个用逗号或空白分隔</small>
          <input name="recipientMemberIds" placeholder="粘贴会员 ID，逗号分隔" /></label>
        <button disabled={busy}>建立发放批次</button>
      </form>
      {batch && <article>
        <h3>批次 {batch.id.slice(0, 8)} · {batch.status === 'issued' ? '已发放' : '待确认'}</h3>
        <p><small>冻结收件人数 {batch.recipientCount} · 渠道 {batch.channel}
          {batch.issuedAt ? ` · 发放于 ${shortDate(batch.issuedAt)}` : ''}</small></p>
        {batch.status === 'pending' ? <form onSubmit={issueBatch}>
          <label>确认发放人数<input name="confirmedRecipientCount" type="number" min={0} defaultValue={batch.recipientCount} required /></label>
          <button disabled={busy}>确认发放</button>
        </form> : <p className="notice">该批次已发放，重复确认不会再次写入。</p>}
      </article>}
    </section>}

    <section>
      <h2>核销记录</h2>
      <p><small>只追加不改写。顾客一栏是不可逆摘要的前 8 位，无法还原邮箱或电话。</small></p>
      <table>
        <thead><tr><th>订单号</th><th>状态</th><th>抵扣金额</th><th>顾客</th><th>预占时间</th><th>核销时间</th><th>规则版本</th></tr></thead>
        <tbody>{redemptions.map(row => <tr key={row.id}>
          <td>{row.publicOrderNumber}</td>
          <td>{REDEMPTION_LABEL[row.status] ?? row.status}</td>
          <td>{minor(row.discountMinor, row.currency)}</td>
          <td>{row.customerRef ?? '—'}</td>
          <td>{shortDate(row.reservedAt)}</td>
          <td>{shortDate(row.redeemedAt)}</td>
          <td>{row.ruleVersion ?? '—'}</td>
        </tr>)}</tbody>
      </table>
      {redemptions.length === 0 && <p><small>这张券还没有核销记录。</small></p>}
    </section>
  </main>;
}
