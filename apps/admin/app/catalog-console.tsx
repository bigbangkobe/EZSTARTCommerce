"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Variant = { id: string; sku: string; optionValues: Record<string, string>; priceMinor: number; compareAtMinor: number | null;
  currency: string; status: string; onHand: number; reserved: number; available: number };
type Translation = { locale: string; name: string; slug: string | null; shortDescription: string | null; description: string | null;
  seoTitle: string | null; seoDescription: string | null };
type Product = { id: string; baseSku: string | null; brandId: string | null; categoryIds: string[]; marketCodes: string[]; status: string;
  translations: Translation[]; variants: Variant[]; media: { mediaId: string; position: number }[]; version: number; createdAt: string; updatedAt: string };
type Label = { id: string; parentId: string | null; position: number; enabled: boolean; version: number;
  translations: { locale: string; name: string; slug: string | null }[] };
type Brand = { id: string; logoMediaId: string | null; enabled: boolean; version: number; translations: { locale: string; name: string; slug: string | null }[] };
type Collection = { id: string; position: number; enabled: boolean; version: number; productIds: string[]; productCount: number;
  translations: { locale: string; name: string; slug: string | null; description: string | null }[] };
type Session = { permissionCodes: string[]; csrfToken: string };
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

const LOCALES = [['zh-CN', '简体'], ['zh-HK', '繁體'], ['en', 'English']] as const;
const nameOf = (labels: { locale: string; name: string }[], locale: 'zh-CN' | 'zh-HK' | 'en') =>
  labels.find(item => item.locale === locale)?.name ?? labels[0]?.name ?? '未命名';

export function CatalogConsole() {
  const session = useRef<Session | null>(null); const [permissions, setPermissions] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [categories, setCategories] = useState<Label[]>([]); const [brands, setBrands] = useState<Brand[]>([]);
  const [editing, setEditing] = useState<Product | null>(null); const [query, setQuery] = useState('');
  const [editingCategory, setEditingCategory] = useState<Label | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
  // 专题商品按运营排的顺序保存：界面上的顺序即前台顺序，不额外提供「排序号」字段。
  const [collectionProducts, setCollectionProducts] = useState<Product[]>([]);
  const [pickQuery, setPickQuery] = useState(''); const [pickResults, setPickResults] = useState<Product[]>([]);
  const [variantRows, setVariantRows] = useState(1);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const canWrite = permissions.includes('catalog.write'); const canPublish = permissions.includes('catalog.publish');
  // 商品索引：专题里已选的商品可能不在当前列表页，用它把 id 还原成名称。
  const [productIndex, setProductIndex] = useState<Map<string, Product>>(new Map());

  async function request<T>(path: string, method = 'GET', body?: object, version?: number): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
      ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      if (response.status === 409) throw new Error('资料已变化或 SKU/slug 已被占用，请刷新后核对再试。');
      if (response.status === 403) throw new Error('当前账号没有执行此操作所需的权限。');
      if (response.status === 422) throw new Error('内容不符合发布规则：三语名称与 slug 必须齐全、币种须为店铺本位币、市场须已审核并启用。');
      if (response.status === 429) throw new Error('操作过于频繁，请稍后重试。');
      throw new Error('操作未完成，请检查填写内容后重试。');
    }
    return (await response.json()).data as T;
  }

  async function reload() {
    const current = await request<Session>('auth/session');
    session.current = { permissionCodes: current.permissionCodes, csrfToken: current.csrfToken };
    setPermissions(current.permissionCodes);
    if (current.permissionCodes.includes('catalog.read')) {
      const page = await request<Page<Product>>('products?limit=25');
      setProducts(page.items); setCursor(page.nextCursor);
      setCategories((await request<{ items: Label[] }>('categories')).items);
      setBrands((await request<{ items: Brand[] }>('brands')).items);
      setCollections((await request<{ items: Collection[] }>('collections')).items);
      // 专题编辑器要用名称显示已选商品：先取一页商品建立索引，选不到时退回 id。
      const index = await request<Page<Product>>('products?limit=100');
      setProductIndex(new Map(index.items.map(item => [item.id, item])));
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

  function payload(form: HTMLFormElement, existing?: Product) {
    const values = new FormData(form);
    const translations = LOCALES.map(([locale]) => ({ locale, name: String(values.get(`name:${locale}`) ?? '').trim(),
      slug: String(values.get(`slug:${locale}`) ?? '').trim() })).filter(item => item.name && item.slug);
    const variants = Array.from({ length: variantRows }, (_unused, index) => {
      const sku = String(values.get(`sku:${index}`) ?? '').trim(); if (!sku) return null;
      const options = String(values.get(`options:${index}`) ?? '').split(',').map(pair => pair.split('=').map(part => part.trim()))
        .filter(pair => pair.length === 2 && pair[0] && pair[1]);
      return { sku, optionValues: Object.fromEntries(options), priceMinor: Number(values.get(`price:${index}`) ?? 0),
        currency: String(values.get('currency') ?? '').trim().toUpperCase(), status: 'active' as const };
    }).filter(item => item !== null);
    const marketCodes = String(values.get('marketCodes') ?? '').split(',').map(code => code.trim()).filter(Boolean);
    return { baseSku: String(values.get('baseSku') ?? '').trim() || null, categoryIds: values.getAll('categoryIds').map(String),
      ...(marketCodes.length ? { marketCodes } : {}), translations,
      // 编辑时不提交规格：规格编辑缺少安全的库存语义，先保持只读，避免误删有库存的规格。
      ...(existing ? {} : { variants }) };
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    void run(async () => { await request('products', 'POST', payload(form)); form.reset(); setVariantRows(1);
      setNotice('草稿已建立；补齐三语内容并确认市场后再发布。'); });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return; const form = event.currentTarget;
    void run(async () => { await request(`products/${editing.id}`, 'PATCH', payload(form, editing), editing.version);
      setEditing(null); setNotice('商品已保存，版本已递增。'); });
  }

  function publish(product: Product) {
    void run(async () => { await request(`products/${product.id}/publish`, 'POST', { expectedVersion: product.version, marketCodes: product.marketCodes });
      setNotice('商品已发布到指定市场。'); });
  }

  function unpublish(product: Product) {
    const reason = prompt('撤下原因（会写入审计记录）'); if (!reason) return;
    void run(async () => { await request(`products/${product.id}/unpublish`, 'POST', { reason });
      setNotice('商品已下架，前台立即不可购买。'); });
  }

  /**
   * 分类编辑：slug 是前台分类页地址（/categories/<slug>）的唯一来源。
   * 没有 slug 的分类前台不列出——所以这里把三种语言的名称与 slug 放在同一张表里，
   * 运营保存时能直接看出「哪一门语言还没有地址」。
   */
  function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingCategory) return;
    const form = event.currentTarget; const values = new FormData(form);
    const translations = LOCALES.map(([locale]) => {
      const name = String(values.get(`cat-name:${locale}`) ?? '').trim();
      const slug = String(values.get(`cat-slug:${locale}`) ?? '').trim();
      return name ? { locale, name, ...(slug ? { slug } : {}) } : null;
    }).filter(item => item !== null);
    const position = Number(values.get('cat-position') ?? editingCategory.position);
    void run(async () => {
      await request(`categories/${editingCategory.id}`, 'PATCH', { parentId: editingCategory.parentId,
        position: Number.isFinite(position) && position >= 0 ? position : editingCategory.position,
        enabled: values.get('cat-enabled') === 'yes', translations }, editingCategory.version);
      setEditingCategory(null); setNotice('分类已更新；前台分类页与站点地图最多半分钟内生效。');
    });
  }

  /** 打开专题编辑器：按已保存的顺序还原商品行，缺索引的退化为 id（保存时仍按 id 提交）。 */
  function openCollection(collection: Collection) {
    setEditingCollection(collection);
    setPickQuery(''); setPickResults([]);
    setCollectionProducts(collection.productIds.map(id => productIndex.get(id) ?? ({ id } as Product)));
  }

  function collectionPayload(form: HTMLFormElement) {
    const values = new FormData(form);
    const translations = LOCALES.map(([locale]) => {
      const name = String(values.get(`col-name:${locale}`) ?? '').trim();
      const slug = String(values.get(`col-slug:${locale}`) ?? '').trim();
      const description = String(values.get(`col-desc:${locale}`) ?? '').trim();
      return name ? { locale, name, ...(slug ? { slug } : {}), ...(description ? { description } : {}) } : null;
    }).filter(item => item !== null);
    const position = Number(values.get('col-position') ?? editingCollection?.position ?? 0);
    return { position: Number.isFinite(position) && position >= 0 ? position : 0,
      enabled: values.get('col-enabled') === 'yes', translations,
      productIds: collectionProducts.map(item => item.id) };
  }

  function createCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    void run(async () => {
      await request('collections', 'POST', { translations: [{
        locale: 'zh-CN', name: String(new FormData(form).get('colName') ?? '').trim(),
        slug: String(new FormData(form).get('colSlug') ?? '').trim() || undefined,
      }] });
      form.reset(); setNotice('专题已建立；补上商品后前台即可看到。');
    });
  }

  function saveCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingCollection) return;
    const payload = collectionPayload(event.currentTarget);
    if (!payload.translations.length) { setError('至少填写一种语言的专题名称。'); return; }
    void run(async () => {
      await request(`collections/${editingCollection.id}`, 'PATCH', payload, editingCollection.version);
      setEditingCollection(null); setCollectionProducts([]);
      setNotice('专题已保存；改过 slug 的旧地址会自动 301 到新地址。');
    });
  }

  function removeCollection(collection: Collection) {
    if (!confirm(`删除专题「${nameOf(collection.translations, 'zh-CN')}」？商品与分类不受影响。`)) return;
    void run(async () => { await request(`collections/${collection.id}`, 'DELETE'); setEditingCollection(null);
      setNotice('专题已删除。'); });
  }

  function searchPickProducts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const page = await request<Page<Product>>(`products?limit=25${pickQuery ? `&q=${encodeURIComponent(pickQuery)}` : ''}`);
      setPickResults(page.items);
      setProductIndex(previous => new Map([...previous, ...page.items.map(item => [item.id, item] as const)]));
    }, false);
  }

  function addCollectionProduct(product: Product) {
    setCollectionProducts(previous => previous.some(item => item.id === product.id) ? previous : [...previous, product]);
  }

  function removeCollectionProduct(id: string) {
    setCollectionProducts(previous => previous.filter(item => item.id !== id));
  }

  function moveCollectionProduct(index: number, delta: number) {
    setCollectionProducts(previous => {
      const next = [...previous]; const target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function createLabel(kind: 'categories' | 'brands') {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
      void run(async () => { await request(kind, 'POST', { translations: [{ locale: 'zh-CN', name: values.get('labelName'), slug: values.get('labelSlug') }] });
        form.reset(); setNotice(kind === 'categories' ? '分类已建立。' : '品牌已建立。'); });
    };
  }

  const fields = (product?: Product) => <>{LOCALES.map(([locale, label]) => {
    const translation = product?.translations.find(item => item.locale === locale);
    return <fieldset key={locale}><legend>{label}</legend>
      <label>名称<input name={`name:${locale}`} defaultValue={translation?.name ?? ''} maxLength={160} /></label>
      <label>slug<input name={`slug:${locale}`} defaultValue={translation?.slug ?? ''} maxLength={180} /></label>
    </fieldset>;
  })}
    <label>基础 SKU<input name="baseSku" defaultValue={product?.baseSku ?? ''} maxLength={64} /></label>
    <fieldset><legend>分类</legend>{categories.length === 0 && <p>尚未建立分类。</p>}
      {categories.map(category => <label className="check" key={category.id}><input type="checkbox" name="categoryIds" value={category.id}
        defaultChecked={product?.categoryIds.includes(category.id) ?? false} />{nameOf(category.translations, 'zh-CN')}</label>)}</fieldset>
    <label>市场代码（逗号分隔，须已审核并启用）<input name="marketCodes" defaultValue={product?.marketCodes.join(',') ?? ''} placeholder="HK" /></label>
    <label>规格币种（须等于店铺本位币）<input name="currency" defaultValue={product?.variants[0]?.currency ?? 'HKD'} maxLength={3} /></label>
    <fieldset><legend>规格</legend>
      {product ? product.variants.map(variant => <p key={variant.id}><small>{variant.sku} · {Object.entries(variant.optionValues).map(([key, value]) => `${key}=${value}`).join(', ')} · {variant.priceMinor} {variant.currency} · 现货 {variant.available}</small></p>)
        : Array.from({ length: variantRows }, (_unused, index) => <div key={index} className="variant-row">
          <label>SKU<input name={`sku:${index}`} maxLength={64} /></label>
          <label>规格（key=value，逗号分隔）<input name={`options:${index}`} placeholder="size=50ml" /></label>
          <label>价格（最小单位）<input name={`price:${index}`} type="number" min={0} /></label>
        </div>)}
      {!product && <button type="button" className="secondary" onClick={() => setVariantRows(rows => rows + 1)}>增加一个规格</button>}
    </fieldset></>;

  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div>
    <header><div><p className="eyebrow">商品管理</p><h1>商品目录</h1></div><div className="actions">
      <a href="/admin/media">媒体库</a><a href="/admin/content">内容页</a><a href="/admin/merchandising">页面陈列</a><a href="/admin/orders">订单</a><a href="/admin/shipping">配送与结账</a><a href="/admin/payments">付款</a><a href="/admin/inventory">库存</a><a href="/admin/aftersales">售后</a><a href="/admin/coupons">优惠券</a><a href="/admin/members">会员与积分</a><a href="/admin/access">员工与角色</a><a href="/admin/settings">店铺设置</a>
      <button disabled={busy} onClick={() => void run(async () => { setEditing(null); })}>刷新目录</button></div></header>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!ready && !error && <p>正在检查会话与权限…</p>}
    {ready && !permissions.includes('catalog.read') && <section><h2>没有商品读取权限</h2><p>请联系店主分配商品权限。</p></section>}
    {permissions.includes('catalog.read') && <>
      <section aria-labelledby="products-title"><h2 id="products-title">商品列表</h2>
        <form onSubmit={event => { event.preventDefault(); const value = new FormData(event.currentTarget).get('q');
          void run(async () => { const page = await request<Page<Product>>(`products?limit=25${value ? `&q=${encodeURIComponent(String(value))}` : ''}`);
            setProducts(page.items); setCursor(page.nextCursor); }); }}>
          <label>搜索商品<input name="q" defaultValue={query} onChange={event => setQuery(event.target.value)} placeholder="名称、基础 SKU 或规格 SKU" maxLength={200} /></label>
          <button disabled={busy}>搜索</button>
        </form>
        {products.length === 0 && <p>尚无商品。</p>}
        {products.map(product => <article key={product.id}><h3>{nameOf(product.translations, 'zh-CN')} <span className="preset">{product.status === 'active' ? '已上架' : '草稿'}</span></h3>
          <p>{product.baseSku ?? '无基础 SKU'} · {product.variants.length} 个规格 · 市场 {product.marketCodes.join('、') || '未指定'}</p>
          <small>版本 {product.version} · 更新 {new Date(product.updatedAt).toLocaleString('zh-CN')}</small>
          <div className="actions">
            {canWrite && <button disabled={busy} onClick={() => { setEditing(product); setNotice(''); }}>编辑 {nameOf(product.translations, 'zh-CN')}</button>}
            {canPublish && product.status !== 'active' && <button disabled={busy} onClick={() => publish(product)}>发布 {nameOf(product.translations, 'zh-CN')}</button>}
            {canPublish && product.status === 'active' && <button className="secondary" disabled={busy} onClick={() => unpublish(product)}>下架 {nameOf(product.translations, 'zh-CN')}</button>}
          </div></article>)}
        {cursor && <button disabled={busy} onClick={() => void run(async () => { const page = await request<Page<Product>>(`products?limit=25&cursor=${cursor}`);
          setProducts(previous => [...previous, ...page.items]); setCursor(page.nextCursor); }, false)}>加载更多商品</button>}
      </section>
      <section aria-labelledby="collections-title"><h2 id="collections-title">专题（策展）</h2>
        <p><small>专题是跨分类的商品组合，前台地址为 <code>/collections/&lt;slug&gt;</code>；
          改 slug 会自动为旧地址登记 301，停用或删除时前台立即下线。没有商品或没有 slug 的专题不会出现在前台列表。</small></p>
        {collections.length === 0 && <p>尚无专题。</p>}
        {collections.map(collection => <article key={collection.id}>
          <h3>{nameOf(collection.translations, 'zh-CN')} <span className="preset">{collection.enabled ? '启用' : '停用'}</span></h3>
          <small>{collection.translations.map(item => `${item.locale}: ${item.slug ?? '无 slug（前台不可见）'}`).join(' · ')}
            {' · '}{collection.productCount} 件商品</small>
          {canWrite && <div className="actions">
            <button type="button" disabled={busy} onClick={() => openCollection(collection)}>编辑专题</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => removeCollection(collection)}>删除专题</button>
          </div>}
        </article>)}
        {editingCollection && canWrite && <section aria-labelledby="edit-collection-title">
          <h2 id="edit-collection-title">编辑专题「{nameOf(editingCollection.translations, 'zh-CN')}」</h2>
          <form key={`${editingCollection.id}:${editingCollection.version}`} onSubmit={saveCollection}>
            <div className="permission-grid">
              {LOCALES.map(([locale, label]) => {
                const translation = editingCollection.translations.find(item => item.locale === locale);
                return <fieldset key={locale}><legend>{label}</legend>
                  <label>名称<input name={`col-name:${locale}`} defaultValue={translation?.name ?? ''} maxLength={160} /></label>
                  <label>slug<input name={`col-slug:${locale}`} defaultValue={translation?.slug ?? ''} maxLength={180}
                    placeholder="如 autumn-picks" /></label>
                  <label>简介<textarea name={`col-desc:${locale}`} defaultValue={translation?.description ?? ''} maxLength={3000} rows={2} /></label>
                </fieldset>;
              })}
              <label>启用<select name="col-enabled" defaultValue={editingCollection.enabled ? 'yes' : 'no'}>
                <option value="yes">启用（前台可见）</option><option value="no">停用（前台立即下线）</option></select></label>
              <label>排序<input name="col-position" type="number" min={0} defaultValue={editingCollection.position} /></label>
            </div>
            <h3>商品（按下列顺序展示）</h3>
            {collectionProducts.length === 0 && <p>还没有商品：从下方搜索结果里加入。</p>}
            <ol className="collection-picks">{collectionProducts.map((item, index) => <li key={item.id}>
              <span>{item.translations ? nameOf(item.translations, 'zh-CN') : item.id}</span>
              <span className="actions">
                <button type="button" className="secondary" disabled={index === 0} onClick={() => moveCollectionProduct(index, -1)}>上移</button>
                <button type="button" className="secondary" disabled={index === collectionProducts.length - 1}
                  onClick={() => moveCollectionProduct(index, 1)}>下移</button>
                <button type="button" className="secondary" onClick={() => removeCollectionProduct(item.id)}>移除</button>
              </span>
            </li>)}</ol>
            <p><small>当前版本 {editingCollection.version}；保存后前台最多半分钟生效。</small></p>
            <button disabled={busy}>保存专题</button>
            <button type="button" className="secondary" onClick={() => { setEditingCollection(null); setCollectionProducts([]); }}>取消</button>
          </form>
          <form onSubmit={searchPickProducts}>
            <label>搜索商品<input name="pickQ" value={pickQuery} maxLength={200}
              onChange={event => setPickQuery(event.target.value)} placeholder="名称或 SKU" /></label>
            <button disabled={busy}>搜索</button>
          </form>
          {pickResults.map(product => <p key={product.id}>
            <small>{nameOf(product.translations, 'zh-CN')} · {product.baseSku ?? '无基础 SKU'} · {product.status === 'active' ? '已上架' : '草稿'}</small>
            <button type="button" disabled={busy || collectionProducts.some(item => item.id === product.id)}
              onClick={() => addCollectionProduct(product)}>加入专题</button>
          </p>)}
        </section>}
        {canWrite && <form onSubmit={createCollection}>
          <label>新专题名称（简中）<input name="colName" required maxLength={160} /></label>
          <label>专题 slug<input name="colSlug" maxLength={180} placeholder="如 autumn-picks" /></label>
          <button disabled={busy}>建立专题</button>
        </form>}
      </section>
      {canWrite && <section aria-labelledby="create-title"><h2 id="create-title">新建商品草稿</h2>
        <form onSubmit={create}><div className="permission-grid">{fields()}</div><button disabled={busy}>保存草稿</button></form></section>}
      {editing && canWrite && <section aria-labelledby="edit-title"><h2 id="edit-title">编辑商品</h2>
        <form key={`${editing.id}:${editing.version}`} onSubmit={save}><div className="permission-grid">{fields(editing)}</div>
          <p><small>规格在保存时按 SKU 增量更新；有库存的规格不能删除。当前版本 {editing.version}。</small></p>
          <button disabled={busy}>保存商品</button><button type="button" className="secondary" onClick={() => setEditing(null)}>取消编辑</button></form></section>}
      <section aria-labelledby="taxonomy-title"><h2 id="taxonomy-title">分类与品牌</h2>
        {categories.map(category => <article key={category.id}><h3>{nameOf(category.translations, 'zh-CN')}</h3>
          <small>{category.translations.map(item => `${item.locale}: ${item.slug ?? '无 slug（前台不可见）'}`).join(' · ')}</small>
          {canWrite && <div className="actions"><button type="button" disabled={busy}
            onClick={() => setEditingCategory(category)}>编辑分类</button></div>}
        </article>)}
        {brands.map(brand => <article key={brand.id}><h3>{nameOf(brand.translations, 'zh-CN')}</h3><small>品牌</small></article>)}
        {editingCategory && canWrite && <section aria-labelledby="edit-category-title">
          <h2 id="edit-category-title">编辑分类「{nameOf(editingCategory.translations, 'zh-CN')}」</h2>
          <form key={`${editingCategory.id}:${editingCategory.version}`} onSubmit={saveCategory}>
            <div className="permission-grid">
              {LOCALES.map(([locale, label]) => {
                const translation = editingCategory.translations.find(item => item.locale === locale);
                return <fieldset key={locale}><legend>{label}</legend>
                  <label>名称<input name={`cat-name:${locale}`} defaultValue={translation?.name ?? ''} maxLength={160} /></label>
                  <label>slug<input name={`cat-slug:${locale}`} defaultValue={translation?.slug ?? ''} maxLength={180}
                    placeholder="如 cigars" /></label>
                </fieldset>;
              })}
              <label>启用<select name="cat-enabled" defaultValue={editingCategory.enabled ? 'yes' : 'no'}>
                <option value="yes">启用</option><option value="no">停用（前台不再展示）</option></select></label>
              <label>排序<input name="cat-position" type="number" min={0} defaultValue={editingCategory.position} /></label>
            </div>
            <p><small>slug 决定前台地址 <code>/categories/&lt;slug&gt;</code>：留空的分类不会出现在前台分类页与站点地图。
              清空某种语言的名称会删除该语言翻译。当前版本 {editingCategory.version}。</small></p>
            <button disabled={busy}>保存分类</button>
            <button type="button" className="secondary" onClick={() => setEditingCategory(null)}>取消</button>
          </form>
        </section>}
        {canWrite && <form onSubmit={createLabel('categories')}><label>新分类名称<input name="labelName" required maxLength={160} /></label>
          <label>分类 slug<input name="labelSlug" required maxLength={180} /></label><button disabled={busy}>建立分类</button></form>}
        {canWrite && <form onSubmit={createLabel('brands')}><label>新品牌名称<input name="labelName" required maxLength={160} /></label>
          <label>品牌 slug<input name="labelSlug" maxLength={180} /></label><button disabled={busy}>建立品牌</button></form>}
      </section>
    </>}
  </main>;
}
