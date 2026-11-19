"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Translation = { locale: string; title: string; slug: string; seoTitle: string | null; seoDescription: string | null;
  indexable: boolean; publishedSlug: string | null };
type Block = { id: string; type: string; visible: boolean; position: number; config: Record<string, unknown> };
type Version = { version: number; status: string; publishedAt: string; note: string | null; releaseSeq: number };
type PageDoc = { id: string; pageKey: string; pageType: string; status: string; position: number; scheduledAt: string | null;
  publishedAt: string | null; version: number; translations: Translation[]; blocks: Block[]; versions: Version[];
  contentRelease: string | null };
type RedirectDoc = { id: string; locale: string; fromPath: string; toPath: string; statusCode: number;
  pageKey: string | null; auto: boolean; createdAt: string };
type PreviewLink = { pageKey: string; path: string; expiresAt: string };
type Session = { permissionCodes: string[]; csrfToken: string };
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

const LOCALES = [['zh-CN', '简体'], ['zh-HK', '繁體'], ['en', 'English']] as const;
const PAGE_TYPES = [['standard', '标准内容页'], ['article', '文章'], ['policy', '政策／条款'], ['faq', '常见问题'], ['announcement', '公告']] as const;
const BLOCK_TYPES = [['rich_text', '段落文本'], ['faq_list', '问答列表'], ['contact_card', '联系方式卡'], ['notice', '提示条']] as const;
const STATUS: Record<string, string> = { draft: '草稿', scheduled: '已定时', published: '已发布', withdrawn: '已撤下' };
const SAMPLE = `[
  {
    "id": "intro",
    "type": "rich_text",
    "visible": true,
    "position": 0,
    "config": {
      "heading": "關於我們",
      "paragraphs": ["第一段內容。", "第二段內容。"],
      "footnote": null
    }
  }
]`;

/** 错误码 → 可执行的修复提示：后台要告诉运营「改哪里」，而不是只说请求失败。 */
const ERROR_TEXT: Record<string, string> = {
  CONTENT_LOCALE_INCOMPLETE: '发布前必须补齐店铺已启用的全部语言（标题与 slug 都要填）。',
  CONTENT_NO_VISIBLE_BLOCK: '至少需要一个可见区块才能发布，空页面不能上线。',
  CONTENT_BLOCK_UNSUPPORTED: '区块类型未在本实例注册，请改用段落文本／问答列表／联系方式卡／提示条。',
  CONTENT_BLOCK_DUPLICATE: '同一页面内区块 id 不能重复。',
  CONTENT_SCHEDULE_IN_PAST: '定时发布时间必须晚于现在（以服务端时间为准）。',
  CONTENT_SCHEDULE_TOO_FAR: '定时发布时间不能超过一年。',
  SLUG_TAKEN: '这个 slug 已被其他页面占用（同语言内地址唯一），请换一个。',
  VERSION_CONFLICT: '页面已在别处修改，请刷新后重新编辑。',
  STATE_CONFLICT: '页面状态已变化（例如已撤下），请刷新后再试。',
  REDIRECT_SELF: '旧地址与目标地址相同，这条重定向没有意义。',
  REDIRECT_LOOP: '这条重定向会让访问在两地址间来回跳（形成循环），请改成最终地址。',
  REDIRECT_SHADOWS_PAGE: '该地址正在线上使用，不能被重定向挡住；要调整内容请直接编辑页面。',
  REDIRECT_EXISTS: '该旧地址已经登记过重定向，请先删除原记录。',
};

export function ContentConsole() {
  const session = useRef<Session | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [pages, setPages] = useState<PageDoc[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<PageDoc | null>(null);
  const [blocksText, setBlocksText] = useState('[]'); const [preview, setPreview] = useState<Block[] | null>(null);
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [redirects, setRedirects] = useState<RedirectDoc[]>([]);
  const [previewLink, setPreviewLink] = useState<PreviewLink | null>(null);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const canWrite = permissions.includes('content.write'); const canPublish = permissions.includes('content.publish');

  async function request<T>(path: string, method = 'GET', body?: object, version?: number): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
      ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (response.status === 204) return undefined as T;
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = body?.error?.code ?? '';
      if (ERROR_TEXT[code]) throw new Error(ERROR_TEXT[code]!);
      if (response.status === 403) throw new Error('当前账号没有执行此操作所需的权限。');
      if (response.status === 429) throw new Error('操作过于频繁，请稍后重试。');
      if (response.status === 422) throw new Error('内容不符合发布规则：请检查标题、slug（小写字母与短横线）与区块配置。');
      throw new Error('操作未完成，请检查填写内容后重试。');
    }
    return (await response.json()).data as T;
  }

  async function reload() {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (current.permissionCodes.includes('content.read')) {
      const page = await request<Page<PageDoc>>('pages?limit=25');
      setPages(page.items); setCursor(page.nextCursor);
      // 接口比界面旧（或权限只到内容）时不该让整个控制台崩掉：取不到就当没有重定向。
      const list = await request<Page<RedirectDoc> | null>('redirects?limit=50').catch(() => null);
      setRedirects(list?.items ?? []);
    }
    setReady(true);
  }
  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);

  async function run(action: () => Promise<void>, refresh = true) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); if (refresh) await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  function startEdit(page: PageDoc) {
    setEditing(page); setBlocksText(JSON.stringify(page.blocks, null, 2)); setPreview(null); setNotice('');
  }

  function payload(form: HTMLFormElement, existing?: PageDoc) {
    const values = new FormData(form);
    const translations = LOCALES.map(([locale]) => ({
      locale,
      title: String(values.get(`title:${locale}`) ?? '').trim(),
      slug: String(values.get(`slug:${locale}`) ?? '').trim(),
      seoTitle: String(values.get(`seoTitle:${locale}`) ?? '').trim() || null,
      seoDescription: String(values.get(`seoDescription:${locale}`) ?? '').trim() || null,
      indexable: values.get(`indexable:${locale}`) === 'on',
    })).filter(item => item.title && item.slug);
    const blocks = JSON.parse(blocksText) as Block[];
    const base = { pageType: String(values.get('pageType') ?? 'standard'), translations, blocks };
    return existing ? base : { ...base, pageKey: String(values.get('pageKey') ?? '').trim() };
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    void run(async () => {
      await request('pages', 'POST', payload(form)); form.reset(); setBlocksText('[]');
      setNotice('草稿已建立。补齐三语内容后即可发布。');
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return;
    void run(async () => {
      await request(`pages/${editing.id}`, 'PATCH', payload(event.currentTarget, editing), editing.version);
      setEditing(null); setNotice('已保存为新草稿版本；线上内容未变。');
    });
  }

  function publish(page: PageDoc) {
    void run(async () => {
      const result = await request<{ scheduled: boolean }>(`pages/${page.id}/publish`, 'POST', { expectedVersion: page.version, mode: 'immediate' });
      setNotice(result.scheduled ? '已登记定时发布计划。' : '已发布：前台立即切到新版本。');
    });
  }

  function schedule(page: PageDoc) {
    const value = prompt('定时发布时间（本地时间，例如 2026-11-20 09:00）'); if (!value) return;
    const at = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(at.getTime())) { setError('时间格式无法识别，请用 2026-11-20 09:00 这样的写法。'); return; }
    void run(async () => {
      await request(`pages/${page.id}/publish`, 'POST', { expectedVersion: page.version, mode: 'scheduled', scheduledAt: at.toISOString() });
      setNotice('已登记定时发布：到点由后台任务切换线上版本，失败会保留原版本并记录原因。');
    });
  }

  function unpublish(page: PageDoc) {
    const reason = prompt('撤下原因（会写入审计记录）'); if (!reason) return;
    void run(async () => { await request(`pages/${page.id}/unpublish`, 'POST', { reason }); setNotice('页面已撤下，公开地址立即失效。'); });
  }

  function rollback(page: PageDoc) {
    const source = prompt('回滚到哪个已发布版本号？（见版本历史）'); if (!source) return;
    const reason = prompt('回滚原因（会写入审计记录）'); if (!reason) return;
    void run(async () => {
      await request(`pages/${page.id}/rollback`, 'POST', { sourceVersion: Number(source), reason, expectedVersion: page.version });
      setNotice('已用旧快照建立新版本，草稿同时恢复为该内容。');
    });
  }

  /** 预览外链：绑定当前草稿版本与选定视口，链接短期有效（默认 60 分钟）。 */
  function issuePreview(page: PageDoc) {
    const locale = page.translations.some(item => item.locale === 'zh-HK') ? 'zh-HK'
      : (page.translations[0]?.locale ?? 'zh-HK');
    void run(async () => {
      const link = await request<{ path: string; expiresAt: string }>(`pages/${page.id}/preview-token`, 'POST',
        { locale, viewport, expectedVersion: page.version });
      setPreviewLink({ pageKey: page.pageKey, path: link.path, expiresAt: link.expiresAt });
      setNotice('预览链接已生成：链接短期有效，过期后需要重新生成。');
    }, false);
  }

  function createRedirect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    void run(async () => {
      await request('redirects', 'POST', {
        locale: String(values.get('locale') ?? 'zh-HK'),
        fromPath: String(values.get('fromPath') ?? '').trim(),
        toPath: String(values.get('toPath') ?? '').trim(),
      });
      form.reset(); setNotice('重定向已登记：旧地址会 301 到新地址。');
    });
  }

  function removeRedirect(doc: RedirectDoc) {
    void run(async () => { await request(`redirects/${doc.id}`, 'DELETE'); setNotice('重定向已删除，旧地址将按 404 处理。'); });
  }

  function showPreview() {
    try { setPreview(JSON.parse(blocksText) as Block[]); setError(''); }
    catch { setError('区块 JSON 无法解析，请先修正格式再预览。'); }
  }

  const fields = (page?: PageDoc) => <>
    {!page && <label>页面键（小写字母与短横线，发布后不改）<input name="pageKey" required placeholder="about" maxLength={64} /></label>}
    <label>页面类型<select name="pageType" defaultValue={page?.pageType ?? 'standard'}>
      {PAGE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {LOCALES.map(([locale, label]) => {
      const translation = page?.translations.find(item => item.locale === locale);
      return <fieldset key={locale}><legend>{label}</legend>
        <label>标题<input name={`title:${locale}`} defaultValue={translation?.title ?? ''} maxLength={200} /></label>
        <label>slug<input name={`slug:${locale}`} defaultValue={translation?.slug ?? ''} maxLength={180} /></label>
        <label>SEO 标题（≤70）<input name={`seoTitle:${locale}`} defaultValue={translation?.seoTitle ?? ''} maxLength={70} /></label>
        <label>SEO 描述（≤320）<textarea name={`seoDescription:${locale}`} defaultValue={translation?.seoDescription ?? ''} maxLength={320} rows={2} /></label>
        <label className="check"><input type="checkbox" name={`indexable:${locale}`} defaultChecked={translation?.indexable ?? false} />允许搜索引擎收录</label>
      </fieldset>;
    })}
    <label>区块（JSON 数组：id / type / visible / position / config）
      <textarea name="blocks" rows={12} value={blocksText} onChange={event => setBlocksText(event.target.value)} />
    </label>
    <p><small>支持类型：{BLOCK_TYPES.map(([, label]) => label).join('、')}。未注册的类型会被服务端拒绝，不会静默失效。</small></p>
    <button type="button" className="secondary" onClick={() => setBlocksText(SAMPLE)}>填入示例区块</button>
    <button type="button" className="secondary" onClick={showPreview}>预览区块</button>
  </>;

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">内容管理</p><h1>内容页与发布版本</h1></div><div className="actions">
      <a href="/admin/catalog">商品目录</a><a href="/admin/media">媒体库</a><a href="/admin/reports">报表</a><a href="/admin/settings">店铺设置</a>
      <button disabled={busy} onClick={() => void run(async () => { setEditing(null); })}>刷新内容</button></div></header>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!ready && !error && <p>正在检查会话与权限…</p>}
    {ready && !permissions.includes('content.read') && <section><h2>没有内容读取权限</h2><p>请联系店主分配内容权限。</p></section>}
    {permissions.includes('content.read') && <>
      <section aria-labelledby="pages-title"><h2 id="pages-title">内容页</h2>
        {pages.length === 0 && <p>尚无内容页。</p>}
        {pages.map(page => <article key={page.id}>
          <h3>{page.translations.find(item => item.locale === 'zh-HK')?.title ?? page.pageKey}
            <span className="preset">{STATUS[page.status] ?? page.status}</span></h3>
          <p>{page.pageKey} · {PAGE_TYPES.find(([value]) => value === page.pageType)?.[1] ?? page.pageType} · 版本 {page.version}
            {page.contentRelease ? ` · 内容发布 ${page.contentRelease}` : ' · 尚未发布'}</p>
          <small>{page.translations.map(item => `${item.locale}: ${item.publishedSlug ?? item.slug}`).join(' · ')}</small>
          {page.versions.length > 0 && <small>版本历史：{page.versions.slice(0, 5).map(item => `v${item.version}(${item.status})`).join('、')}</small>}
          <div className="actions">
            {canWrite && <button disabled={busy} onClick={() => startEdit(page)}>编辑 {page.pageKey}</button>}
            {permissions.includes('content.preview') && <button className="secondary" disabled={busy} onClick={() => issuePreview(page)}>预览链接</button>}
            {canPublish && <button disabled={busy} onClick={() => publish(page)}>发布 {page.pageKey}</button>}
            {canPublish && <button className="secondary" disabled={busy} onClick={() => schedule(page)}>定时发布</button>}
            {canPublish && page.status === 'published' && <button className="secondary" disabled={busy} onClick={() => unpublish(page)}>撤下</button>}
            {canPublish && page.versions.length > 1 && <button className="secondary" disabled={busy} onClick={() => rollback(page)}>回滚</button>}
          </div>
        </article>)}
        {cursor && <button disabled={busy} onClick={() => void run(async () => {
          const page = await request<Page<PageDoc>>(`pages?limit=25&cursor=${cursor}`);
          setPages(previous => [...previous, ...page.items]); setCursor(page.nextCursor); }, false)}>加载更多</button>}
      </section>
      {canWrite && <section aria-labelledby="create-title"><h2 id="create-title">新建内容页草稿</h2>
        <form onSubmit={create}><div className="permission-grid">{fields()}</div>
          <button disabled={busy}>保存草稿</button></form></section>}
      {editing && canWrite && <section aria-labelledby="edit-title"><h2 id="edit-title">编辑 {editing.pageKey}</h2>
        <form key={`${editing.id}:${editing.version}`} onSubmit={save}><div className="permission-grid">{fields(editing)}</div>
          <p><small>当前版本 {editing.version}。保存只改草稿，线上内容要等你发布才会变。</small></p>
          <button disabled={busy}>保存页面</button>
          <button type="button" className="secondary" onClick={() => setEditing(null)}>取消编辑</button></form></section>}
      {previewLink && <section aria-labelledby="link-title"><h2 id="link-title">预览链接 · {previewLink.pageKey}</h2>
        <p><a href={previewLink.path} target="_blank" rel="noreferrer">{previewLink.path}</a></p>
        <p><small>到期时间 {new Date(previewLink.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC ·
          页面为 noindex 且不写入任何埋点；手机／桌面版在生成时决定。</small></p>
        <button type="button" className="secondary" onClick={() => { void navigator.clipboard?.writeText(location.origin + previewLink.path); setNotice('链接已复制。'); }}>复制链接</button>
        <button type="button" className="secondary" onClick={() => setPreviewLink(null)}>收起</button>
      </section>}
      <section aria-labelledby="redirect-title"><h2 id="redirect-title">URL 重定向</h2>
        <p><small>改过已发布页面的 slug 后，旧地址会自动登记 301；这里可以复核、补登记或删除。只接受站内路径。</small></p>
        {redirects.length === 0 && <p>尚无重定向。</p>}
        {redirects.map(doc => <article key={doc.id}>
          <h3>{doc.fromPath} → {doc.toPath}<span className="preset">{doc.statusCode}{doc.auto ? ' · 自动' : ''}</span></h3>
          <small>{doc.locale}{doc.pageKey ? ` · 来源页面 ${doc.pageKey}` : ''}</small>
          {canPublish && <div className="actions"><button className="secondary" disabled={busy} onClick={() => removeRedirect(doc)}>删除</button></div>}
        </article>)}
        {canPublish && <form onSubmit={createRedirect}><div className="permission-grid">
          <label>语言<select name="locale" defaultValue="zh-HK">{LOCALES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>旧地址<input name="fromPath" required placeholder="/zh-HK/pages/old-about" maxLength={300} /></label>
          <label>新地址<input name="toPath" required placeholder="/zh-HK/pages/about" maxLength={300} /></label>
        </div><button disabled={busy}>登记重定向</button></form>}
      </section>
      {preview && <section aria-labelledby="preview-title"><h2 id="preview-title">草稿预览</h2>
        <div className="actions"><button type="button" className="secondary" onClick={() => setViewport('desktop')}>桌面</button>
          <button type="button" className="secondary" onClick={() => setViewport('mobile')}>手机</button></div>
        <div className="content-preview" style={{ maxWidth: viewport === 'mobile' ? 380 : undefined }}>
          {preview.filter(block => block.visible).map(block => <PreviewBlock key={block.id} block={block} />)}
          {preview.filter(block => block.visible).length === 0 && <p>没有可见区块。</p>}
        </div>
        <p><small>预览只渲染当前草稿；未发布的草稿不会出现在公开地址，也不会被搜索收录。</small></p>
      </section>}
    </>}
  </main>;
}

/** 预览只做「内容长什么样」的近似：文本块原样输出，不做 HTML 解析（配置里也不允许 HTML）。 */
function PreviewBlock({ block }: { block: Block }) {
  const config = block.config as Record<string, unknown>;
  if (block.type === 'rich_text') return <article>
    {typeof config['heading'] === 'string' && <h3>{config['heading']}</h3>}
    {(config['paragraphs'] as string[] | undefined)?.map((text, index) => <p key={index}>{text}</p>)}
  </article>;
  if (block.type === 'faq_list') return <article>{(config['items'] as { question: string; answer: string }[] | undefined)
    ?.map((item, index) => <p key={index}><strong>{item.question}</strong><br />{item.answer}</p>)}</article>;
  if (block.type === 'contact_card') return <article>
    {typeof config['heading'] === 'string' && <h3>{config['heading']}</h3>}
    {typeof config['body'] === 'string' && <p>{config['body']}</p>}
    {typeof config['email'] === 'string' && <p>{config['email']}</p>}
    {config['showWhatsApp'] === true && <p>WhatsApp 联络</p>}
  </article>;
  if (block.type === 'notice') return <p className={`notice ${String(config['tone'])}`}>{String(config['text'] ?? '')}</p>;
  return <p>未注册的区块类型：{block.type}</p>;
}
