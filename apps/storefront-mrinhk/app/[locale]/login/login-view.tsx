'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchProfile, memberErrorMessage, requestOtp, verifyOtp, type OtpChallengeView,
} from '../../../lib/member-client';
import { copyFor, fill, localePath, type Locale } from '../../../lib/i18n';

/**
 * 会员登录：邮箱 + 一次性验证码，没有密码。
 *
 * 两段式而不是一屏：验证码有时效（10 分钟）且有 60 秒重发冷却，
 * 分成两步才能把「重发倒计时」和「本次验证码剩余时间」都说清楚。
 * 页面不对邮箱是否已注册做任何判断——服务端对两种情况返回完全相同的响应。
 */
export default function LoginView({ locale }: { locale: Locale }) {
  const t = copyFor[locale];
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
      setError(t.login.invalidEmail);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    // OTP 邮件模板按这个语言发送，所以传的是当前页面语言。
    const result = await requestOtp(value, locale);
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 429 ? t.login.tooMany : memberErrorMessage(result, t));
      return;
    }
    applyChallenge(result.data);
    setNotice(fill(t.login.sentNotice, { minutes: Math.round(result.data.expiresInSeconds / 60) }));
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) {
      setError(t.login.invalidCode);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await verifyOtp(challenge.challengeId, code);
    if (!result.ok) {
      setBusy(false);
      setError(memberErrorMessage(result, t));
      return;
    }
    // 整页跳转：页头的会员入口与购物袋徽标都要按新状态重新取一次。
    window.location.assign(localePath(locale, '/member'));
  }

  async function resend() {
    if (resendIn > 0 || busy) return;
    setBusy(true);
    setError(null);
    const result = await requestOtp(email.trim(), locale);
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 429 ? t.login.tooMany : memberErrorMessage(result, t));
      return;
    }
    applyChallenge(result.data);
    setNotice(t.login.resentNotice);
  }

  const masked = email.trim().replace(/^(.)(.*)@/, (_, first: string, rest: string) =>
    `${first}${'*'.repeat(Math.min(3, Math.max(0, rest.length)))}@`);

  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">伍</span>
        <h2>{t.login.heading}</h2>
        <span className="jp">{t.login.jp}</span>
      </div>

      <div className="member-auth">
        {alreadySignedIn ? (
          <div className="member-auth-body">
            <p>{t.login.signedIn}</p>
            <div className="member-auth-actions">
              <Link className="btn btn-primary" href={localePath(locale, '/member')}>{t.login.toMember}</Link>
              <Link className="link-btn" href={localePath(locale, '/products')}>{t.common.continueShopping}</Link>
            </div>
          </div>
        ) : step === 'email' ? (
          <form className="member-auth-body" onSubmit={(event) => void submitEmail(event)}>
            <p className="member-auth-lead">{t.login.lead}</p>
            <label className="member-field">
              <span>{t.login.emailLabel}</span>
              <input type="email" name="email" autoComplete="email" required value={email}
                placeholder="you@example.com" disabled={busy}
                onChange={(event) => setEmail(event.target.value)} />
            </label>
            {error && <p className="form-note error">{error}</p>}
            <button className="btn btn-primary member-auth-submit" type="submit" disabled={busy}>
              {busy ? t.login.sending : t.login.getCode}
            </button>
            <p className="form-note">{t.login.privacyNote}</p>
          </form>
        ) : (
          <form className="member-auth-body" onSubmit={(event) => void submitCode(event)}>
            <p className="member-auth-lead">
              {fill(t.login.codeLead, { email: masked, minutes: Math.max(1, Math.ceil(expiresIn / 60)) })}
            </p>
            <label className="member-field">
              <span>{t.login.codeLabel}</span>
              <input className="code-input" type="text" inputMode="numeric" autoComplete="one-time-code"
                name="code" required maxLength={6} value={code} disabled={busy} placeholder="000000"
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} />
            </label>
            {notice && !error && <p className="form-note">{notice}</p>}
            {error && <p className="form-note error">{error}</p>}
            <button className="btn btn-primary member-auth-submit" type="submit" disabled={busy || code.length !== 6}>
              {busy ? t.login.verifying : t.login.verify}
            </button>
            <div className="member-auth-actions">
              <button className="link-btn" type="button" onClick={() => void resend()} disabled={resendIn > 0 || busy}>
                {resendIn > 0 ? fill(t.login.resendIn, { seconds: resendIn }) : t.login.resend}
              </button>
              <button className="link-btn" type="button" disabled={busy}
                onClick={() => { setStep('email'); setChallenge(null); setCode(''); setError(null); setNotice(null); }}>
                {t.login.changeEmail}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
