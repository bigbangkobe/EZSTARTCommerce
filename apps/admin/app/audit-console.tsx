"use client";
import { useEffect, useRef, useState } from 'react';
type Entry = { id: string; actorId: string | null; action: string; objectId: string | null; result: string; requestId: string; reason: string | null; occurredAt: string };
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
type Session = { user: { id: string }; permissionCodes: string[]; csrfToken: string };
export function AuditConsole() {
  const session = useRef<Session | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false);
  const [error, setError] = useState(''); const [forbidden, setForbidden] = useState(false);
  async function request<T>(path: string): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (response.status === 403) { setForbidden(true); throw new Error(''); }
    if (!response.ok) throw new Error('审计记录加载失败，请稍后重试。');
    return (await response.json()).data;
  }
  async function load(reset: boolean) {
    setBusy(true); setError('');
    try {
      if (!session.current) session.current = await request<Session>('auth/session');
      if (!session.current.permissionCodes.includes('audit.read')) { setForbidden(true); return; }
      const page = await request<Page<Entry>>(`audit-logs?limit=25${!reset && cursor ? `&cursor=${cursor}` : ''}`);
      setEntries(previous => reset ? page.items : [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '审计记录加载失败。'); }
    finally { setBusy(false); setReady(true); }
  }
  useEffect(() => { void load(true); }, []);
  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">店铺管理</p><h1>审计记录</h1></div><button disabled={busy} onClick={() => void load(true)}>刷新记录</button></header>
    <p>审计记录由系统追加写入，任何人不能在此编辑或删除；页面只读取与本实例相关的操作轨迹。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!ready && !error && <p>正在检查会话与权限…</p>}
    {forbidden && <section><h2>没有读取权限</h2><p>审计记录仅对获授权的审计角色开放，请联系店主。</p></section>}
    {ready && !forbidden && entries.length === 0 && <section><h2>暂无记录</h2><p>该实例还没有产生可读取的审计事件。</p></section>}
    {!forbidden && entries.length > 0 && <section aria-labelledby="audit-title"><h2 id="audit-title">最近事件</h2>
      {entries.map(entry => <article key={entry.id}>
        <h3>{entry.action}</h3>
        <p>{new Date(entry.occurredAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · 结果：{entry.result}</p>
        <small>操作者：{entry.actorId ?? '未认证'} · 对象：{entry.objectId ?? '—'} · 请求：{entry.requestId}{entry.reason ? ` · 说明：${entry.reason}` : ''}</small>
      </article>)}
      {cursor && <button disabled={busy} onClick={() => void load(false)}>加载更多记录</button>}
    </section>}
    <p><a href="/admin/access">返回员工与角色</a></p>
  </main>;
}
