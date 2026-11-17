"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';
type Staff = { id: string; email: string; displayName: string; status: string; roleIds: string[]; version: number };
type Role = { id: string; name: string; kind: string; presetKey: string | null; description: string | null; permissionCodes: string[]; version: number };
type Session = { user: Staff; permissionCodes: string[]; csrfToken: string };
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
export function AccessConsole() {
  const session = useRef<Session | null>(null); const [permissions, setPermissions] = useState<string[]>([]);
  const [users, setUsers] = useState<Staff[]>([]); const [roles, setRoles] = useState<Role[]>([]);
  const [userCursor, setUserCursor] = useState<string | null>(null); const [roleCursor, setRoleCursor] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<Staff | null>(null); const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const has = (code: string) => permissions.includes(code);
  const templates = roles.filter(role => role.presetKey && role.kind !== 'owner');
  const template = roles.find(role => role.id === templateId) ?? null;
  const draftCodes = editingRole ? editingRole.permissionCodes : template?.permissionCodes ?? [];
  async function request<T>(path: string, method = 'GET', body?: object, version?: number): Promise<T> {
    const response = await fetch(`/api/v1/admin/${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': session.current?.csrfToken ?? '' } : {}),
      ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.assign('/admin/login'); throw new Error('会话已失效，请重新登录。'); }
    if (!response.ok) {
      if (response.status === 409) throw new Error('资料已变化，或操作触及店主/邀请保护规则。请刷新后核对再试。');
      if (response.status === 403) throw new Error('当前账号没有执行此操作所需的权限。');
      if (response.status === 429) throw new Error('操作过于频繁，请稍后重试。');
      throw new Error('操作未完成，请检查填写内容后重试。');
    }
    return (await response.json()).data;
  }
  async function reload() {
    const current = await request<Session>('auth/session'); session.current = current; setPermissions(current.permissionCodes);
    if (current.permissionCodes.includes('staff.read')) { const page = await request<Page<Staff>>('users?limit=25'); setUsers(page.items); setUserCursor(page.nextCursor); }
    if (current.permissionCodes.includes('roles.manage')) { const page = await request<Page<Role>>('roles?limit=100'); setRoles(page.items); setRoleCursor(page.nextCursor); }
    setReady(true);
  }
  useEffect(() => { reload().catch(reason => setError(reason instanceof Error ? reason.message : '加载失败。')); }, []);
  async function run(action: () => Promise<void>, refresh = true) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); if (refresh) await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成。'); }
    finally { setBusy(false); }
  }
  async function loadMore(kind: 'users' | 'roles') {
    await run(async () => {
      const cursor = kind === 'users' ? userCursor : roleCursor; if (!cursor) return;
      if (kind === 'users') { const page = await request<Page<Staff>>(`users?limit=25&cursor=${cursor}`); setUsers(previous => [...previous, ...page.items]); setUserCursor(page.nextCursor); }
      else { const page = await request<Page<Role>>(`roles?limit=100&cursor=${cursor}`); setRoles(previous => [...previous, ...page.items]); setRoleCursor(page.nextCursor); }
    }, false);
  }
  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    void run(async () => { await request('users', 'POST', { email: values.get('email'), displayName: values.get('displayName'), locale: values.get('locale'), roleIds: values.getAll('roleIds') }); form.reset(); setNotice('员工邀请已建立并加入邮件投递队列。'); });
  }
  function saveRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    void run(async () => { await request(editingRole ? `roles/${editingRole.id}` : 'roles', editingRole ? 'PATCH' : 'POST', {
      name: values.get('roleName'), description: values.get('description') || null, permissionCodes: values.getAll('permissionCodes'),
    }, editingRole?.version); setEditingRole(null); form.reset(); setNotice('角色已保存；关联员工的旧会话和邀请凭据已失效。'); });
  }
  function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingUser) return; const values = new FormData(event.currentTarget);
    void run(async () => { await request(`users/${editingUser.id}`, 'PATCH', { displayName: values.get('staffName'),
      ...(editingUser.status !== 'invited' ? { status: values.get('status') } : {}),
      ...(has('roles.manage') && !editingUser.roleIds.some(id => roles.find(role => role.id === id)?.kind === 'owner') ? { roleIds: values.getAll('editRoleIds') } : {}),
    }, editingUser.version); setEditingUser(null); setNotice('员工资料已保存，旧会话和邀请凭据已失效。'); });
  }
  return <main className="console"><div className="brand">EZSTART<span>Commerce</span></div><header><div><p className="eyebrow">店铺管理</p><h1>员工与角色</h1></div><div className="actions">{has('catalog.read') && <a href="/admin/catalog">商品目录</a>}{has('members.manage') && <a href="/admin/members">会员与积分</a>}{has('store.settings.manage') && <a href="/admin/settings">店铺设置</a>}{has('audit.read') && <a href="/admin/audit">查看审计记录</a>}<button disabled={busy} onClick={() => void run(async () => { setEditingUser(null); setEditingRole(null); })}>刷新资料</button></div></header>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!ready && !error && <p>正在检查会话与权限…</p>}
    {ready && !has('staff.read') && !has('roles.manage') && <section><h2>没有管理权限</h2><p>请联系店主分配员工读取或角色管理权限。</p></section>}
    {has('staff.read') && <section aria-labelledby="staff-title"><h2 id="staff-title">员工列表</h2><div className="staff-grid">{users.map(user => <article key={user.id}><h3>{user.displayName}</h3><p>{user.email}</p><p>状态：{user.status === 'active' ? '已启用' : user.status === 'invited' ? '待接受邀请' : '已停用'} · 版本 {user.version}</p><small>{user.roleIds.map(id => roles.find(role => role.id === id)?.name ?? id).join('、')}</small>{has('staff.manage') && <div className="actions"><button disabled={busy} onClick={() => setEditingUser(user)}>编辑 {user.displayName}</button><button className="secondary" disabled={busy} onClick={() => { if (confirm(`确认撤销 ${user.displayName} 的全部会话？`)) void run(async () => { await request(`users/${user.id}/sessions/revoke`, 'POST', { reason: '管理员确认撤销员工全部会话' }); setNotice('员工会话已撤销。'); }); }}>撤销 {user.displayName} 的会话</button></div>}</article>)}</div>{userCursor && <button disabled={busy} onClick={() => void loadMore('users')}>加载更多员工</button>}</section>}
    {editingUser && has('staff.manage') && <section aria-labelledby="edit-staff-title"><h2 id="edit-staff-title">编辑员工</h2><form key={`${editingUser.id}:${editingUser.version}`} onSubmit={saveUser}><label>员工姓名<input name="staffName" defaultValue={editingUser.displayName} required maxLength={120} /></label>{editingUser.status !== 'invited' && <label>账号状态<select name="status" defaultValue={editingUser.status}><option value="active">启用</option><option value="suspended">停用</option></select></label>}{has('roles.manage') && <fieldset><legend>员工角色</legend>{roles.filter(role => role.kind !== 'owner').map(role => <label className="check" key={role.id}><input type="checkbox" name="editRoleIds" value={role.id} defaultChecked={editingUser.roleIds.includes(role.id)} />{role.name}</label>)}</fieldset>}<label className="check"><input type="checkbox" required />我确认此次修改，并知悉旧会话和邀请将失效</label><button disabled={busy}>保存员工</button><button type="button" className="secondary" onClick={() => setEditingUser(null)}>取消编辑</button></form></section>}
    {has('staff.manage') && <section aria-labelledby="invite-title"><h2 id="invite-title">邀请员工</h2>{!has('roles.manage') ? <p>选择邀请角色需要角色管理权限，请联系店主。</p> : <form onSubmit={invite}><label>员工邮箱<input name="email" type="email" autoComplete="off" maxLength={254} required /></label><label>显示姓名<input name="displayName" required maxLength={120} /></label><label>通知语言<select name="locale"><option value="zh-CN">简体中文</option><option value="zh-HK">繁體中文</option><option value="en">English</option></select></label><fieldset><legend>分配角色（至少选择一个）</legend>{roles.filter(role => role.kind !== 'owner').map(role => <label className="check" key={role.id}><input type="checkbox" name="roleIds" value={role.id} />{role.name}</label>)}</fieldset><button disabled={busy}>建立员工邀请</button></form>}</section>}
    {has('roles.manage') && <><section aria-labelledby="roles-title"><h2 id="roles-title">角色列表</h2>
      {templates.length > 0 && <p>已按岗位职责预置 {templates.length} 个默认岗位权限包，可直接分配给员工，也可按实际职责调整权限。</p>}
      {roles.map(role => <article key={role.id}><h3>{role.name}{role.presetKey && role.kind !== 'owner' && <span className="preset">默认岗位包</span>}</h3><p>{role.description || '未填写说明'}</p><small>{role.permissionCodes.join('、') || '没有授权权限'}</small><button disabled={busy || role.kind === 'owner'} onClick={() => { setTemplateId(''); setEditingRole(role); }}>编辑角色 {role.name}</button></article>)}
      {roleCursor && <button disabled={busy} onClick={() => void loadMore('roles')}>加载更多角色</button>}</section>
    <section aria-labelledby="role-form-title"><h2 id="role-form-title">{editingRole ? '编辑角色' : '创建角色'}</h2><form key={editingRole ? `${editingRole.id}:${editingRole.version}` : 'new-role'} onSubmit={saveRole}><label>角色名称<input name="roleName" defaultValue={editingRole?.name ?? ''} required maxLength={80} /></label><label>角色说明<textarea name="description" defaultValue={editingRole?.description ?? ''} maxLength={500} /></label>{!editingRole && <label>以默认岗位为模板<select value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="">空白角色（自行勾选权限）</option>{templates.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>}<fieldset key={`${editingRole?.id ?? 'new'}:${templateId}`}><legend>授予权限（仅列出您拥有的权限）</legend><div className="permission-grid">{permissions.map(code => <label className="check" key={code}><input type="checkbox" name="permissionCodes" value={code} defaultChecked={draftCodes.includes(code)} />{code}</label>)}</div></fieldset><label className="check"><input type="checkbox" required />我已核对角色权限并确认保存</label><button disabled={busy}>保存角色</button>{editingRole && <button type="button" className="secondary" onClick={() => { setEditingRole(null); setTemplateId(''); }}>取消角色编辑</button>}</form></section></>}
  </main>;
}
