"use client";
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

type Session = { user: { email: string; displayName: string; mustChangePassword?: boolean };
  permissionCodes: string[]; csrfToken: string };
type NavItem = { href: string; label: string; permission: string; icon: IconName };
type NavGroup = { title: string; items: NavItem[] };

/** 这些页面是登录前的自助流程，不该被后台外壳包住，也不该探测会话（否则 401 会把用户踢回登录页）。 */
const AUTH_PATHS = ['/admin/login', '/admin/reset-password', '/admin/accept-invitation', '/admin/password'];

/** 导航是外壳，权限是数据：不持有某页主接口权限的人看不到入口，避免点进去才发现 403。 */
const NAV: NavGroup[] = [
  { title: '日常', items: [
    { href: '/admin', label: '工作台', permission: 'orders.read', icon: 'home' },
    { href: '/admin/orders', label: '订单', permission: 'orders.read', icon: 'receipt' },
    { href: '/admin/aftersales', label: '售后', permission: 'aftersales.read', icon: 'returns' },
    { href: '/admin/payments', label: '付款与对账', permission: 'payments.read', icon: 'card' },
  ] },
  { title: '商品', items: [
    { href: '/admin/catalog', label: '商品目录', permission: 'catalog.read', icon: 'box' },
    { href: '/admin/inventory', label: '库存', permission: 'inventory.read', icon: 'layers' },
    { href: '/admin/shipping', label: '配送与结账', permission: 'shipping.manage', icon: 'truck' },
    { href: '/admin/coupons', label: '优惠券', permission: 'coupons.read', icon: 'ticket' },
    { href: '/admin/media', label: '媒体库', permission: 'media.manage', icon: 'image' },
    { href: '/admin/content', label: '内容页', permission: 'content.read', icon: 'file' },
    { href: '/admin/merchandising', label: '页面陈列', permission: 'content.read', icon: 'layout' },
    { href: '/admin/theme', label: '主题', permission: 'content.read', icon: 'palette' },
  ] },
  { title: '顾客与经营', items: [
    { href: '/admin/members', label: '会员与积分', permission: 'members.manage', icon: 'users' },
    { href: '/admin/reports', label: '报表', permission: 'reports.view', icon: 'chart' },
    { href: '/admin/privacy', label: '资料请求', permission: 'privacy.read', icon: 'shield' },
  ] },
  { title: '系统', items: [
    { href: '/admin/access', label: '员工与角色', permission: 'staff.read', icon: 'badge' },
    { href: '/admin/audit', label: '审计记录', permission: 'audit.read', icon: 'clock' },
    { href: '/admin/settings', label: '店铺设置', permission: 'store.settings.manage', icon: 'sliders' },
  ] },
];

type IconName = 'home' | 'receipt' | 'returns' | 'card' | 'box' | 'layers' | 'truck' | 'ticket'
  | 'image' | 'file' | 'layout' | 'palette' | 'users' | 'chart' | 'shield' | 'badge' | 'clock'
  | 'sliders' | 'menu' | 'close';

const ICONS: Record<IconName, ReactNode> = {
  home: <><path d="M3 10.6 12 3.2l9 7.4V20a1 1 0 0 1-1 1h-5.2v-6H9.2v6H4a1 1 0 0 1-1-1z" /></>,
  receipt: <><path d="M6 3h12v18l-3-1.9-3 1.9-3-1.9L6 21z" /><path d="M9 8h6M9 12h6" /></>,
  returns: <><path d="M3.5 12a8.5 8.5 0 1 0 2.9-6.4" /><path d="M3.2 4.2v4.6h4.6" /></>,
  card: <><rect x="2.8" y="5.5" width="18.4" height="13" rx="2.4" /><path d="M2.8 10.2h18.4" /></>,
  box: <><path d="M12 3 20.2 7.6v8.8L12 21 3.8 16.4V7.6z" /><path d="M3.9 7.7 12 12.2l8.1-4.5M12 12.2V21" /></>,
  layers: <><path d="M12 3.2 20.4 8 12 12.8 3.6 8z" /><path d="M3.6 12.8 12 17.6l8.4-4.8" /></>,
  truck: <><path d="M2.8 6.6h10.4v9.6H2.8zM13.2 10.2h3.6l3.4 3.2v2.8h-7z" /><circle cx="7" cy="18.4" r="1.7" /><circle cx="17.2" cy="18.4" r="1.7" /></>,
  ticket: <><path d="M4 8.4A2.4 2.4 0 0 1 6.4 6h11.2A2.4 2.4 0 0 1 20 8.4v1.4a2.2 2.2 0 0 0 0 4.4v1.4a2.4 2.4 0 0 1-2.4 2.4H6.4A2.4 2.4 0 0 1 4 15.6v-1.4a2.2 2.2 0 0 0 0-4.4z" /><path d="M13.4 9v6" /></>,
  image: <><rect x="3" y="4.8" width="18" height="14.4" rx="2.2" /><circle cx="8.4" cy="9.8" r="1.5" /><path d="m3.6 16.4 4.6-4.4 3.6 3.4 2.8-2.6 5.4 5" /></>,
  file: <><path d="M6.6 3h7.2L19 8.2V21H6.6z" /><path d="M13.6 3.2v5.2H19M9.6 12.4h6M9.6 16h6" /></>,
  layout: <><rect x="3" y="4.6" width="18" height="14.8" rx="2.2" /><path d="M3 10h18M9.4 10v9.4" /></>,
  palette: <><path d="M12 3.2c4.4 4.6 6.4 7.3 6.4 9.9a6.4 6.4 0 0 1-12.8 0c0-2.6 2-5.3 6.4-9.9z" /></>,
  users: <><circle cx="8.6" cy="8" r="3.6" /><path d="M2.6 20a6 6 0 0 1 12 0" /><path d="M16.2 4.9a3.6 3.6 0 0 1 0 6.9M17.6 14.6a5.6 5.6 0 0 1 3.9 5.4" /></>,
  chart: <><path d="M4.2 3.6v16.8h16" /><path d="M8.4 17V12M12.6 17V7.6M16.8 17v-5.6" /></>,
  shield: <><path d="M12 3.2 19.6 6v6.2c0 4.4-3.2 7.8-7.6 8.8-4.4-1-7.6-4.4-7.6-8.8V6z" /></>,
  badge: <><rect x="5.4" y="3" width="13.2" height="18" rx="2.2" /><circle cx="12" cy="9.6" r="2.4" /><path d="M8.4 16.4a3.8 3.8 0 0 1 7.2 0" /></>,
  clock: <><circle cx="12" cy="12" r="8.8" /><path d="M12 7.2V12l3.4 2" /></>,
  sliders: <><path d="M3.6 7.4h16.8M3.6 12h16.8M3.6 16.6h16.8" /><circle cx="9" cy="7.4" r="2" /><circle cx="15.4" cy="12" r="2" /><circle cx="8" cy="16.6" r="2" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
};

function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ICONS[name]}</svg>;
}

function initial(name: string) {
  const value = (name || '').trim();
  if (!value) return '·';
  // 中文取首字，西文取首字母，头像里两个字符以上会挤。
  return /[\u4e00-\u9fa5]/.test(value[0]!) ? value[0]! : value.slice(0, 1).toUpperCase();
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = AUTH_PATHS.some(path => pathname === path || pathname.startsWith(path + '/'));
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (isAuthPage) return;
    let alive = true;
    void (async () => {
      try {
        const response = await fetch('/api/v1/admin/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401) { location.assign('/admin/login'); return; }
        if (!response.ok) { if (alive) setFailed(true); return; }
        const data: Session = (await response.json()).data;
        if (data.user.mustChangePassword) { location.assign('/admin/password'); return; }
        if (alive) setSession(data);
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; };
  }, [isAuthPage, pathname]);

  // 抽屉只在窄屏存在：切页、按 Esc、点遮罩都该关掉，否则下一屏会被盖住。
  useEffect(() => { setNavOpen(false); }, [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = previous; };
  }, [navOpen]);

  async function logout() {
    try {
      await fetch('/api/v1/admin/auth/logout', { method: 'POST', credentials: 'same-origin',
        headers: { 'X-CSRF-Token': session?.csrfToken ?? '' } });
    } finally { location.assign('/admin/login'); }
  }

  if (isAuthPage) return <>{children}</>;

  const allowed = (permission: string) => session?.permissionCodes.includes(permission) ?? false;
  const groups = NAV.map(group => ({ ...group, items: group.items.filter(item => allowed(item.permission)) }))
    .filter(group => group.items.length);
  const isActive = (href: string) => href === '/admin' ? pathname === '/admin' : pathname === href || pathname.startsWith(href + '/');
  const current = NAV.flatMap(group => group.items).find(item => isActive(item.href));
  const who = session?.user.displayName || session?.user.email || '';

  return <>
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <div className="app-shell">
      <header className="app-topbar">
        <button className="nav-toggle" type="button" aria-label="打开导航菜单" aria-expanded={navOpen}
          aria-controls="admin-nav" onClick={() => setNavOpen(true)}><Icon name="menu" /></button>
        <span className="topbar-title">{current?.label ?? '工作台'}</span>
        {who && <span className="avatar" aria-hidden="true">{initial(who)}</span>}
      </header>

      <div className={`nav-scrim${navOpen ? ' open' : ''}`} onClick={() => setNavOpen(false)} aria-hidden="true" />

      <aside className={`app-nav${navOpen ? ' open' : ''}`} id="admin-nav">
        <div className="nav-head">
          <span className="nav-mark" aria-hidden="true">E</span>
          <div>
            <strong>EZSTART Commerce</strong>
            <small>店铺管理后台</small>
          </div>
          <button className="nav-close" type="button" aria-label="关闭导航菜单"
            onClick={() => setNavOpen(false)}><Icon name="close" /></button>
        </div>

        {!session && !failed && <p className="nav-note">正在载入导航…</p>}
        {failed && <p className="nav-note">导航加载失败，请刷新页面。</p>}

        <nav aria-label="主导航">
          {groups.map(group => <div className="nav-group" key={group.title}>
            <p className="nav-group-title">{group.title}</p>
            {group.items.map(item => <a key={item.href} href={item.href}
              aria-current={isActive(item.href) ? 'page' : undefined}><Icon name={item.icon} />{item.label}</a>)}
          </div>)}
        </nav>

        {session && <div className="nav-foot">
          <p className="who">
            <span className="avatar" aria-hidden="true">{initial(who)}</span>
            <span><strong>{who || '已登录'}</strong><small>当前账号</small></span>
          </p>
          <div className="nav-foot-actions">
            <a href="/admin/password">修改密码</a>
            <button type="button" onClick={() => void logout()}>退出</button>
          </div>
        </div>}
      </aside>

      <div className="app-body" id="main-content">{children}</div>
    </div>
  </>;
}
