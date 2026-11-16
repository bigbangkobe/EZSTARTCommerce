"use client";
import { useEffect, useRef, useState } from 'react';

type Media = { id: string; objectKey: string; contentType: string; sizeBytes: number; sha256: string | null;
  width: number | null; height: number | null; originalFileName: string; status: 'pending' | 'ready';
  url: string | null; createdAt: string; updatedAt: string };
type Session = { permissionCodes: string[]; csrfToken: string };
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
type Target = { mediaId: string; objectKey: string; uploadUrl: string; method: 'PUT'; headers: Record<string, string>;
  expiresAt: string; maxSizeBytes: number };

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

/** 摘要在浏览器本地算，服务端会再算一遍：这个值只用来让“确认”请求可被校验。 */
async function sha256(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

export function MediaConsole() {
  const session = useRef<Session | null>(null); const [permissions, setPermissions] = useState<string[]>([]);
  const [items, setItems] = useState<Media[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState('');
  const canManage = permissions.includes('media.manage');

  async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      if (response.status === 403) throw new Error('当前账号没有执行此操作所需的权限。');
      if (response.status === 409) throw new Error('该媒体已完成上传，无需重复确认。');
      if (response.status === 413) throw new Error('文件超过 10 MB 上限。');
      if (response.status === 422) throw new Error('文件不符合要求：只接受 JPEG/PNG/WebP 图片，且需与声明的类型一致。');
      if (response.status === 429) throw new Error('操作过于频繁，请稍后重试。');
      throw new Error('操作未完成，请稍后重试。');
    }
    return (await response.json()).data as T;
  }

  async function reload() {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (current.permissionCodes.includes('media.manage')) {
      const page = await request<Page<Media>>('media?limit=24');
      setItems(page.items); setCursor(page.nextCursor);
    }
    setReady(true);
  }
  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);

  async function loadMore() {
    if (!cursor) return;
    const page = await request<Page<Media>>(`media?limit=24&cursor=${encodeURIComponent(cursor)}`);
    setItems(current => [...current, ...page.items]); setCursor(page.nextCursor);
  }

  async function upload(file: File) {
    if (!ACCEPTED.includes(file.type)) throw new Error('只接受 JPEG、PNG 或 WebP 图片。');
    if (file.size > MAX_BYTES) throw new Error('文件超过 10 MB 上限。');
    setProgress('正在申请上传目标…');
    const target = await request<Target>('media/upload-target', 'POST', { fileName: file.name, contentType: file.type, sizeBytes: file.size });
    setProgress('正在上传字节…');
    const sent = await fetch(target.uploadUrl, { method: target.method, headers: target.headers, body: file });
    if (!sent.ok) throw new Error(`上传失败（${sent.status}）；请重新选择文件。`);
    setProgress('正在由服务端校验摘要与尺寸…');
    const done = await request<Media>('media/complete', 'POST', { objectKey: target.objectKey, sha256: await sha256(file) });
    return done;
  }

  async function run(action: () => Promise<void>, refresh = true) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); if (refresh) await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); setProgress(''); }
  }

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">商品管理</p><h1>媒体库</h1></div><div className="actions">
      <a href="/admin/catalog">商品目录</a><a href="/admin/orders">订单</a><a href="/admin/shipping">配送与结账</a><a href="/admin/payments">付款</a><a href="/admin/inventory">库存</a><a href="/admin/aftersales">售后</a><a href="/admin/coupons">优惠券</a><a href="/admin/settings">店铺设置</a>
      <button disabled={busy} onClick={() => void run(async () => {})}>刷新媒体库</button></div></header>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!ready && !error && <p>正在检查会话与权限…</p>}
    {ready && !canManage && <section><h2>没有媒体管理权限</h2><p>上传与查看媒体库需要 media.manage 权限，请联系店主。</p></section>}
    {canManage && <>
      <section aria-labelledby="upload-title"><h2 id="upload-title">上传图片</h2>
        <p>支持 JPEG、PNG、WebP，单文件不超过 10 MB。上传完成后把媒体 ID 填进商品的图片字段即可引用。</p>
        <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget;
          const file = new FormData(form).get('file');
          if (!(file instanceof File) || file.size === 0) { setError('请选择一张图片。'); return; }
          void run(async () => {
            const done = await upload(file);
            setNotice(`已入库：${done.originalFileName}（${done.width}×${done.height}，${size(done.sizeBytes)}）。媒体 ID：${done.id}`);
            form.reset();
          }); }}>
          <label>图片文件<input name="file" type="file" accept={ACCEPTED.join(',')} required /></label>
          <button disabled={busy} type="submit">{busy ? '正在上传…' : '上传'}</button>
          {progress && <small role="status">{progress}</small>}
        </form>
      </section>
      <section aria-labelledby="library-title"><h2 id="library-title">已上传媒体</h2>
        {items.length === 0 && <p>还没有上传任何图片。</p>}
        {items.map(item => <article key={item.id}>
          <h3>{item.originalFileName}</h3>
          {item.url ? <img src={item.url} alt={item.originalFileName} width={160} height={120}
            style={{ objectFit: 'contain', background: '#f3f5f8', borderRadius: 8 }} /> : <p><small>尚未确认，暂无预览。</small></p>}
          <p><small>{item.contentType} · {item.width && item.height ? `${item.width}×${item.height}` : '尺寸未知'} · {size(item.sizeBytes)} · {item.status === 'ready' ? '已入库' : '待确认'}</small></p>
          <p><small>媒体 ID：<code>{item.id}</code></small></p>
          <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
              await navigator.clipboard.writeText(item.id); setNotice('媒体 ID 已复制，可粘贴到商品或品牌表单。');
            }, false)}>复制 ID</button>
          </div>
        </article>)}
        {cursor && <button type="button" className="secondary" disabled={busy} onClick={() => void run(loadMore, false)}>加载更多</button>}
      </section>
    </>}
  </main>;
}
