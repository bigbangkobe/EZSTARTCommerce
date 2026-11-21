"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Session = { user: { email: string; displayName: string; mustChangePassword: boolean }; csrfToken: string };

/**
 * 修改自己的后台密码。
 * 首次登录（店主直建账号，初始密码经微信/口头传递）会强制跳到这一页，
 * 未完成改密前，除会话查询与登出外的后台接口都会返回 403 PASSWORD_CHANGE_REQUIRED。
 */
export function PasswordForm() {
  const session = useRef<Session | null>(null);
  const [pending, setPending] = useState(false); const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => {
    fetch('/api/v1/admin/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('unauthorized')))
      .then(payload => { session.current = payload.data; setPending(Boolean(payload.data.user.mustChangePassword)); setReady(true); })
      .catch(() => location.assign('/admin/login'));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget; const values = new FormData(form);
    const currentPassword = String(values.get('currentPassword') ?? '');
    const newPassword = String(values.get('newPassword') ?? '');
    const confirm = String(values.get('confirmPassword') ?? '');
    setError(''); setNotice('');
    if (newPassword.length < 8) { setError('新密码至少需要 8 个字符。'); return; }
    if (newPassword !== confirm) { setError('两次输入的新密码不一致。'); return; }
    if (newPassword === currentPassword) { setError('新密码不能与当前密码相同。'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/v1/admin/auth/password', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.current?.csrfToken ?? '' },
        body: JSON.stringify({ currentPassword, newPassword }) });
      if (!response.ok) {
        if (response.status === 401) throw new Error('当前密码不正确，请重新输入。');
        if (response.status === 403) throw new Error('会话或来源校验未通过，请重新登录后再试。');
        if (response.status === 429) throw new Error('尝试过于频繁，请稍后再试。');
        throw new Error('密码未修改，请检查填写内容后重试。');
      }
      form.reset(); session.current = { ...session.current!, csrfToken: session.current!.csrfToken };
      setPending(false); setNotice('密码已更新，其他设备上的旧登录已失效。');
      setTimeout(() => location.assign('/admin/access'), 600);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <main><div className="brand">EZSTART<span>Commerce</span></div><section aria-labelledby="title">
    <p className="eyebrow">店铺管理 · 账号安全</p>
    <h1 id="title">修改密码</h1>
    {pending && <p role="status" className="notice">这是店主设置的初始密码，请先设置只有你自己知道的新密码，再进入后台。</p>}
    {!pending && ready && <p>修改成功后，你在其他设备上的登录会立即失效。</p>}
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <form onSubmit={submit}>
      <label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" maxLength={256} required /></label>
      <label>新密码<input name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={256} required /><small>至少 8 个字符，请勿与初始密码相同。</small></label>
      <label>确认新密码<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} maxLength={256} required /></label>
      <button disabled={busy || !ready}>{busy ? '正在保存…' : '保存新密码'}</button>
    </form>
    <a href="/admin/access">返回员工与角色管理</a>
  </section><p className="footer">账号仅用于当前店铺，请勿与其他员工共用。</p></main>;
}
