'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchProfile, memberErrorMessage, requestOtp, verifyOtp, type OtpChallengeView,
} from '../../lib/member-client';
import { site } from '../../lib/site';

/**
 * 会员登录：邮箱 + 一次性验证码，没有密码。
 *
 * 两段式而不是一屏：验证码有时效（10 分钟）且有 60 秒重发冷却，
 * 分成两步才能把「重发倒计时」和「本次验证码剩余时间」都说清楚。
 * 页面不对邮箱是否已注册做任何判断——服务端对两种情况返回完全相同的响应。
 */
export default function LoginPage() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<OtpChallengeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [expiresIn, setExpiresIn] = useState(0);
  const [alreadySignedIn, setAlreadySignedIn] = useState(false);

  // 已经登入就没必要再看登录表单；顺手把会话 CSRF 恢复进 sessionStorage。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchProfile();
      if (!cancelled && result.ok) setAlreadySignedIn(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // 一个计时器同时驱动「重发冷却」与「验证码剩余时间」，避免两条 setInterval 各减各的。
  useEffect(() => {
    if (resendIn <= 0 && expiresIn <= 0) return;
    const timer = window.setInterval(() => {
      setResendIn((value) => (value > 0 ? value - 1 : 0));
      setExpiresIn((value) => (value > 0 ? value - 1 : 0));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [resendIn > 0, expiresIn > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyChallenge = useCallback((next: OtpChallengeView) => {
    setChallenge(next);
    setStep('code');
    setCode('');
    setResendIn(next.resendAfterSeconds);
    setExpiresIn(next.expiresInSeconds);
  }, []);

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('請輸入有效的電郵地址。');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await requestOtp(value, site.checkoutLocale);
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 429 ? '申請過於頻繁，請稍後再試。' : memberErrorMessage(result));
      return;
    }
    applyChallenge(result.data);
    setNotice(`驗證碼已寄出，請在 ${Math.round(result.data.expiresInSeconds / 60)} 分鐘內使用。`);
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) {
      setError('請輸入 6 位數字驗證碼。');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await verifyOtp(challenge.challengeId, code);
    if (!result.ok) {
      setBusy(false);
      setError(memberErrorMessage(result));
      return;
    }
    // 整页跳转：页头的会员入口与购物袋徽标都要按新状态重新取一次。
    window.location.assign('/member');
  }

  async function resend() {
    if (resendIn > 0 || busy) return;
    setBusy(true);
    setError(null);
    const result = await requestOtp(email.trim(), site.checkoutLocale);
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 429 ? '申請過於頻繁，請稍後再試。' : memberErrorMessage(result));
      return;
    }
    applyChallenge(result.data);
    setNotice('已重新寄出驗證碼，先前的驗證碼同時失效。');
  }

  const masked = email.trim().replace(/^(.)(.*)@/, (_, first: string, rest: string) =>
    `${first}${'*'.repeat(Math.min(3, Math.max(0, rest.length)))}@`);

  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">伍</span>
        <h2>會員登入</h2>
        <span className="jp">ログイン</span>
      </div>

      <div className="member-auth">
        {alreadySignedIn ? (
          <div className="member-auth-body">
            <p>你已登入會員帳戶。</p>
            <div className="member-auth-actions">
              <Link className="btn btn-primary" href="/member">前往會員中心</Link>
              <Link className="link-btn" href="/products">繼續購物</Link>
            </div>
          </div>
        ) : step === 'email' ? (
          <form className="member-auth-body" onSubmit={(event) => void submitEmail(event)}>
            <p className="member-auth-lead">
              輸入電郵地址，我們會寄出一組 6 位驗證碼。首次登入會自動為你建立會員帳戶，不需設定密碼。
            </p>
            <label className="member-field">
              <span>電郵地址</span>
              <input type="email" name="email" autoComplete="email" required value={email}
                placeholder="you@example.com" disabled={busy}
                onChange={(event) => setEmail(event.target.value)} />
            </label>
            {error && <p className="form-note error">{error}</p>}
            <button className="btn btn-primary member-auth-submit" type="submit" disabled={busy}>
              {busy ? '寄出中…' : '取得驗證碼'}
            </button>
            <p className="form-note">
              登入即表示你同意我們依《私隱政策》處理你的電郵與訂單資料。我們不會寄送廣告郵件。
            </p>
          </form>
        ) : (
          <form className="member-auth-body" onSubmit={(event) => void submitCode(event)}>
            <p className="member-auth-lead">
              驗證碼已寄至 <strong>{masked}</strong>。請在 {Math.max(1, Math.ceil(expiresIn / 60))} 分鐘內輸入。
            </p>
            <label className="member-field">
              <span>6 位驗證碼</span>
              <input className="code-input" type="text" inputMode="numeric" autoComplete="one-time-code"
                name="code" required maxLength={6} value={code} disabled={busy} placeholder="000000"
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} />
            </label>
            {notice && !error && <p className="form-note">{notice}</p>}
            {error && <p className="form-note error">{error}</p>}
            <button className="btn btn-primary member-auth-submit" type="submit" disabled={busy || code.length !== 6}>
              {busy ? '驗證中…' : '登入'}
            </button>
            <div className="member-auth-actions">
              <button className="link-btn" type="button" onClick={() => void resend()} disabled={resendIn > 0 || busy}>
                {resendIn > 0 ? `重新寄出（${resendIn} 秒）` : '重新寄出驗證碼'}
              </button>
              <button className="link-btn" type="button" disabled={busy}
                onClick={() => { setStep('email'); setChallenge(null); setCode(''); setError(null); setNotice(null); }}>
                更換電郵地址
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
