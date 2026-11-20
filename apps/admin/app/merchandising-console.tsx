"use client";
import { useEffect, useRef, useState } from 'react';

type Section = { sectionId: string; type: string; visible: boolean; position: number; titleByLocale: Record<string, string>;
  sortMode: string; limit: number; productIds: string[]; categoryIds: string[]; collectionId: string | null };
type Layout = { pageKey: string; kind: string; status: string; version: number; sections: Section[];
  published: { version: number; publishedAt: string | null } | null; publishedAt: string | null;
  versions: { version: number; publishedAt: string; note: string | null }[];
  issues: { sectionId: string; productId: string; reason: string }[]; updatedAt: string | null };
type PickProduct = { id: string; name: string; status: string; publishedAt: string | null; markets: string[];
  sellable: boolean; reasons: string[] };
type PickCategory = { id: string; name: string };
type PickCollection = { id: string; name: string };
type PageEntry = { pageKey: string; kind: string; targetId: string | null; name: string | null; status: string; version: number };
type Session = { permissionCodes: string[]; csrfToken: string };

const LOCALES = [['zh-CN', '简体'], ['zh-HK', '繁體'], ['en', 'English']] as const;
const SORT_MODES = [['manual', '手工顺序'], ['newest', '新品优先'], ['fulfilled_sales_30d', '近 30 天销量'],
  ['price_asc', '价格由低到高'], ['price_desc', '价格由高到低']] as const;
/** 页面选择器的显示名：首页固定，分类/专题用各自名称（没有就退回 id，不显示空白选项）。 */
const pageLabel = (entry: PageEntry) => entry.kind === 'home' ? '首页'
  : `${entry.kind === 'collection' ? '专题' : '分类'} · ${entry.name || entry.targetId || entry.pageKey}`;

/** 每个错误码都要能告诉运营「改哪里」，而不是只说保存失败。 */
const ERROR_TEXT: Record<string, string> = {
  MERCHANDISING_PAGE_UNKNOWN: '这个页面还没开放陈列配置（目前支持首页与分类页）。',
  MERCHANDISING_SECTION_UNSUPPORTED: '当前主题只注册了「商品网格」，其它区块需要定制开发。',
  MERCHANDISING_SECTION_DUPLICATE: '同一版面内区块 id 不能重复。',
  MERCHANDISING_SORT_UNSUPPORTED: '排序方式未实现，请从已提供的新品／销量／价格中选择。',
  MERCHANDISING_MODE_CONFLICT: '手工顺序与动态排序不能混用：动态区块请先清空手工商品清单。',
  MERCHANDISING_PRODUCT_DUPLICATE: '同一区块里不能重复添加同一个商品。',
  MERCHANDISING_LIMIT_UNREACHABLE: '手工区块的商品数量不能少于展示上限，否则区块永远填不满。',
  MERCHANDISING_LOCALE_INCOMPLETE: '发布前要补齐店铺已启用的每种语言的区块标题。',
  MERCHANDISING_NO_VISIBLE_SECTION: '至少需要一个可见区块才能发布，空版面不能上线。',
  MERCHANDISING_COLLECTION_OUT_OF_SCOPE: '专题版面只能筛本专题的商品；跨专题推荐请用首页版面。',
  MERCHANDISING_PRODUCT_INELIGIBLE: '有手工商品已下架、未发布或当前市场不可售，请先替换再发布。',
  MERCHANDISING_PRODUCT_OUT_OF_SCOPE: '分类版面只能选本分类的商品；跨分类推荐请用首页版面。',
  VERSION_CONFLICT: '版面已在别处修改，请刷新后重新编辑（避免覆盖别人的改动）。',
  VALIDATION_ERROR: '配置不符合规则：请检查标题长度、展示上限与商品清单。',
};

const REASON_TEXT: Record<string, string> = {
  PRODUCT_NOT_FOUND: '商品已不存在',
  PRODUCT_NOT_ACTIVE: '商品未上架',
  PRODUCT_NOT_PUBLISHED: '尚未到发布时间',
  PRODUCT_MARKET_INELIGIBLE: '当前市场不可售',
};

const emptySection = (index: number): Section => ({ sectionId: `grid-${index + 1}`, type: 'product_grid', visible: true,
  position: index, titleByLocale: {}, sortMode: 'newest', limit: 6, productIds: [], categoryIds: [], collectionId: null });

export function MerchandisingConsole() {
  const session = useRef<Session | null>(null);
  const [pageKey, setPageKey] = useState<string>('home');
  const [doc, setDoc] = useState<Layout | null>(null);
  const [products, setProducts] = useState<PickProduct[]>([]);
  const [categories, setCategories] = useState<PickCategory[]>([]);
  const [collections, setCollections] = useState<PickCollection[]>([]);
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [markup, setMarkup] = useState('');
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('內容調整');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const canWrite = permissions.includes('content.write'); const canPublish = permissions.includes('content.publish');

  async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = payload?.error?.code ?? '';
      if (ERROR_TEXT[code]) throw new Error(ERROR_TEXT[code]!);
      if (response.status === 403) throw new Error('当前账号没有执行此操作所需的权限。');
      if (response.status === 409) throw new Error(ERROR_TEXT['VERSION_CONFLICT']!);
      throw new Error('操作未完成，请检查配置后重试。');
    }
    return (await response.json()).data as T;
  }

  async function load(target = pageKey, search = query) {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (current.permissionCodes.includes('content.read')) {
      const layout = await request<Layout>(`merchandising/${target}`);
      setDoc(layout);
      setPageKey(target);
      // 分类/专题版面只列本范围商品：选不到范围外的，也就不会到保存时才被拒。
      const categoryId = target.startsWith('category:') ? target.slice('category:'.length) : null;
      const collectionId = target.startsWith('collection:') ? target.slice('collection:'.length) : null;
      // 选择器失败不该把整个控制台打空：没有候选就只能手填 id，页面其余部分仍然可用。
      const picked = await request<{ items: PickProduct[]; categories: PickCategory[]; collections?: PickCollection[] }>(
        `merchandising/products?limit=100${search ? `&q=${encodeURIComponent(search)}` : ''}`
        + `${categoryId ? `&categoryId=${encodeURIComponent(categoryId)}` : ''}`
        + `${collectionId ? `&collectionId=${encodeURIComponent(collectionId)}` : ''}`).catch(() => null);
      setProducts(picked?.items ?? []); setCategories(picked?.categories ?? []); setCollections(picked?.collections ?? []);
      const listing = await request<{ items: PageEntry[] }>('merchandising/pages').catch(() => null);
      setPages(listing?.items ?? [{ pageKey: 'home', kind: 'home', targetId: null, name: null, status: 'none', version: 0 }]);
    }
    setReady(true);
  }

  useEffect(() => { load().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);

  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '请求未完成。'); }
    finally { setBusy(false); }
  }

  function patchSection(index: number, change: Partial<Section> | ((current: Section) => Partial<Section>)) {
    setDoc(current => current ? { ...current, sections: current.sections.map((section, position) =>
      position === index ? { ...section, ...(typeof change === 'function' ? change(section) : change) } : section) } : current);
  }

  function move(index: number, delta: number) {
    setDoc(current => {
      if (!current) return current;
      const sections = [...current.sections];
      const target = index + delta;
      if (target < 0 || target >= sections.length) return current;
      [sections[index], sections[target]] = [sections[target]!, sections[index]!];
      return { ...current, sections: sections.map((section, position) => ({ ...section, position })) };
    });
  }

  function remove(index: number) {
    setDoc(current => current ? { ...current,
      sections: current.sections.filter((_, position) => position !== index).map((section, position) => ({ ...section, position })) }
      : current);
  }

  function addSection() {
    setDoc(current => current ? { ...current,
      sections: [...current.sections, emptySection(current.sections.length)] } : current);
  }

  async function save() {
    if (!doc) return;
    await run(async () => {
      const saved = await request<Layout>(`merchandising/${pageKey}`, 'PATCH',
        { expectedVersion: doc.version, sections: doc.sections });
      setDoc(saved); setNotice(`草稿已保存（版本 ${saved.version}）。线上页面仍是上一版，发布后才生效。`);
    });
  }

  async function publish() {
    if (!doc) return;
    await run(async () => {
      const result = await request<Layout & { releaseToken: string }>(`merchandising/${pageKey}/publish`, 'POST',
        { expectedVersion: doc.version });
      setDoc(result); setNotice(`已发布（版本 ${result.version}，内容标记 ${result.releaseToken}）。前台最多半分钟内更新。`);
    });
  }

  async function unpublish() {
    if (!doc) return;
    await run(async () => {
      const result = await request<Layout>(`merchandising/${pageKey}/unpublish`, 'POST',
        { expectedVersion: doc.version, reason: reason.trim() || '內容調整' });
      setDoc(result); setNotice('已撤下：前台回到主题默认陈列，草稿仍保留。');
    });
  }

  const issueFor = (productId: string) => doc?.issues.find(issue => issue.productId === productId)?.reason ?? null;

  return <main>
    <h1>页面陈列</h1>
    <nav><a href="/admin/content">内容页</a><a href="/admin/catalog">商品</a><a href="/admin/media">媒体库</a>
      <a href="/admin/theme">主题</a><a href="/admin/settings">店铺设置</a></nav>
    <p><small>陈列决定页面展示哪些商品、按什么顺序。首页、分类页与专题页各有一份版面：分类版面只能选本分类商品，专题版面只能选本专题商品，动态区块的候选也同样受限。保存只改草稿，发布后才对外生效，撤下会回到主题默认布局。</small></p>
    {!ready && <p>加载中…</p>}
    {ready && !permissions.includes('content.read') && <section><h2>没有内容读取权限</h2><p>请联系店主分配内容权限。</p></section>}
    {ready && permissions.includes('content.read') && <>
      <section aria-labelledby="layout-title"><h2 id="layout-title">版面</h2>
        <div className="permission-grid">
          <label>页面<select value={pageKey} onChange={event => { void load(event.target.value, query)
            .catch(caught => setError(caught.message)); }}>
            {pages.map(entry => <option key={entry.pageKey} value={entry.pageKey}>
              {pageLabel(entry)}{entry.status === 'none' ? '（未配置）' : ''}</option>)}</select></label>
          <label>状态<input readOnly value={doc ? `${doc.status === 'published' ? '已发布' : '草稿'} · 版本 ${doc.version}` : ''} /></label>
          <label>线上版本<input readOnly value={doc?.published
            ? `v${doc.published.version}${doc.published.publishedAt ? ` · ${doc.published.publishedAt.slice(0, 16).replace('T', ' ')}` : ''}`
            : '未发布（前台用主题默认布局）'} /></label>
        </div>
        {canWrite && <div className="actions"><button disabled={busy} onClick={() => void run(async () => { await save(); })}>保存草稿</button>
          {canPublish && <button className="secondary" disabled={busy || doc?.status !== 'draft' || !doc?.sections.length}
            onClick={() => void run(async () => { await publish(); })}>发布</button>}
          {canPublish && <button className="secondary" disabled={busy || doc?.status !== 'published'}
            onClick={() => void run(async () => { await unpublish(); })}>撤下</button>}
          <button type="button" className="secondary" disabled={busy} onClick={addSection}>新增商品网格</button></div>}
        {canPublish && doc?.status === 'published' && <p><small>撤下原因（会写进审计）
          <input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></small></p>}
        {doc && doc.sections.length === 0 && <p>还没有区块。新增一个商品网格并填好三语标题后才能发布。</p>}
      </section>

      {doc?.sections.map((section, index) => <section key={index} aria-labelledby={`section-${index}`}>
        <h2 id={`section-${index}`}>区块 {index + 1} · {section.sectionId}</h2>
        <div className="permission-grid">
          <label>区块 id<input value={section.sectionId} maxLength={64} readOnly={!canWrite}
            onChange={event => patchSection(index, { sectionId: event.target.value })} /></label>
          <label>显示<select value={section.visible ? 'yes' : 'no'} disabled={!canWrite}
            onChange={event => patchSection(index, { visible: event.target.value === 'yes' })}>
            <option value="yes">显示</option><option value="no">隐藏（保留配置）</option></select></label>
          <label>排序方式<select value={section.sortMode} disabled={!canWrite}
            onChange={event => { const sortMode = event.target.value;
              patchSection(index, sortMode === 'manual' ? { sortMode } : { sortMode, productIds: [] }); }}>
            {SORT_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>展示上限<input type="number" min={1} max={24} value={section.limit} disabled={!canWrite}
            onChange={event => patchSection(index, { limit: Number(event.target.value) || 1 })} /></label>
          {LOCALES.map(([locale, label]) => <label key={locale}>{label}标题
            <input value={section.titleByLocale[locale] ?? ''} maxLength={80} disabled={!canWrite}
              placeholder="发布前必须补齐三语"
              onChange={event => patchSection(index, current => ({
                titleByLocale: { ...current.titleByLocale, [locale]: event.target.value } }))} /></label>)}
        </div>
        <div className="actions">
          <button type="button" className="secondary" disabled={!canWrite || index === 0} onClick={() => move(index, -1)}>上移</button>
          <button type="button" className="secondary" disabled={!canWrite || index === doc.sections.length - 1}
            onClick={() => move(index, 1)}>下移</button>
          <button type="button" className="secondary" disabled={!canWrite} onClick={() => remove(index)}>删除区块</button>
        </div>
        {section.sortMode === 'manual'
          ? <ManualPicker section={section} products={products} query={query} setQuery={setQuery}
            onSearch={() => void load(pageKey, query).catch(caught => setError(caught.message))}
            issueFor={issueFor} disabled={!canWrite} onChange={ids => patchSection(index, { productIds: ids })} />
          : <DynamicScope section={section} categories={categories} collections={collections} disabled={!canWrite}
            lockedCollectionId={pageKey.startsWith('collection:') ? pageKey.slice('collection:'.length) : null}
            onChange={patch => patchSection(index, patch)} />}
      </section>)}
      {doc && doc.issues.length > 0 && <section aria-labelledby="issues-title"><h2 id="issues-title">需要修复</h2>
        <ul>{doc.issues.map(issue => <li key={`${issue.sectionId}:${issue.productId}`}>
          区块 {issue.sectionId} 的商品 {issue.productId}：{REASON_TEXT[issue.reason] ?? issue.reason}（前台已隐藏，请替换）
        </li>)}</ul></section>}
    </>}
    {markup && <pre>{markup}</pre>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </main>;
}

/** 手工区块：只能选手工商品；不可售商品作为禁选项展示原因，避免运营点了保存才被拒。 */
function ManualPicker({ section, products, query, setQuery, onSearch, issueFor, disabled, onChange }:
{ section: Section; products: PickProduct[]; query: string; setQuery: (value: string) => void; onSearch: () => void;
  issueFor: (productId: string) => string | null; disabled: boolean; onChange: (ids: string[]) => void }) {
  const toggle = (id: string) => onChange(section.productIds.includes(id)
    ? section.productIds.filter(item => item !== id) : [...section.productIds, id]);
  return <div>
    <p><small>勾选顺序就是首页展示顺序（上限 {section.limit} 件）；已下架/不可售商品不能选。</small></p>
    <div className="actions"><input value={query} placeholder="搜索商品名称" maxLength={200}
      onChange={event => setQuery(event.target.value)} /><button type="button" className="secondary" onClick={onSearch}>搜索</button></div>
    {section.productIds.length === 0 && <p>还没有选择商品。</p>}
    <ol>{section.productIds.map(id => {
      const product = products.find(item => item.id === id);
      const issue = issueFor(id);
      return <li key={id}>{product?.name ?? id}{issue ? ` · ${REASON_TEXT[issue] ?? issue}（前台已隐藏）` : ''}
        {!disabled && <button type="button" className="secondary" onClick={() => toggle(id)}>移除</button>}</li>;
    })}</ol>
    <ul>{products.map(product => <li key={product.id}>
      <label><input type="checkbox" checked={section.productIds.includes(product.id)} disabled={disabled || !product.sellable}
        onChange={() => toggle(product.id)} /> {product.name}
        <small>{product.markets.length ? ` · ${product.markets.join('/')}` : ' · 无可售市场'}</small>
        {!product.sellable && <small> · {product.reasons.map(reason => REASON_TEXT[reason] ?? reason).join('、')}</small>}
      </label>
    </li>)}</ul>
  </div>;
}

/**
 * 动态区块：分类/专题只是候选范围，商品资格与补足由服务端按规则实时决定。
 * 专题版面里候选已经锁死在本专题，不再显示范围选择器——再选别的专题只会得到空区块。
 */
function DynamicScope({ section, categories, collections, disabled, lockedCollectionId, onChange }:
{ section: Section; categories: PickCategory[]; collections: PickCollection[]; disabled: boolean;
  lockedCollectionId: string | null; onChange: (patch: Partial<Section>) => void }) {
  const toggle = (id: string) => onChange({ categoryIds: section.categoryIds.includes(id)
    ? section.categoryIds.filter(item => item !== id) : [...section.categoryIds, id] });
  if (lockedCollectionId) {
    return <div><p><small>候选范围已限定在本专题：动态区块只会在本专题商品里排序与补足。</small></p></div>;
  }
  return <div>
    <p><small>候选范围（不选 = 全店可售商品）。资格不合格的商品会被排除，并由后续合格商品补足展示数量。</small></p>
    <label>限定专题<select value={section.collectionId ?? ''} disabled={disabled}
      onChange={event => onChange({ collectionId: event.target.value || null })}>
      <option value="">不限专题</option>
      {collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
    </select></label>
    <ul>{categories.map(category => <li key={category.id}>
      <label><input type="checkbox" checked={section.categoryIds.includes(category.id)} disabled={disabled}
        onChange={() => toggle(category.id)} /> {category.name}</label>
    </li>)}</ul>
    {categories.length === 0 && <p>还没有启用中的分类。</p>}
  </div>;
}
