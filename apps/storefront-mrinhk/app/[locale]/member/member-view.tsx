'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatMinor } from '../../../lib/cart-client';
import {
  fetchOrders, fetchPoints, fetchProfile, logout, memberErrorMessage,
  type MemberOrderView, type MemberPointsView, type MemberProfileView,
} from '../../../lib/member-client';
import { INTL_LOCALE, copyFor, fill, localePath, statusLabel, type Locale } from '../../../lib/i18n';

function tierName(tier: { nameByLocale: Record<string, string>; code: string } | null, locale: Locale) {
  if (!tier) return null;
  // 等级名按当前页面语言取，取不到再退回店铺默认语言，最后才用代码。
  return tier.nameByLocale[locale] ?? tier.nameByLocale['zh-CN'] ?? tier.nameByLocale['en'] ?? tier.code;
}

function formatDate(value: string, locale: Locale) {
  return new Date(value).toLocaleDateString(INTL_LOCALE[locale], { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * 会员中心：身份、等级、积分与订单，全部只读。
 *
 * 数据分三次取（profile / orders / points）而不是一个聚合接口：
 * 积分与订单可能各自慢，且积分功能可以单独关闭——分开放，任何一块失败都不影响其余展示。
 */
export default function MemberView({ locale }: { locale: Locale }) {
  const t = copyFor[locale];
  const [profile, setProfile] = useState<MemberProfileView | null>(null);
  const [orders, setOrders] = useState<MemberOrderView[] | null>(null);
  const [points, setPoints] = useState<MemberPointsView | null>(null);
  const [state, setState] = useState<'loading' | 'anonymous' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchProfile();
    if (!result.ok) {
      if (result.status === 401) { setState('anonymous'); return; }
      setState('error');
      setError(memberErrorMessage(result, t));
      return;
    }
    setProfile(result.data);
    setState('ready');
    const [orderPage, pointPage] = await Promise.all([fetchOrders(20), fetchPoints(20)]);
    setOrders(orderPage.ok ? orderPage.data.items : []);
    setPoints(pointPage.ok ? pointPage.data : null);
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  async function signOut() {
    setBusy(true);
    setSignOutError(null);
    const result = await logout();
    // 401 说明会话本来就没了，等同于登出成功；其他失败要如实告诉用户，不能假装已登出。
    if (!result.ok && result.status !== 401) {
      setBusy(false);
      setSignOutError(t.member.signOutError);
      return;
    }
    // 整页跳转：页头与购物袋都要回到未登录状态。
    window.location.assign(localePath(locale));
  }

  if (state === 'loading') {
    return (
      <section className="section">
        <div className="red-line" />
        <div className="section-head"><span className="num">陸</span><h2>{t.member.heading}</h2>
          <span className="jp">{t.member.jp}</span></div>
        <div className="empty-state">{t.common.loading}</div>
      </section>
    );
  }

  if (state === 'anonymous') {
    return (
      <section className="section">
        <div className="red-line" />
        <div className="section-head"><span className="num">陸</span><h2>{t.member.heading}</h2>
          <span className="jp">{t.member.jp}</span></div>
        <div className="member-auth">
          <div className="member-auth-body">
            <p className="member-auth-lead">{t.member.anonymousLead}</p>
            <div className="member-auth-actions">
              <Link className="btn btn-primary" href={localePath(locale, '/login')}>{t.member.signInJoin}</Link>
              <Link className="link-btn" href={localePath(locale, '/products')}>{t.member.browseFirst}</Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (state === 'error' || !profile) {
    return (
      <section className="section">
        <div className="red-line" />
        <div className="section-head"><span className="num">陸</span><h2>{t.member.heading}</h2>
          <span className="jp">{t.member.jp}</span></div>
        <div className="empty-state">
          <p>{error ?? t.member.loadError}</p>
          <button className="btn btn-ghost" type="button" style={{ marginTop: 18 }}
            onClick={() => { setState('loading'); void load(); }}>{t.common.retry}</button>
        </div>
      </section>
    );
  }

  const name = tierName(profile.loyalty.tier, locale);
  const spend = formatMinor(profile.loyalty.lifetimeSpendMinor, 'HKD');

  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">陸</span>
        <h2>{t.member.heading}</h2>
        <span className="jp">{t.member.jp}</span>
      </div>

      <div className="member-grid">
        <div className="member-card">
          <span className="member-label">{t.member.label}</span>
          <p className="member-name">{profile.displayName}</p>
          <dl className="member-facts">
            <div><dt>{t.member.memberNo}</dt><dd>{profile.memberNo}</dd></div>
            <div><dt>{t.member.email}</dt><dd>{profile.email ?? '—'}</dd></div>
            <div><dt>{t.member.joinedAt}</dt><dd>{formatDate(profile.joinedAt, locale)}</dd></div>
            <div><dt>{t.member.lifetimeSpend}</dt><dd>{spend}</dd></div>
          </dl>
        </div>

        <div className="member-card member-points">
          <span className="member-label">{t.member.availablePoints}</span>
          <p className="member-balance">{profile.loyalty.balance.toLocaleString(INTL_LOCALE[locale])}</p>
          <p className="member-tier">
            {name ? fill(t.member.currentTier, { tier: name }) : t.member.noTier}
          </p>
          <p className="form-note">
            {profile.loyalty.pointsEnabled
              ? fill(t.member.pointsRule, { amount: formatMinor(profile.loyalty.minorPerPoint, 'HKD') })
              : t.member.pointsDisabled}
          </p>
          {points?.pointsExpiryMonths ? (
            <p className="form-note">{fill(t.member.pointsExpiry, { months: points.pointsExpiryMonths })}</p>
          ) : null}
          {profile.loyalty.tier && profile.loyalty.tier.benefits.length > 0 && (
            <ul className="member-benefits">
              {profile.loyalty.tier.benefits.map((benefit) => <li key={benefit}>{benefit}</li>)}
            </ul>
          )}
        </div>
      </div>

      <div className="member-section">
        <h3>{t.member.pointsHistory}</h3>
        {!points && <p className="form-note">{t.member.pointsUnavailable}</p>}
        {points && points.items.length === 0 && <p className="form-note">{t.member.pointsEmpty}</p>}
        {points && points.items.length > 0 && (
          <table className="member-table">
            <thead>
              <tr><th>{t.member.date}</th><th>{t.member.description}</th><th>{t.member.change}</th>
                <th>{t.member.balance}</th></tr>
            </thead>
            <tbody>
              {points.items.map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.createdAt, locale)}</td>
                  <td>
                    {statusLabel(t.member.entryType, row.entryType)}
                    {row.reason && <small>{row.reason}</small>}
                  </td>
                  <td className={row.deltaPoints >= 0 ? 'positive' : 'negative'}>
                    {row.deltaPoints >= 0 ? `+${row.deltaPoints}` : row.deltaPoints}
                  </td>
                  <td>{row.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="member-section">
        <h3>{t.member.orders}</h3>
        {!orders && <p className="form-note">{t.member.ordersUnavailable}</p>}
        {orders && orders.length === 0 && (
          <p className="form-note">
            {t.member.ordersEmpty}<Link href={localePath(locale, '/products')}>{t.member.ordersEmptyLink}</Link>
            {t.member.ordersEmptyTail}
          </p>
        )}
        {orders && orders.length > 0 && (
          <table className="member-table">
            <thead>
              <tr><th>{t.member.orderNumber}</th><th>{t.member.placedAt}</th><th>{t.member.status}</th>
                <th>{t.member.payment}</th><th>{t.member.amount}</th></tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderNumber}>
                  <td className="mono">{order.orderNumber}</td>
                  <td>{formatDate(order.placedAt, locale)}</td>
                  <td>{statusLabel(t.member.orderStatus, order.orderStatus)}</td>
                  <td>{statusLabel(t.member.paymentStatus, order.paymentStatus)}</td>
                  <td>{formatMinor(order.totalMinor, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="member-footer">
        <p className="form-note">
          {t.member.footerNote}
          {signOutError && <><br /><span className="form-note error">{signOutError}</span></>}
        </p>
        <button className="link-btn" type="button" disabled={busy} onClick={() => void signOut()}>
          {busy ? t.member.signingOut : t.member.signOut}
        </button>
      </div>
    </section>
  );
}
