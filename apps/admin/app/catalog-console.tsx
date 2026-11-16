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
  const [variantRows, setVariantRows] = useState(1);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const canWrite = permissions.includes('catalog.write'); const canPublish = permissions.includes('catalog.publish');

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
      <a href="/admin/media">媒体库</a><a href="/admin/orders">订单</a><a href="/admin/shipping">配送与结账</a><a href="/admin/payments">付款</a><a href="/admin/inventory">库存</a><a href="/admin/aftersales">售后</a><a href="/admin/access">员工与角色</a><a href="/admin/settings">店铺设置</a>
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
      {canWrite && <section aria-labelledby="create-title"><h2 id="create-title">新建商品草稿</h2>
        <form onSubmit={create}><div className="permission-grid">{fields()}</div><button disabled={busy}>保存草稿</button></form></section>}
      {editing && canWrite && <section aria-labelledby="edit-title"><h2 id="edit-title">编辑商品</h2>
        <form key={`${editing.id}:${editing.version}`} onSubmit={save}><div className="permission-grid">{fields(editing)}</div>
          <p><small>规格在保存时按 SKU 增量更新；有库存的规格不能删除。当前版本 {editing.version}。</small></p>
          <button disabled={busy}>保存商品</button><button type="button" className="secondary" onClick={() => setEditing(null)}>取消编辑</button></form></section>}
      <section aria-labelledby="taxonomy-title"><h2 id="taxonomy-title">分类与品牌</h2>
        {categories.map(category => <article key={category.id}><h3>{nameOf(category.translations, 'zh-CN')}</h3><small>{category.translations.map(item => `${item.locale}: ${item.slug ?? '无 slug'}`).join(' · ')}</small></article>)}
        {brands.map(brand => <article key={brand.id}><h3>{nameOf(brand.translations, 'zh-CN')}</h3><small>品牌</small></article>)}
        {canWrite && <form onSubmit={createLabel('categories')}><label>新分类名称<input name="labelName" required maxLength={160} /></label>
          <label>分类 slug<input name="labelSlug" required maxLength={180} /></label><button disabled={busy}>建立分类</button></form>}
        {canWrite && <form onSubmit={createLabel('brands')}><label>新品牌名称<input name="labelName" required maxLength={160} /></label>
          <label>品牌 slug<input name="labelSlug" maxLength={180} /></label><button disabled={busy}>建立品牌</button></form>}
      </section>
    </>}
  </main>;
}
