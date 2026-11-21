"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Mode = 'request' | 'complete' | 'sent' | 'done';
export function ResetForm() {
  const [mode, setMode] = useState<Mode>('request');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const reset = useRef('');
  // Ref survives development effect re-runs; the credential never enters browser storage.
  useEffect(() => {
    if (location.hash) { reset.current = location.hash.slice(1); history.replaceState(null, '', location.pathname); }
    if (reset.current) setMode('complete');
    setReady(true);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget; const values = new FormData(form);
    setBusy(true); setError('');
    try {
      const body = mode === 'request' ? { email: values.get('email') }
        : { resetToken: reset.current, newPassword: values.get('password') };
      const response = await fetch('/api/v1/admin/auth/password-reset', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const code = payload?.error?.code;
        throw new Error(code === 'RATE_LIMITED' ? '操作过于频繁，请稍后重试。' : response.status === 401
          ? '重设链接已失效或已被使用，请重新申请。' : '操作未完成，请检查填写内容后重试。');
      }
      form.reset();
      if (mode === 'complete') reset.current = '';
      setMode(mode === 'request' ? 'sent' : 'done');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <main><div className="brand">EZSTART<span>Commerce</span></div><section aria-labelledby="title">
    <p className="eyebrow">店铺管理 · 账号恢复</p>
    <h1 id="title">{mode === 'request' ? '重设后台密码' : mode === 'complete' ? '设置新密码' : mode === 'sent' ? '请查收邮件' : '密码已重设'}</h1>
    {mode === 'request' && <p>输入员工邮箱。若该邮箱属于本店员工，我们会发送一次性的重设链接。</p>}
    {mode === 'complete' && <p>链接 30 分钟内有效且只能使用一次。重设完成后，所有已登录会话将被退出，验证器与恢复码保持不变。</p>}
    {mode === 'sent' && <p>如果该邮箱已注册，重设邮件正在发送，请检查收件箱与垃圾邮件目录。未收到时可在一分钟后重新申请。</p>}
    {mode === 'done' && <p>新密码已生效。请使用新密码登录，并继续完成身份验证。</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {(mode === 'request' || mode === 'complete') && <form onSubmit={submit}>
      {mode === 'request' && <label>员工邮箱<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>}
      {mode === 'complete' && <label>新密码<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={256} required /><small>至少 8 个字符，请使用独立密码。</small></label>}
      <button disabled={busy || !ready}>{busy ? '正在处理…' : mode === 'request' ? '发送重设链接' : '设置新密码'}</button>
    </form>}
    {mode === 'complete' && <a href="/admin/reset-password">链接无效？重新申请</a>}
    {mode !== 'complete' && <a href="/admin/login">返回登录</a>}
  </section><p className="footer">账号仅用于当前店铺，请勿与其他员工共用。</p></main>;
}
