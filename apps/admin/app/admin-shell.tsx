"use client";
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

type Session = { user: { email: string; displayName: string; mustChangePassword?: boolean };
  permissionCodes: string[]; csrfToken: string };
type NavItem = { href: string; label: string; permission: string };
type NavGroup = { title: string; items: NavItem[] };

/** 这些页面是登录前的自助流程，不该被后台外壳包住，也不该探测会话（否则 401 会把用户踢回登录页）。 */
const AUTH_PATHS = ['/admin/login', '/admin/reset-password', '/admin/accept-invitation', '/admin/password'];

/** 导航是外壳，权限是数据：不持有某页主接口权限的人看不到入口，避免点进去才发现 403。 */
const NAV: NavGroup[] = [
  { title: '日常', items: [
    { href: '/admin', label: '工作台', permission: 'orders.read' },
    { href: '/admin/orders', label: '订单', permission: 'orders.read' },
    { href: '/admin/aftersales', label: '售后', permission: 'aftersales.read' },
    { href: '/admin/payments', label: '付款与对账', permission: 'payments.read' },
  ] },
  { title: '商品', items: [
    { href: '/admin/catalog', label: '商品目录', permission: 'catalog.read' },
    { href: '/admin/inventory', label: '库存', permission: 'inventory.read' },
    { href: '/admin/shipping', label: '配送与结账', permission: 'shipping.manage' },
    { href: '/admin/coupons', label: '优惠券', permission: 'coupons.read' },
    { href: '/admin/media', label: '媒体库', permission: 'media.manage' },
    { href: '/admin/content', label: '内容页', permission: 'content.read' },
    { href: '/admin/merchandising', label: '页面陈列', permission: 'content.read' },
    { href: '/admin/theme', label: '主题', permission: 'content.read' },
  ] },
  { title: '顾客与经营', items: [
    { href: '/admin/members', label: '会员与积分', permission: 'members.manage' },
    { href: '/admin/reports', label: '报表', permission: 'reports.view' },
    { href: '/admin/privacy', label: '资料请求', permission: 'privacy.read' },
  ] },
  { title: '系统', items: [
    { href: '/admin/access', label: '员工与角色', permission: 'staff.read' },
    { href: '/admin/audit', label: '审计记录', permission: 'audit.read' },
    { href: '/admin/settings', label: '店铺设置', permission: 'store.settings.manage' },
  ] },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = AUTH_PATHS.some(path => pathname === path || pathname.startsWith(path + '/'));
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);

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

  return <div className="app-shell">
    <aside className="app-nav">
      <div className="brand">EZSTART<span>Commerce</span></div>
      {!session && !failed && <p className="nav-note">正在载入导航…</p>}
      {failed && <p className="nav-note">导航加载失败，请刷新页面。</p>}
      <nav>
        {groups.map(group => <div className="nav-group" key={group.title}>
          <p className="nav-group-title">{group.title}</p>
          {group.items.map(item => <a key={item.href} href={item.href} className={isActive(item.href) ? 'active' : ''}>{item.label}</a>)}
        </div>)}
      </nav>
      {session && <footer>
        <p className="who">{session.user.displayName || session.user.email}</p>
        <a href="/admin/password">修改密码</a>
        <button type="button" onClick={() => void logout()}>退出登录</button>
      </footer>}
    </aside>
    <div className="app-body">{children}</div>
  </div>;
}
