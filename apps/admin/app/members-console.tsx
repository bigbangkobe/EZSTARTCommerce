"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { permissionCodes: string[]; csrfToken: string };
type Setting = { enabled: boolean; minorPerPoint: number; pointsExpiryMonths: number | null; version: number; updatedAt: string };
type Tier = { id: string; code: string; nameByLocale: Record<string, string>; rank: number; minLifetimeSpendMinor: number;
  minorPerPoint: number | null; benefits: string[]; status: string; version: number; createdAt: string; updatedAt: string };
type Overview = { settings: Setting; tiers: Tier[] };
type Member = { id: string; memberNo: string; status: string; joinedAt: string; consentRef: string | null; version: number;
  lifetimeSpendMinor: number; tier: { id: string; code: string; rank: number; nameByLocale: Record<string, string> } | null;
  customer: { id: string; displayName: string; email: string | null } };
type Ledger = { id: string; deltaPoints: number; balanceAfter: number; entryType: string; sourceType: string;
  sourceRef: string | null; reasonCode: string; reason: string | null; ruleVersion: string; createdAt: string };
type MemberPoints = { member: { id: string; memberNo: string; status: string; joinedAt: string; lifetimeSpendMinor: number;
  tier: { id: string; code: string; rank: number; nameByLocale: Record<string, string> } | null;
  customer: { id: string; displayName: string; email: string | null } };
  balance: number; accountStatus: string; minorPerPoint: number; enabled: boolean;
  items: Ledger[]; hasMore: boolean; nextCursor: string | null };

const MEMBER_STATUS: Record<string, string> = { active: '正常', suspended: '已停用', closed: '已注销' };
const TIER_STATUS: Record<string, string> = { active: '启用', retired: '已退役' };
const ENTRY_TYPE: Record<string, string> = { earn: '订单发放', adjust: '人工调整', redeem: '兑换扣减',
  expire: '到期作废', reversal: '退款回冲' };

/** 金额统一按「分」入参，展示时除以 100；店铺基础货币由店铺设置决定，这里不硬编码币种。 */
function money(minor: number) { return (minor / 100).toFixed(2); }
function when(value: string | null) { return value ? new Date(value).toLocaleString() : '—'; }
function tierLabel(tier: { code: string; nameByLocale: Record<string, string> } | null) {
  if (!tier) return '—';
  return tier.nameByLocale['zh-HK'] ?? tier.nameByLocale['zh-CN'] ?? tier.nameByLocale['en'] ?? tier.code;
}
/** 多语言名是「有则填、空则不发」的稀疏对象：空串不许出现在请求里。 */
function names(values: FormData) {
  const entries: Record<string, string> = {};
  for (const locale of ['zh-CN', 'zh-HK', 'en']) {
    const value = String(values.get(`name:${locale}`) ?? '').trim();
    if (value) entries[locale] = value;
  }
  return entries;
}
function benefitsOf(values: FormData) {
  return String(values.get('benefits') ?? '').split('\n').map(line => line.trim()).filter(Boolean);
}

export function MembersConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [points, setPoints] = useState<MemberPoints | null>(null);
  const [selectedTierId, setSelectedTierId] = useState('');
  const [adjustKey, setAdjustKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canManage = permissions.includes('members.manage');
  const canAdjust = permissions.includes('points.adjust');
  const selectedTier = overview?.tiers.find(tier => tier.id === selectedTierId) ?? null;

  async function request<T>(path: string, method = 'GET', body?: object, options: { version?: number; key?: string } = {}) {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
      ...(options.version !== undefined ? { 'If-Match': `"${options.version}"` } : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = payload?.error?.code ?? '';
      if (response.status === 403) throw new Error('当前账号没有该操作权限：查看与配置会员需要 members.manage，调整积分还需要 points.adjust。');
      if (response.status === 404) throw new Error('这位会员或这个等级不存在，可能刚被其他人删除，请刷新。');
      if (response.status === 409) throw new Error(
        code === 'VERSION_CONFLICT' ? '这条记录刚被其他人改过，请刷新后按最新版本重试。'
          : code === 'TIER_RANK_TAKEN' ? '这个顺位已被别的等级占用，换一个顺位。'
            : code === 'TIER_CODE_TAKEN' ? '这个等级编码已被占用，换一个。'
              : code === 'POINT_BALANCE_INSUFFICIENT' ? '扣减后余额会变成负数：积分不允许透支。'
                : code === 'IDEMPOTENCY_KEY_REUSED' ? '同一个幂等键被用于不同的调整请求，请重新提交以生成新的键。'
                  : code === 'EMPTY_PATCH' ? '没有需要保存的改动。'
                    : '当前状态不允许该操作，请刷新后确认。');
      if (response.status === 422) throw new Error(
        code === 'MEMBER_TIER_UNKNOWN' ? '指定的等级不存在。'
          : code === 'MEMBER_TIER_RETIRED' ? '已退役的等级不能再分配给会员。'
            : '填写内容不符合要求：换算率为 1–1000000 的整数、顺位 1–100、等级编码为大写字母数字、累计消费门槛为非负整数；人工调整的原因码只能是小写字母、数字与下划线，金额不能为 0。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return ((await response.json()) as { data: T }).data;
  }

  async function loadMembers(cursor?: string) {
    const page = await request<{ items: Member[]; hasMore: boolean; nextCursor: string | null }>(
      `members?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    setMembers(current => cursor ? [...current, ...page.items] : page.items);
    setNextCursor(page.hasMore ? page.nextCursor : null);
    return page.items;
  }

  async function loadPoints(memberId: string) {
    if (!memberId) { setPoints(null); return; }
    setPoints(await request<MemberPoints>(`members/${memberId}/points?limit=20`));
  }

  async function reload() {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (!current.permissionCodes.includes('members.manage')) return;
    setOverview(await request<Overview>('loyalty'));
    const items = await loadMembers();
    const nextId = items.some(row => row.id === selectedId) ? selectedId : items[0]?.id ?? '';
    setSelectedId(nextId);
    await loadPoints(nextId);
  }

  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);
  // 幂等键跟着「这次意图」走：换会员或提交成功后换新键，中途重试沿用同一个键。
  useEffect(() => { setAdjustKey(crypto.randomUUID()); }, [selectedId]);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const message = await action(); await reload(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!overview) return;
    const values = new FormData(event.currentTarget);
    const enabled = values.get('enabled') === 'on';
    const minorPerPoint = Math.round(Number(values.get('minorPerPoint') ?? 0));
    const rawExpiry = String(values.get('pointsExpiryMonths') ?? '').trim();
    if (!Number.isSafeInteger(minorPerPoint) || minorPerPoint < 1 || minorPerPoint > 1_000_000) {
      setError('换算率必须是 1–1000000 的整数（多少分换 1 点）。'); return;
    }
    const pointsExpiryMonths = rawExpiry ? Math.round(Number(rawExpiry)) : null;
    if (pointsExpiryMonths !== null && (!Number.isSafeInteger(pointsExpiryMonths) || pointsExpiryMonths < 1 || pointsExpiryMonths > 120)) {
      setError('积分有效期填 1–120 个月，留空表示永不过期。'); return;
    }
    void run(async () => {
      await request<Setting>('loyalty/settings', 'PATCH', { enabled, minorPerPoint, pointsExpiryMonths },
        { version: overview.settings.version });
      return '积分口径已保存。改动只影响之后的订单，历史流水保留当时的规则版本。';
    });
  }

  function createTier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const code = String(values.get('code') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code)) { setError('等级编码只能包含大写字母、数字与连字符，且以字母或数字开头（最多 40 位）。'); return; }
    const nameByLocale = names(values);
    if (!Object.keys(nameByLocale).length) { setError('至少填写一种语言的等级名。'); return; }
    const rank = Math.round(Number(values.get('rank') ?? 0));
    const minSpend = Math.round(Number(values.get('minLifetimeSpendMinor') ?? 0));
    const rawRate = String(values.get('minorPerPoint') ?? '').trim();
    if (!Number.isSafeInteger(rank) || rank < 1 || rank > 100) { setError('顺位必须是 1–100 的整数，数字越大等级越高。'); return; }
    if (!Number.isSafeInteger(minSpend) || minSpend < 0) { setError('累计消费门槛必须是非负整数（单位：分）。'); return; }
    const rate = rawRate ? Math.round(Number(rawRate)) : null;
    if (rate !== null && (!Number.isSafeInteger(rate) || rate < 1 || rate > 1_000_000)) { setError('等级专属换算率必须是 1–1000000 的整数，留空则沿用店铺口径。'); return; }
    void run(async () => {
      const created = await request<Tier>('loyalty/tiers', 'POST', { code, nameByLocale, rank,
        minLifetimeSpendMinor: minSpend, minorPerPoint: rate, benefits: benefitsOf(values),
        status: String(values.get('status') ?? 'active') });
      form.reset();
      return `已创建等级 ${created.code}（顺位 ${created.rank}）。只对之后的订单生效。`;
    });
  }

  function updateTier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTier) return;
    const values = new FormData(event.currentTarget);
    const code = String(values.get('code') ?? '').trim().toUpperCase();
    const nameByLocale = names(values);
    const rank = Math.round(Number(values.get('rank') ?? 0));
    const minSpend = Math.round(Number(values.get('minLifetimeSpendMinor') ?? 0));
    const rawRate = String(values.get('minorPerPoint') ?? '').trim();
    if (!Object.keys(nameByLocale).length) { setError('至少保留一种语言的等级名。'); return; }
    if (!Number.isSafeInteger(rank) || rank < 1 || rank > 100) { setError('顺位必须是 1–100 的整数。'); return; }
    if (!Number.isSafeInteger(minSpend) || minSpend < 0) { setError('累计消费门槛必须是非负整数（单位：分）。'); return; }
    const rate = rawRate ? Math.round(Number(rawRate)) : null;
    if (rate !== null && (!Number.isSafeInteger(rate) || rate < 1 || rate > 1_000_000)) { setError('等级专属换算率必须是 1–1000000 的整数。'); return; }
    void run(async () => {
      const updated = await request<Tier>(`loyalty/tiers/${selectedTier.id}`, 'PATCH', { code, nameByLocale, rank,
        minLifetimeSpendMinor: minSpend, minorPerPoint: rate, benefits: benefitsOf(values),
        status: String(values.get('status') ?? 'active') }, { version: selectedTier.version });
      return `已更新等级 ${updated.code}，版本升到 ${updated.version}。退役等级不会清空既有会员归属。`;
    });
  }

  function adjust(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!points) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const deltaPoints = Math.round(Number(values.get('deltaPoints') ?? 0));
    const reasonCode = String(values.get('reasonCode') ?? '').trim();
    const reason = String(values.get('reason') ?? '').trim();
    if (!Number.isSafeInteger(deltaPoints) || deltaPoints === 0) { setError('调整金额必须是非 0 整数：正数加、负数扣。'); return; }
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode)) { setError('原因码只能是小写字母开头的小写字母、数字与下划线。'); return; }
    if (!reason) { setError('请填写调整原因，它会写进审计与流水。'); return; }
    void run(async () => {
      const row = await request<Ledger>(`members/${points.member.id}/points-adjustments`, 'POST',
        { deltaPoints, reasonCode, reason }, { key: adjustKey });
      form.reset();
      setAdjustKey(crypto.randomUUID());
      return `已登记 ${row.deltaPoints > 0 ? '+' : ''}${row.deltaPoints} 点，调整后余额 ${row.balanceAfter}。`;
    });
  }

  if (permissions.length > 0 && !canManage) {
    return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
      <header><div><p className="eyebrow">店铺管理</p><h1>会员与积分</h1></div>
        <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a>{permissions.includes('privacy.read') && <a href="/admin/privacy">资料请求</a>}</div></header>
      <p className="error">当前账号没有会员读取权限（members.manage）。</p></main>;
  }

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>会员与积分</h1></div>
      <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a>
        <a href="/admin/coupons">优惠券</a><a href="/admin/reports">报表</a><a href="/admin/settings">店铺设置</a>
        <button disabled={busy} onClick={() => void run(async () => '已刷新。')}>刷新</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <p><small>积分只由追加流水改变：账户余额与流水同事务写入，流水表拒绝改删。等级按累计消费解析，
      升级只影响之后的订单，历史流水保留当时的规则版本。</small></p>

    {overview && <section>
      <h2>积分口径</h2>
      <p>状态 <strong>{overview.settings.enabled ? '发放中' : '已暂停'}</strong>
        {' · '}每 {overview.settings.minorPerPoint} 分（最小货币单位）得 1 点
        {' · '}有效期 {overview.settings.pointsExpiryMonths === null ? '永不过期' : `${overview.settings.pointsExpiryMonths} 个月`}
        {' · '}版本 {overview.settings.version}</p>
      <p><small>口径只按商品金额（小计减折扣）计算，运费与税费不积分；不足 1 点的零头直接舍去，不预支。
        有效期是入账时的快照：改配置只影响之后发放的积分，到期未用的部分由清扫写成「到期作废」流水，不清零重记。
        暂停发放不会清零已有余额。</small></p>
      <form onSubmit={saveSettings}>
        <label className="check"><input type="checkbox" name="enabled" defaultChecked={overview.settings.enabled}
          key={`enabled-${overview.settings.version}`} />订单完成后发放积分</label>
        <label>换算率<small>多少「分」换 1 点，1–1000000 的整数</small>
          <input name="minorPerPoint" type="number" min={1} max={1000000} required
            defaultValue={overview.settings.minorPerPoint} key={`rate-${overview.settings.version}`} /></label>
        <label>积分有效期（月）<small>留空表示永不过期；1–120</small>
          <input name="pointsExpiryMonths" type="number" min={1} max={120}
            defaultValue={overview.settings.pointsExpiryMonths ?? ''} key={`expiry-${overview.settings.version}`} /></label>
        <button disabled={busy}>保存积分口径</button>
      </form>
    </section>}

    {overview && <section>
      <h2>等级阶梯</h2>
      <p><small>门槛是累计消费（分，含折扣后的商品金额）。顺位决定「谁更高」：门槛相同时顺位大的胜出。
        退役后不再参与解析与新分配，但既有会员的归属保留。</small></p>
      <table>
        <thead><tr><th>顺位</th><th>编码</th><th>名称</th><th>累计消费门槛</th><th>换算率</th><th>权益</th><th>状态</th><th>版本</th></tr></thead>
        <tbody>{overview.tiers.map(tier => <tr key={tier.id} aria-selected={tier.id === selectedTierId}
          onClick={() => setSelectedTierId(tier.id)}>
          <td>{tier.rank}</td><td>{tier.code}</td><td>{tierLabel(tier)}</td>
          <td>{money(tier.minLifetimeSpendMinor)}</td>
          <td>{tier.minorPerPoint === null ? '沿用店铺' : tier.minorPerPoint}</td>
          <td>{tier.benefits.length ? tier.benefits.join('、') : '—'}</td>
          <td>{TIER_STATUS[tier.status] ?? tier.status}</td><td>{tier.version}</td>
        </tr>)}</tbody>
      </table>
      {overview.tiers.length === 0 && <p><small>还没有配置等级：会员会被记为「未分档」，订单照常累计消费但不发放等级差异。</small></p>}

      <article>
        <h3>新等级</h3>
        <form onSubmit={createTier}>
          <label>编码<input name="code" maxLength={40} required placeholder="GOLD" /></label>
          <label>名称（简体）<input name="name:zh-CN" maxLength={120} placeholder="金卡会员" /></label>
          <label>名称（繁體）<input name="name:zh-HK" maxLength={120} placeholder="金卡會員" /></label>
          <label>名称（English）<input name="name:en" maxLength={120} placeholder="Gold" /></label>
          <label>顺位<small>1–100，数字越大等级越高</small><input name="rank" type="number" min={1} max={100} required defaultValue={1} /></label>
          <label>累计消费门槛（分）<small>0 表示不限</small><input name="minLifetimeSpendMinor" type="number" min={0} required defaultValue={0} /></label>
          <label>专属换算率<small>留空则沿用店铺口径</small><input name="minorPerPoint" type="number" min={1} max={1000000} /></label>
          <label>权益<small>一行一条，最多 20 条</small><textarea name="benefits" rows={3} /></label>
          <label>状态<select name="status" defaultValue="active">
            <option value="active">启用</option><option value="retired">退役</option>
          </select></label>
          <button disabled={busy}>创建等级</button>
        </form>
      </article>

      {selectedTier && <article>
        <h3>编辑 {selectedTier.code}</h3>
        <p><small>保存会升版本并写审计。已经在用这个等级的会员归属不变，换算率改动只影响之后的订单。</small></p>
        <form onSubmit={updateTier} key={`${selectedTier.id}-${selectedTier.version}`}>
          <label>编码<input name="code" maxLength={40} required defaultValue={selectedTier.code} /></label>
          <label>名称（简体）<input name="name:zh-CN" maxLength={120} defaultValue={selectedTier.nameByLocale['zh-CN'] ?? ''} /></label>
          <label>名称（繁體）<input name="name:zh-HK" maxLength={120} defaultValue={selectedTier.nameByLocale['zh-HK'] ?? ''} /></label>
          <label>名称（English）<input name="name:en" maxLength={120} defaultValue={selectedTier.nameByLocale['en'] ?? ''} /></label>
          <label>顺位<input name="rank" type="number" min={1} max={100} required defaultValue={selectedTier.rank} /></label>
          <label>累计消费门槛（分）<input name="minLifetimeSpendMinor" type="number" min={0} required defaultValue={selectedTier.minLifetimeSpendMinor} /></label>
          <label>专属换算率<small>留空则沿用店铺口径</small>
            <input name="minorPerPoint" type="number" min={1} max={1000000} defaultValue={selectedTier.minorPerPoint ?? ''} /></label>
          <label>权益<textarea name="benefits" rows={3} defaultValue={selectedTier.benefits.join('\n')} /></label>
          <label>状态<select name="status" defaultValue={selectedTier.status}>
            <option value="active">启用</option><option value="retired">退役</option>
          </select></label>
          <button disabled={busy}>保存等级</button>
        </form>
      </article>}
    </section>}

    <section>
      <h2>会员</h2>
      <p><small>邮箱按账号权限显示：有 customers.read_pii 才是原文，否则是掩码。</small></p>
      <table>
        <thead><tr><th>会员号</th><th>顾客</th><th>邮箱</th><th>等级</th><th>累计消费</th><th>状态</th><th>加入时间</th></tr></thead>
        <tbody>{members.map(member => <tr key={member.id} aria-selected={member.id === selectedId}
          onClick={() => { setSelectedId(member.id); void loadPoints(member.id)
            .catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }}>
          <td>{member.memberNo}</td><td>{member.customer.displayName}</td><td>{member.customer.email ?? '—'}</td>
          <td>{tierLabel(member.tier)}</td><td>{money(member.lifetimeSpendMinor)}</td>
          <td>{MEMBER_STATUS[member.status] ?? member.status}</td><td>{when(member.joinedAt)}</td>
        </tr>)}</tbody>
      </table>
      {members.length === 0 && <p><small>还没有会员。会员由顾客用邮箱验证码自助注册，或在顾客详情里手动建。</small></p>}
      {nextCursor && <button className="secondary" disabled={busy}
        onClick={() => void run(async () => { await loadMembers(nextCursor); return '已加载更多会员。'; })}>加载更多会员</button>}

      {points && <article>
        <h3>{points.member.memberNo} · {points.member.customer.displayName}</h3>
        <p>等级 {tierLabel(points.member.tier)} · 累计消费 {money(points.member.lifetimeSpendMinor)}
          {' · '}当前换算率 {points.minorPerPoint} · 发放 {points.enabled ? '开启' : '暂停'}</p>
        <p>积分余额 <strong>{points.balance}</strong> 点 · 账户状态 {points.accountStatus}
          {points.member.customer.email ? ` · ${points.member.customer.email}` : ''}</p>

        <h3>最近流水</h3>
        <table>
          <thead><tr><th>时间</th><th>类型</th><th>变动</th><th>余额</th><th>原因码</th><th>原因</th><th>来源</th><th>规则版本</th></tr></thead>
          <tbody>{points.items.map(row => <tr key={row.id}>
            <td>{when(row.createdAt)}</td><td>{ENTRY_TYPE[row.entryType] ?? row.entryType}</td>
            <td>{row.deltaPoints > 0 ? `+${row.deltaPoints}` : row.deltaPoints}</td><td>{row.balanceAfter}</td>
            <td>{row.reasonCode}</td><td>{row.reason ?? '—'}</td><td>{row.sourceRef ?? row.sourceType}</td>
            <td>{row.ruleVersion}</td>
          </tr>)}</tbody>
        </table>
        {points.items.length === 0 && <p><small>这位会员还没有积分流水。</small></p>}

        {canAdjust ? <form onSubmit={adjust} key={`adjust-${points.member.id}`}>
          <h3>人工调整</h3>
          <p><small>必须带原因：它会同时写进流水与审计。同一笔调整重试不会变成两次加减（幂等键
            {adjustKey ? ` ${adjustKey.slice(0, 8)}…` : ' 生成中'}）。</small></p>
          <label>变动点数<small>正数加、负数扣，不能为 0；扣减后余额不能为负</small>
            <input name="deltaPoints" type="number" step={1} required /></label>
          <label>原因码<small>小写字母开头，如 goodwill / manual_fix</small>
            <input name="reasonCode" maxLength={80} required placeholder="goodwill" /></label>
          <label>原因说明<input name="reason" maxLength={1000} required placeholder="客服补偿：订单配送延误" /></label>
          <button disabled={busy || !adjustKey}>登记调整</button>
        </form> : <p><small>当前账号没有 points.adjust 权限，只能查看积分账。</small></p>}
      </article>}
    </section>
  </main>;
}
