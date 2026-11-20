"use client";
import { useEffect, useRef, useState } from 'react';

type Section = { type: string; params?: Record<string, string | number | boolean> };
type ThemeConfig = {
  brand: { name: string; brandLatin?: string; tagline?: string; whatsappNumber?: string; whatsappGreeting?: string };
  tokens: { primaryColor: string; inkColor: string; paperColor: string; fontPair: string; radius: number };
  navigation?: string[];
  homeSections: Section[];
};
type ThemeDoc = {
  status: string; version: number; config: ThemeConfig | null;
  published: { version: number; publishedAt: string | null } | null;
  publishedAt: string | null;
  versions: { version: number; publishedAt: string; note: string | null }[];
  updatedAt: string | null;
};
type Session = { permissionCodes: string[]; csrfToken: string };

const SECTION_TYPES = ['hero', 'about', 'product_grid', 'rich_text', 'faq', 'content_card'] as const;
const FONT_PRESETS = ['editorial-jp', 'modern-sans', 'classic-serif'] as const;
const SECTION_LABEL: Record<string, string> = {
  hero: '主视觉 (Hero)', about: '关于 (About)', product_grid: '商品网格',
  rich_text: '图文', faq: '常见问题', content_card: '内容卡片',
};
const ERROR_TEXT: Record<string, string> = {
  THEME_COLOR_INVALID: '颜色必须是 6 位十六进制，例如 #BC002D。',
  THEME_FONT_UNSUPPORTED: '字体组合不在允许范围内。',
  THEME_SECTION_UNSUPPORTED: '首页区块类型未注册，请从列表中选择。',
  THEME_SECTION_DUPLICATE: '同一首页不能重复使用同一种区块。',
  VERSION_CONFLICT: '配置已在别处修改，请刷新后重新编辑。',
  VALIDATION_ERROR: '配置不符合规则：请检查品牌名长度、颜色与区块参数。',
};

/** 一份可用的默认草稿：未配置过时据此开始编辑。 */
const blankConfig = (): ThemeConfig => ({
  brand: { name: '', brandLatin: '', tagline: '', whatsappNumber: '', whatsappGreeting: '' },
  tokens: { primaryColor: '#BC002D', inkColor: '#1A1A1A', paperColor: '#F7F5F0', fontPair: 'editorial-jp', radius: 16 },
  homeSections: [{ type: 'hero' }, { type: 'about' }, { type: 'product_grid', params: { sectionId: 'featured', limit: 6 } }],
});

export function ThemeConsole() {
  const session = useRef<Session | null>(null);
  const [doc, setDoc] = useState<ThemeDoc | null>(null);
  const [config, setConfig] = useState<ThemeConfig>(blankConfig());
  const [permissions, setPermissions] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('主题调整');
  const canWrite = permissions.includes('content.write');
  const canPublish = permissions.includes('content.publish');

  async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = payload?.error?.code ?? '';
      if (ERROR_TEXT[code]) throw new Error(ERROR_TEXT[code]!);
      if (response.status === 403) throw new Error('当前账号没有执行此操作所需的权限。');
      throw new Error('操作未完成，请检查配置后重试。');
    }
    return response.json() as Promise<T>;
  }

  async function load() {
    setError('');
    try {
      const [s, d] = await Promise.all([
        fetch('/api/v1/admin/auth/session', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json()) as Promise<Session>,
        request<ThemeDoc>('theme'),
      ]);
      session.current = s; setPermissions(s.permissionCodes ?? []);
      setDoc(d); setConfig(d.config ?? blankConfig());
    } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setReady(true); }
  }

  useEffect(() => { void load(); }, []);

  function setBrand(key: keyof ThemeConfig['brand'], value: string) {
    setConfig(prev => ({ ...prev, brand: { ...prev.brand, [key]: value } }));
  }
  function setToken(key: keyof ThemeConfig['tokens'], value: string | number) {
    setConfig(prev => ({ ...prev, tokens: { ...prev.tokens, [key]: value } }));
  }
  function moveSection(index: number, delta: number) {
    setConfig(prev => {
      const sections = [...prev.homeSections];
      const target = index + delta;
      if (target < 0 || target >= sections.length) return prev;
      [sections[index], sections[target]] = [sections[target]!, sections[index]!];
      return { ...prev, homeSections: sections };
    });
  }
  function addSection(type: string) {
    setConfig(prev => ({ ...prev,
      homeSections: [...prev.homeSections, type === 'product_grid'
        ? { type, params: { sectionId: `grid-${prev.homeSections.length + 1}`, limit: 6 } }
        : { type }] }));
  }
  function removeSection(index: number) {
    setConfig(prev => ({ ...prev, homeSections: prev.homeSections.filter((_, i) => i !== index) }));
  }

  async function action(fn: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try { const d = await fn(); if (d && typeof d === 'object' && 'status' in d) { const next = d as ThemeDoc; setDoc(next); setConfig(next.config ?? blankConfig()); } setNotice(success); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  }

  const version = doc?.version ?? 1;

  if (!ready) return <main className="console theme-console"><p>加载中…</p></main>;

  return (
    <main className="console theme-console">
      <header>
        <div><h1>店铺主题配置</h1><p>配置驱动的专属前台：品牌、配色与首页区块。保存草稿不改变线上，发布后才生效。</p></div>
        <nav><a href="/admin/merchandising">商品陈列</a> · <a href="/admin/settings">店铺设置</a></nav>
      </header>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section>
        <h2>当前状态</h2>
        <p>
          草稿版本 v{version} · 线上：{doc?.published ? `v${doc.published.version}（${doc.published.publishedAt ?? '—'}）` : '未发布（前台使用默认主题）'}
        </p>
        <div className="actions">
          <button disabled={!canWrite || busy} onClick={() => void action(
            () => request('theme', 'PUT', { expectedVersion: version, config }), '草稿已保存（线上未变化）')}>保存草稿</button>
          <button disabled={!canPublish || busy || !doc?.config} onClick={() => void action(
            () => request('theme/publish', 'POST', { expectedVersion: version, note: reason }), '已发布，前台最多 30 秒后生效')}>发布到线上</button>
          <button disabled={!canPublish || busy || doc?.status !== 'published'} onClick={() => void action(
            () => request('theme/unpublish', 'POST', { expectedVersion: version, reason }), '已撤下，前台回退默认主题')}>撤下</button>
        </div>
      </section>

      <section>
        <h2>品牌</h2>
        <label>店铺名称<input value={config.brand.name} onChange={e => setBrand('name', e.target.value)} maxLength={60} /></label>
        <label>英文/别名<input value={config.brand.brandLatin ?? ''} onChange={e => setBrand('brandLatin', e.target.value)} maxLength={60} /></label>
        <label>标语<input value={config.brand.tagline ?? ''} onChange={e => setBrand('tagline', e.target.value)} maxLength={200} /></label>
        <label>WhatsApp 号码<input value={config.brand.whatsappNumber ?? ''} onChange={e => setBrand('whatsappNumber', e.target.value)} maxLength={30} /></label>
        <label>WhatsApp 问候语<input value={config.brand.whatsappGreeting ?? ''} onChange={e => setBrand('whatsappGreeting', e.target.value)} maxLength={200} /></label>
      </section>

      <section>
        <h2>视觉主题</h2>
        <label>主色<input type="color" value={config.tokens.primaryColor} onChange={e => setToken('primaryColor', e.target.value)} /></label>
        <label>文字色<input type="color" value={config.tokens.inkColor} onChange={e => setToken('inkColor', e.target.value)} /></label>
        <label>背景色<input type="color" value={config.tokens.paperColor} onChange={e => setToken('paperColor', e.target.value)} /></label>
        <label>字体组合<select value={config.tokens.fontPair} onChange={e => setToken('fontPair', e.target.value)}>
          {FONT_PRESETS.map(f => <option key={f} value={f}>{f}</option>)}
        </select></label>
        <label>圆角 (px)<input type="number" min={0} max={64} value={config.tokens.radius} onChange={e => setToken('radius', Number(e.target.value))} /></label>
      </section>

      <section>
        <h2>首页区块（自上而下）</h2>
        <p>区块顺序与参数由此决定；注册表中尚未实现完整渲染的类型会安全跳过。</p>
        <ol className="section-list">
          {config.homeSections.map((section, index) => (
            <li key={index}>
              <span className="badge">{SECTION_LABEL[section.type] ?? section.type}</span>
              {section.type === 'product_grid' && <span> · {String(section.params?.limit ?? 6)} 件</span>}
              <span className="row-actions">
                <button disabled={index === 0} onClick={() => moveSection(index, -1)}>↑</button>
                <button disabled={index === config.homeSections.length - 1} onClick={() => moveSection(index, 1)}>↓</button>
                <button onClick={() => removeSection(index)}>移除</button>
              </span>
            </li>
          ))}
        </ol>
        <div className="actions">
          {SECTION_TYPES.map(type => <button key={type} onClick={() => addSection(type)}>+ {SECTION_LABEL[type]}</button>)}
        </div>
      </section>

      <section>
        <h2>发布历史</h2>
        {doc?.versions?.length ? <ul>
          {doc.versions.map(v => <li key={v.version}>v{v.version} · {v.publishedAt}{v.note ? ` · ${v.note}` : ''}{doc.published?.version === v.version ? ' ← 线上' : ''}</li>)}
        </ul> : <p>尚无发布记录。</p>}
        {doc?.published && <div className="actions">
          <label>回滚到版本<select id="rollback-version" defaultValue={doc.versions[0]?.version}>
            {doc.versions.map(v => <option key={v.version} value={v.version}>v{v.version}</option>)}
          </select></label>
          <button disabled={!canPublish || busy} onClick={() => {
            const el = document.getElementById('rollback-version') as HTMLSelectElement | null;
            const targetVersion = Number(el?.value ?? 0);
            void action(() => request('theme/rollback', 'POST', { expectedVersion: version, version: targetVersion }), '已回滚');
          }}>回滚</button>
        </div>}
      </section>
    </main>
  );
}
