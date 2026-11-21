"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Mode = 'invite' | 'login' | 'enroll' | 'verify' | 'done';
export function IdentityForm({ initialMode }: { initialMode: 'invite' | 'login' }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [ready, setReady] = useState(false); const [secret, setSecret] = useState('');
  const [codes, setCodes] = useState<string[]>([]); const [saved, setSaved] = useState(false);
  const invitation = useRef(''); const challenge = useRef(''); const enrollment = useRef('');
  // Ref survives development effect re-runs; credentials never enter browser storage.
  useEffect(() => {
    if (location.hash) { invitation.current = location.hash.slice(1); history.replaceState(null, '', location.pathname); }
    setReady(true);
  }, []);
  async function api(path: string, body: object) {
    const response = await fetch(`/api/v1/admin/auth/${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) {
      const code = payload?.error?.code;
      throw new Error(code === 'RATE_LIMITED' ? '操作过于频繁，请稍后重试。' : response.status === 401 ? '凭据已失效或验证码不正确。已设置密码的员工可使用密码登录继续。' : '操作未完成，请重试或联系店主。');
    }
    return payload.data;
  }
  async function startEnrollment() {
    const data = await api('mfa/enrollments', { challengeId: challenge.current });
    enrollment.current = data.enrollmentId; setSecret(data.totpSecret);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget; const values = new FormData(form);
    setBusy(true); setError('');
    try {
      if (mode === 'invite' || mode === 'login') {
        if (mode === 'invite' && !invitation.current) throw new Error('邀请链接缺少凭据，请重新打开完整邮件链接。');
        const data = mode === 'invite' ? await api('invitations/accept', { invitationToken: invitation.current, newPassword: values.get('password') })
          : await api('login', { email: values.get('email'), password: values.get('password') });
        form.reset(); invitation.current = '';
        if (data.nextAction) {
          challenge.current = data.challengeId;
          if (data.nextAction === 'enroll_mfa') { setMode('enroll'); await startEnrollment(); }
          else setMode('verify');
        } else setMode('done');
      } else if (mode === 'enroll') {
        if (!enrollment.current) { await startEnrollment(); return; }
        const data = await api('mfa/enrollments/confirm', { challengeId: challenge.current, enrollmentId: enrollment.current, code: values.get('code') });
        form.reset(); setCodes(data.recoveryCodes); setSecret(''); challenge.current = ''; enrollment.current = ''; setMode('done');
      } else if (mode === 'verify') {
        await api('mfa/verify', { challengeId: challenge.current, code: values.get('code') });
        form.reset(); challenge.current = ''; setMode('done');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请求未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <main><div className="brand">EZSTART<span>Commerce</span></div><section aria-labelledby="title">
    <p className="eyebrow">店铺管理 · 安全访问</p>
    <h1 id="title">{mode === 'invite' ? '接受员工邀请' : mode === 'login' ? '登录店铺后台' : mode === 'enroll' ? '绑定身份验证器' : mode === 'verify' ? '验证您的身份' : '身份验证已完成'}</h1>
    {mode === 'invite' && <p>设置您自己的密码，再绑定验证器，完成店铺员工账号开通。</p>}
    {mode === 'login' && <p>使用账号和密码登录。未完成的验证器登记可在登录后继续。</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <form onSubmit={submit}>
      {mode === 'login' && <label>账号<input name="email" type="text" autoComplete="username" required maxLength={254} /></label>}
      {(mode === 'invite' || mode === 'login') && <label>{mode === 'invite' ? '设置密码' : '密码'}<input name="password" type="password" autoComplete={mode === 'invite' ? 'new-password' : 'current-password'} minLength={8} maxLength={256} required /><small>至少 8 个字符，请使用独立密码。</small></label>}
      {mode === 'enroll' && <><p>在验证器中选择手动添加账号，输入以下密钥，再填写生成的六位验证码。</p>{secret && <div className="secret"><code>{secret}</code><small>此密钥仅用于本次绑定，请勿分享。</small></div>}{enrollment.current && <label>六位验证码<input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required /></label>}<small>登记超时或页面刷新后，请使用密码重新登录。</small></>}
      {mode === 'verify' && <label>验证码或恢复码<input name="code" autoComplete="one-time-code" required maxLength={20} /></label>}
      {mode !== 'done' && <button disabled={busy || !ready}>{busy ? '正在处理…' : mode === 'invite' ? '设置密码并继续' : mode === 'enroll' ? enrollment.current ? '确认绑定' : '重新获取绑定密钥' : '继续'}</button>}
    </form>
    {mode === 'done' && <><a href="/admin/access">进入员工与角色管理</a>{codes.length > 0 ? <><p>请立即离线保存恢复码。每个恢复码只能使用一次，离开后无法再次查看。</p><ul className="codes">{codes.map(code => <li key={code}><code>{code}</code></li>)}</ul><label className="check"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />我已离线保存恢复码</label>{saved && <button onClick={() => { setCodes([]); setSaved(false); }}>隐藏恢复码</button>}</> : <p>身份会话已建立。您可以进入员工与角色管理。</p>}</>}
    {(mode === 'invite' || mode === 'enroll' || mode === 'verify') && <a href="/admin/login">已设置密码？重新登录</a>}
    {(mode === 'login' || mode === 'done') && <a href="/admin/reset-password">忘记密码？申请一次性重设链接</a>}
  </section><p className="footer">账号仅用于当前店铺，请勿与其他员工共用。</p></main>;
}
