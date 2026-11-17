"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Actor = { id: string; displayName: string } | null;
type HistoryEntry = { action: string; actorName: string | null; result: string; reason: string | null; occurredAt: string };
type Request = { id: string; requestNumber: string; requestType: string; sourceChannel: string; scope: string[];
  customerRef: string | null; customerId: string | null; customerName: string | null; verificationState: string;
  verificationMethod: string | null; verificationEvidenceRef: string | null; verifiedAt: string | null; verifier: Actor;
  status: string; receivedAt: string; dueAt: string; overdueDays: number; owner: Actor; reviewer: Actor;
  decisionAt: string | null; decisionReason: string | null; retentionExceptionRef: string | null; exportJobRef: string | null;
  completedAt: string | null; ruleVersion: string; version: number; createdAt: string; updatedAt: string;
  history?: HistoryEntry[] };
type Queue = { items: Request[]; hasMore: boolean; nextCursor: string | null;
  summary: { open: number; overdue: number }; settings: { dueDays: number; version: number; updatedAt: string } };

const REQUEST_TYPES: Record<string, string> = { access: '查阅', export: '导出', correct: '更正',
  withdraw_marketing: '退订营销', delete: '删除', anonymize: '匿名化' };
const CHANNELS: Record<string, string> = { email: '邮件', phone: '电话', admin: '后台登记', storefront: '门店前台' };
const STATUS: Record<string, string> = { received: '待核验', verified: '已核验', approved: '已批准待执行',
  needs_information: '待顾客补充', rejected: '已拒绝', completed: '已完成' };
const DECISIONS: Record<string, string> = { approved: '批准（待执行）', rejected: '拒绝',
  needs_information: '要求补充材料', completed: '标记完成' };
const ACTION_LABELS: Record<string, string> = { 'privacy.request.created': '受理', 'privacy.request.verified': '核验身份',
  'privacy.request.approved': '批准', 'privacy.request.rejected': '拒绝', 'privacy.request.needs_information': '要求补充',
  'privacy.request.completed': '标记完成', 'privacy.request.updated': '改负责人或延期' };
/** 只有这两类请求在完成时必须指出保留依据：交易事实不随请求消失。 */
const RETENTION_TYPES = new Set(['delete', 'anonymize']);

function when(value: string | null) { return value ? new Date(value).toLocaleString() : '—'; }
function scopeOf(values: string[]) { return values.length ? values.join('、') : '—'; }

export function PrivacyConsole() {
  const session = useRef<{ csrfToken: string } | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [items, setItems] = useState<Request[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<Request | null>(null);
  const [verifyKey, setVerifyKey] = useState('');
  const [decideKey, setDecideKey] = useState('');
  const [decision, setDecision] = useState('approved');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canManage = permissions.includes('privacy.manage');
  const canVerify = permissions.includes('privacy.verify');
  const canProcess = permissions.includes('privacy.process');

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
      if (response.status === 403) throw new Error(canProcess
        ? '当前账号没有该操作权限：受理与延期要 privacy.manage，核验要 privacy.verify，决定要 privacy.process。'
        : '当前账号没有资料请求权限：查看队列要 privacy.read。');
      if (response.status === 404) throw new Error('这条请求不存在，可能刚被其他人处理，请刷新。');
      if (response.status === 409) throw new Error(
        code === 'VERSION_CONFLICT' ? '这条记录刚被其他人改过，请刷新后按最新版本重试。'
          : code === 'PRIVACY_STATUS_CONFLICT' ? '这条请求已经结案或正在别的处理步骤上，不能再这么操作。'
            : code === 'PRIVACY_VERIFICATION_REQUIRED' ? '身份还没核验：不能批准，也不能标记完成。'
              : code === 'PRIVACY_ALREADY_VERIFIED' ? '这条请求已经核验过身份了；如果只是重试，请沿用原来的幂等键。'
                : code === 'IDEMPOTENCY_KEY_REUSED' ? '同一个幂等键被用于另一条请求，请重新提交以生成新的键。'
                  : '当前状态不允许该操作，请刷新后确认。');
      if (response.status === 422) throw new Error(
        code === 'PRIVACY_RETENTION_EXCEPTION_REQUIRED' ? '删除/匿名化完成前必须填写保留例外依据（例如订单需按税务要求保留）。'
          : code === 'EMPTY_PATCH' ? '没有需要保存的改动。'
            : code === 'PRIVACY_UPDATE_REASON_REQUIRED' ? '改负责人或延期都要写理由。'
              : code === 'PRIVACY_DUE_AT_INVALID' ? '到期时间必须晚于受理时间，且不超过一年。'
                : code === 'PRIVACY_CUSTOMER_NOT_FOUND' ? '指定的顾客不存在，请先在顾客页确认。'
                  : code === 'PRIVACY_OWNER_INVALID' ? '指定的负责人不存在或已停用。'
                    : '填写内容不符合要求：来源渠道与类型必须是给定选项，原因必填且不超过 1000 字。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return ((await response.json()) as { data: T }).data;
  }

  async function loadDetail(id: string) {
    if (!id) { setDetail(null); return; }
    setDetail(await request<Request>(`privacy-requests/${id}`));
  }

  async function loadQueue(cursor?: string) {
    const query = new URLSearchParams({ limit: '25' });
    if (cursor) query.set('cursor', cursor);
    if (statusFilter) query.set('status', statusFilter);
    if (onlyOverdue) query.set('overdue', 'true');
    const page = await request<Queue>(`privacy-requests?${query.toString()}`);
    setQueue({ ...page, items: [] });
    setItems(current => cursor ? [...current, ...page.items] : page.items);
    setNextCursor(page.hasMore ? page.nextCursor : null);
    return page.items;
  }

  async function reload() {
    const current = await request<{ permissionCodes: string[]; csrfToken: string }>('auth/session');
    session.current = { csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (!current.permissionCodes.includes('privacy.read')) return;
    const rows = await loadQueue();
    const nextId = rows.some(row => row.id === selectedId) ? selectedId : rows[0]?.id ?? '';
    setSelectedId(nextId);
    await loadDetail(nextId);
  }

  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, [statusFilter, onlyOverdue]);
  // 幂等键跟着「这次意图」走：换请求或提交成功后换新键，失败重试沿用同一个键。
  useEffect(() => {
    setVerifyKey(crypto.randomUUID());
    setDecideKey(crypto.randomUUID());
    setDecision('approved');
    loadDetail(selectedId).catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。'));
  }, [selectedId]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : '操作未完成。'); }
    finally { setBusy(false); }
  }

  async function submitAction(action: () => Promise<string>) {
    await run(async () => { setNotice(await action()); await reload(); });
  }

  const selected = detail;
  const needsRetention = selected !== null && RETENTION_TYPES.has(selected.requestType);

  return <main className="console">
    <div className="brand">EZSTART<span>Commerce</span></div>
    <header>
      <div><p className="eyebrow">顾客与合规</p><h1>资料请求</h1></div>
      <div className="actions"><a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a>
        {permissions.includes('customers.read_masked') && <a href="/admin/members">会员与积分</a>}
        {permissions.includes('audit.read') && <a href="/admin/audit">审计记录</a>}
        <button disabled={busy} onClick={() => void run(async () => { await reload(); })}>刷新队列</button></div>
    </header>

    {error && <p className="notice error" role="alert">{error}</p>}
    {notice && <p className="notice">{notice}</p>}

    {!permissions.length && <p><small>当前账号没有资料请求的查看权限（privacy.read）。</small></p>}

    {permissions.includes('privacy.read') && <>
      <section>
        <h2>处理口径与队列</h2>
        <p><small>共 {queue?.summary.open ?? 0} 件未结案，其中 {queue?.summary.overdue ?? 0} 件已逾期。
          到期日是受理时按当时口径算出的快照：之后改口径只影响新受理的请求。</small></p>
        <form className="actions" onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void submitAction(async () => {
            const saved = await request<{ dueDays: number; version: number }>('privacy-settings', 'PATCH',
              { dueDays: Number(values.get('dueDays')) }, { version: queue!.settings.version });
            return `口径已更新为 ${saved.dueDays} 天（版本 ${saved.version}）。`;
          });
        }}>
          <label>受理后须在 <input name="dueDays" type="number" min={1} max={365} defaultValue={queue?.settings.dueDays ?? 30}
            key={queue?.settings.version} disabled={!canManage} /> 天内处理完</label>
          <button disabled={busy || !canManage} type="submit">保存口径</button>
          {!canManage && <small>改口径需要 privacy.manage。</small>}
        </form>

        <div className="actions">
          <label>状态 <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
            <option value="">全部</option>
            {Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label><input type="checkbox" checked={onlyOverdue} onChange={event => setOnlyOverdue(event.target.checked)} /> 只看逾期</label>
        </div>

        <table>
          <thead><tr><th>单号</th><th>类型</th><th>来源</th><th>状态</th><th>到期</th><th>负责人</th></tr></thead>
          <tbody>
            {items.map(row => <tr key={row.id} style={row.id === selectedId ? { fontWeight: 600 } : undefined}>
              <td><button className="link" disabled={busy} onClick={() => setSelectedId(row.id)}>{row.requestNumber}</button></td>
              <td>{REQUEST_TYPES[row.requestType] ?? row.requestType}</td>
              <td>{CHANNELS[row.sourceChannel] ?? row.sourceChannel}</td>
              <td>{STATUS[row.status] ?? row.status}{row.overdueDays > 0 &&
                <span className="pill warn">逾期 {row.overdueDays} 天</span>}</td>
              <td>{when(row.dueAt)}</td>
              <td>{row.owner?.displayName ?? '—'}</td>
            </tr>)}
            {!items.length && <tr><td colSpan={6}>队列为空。</td></tr>}
          </tbody>
        </table>
        {nextCursor && <button disabled={busy} onClick={() => void run(async () => { await loadQueue(nextCursor); })}>加载更多</button>}
      </section>

      {canManage && <section>
        <h2>登记新请求</h2>
        <p><small>受理只记录「顾客说要什么」。身份核验是单独一步：核验之前不能批准，也不能标记完成。
          邮箱、电话等联系方式只作为核验线索，不算已确认身份。</small></p>
        <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void submitAction(async () => {
            const created = await request<Request>('privacy-requests', 'POST', {
              requestType: values.get('requestType'), sourceChannel: values.get('sourceChannel'),
              customerRef: String(values.get('customerRef') ?? '').trim() || null,
              scope: String(values.get('scope') ?? '').split(',').map(item => item.trim()).filter(Boolean),
            });
            setSelectedId(created.id);
            return `已受理 ${created.requestNumber}，到期 ${when(created.dueAt)}。`;
          });
        }}>
          <label>类型 <select name="requestType" defaultValue="access">
            {Object.entries(REQUEST_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>来源 <select name="sourceChannel" defaultValue="email">
            {Object.entries(CHANNELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>申请人自述身份 <input name="customerRef" maxLength={200} placeholder="邮箱 / 电话 / 姓名（核验线索）" /></label>
          <label>范围 <input name="scope" maxLength={400} placeholder="profile, orders（逗号分隔，可留空）" /></label>
          <button disabled={busy} type="submit">受理</button>
        </form>
      </section>}

      {selected && <section>
        <h2>{selected.requestNumber}：{REQUEST_TYPES[selected.requestType] ?? selected.requestType}</h2>
        <p><small>状态 {STATUS[selected.status] ?? selected.status}；核验 {selected.verificationState === 'verified'
          ? `已完成（${selected.verificationMethod}，${when(selected.verifiedAt)}，${selected.verifier?.displayName ?? '—'}）`
          : '未完成'}；受理 {when(selected.receivedAt)}，到期 {when(selected.dueAt)}。
          {selected.overdueDays > 0 ? ` 已逾期 ${selected.overdueDays} 天。` : ' 尚未逾期。'}</small></p>
        <p><small>自述身份 {selected.customerRef ?? '—'}；关联顾客 {selected.customerName ?? selected.customerId ?? '未关联'}；
          范围 {scopeOf(selected.scope)}；来源 {CHANNELS[selected.sourceChannel] ?? selected.sourceChannel}；
          负责人 {selected.owner?.displayName ?? '—'}；规则版本 {selected.ruleVersion}。</small></p>
        {selected.decisionReason && <p><small>最近记录：{STATUS[selected.status]} —— {selected.decisionReason}
          （{when(selected.decisionAt)}，{selected.reviewer?.displayName ?? '—'}）</small></p>}
        {selected.retentionExceptionRef && <p><small>保留例外依据：{selected.retentionExceptionRef}</small></p>}

        {canVerify && selected.verificationState !== 'verified' && !['rejected', 'completed'].includes(selected.status) &&
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void submitAction(async () => {
              const updated = await request<Request>(`privacy-requests/${selected.id}/verify`, 'POST', {
                verificationMethod: values.get('verificationMethod'), evidenceRef: values.get('evidenceRef'),
                reason: values.get('reason'), customerId: String(values.get('customerId') ?? '').trim() || null,
              }, { key: verifyKey });
              setVerifyKey(crypto.randomUUID());
              return `${updated.requestNumber} 身份已核验（版本 ${updated.version}）。`;
            });
          }}>
            <h3>核验身份</h3>
            <p><small>核验方式与证据都要留档：例如「回复了档案邮箱收到的工单」。关联顾客可留空，留空就只记录「人已核验」。</small></p>
            <label>核验方式 <input name="verificationMethod" required maxLength={80} placeholder="email_reply" /></label>
            <label>证据引用 <input name="evidenceRef" required maxLength={200} placeholder="ticket-1234" /></label>
            <label>说明 <input name="reason" required maxLength={1000} placeholder="顾客从登记邮箱回信确认" /></label>
            <label>关联顾客 ID <input name="customerId" maxLength={36} placeholder="可留空" /></label>
            <button disabled={busy} type="submit">确认已核验</button>
          </form>}

        {canProcess && !['rejected', 'completed'].includes(selected.status) &&
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            const retention = String(values.get('retentionExceptionRef') ?? '').trim();
            void submitAction(async () => {
              const updated = await request<Request>(`privacy-requests/${selected.id}/complete`, 'POST', {
                decision: values.get('decision'), reason: values.get('reason'),
                retentionExceptionRef: retention || null,
              }, { key: decideKey });
              setDecideKey(crypto.randomUUID());
              return `${updated.requestNumber} 已记录：${DECISIONS[updated.status] ?? updated.status}。`;
            });
          }}>
            <h3>决定</h3>
            <p><small>「批准」只表示可以做，不等于做完了：执行后再回来标记完成，完成时间才成立。
              删除与匿名化完成时必须写出保留依据——订单、支付、售后等交易事实不会因为请求而消失。</small></p>
            <label>决定 <select name="decision" value={decision} onChange={event => setDecision(event.target.value)}>
              {Object.entries(DECISIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label>原因 <input name="reason" required maxLength={1000} placeholder="已按身份核验结果处理" /></label>
            {needsRetention && decision === 'completed' &&
              <label>保留例外依据 <input name="retentionExceptionRef" required maxLength={200} placeholder="retention-v1#order-history" /></label>}
            <button disabled={busy} type="submit">记录决定</button>
          </form>}

        {canManage && !['rejected', 'completed'].includes(selected.status) &&
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void submitAction(async () => {
              const dueAt = String(values.get('dueAt') ?? '').trim();
              const updated = await request<Request>(`privacy-requests/${selected.id}`, 'PATCH', {
                ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
                reason: values.get('reason'),
              }, { version: selected.version });
              return `${updated.requestNumber} 已更新（版本 ${updated.version}）。`;
            });
          }}>
            <h3>延期</h3>
            <p><small>延期只影响提醒，不会把逾期记录抹掉。必须写理由：队列上的每个日期变化都要能回答「为什么」。</small></p>
            <label>新到期时间 <input name="dueAt" type="datetime-local" required /></label>
            <label>理由 <input name="reason" required maxLength={1000} placeholder="顾客要求补交材料，已同意延期" /></label>
            <button disabled={busy} type="submit">保存延期</button>
          </form>}

        <h3>处理历史</h3>
        <p><small>与「审计记录」是同一份事实：这里看到的每一行都能在审计页查到。</small></p>
        <table>
          <thead><tr><th>时间</th><th>动作</th><th>操作人</th><th>说明</th></tr></thead>
          <tbody>
            {(selected.history ?? []).map((entry, index) => <tr key={`${entry.occurredAt}-${index}`}>
              <td>{when(entry.occurredAt)}</td>
              <td>{ACTION_LABELS[entry.action] ?? entry.action}</td>
              <td>{entry.actorName ?? '—'}</td>
              <td>{entry.reason ?? '—'}</td>
            </tr>)}
            {!(selected.history ?? []).length && <tr><td colSpan={4}>还没有处理记录。</td></tr>}
          </tbody>
        </table>
      </section>}
    </>}
  </main>;
}
