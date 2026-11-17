'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatMinor } from '../../lib/cart-client';
import {
  fetchOrders, fetchPoints, fetchProfile, logout, memberErrorMessage,
  type MemberOrderView, type MemberPointsView, type MemberProfileView,
} from '../../lib/member-client';

/** 状态文案只描述客户能看到的事实，不暴露内部流程（例如风控、人工审核队列）。 */
const ORDER_STATUS: Record<string, string> = {
  pending_payment: '待付款', awaiting_confirmation: '待確認', confirmed: '已確認', processing: '處理中',
  on_hold: '暫停處理', partially_shipped: '部分出貨', shipped: '已出貨', completed: '已完成', cancelled: '已取消',
};
const PAYMENT_STATUS: Record<string, string> = {
  created: '待付款', requires_action: '待完成付款', processing: '付款處理中', succeeded: '已付款', failed: '付款失敗',
  cancelled: '付款已取消', unknown: '付款狀態待確認', cod_due: '貨到付款', collected: '已收款',
  rejected: '付款被拒', returned: '款項已退回',
};
const ENTRY_TYPE: Record<string, string> = {
  earn: '購物回贈', adjust: '人工調整', redeem: '兌換扣減', expire: '積分到期', reversal: '退回調整',
};

function tierName(tier: { nameByLocale: Record<string, string>; code: string } | null) {
  if (!tier) return null;
  return tier.nameByLocale['zh-HK'] ?? tier.nameByLocale['zh-CN'] ?? tier.nameByLocale['en'] ?? tier.code;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('zh-HK', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * 会员中心：身份、等级、积分与订单，全部只读。
 *
 * 数据分三次取（profile / orders / points）而不是一个聚合接口：
 * 积分与订单可能各自慢，且积分功能可以单独关闭——分开放，任何一块失败都不影响其余展示。
 */
export default function MemberPage() {
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
      setError(memberErrorMessage(result));
      return;
    }
    setProfile(result.data);
    setState('ready');
    const [orderPage, pointPage] = await Promise.all([fetchOrders(20), fetchPoints(20)]);
    setOrders(orderPage.ok ? orderPage.data.items : []);
    setPoints(pointPage.ok ? pointPage.data : null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function signOut() {
    setBusy(true);
    setSignOutError(null);
    const result = await logout();
    // 401 说明会话本来就没了，等同于登出成功；其他失败要如实告诉用户，不能假装已登出。
    if (!result.ok && result.status !== 401) {
      setBusy(false);
      setSignOutError('登出未能完成，請再試一次。');
      return;
    }
    // 整页跳转：页头与购物袋都要回到未登录状态。
    window.location.assign('/');
  }

  if (state === 'loading') {
    return (
      <section className="section">
        <div className="red-line" />
        <div className="section-head"><span className="num">陸</span><h2>會員中心</h2><span className="jp">マイページ</span></div>
        <div className="empty-state">載入中…</div>
      </section>
    );
  }

  if (state === 'anonymous') {
    return (
      <section className="section">
        <div className="red-line" />
        <div className="section-head"><span className="num">陸</span><h2>會員中心</h2><span className="jp">マイページ</span></div>
        <div className="member-auth">
          <div className="member-auth-body">
            <p className="member-auth-lead">登入後即可查看訂單、積分與會員等級。我們只用一組電郵驗證碼辨識身份，不需密碼。</p>
            <div className="member-auth-actions">
              <Link className="btn btn-primary" href="/login">登入 / 加入會員</Link>
              <Link className="link-btn" href="/products">先看看商品</Link>
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
        <div className="section-head"><span className="num">陸</span><h2>會員中心</h2><span className="jp">マイページ</span></div>
        <div className="empty-state">
          <p>{error ?? '會員資料暫時無法載入。'}</p>
          <button className="btn btn-ghost" type="button" style={{ marginTop: 18 }}
            onClick={() => { setState('loading'); void load(); }}>重新載入</button>
        </div>
      </section>
    );
  }

  const name = tierName(profile.loyalty.tier);
  const spend = formatMinor(profile.loyalty.lifetimeSpendMinor, 'HKD');

  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">陸</span>
        <h2>會員中心</h2>
        <span className="jp">マイページ</span>
      </div>

      <div className="member-grid">
        <div className="member-card">
          <span className="member-label">會員</span>
          <p className="member-name">{profile.displayName}</p>
          <dl className="member-facts">
            <div><dt>會員編號</dt><dd>{profile.memberNo}</dd></div>
            <div><dt>電郵</dt><dd>{profile.email ?? '—'}</dd></div>
            <div><dt>加入日期</dt><dd>{formatDate(profile.joinedAt)}</dd></div>
            <div><dt>累計消費</dt><dd>{spend}</dd></div>
          </dl>
        </div>

        <div className="member-card member-points">
          <span className="member-label">可用積分</span>
          <p className="member-balance">{profile.loyalty.balance.toLocaleString('zh-HK')}</p>
          <p className="member-tier">
            {name ? <>目前等級：<strong>{name}</strong></> : '尚未達到任何會員等級'}
          </p>
          <p className="form-note">
            {profile.loyalty.pointsEnabled
              ? `每消費 ${formatMinor(profile.loyalty.minorPerPoint, 'HKD')} 可累積 1 分，訂單全部送達後入帳。`
              : '積分功能尚未啟用，你的消費仍會計入會員等級。'}
          </p>
          {profile.loyalty.tier && profile.loyalty.tier.benefits.length > 0 && (
            <ul className="member-benefits">
              {profile.loyalty.tier.benefits.map((benefit) => <li key={benefit}>{benefit}</li>)}
            </ul>
          )}
        </div>
      </div>

      <div className="member-section">
        <h3>積分記錄</h3>
        {!points && <p className="form-note">積分資料暫時無法載入。</p>}
        {points && points.items.length === 0 && <p className="form-note">還沒有積分記錄。完成第一張訂單後就會看到。</p>}
        {points && points.items.length > 0 && (
          <table className="member-table">
            <thead>
              <tr><th>日期</th><th>說明</th><th>變動</th><th>結餘</th></tr>
            </thead>
            <tbody>
              {points.items.map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.createdAt)}</td>
                  <td>
                    {ENTRY_TYPE[row.entryType] ?? row.entryType}
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
        <h3>我的訂單</h3>
        {!orders && <p className="form-note">訂單資料暫時無法載入。</p>}
        {orders && orders.length === 0 && (
          <p className="form-note">
            還沒有訂單。<Link href="/products">去看看商品</Link>，完成訂單後會自動歸到這個帳戶。
          </p>
        )}
        {orders && orders.length > 0 && (
          <table className="member-table">
            <thead>
              <tr><th>訂單編號</th><th>下單日期</th><th>狀態</th><th>付款</th><th>金額</th></tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderNumber}>
                  <td className="mono">{order.orderNumber}</td>
                  <td>{formatDate(order.placedAt)}</td>
                  <td>{ORDER_STATUS[order.orderStatus] ?? order.orderStatus}</td>
                  <td>{PAYMENT_STATUS[order.paymentStatus] ?? order.paymentStatus}</td>
                  <td>{formatMinor(order.totalMinor, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="member-footer">
        <p className="form-note">
          需要修改訂單或查詢配送？透過 WhatsApp 聯絡我們會更快。
          {signOutError && <><br /><span className="form-note error">{signOutError}</span></>}
        </p>
        <button className="link-btn" type="button" disabled={busy} onClick={() => void signOut()}>
          {busy ? '登出中…' : '登出'}
        </button>
      </div>
    </section>
  );
}
