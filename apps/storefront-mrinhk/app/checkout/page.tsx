'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  api, createQuote, formatMinor, listShippingMethods, notifyCartUpdated, placeOrder,
  type ApiOutcome, type CartView, type OrderCreatedView, type ShippingMethodView,
} from '../../lib/cart-client';
import { fetchProfile, type MemberProfileView } from '../../lib/member-client';
import { trackBeginCheckout } from '../../lib/analytics-client';
import { site } from '../../lib/site';
import MemberNudge from './member-nudge';

/**
 * 结账页：三步一屏（收货资料 → 配送方式 → 付款），全部基于服务端报价，
 * 浏览器只提交选择与地址，不提交任何金额。
 */
export default function CheckoutPage() {
  const [cart, setCart] = useState<CartView | null>(null);
  const [methods, setMethods] = useState<ShippingMethodView[] | null>(null);
  const [methodId, setMethodId] = useState<string>('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderCreatedView | null>(null);
  const [member, setMember] = useState<MemberProfileView | null>(null);
  const [pointsToUse, setPointsToUse] = useState('');
  const [form, setForm] = useState({
    fullName: '', phone: '', recipientName: '', city: '', district: '', addressLine1: '', addressLine2: '',
  });

  const loadCart = useCallback(async () => {
    const result = await api<CartView>('GET', '/storefront/cart');
    setCart(result.ok ? result.data : null);
  }, []);

  useEffect(() => {
    void loadCart();
  }, [loadCart]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchProfile();
      if (!cancelled && result.ok) setMember(result.data);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!cart || cart.items.length === 0) return;
    let cancelled = false;
    void (async () => {
      const result = await listShippingMethods('HK', site.checkoutLocale);
      if (cancelled || !result.ok) return;
      setMethods(result.data.items);
      setMethodId((current) => current || result.data.items[0]?.id || '');
    })();
    return () => { cancelled = true; };
  }, [cart]);

  const method = methods?.find((item) => item.id === methodId) ?? null;
  // 输入框只是「想用多少」；实际抵扣以服务端报价为准，页面不自己算钱。
  const points = Math.max(0, Math.min(Number.parseInt(pointsToUse, 10) || 0, member?.loyalty.balance ?? 0));

  function update(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit() {
    if (!cart || !method) return;
    setBusy(true);
    setError(null);
    // 开始结账：在提交报价之前上报；成功下单由服务端订单权威归因，不发浏览器 purchase。
    void trackBeginCheckout('checkout', site.checkoutLocale, site.marketCode);
    const quote = await createQuote({
      cartId: cart.cartId,
      locale: site.checkoutLocale,
      marketCode: site.marketCode,
      contact: { fullName: form.fullName, phone: form.phone },
      shippingAddress: {
        recipientName: form.recipientName || form.fullName,
        phone: form.phone,
        countryCode: 'HK',
        city: form.city,
        district: form.district,
        addressLine1: form.addressLine1,
        addressLine2: form.addressLine2,
      },
      shippingMethodId: method.id,
      ...(points > 0 ? { pointsToUse: points } : {}),
      policyAcceptances: site.policies.map((policy) => ({ ...policy, accepted: true as const })),
    });
    if (!quote.ok) {
      setBusy(false);
      setError(describe(quote));
      // 库存/购物袋状态可能已变化，重读一次
      await loadCart();
      return;
    }
    const placed = await placeOrder(quote.data.quoteId, quote.data.version, 'cod');
    setBusy(false);
    if (!placed.ok) {
      setError(describe(placed));
      await loadCart();
      return;
    }
    setOrder(placed.data);
    notifyCartUpdated();
  }

  // ---- 已下单：确认面板 ----
  if (order) {
    return (
      <section className="section">
        <div className="red-line" />
        <div className="section-head">
          <span className="num">肆</span>
          <h2>訂單已確認</h2>
          <span className="jp">ご注文ありがとう</span>
        </div>
        <div className="card order-confirmed">
          <div className="order-number">{order.publicOrderNumber}</div>
          <ul className="order-facts">
            <li>訂單狀態：<strong>{order.orderStatus === 'awaiting_confirmation' ? '待確認' : order.orderStatus}</strong></li>
            <li>付款方式：<strong>貨到付款（現金）</strong></li>
            <li>應付金額：<strong>{formatMinor(order.totalMinor, order.currency)}</strong></li>
            {order.pointsRedeemed > 0 && <li>已用積分：<strong>{order.pointsRedeemed} 分（抵 {formatMinor(order.pointsValueMinor, order.currency)}）</strong></li>}
          </ul>
          {order.paymentAction?.instructions && <p className="form-note">{order.paymentAction.instructions}</p>}
          <div className="cta-row" style={{ marginTop: 24 }}>
            <Link className="btn btn-primary" href="/products">繼續選購</Link>
          </div>
        </div>
      </section>
    );
  }

  // ---- 购物袋为空 ----
  if (cart && cart.items.length === 0) {
    return (
      <section className="section">
        <div className="red-line" />
        <div className="section-head"><span className="num">肆</span><h2>結帳</h2><span className="jp">お支払い</span></div>
        <div className="empty-state">
          <p>購物袋是空的，無法結帳。</p>
          <Link className="btn btn-primary" href="/products" style={{ marginTop: 20 }}>瀏覽商品</Link>
        </div>
      </section>
    );
  }

  const canSubmit = Boolean(
    cart && cart.items.length > 0 && method && !busy
    && form.fullName.trim() && form.phone.trim() && form.addressLine1.trim() && agree
    && cart.items.every((item) => item.available),
  );

  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head"><span className="num">肆</span><h2>結帳</h2><span className="jp">お支払い</span></div>

      <div className="checkout-grid">
        <div className="checkout-main">
          <h3>收貨資料</h3>
          <div className="form-grid">
            <label>姓名<input value={form.fullName} onChange={(e) => update('fullName', e.target.value)} placeholder="陳大文" /></label>
            <label>電話<input value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="+852 9123 4567" inputMode="tel" /></label>
            <label>城市<input value={form.city} onChange={(e) => update('city', e.target.value)} placeholder="香港" /></label>
            <label>地區<input value={form.district} onChange={(e) => update('district', e.target.value)} placeholder="油尖旺區" /></label>
            <label className="span-2">地址<input value={form.addressLine1} onChange={(e) => update('addressLine1', e.target.value)} placeholder="彌敦道 1 號演示大廈 3 樓 301 室" /></label>
            <label className="span-2">地址（續，可選）<input value={form.addressLine2} onChange={(e) => update('addressLine2', e.target.value)} /></label>
          </div>

          <h3>配送方式</h3>
          {!methods && <p className="form-note">配送方式載入中…</p>}
          {methods && methods.length === 0 && <p className="form-note error">此目的地暫無可用配送方式。</p>}
          <div className="method-list">
            {(methods ?? []).map((item) => (
              <label key={item.id} className={`method-option${item.id === methodId ? ' selected' : ''}`}>
                <input type="radio" name="shipping-method" checked={item.id === methodId} onChange={() => setMethodId(item.id)} />
                <span className="method-name">
                  {item.name}
                  {(item.estimatedMinDays ?? item.estimatedMaxDays) && (
                    <small>約 {item.estimatedMinDays ?? '–'}–{item.estimatedMaxDays ?? '–'} 個工作日</small>
                  )}
                </span>
                <strong>{item.feeMinor === 0 ? '免運' : formatMinor(item.feeMinor)}</strong>
              </label>
            ))}
          </div>

          <h3>付款方式</h3>
          <div className="method-list">
            {method?.codEnabled ? (
              <label className="method-option selected">
                <input type="radio" checked readOnly />
                <span className="method-name">貨到付款（現金）<small>送貨時以現金支付</small></span>
              </label>
            ) : (
              <p className="form-note">此配送方式暫不支援貨到付款。</p>
            )}
          </div>

          <label className="agree-row">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>{site.policies[0].label}</span>
          </label>

          {error && <p className="form-note error">{error}</p>}
        </div>

        <aside className="checkout-aside">
          <h3>訂單摘要</h3>
          {cart && (
            <>
              <ul className="summary-items">
                {cart.items.map((item) => (
                  <li key={item.id}>
                    <span>{item.productName}{item.variantName ? `（${item.variantName}）` : ''} ×{item.quantity}</span>
                    <strong>{formatMinor(item.lineSubtotalMinor, cart.currency)}</strong>
                  </li>
                ))}
              </ul>
              <div className="summary-line">
                <span>小計</span><strong>{formatMinor(cart.subtotalMinor, cart.currency)}</strong>
              </div>
              <div className="summary-line">
                <span>運費</span>
                <strong>{method ? (method.feeMinor === 0 ? '免運' : formatMinor(method.feeMinor)) : '—'}</strong>
              </div>
              {member?.loyalty.pointsEnabled && member.loyalty.balance > 0 && <label className="summary-line">
                <span>使用積分<small>可用 {member.loyalty.balance} 分，{member.loyalty.minorPerPoint} 分抵 1 元</small></span>
                <input type="number" min={0} max={member.loyalty.balance} value={pointsToUse}
                  onChange={(event) => setPointsToUse(event.target.value)} placeholder="0" />
              </label>}
              <MemberNudge />
              <p className="form-note">金額以下單時的服務端報價為準。</p>
              <button className="btn btn-primary checkout-btn" type="button" disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? '處理中…' : '確認下單（貨到付款）'}
              </button>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

/** 把服务端错误码翻译成用户能懂的话；未知错误保留原文。 */
function describe(result: Extract<ApiOutcome<unknown>, { ok: false }>): string {
  if (result.status === 409 || result.code === 'OUT_OF_STOCK') return '存貨不足或購物袋已變動，請返回購物袋確認後再試。';
  if (result.code === 'MARKET_NOT_AVAILABLE') return '商店暫未在此市場開放，請稍後再試。';
  if (result.code === 'QUOTE_EXPIRED') return '報價已過期，請重新確認下單。';
  if (result.code === 'POINT_BALANCE_INSUFFICIENT') return '積分不足，請減少使用點數後再試。';
  if (result.code === 'POINTS_MEMBER_REQUIRED' || result.code === 'POINTS_MEMBER_MISMATCH') return '使用積分需要先登入會員，且下單時請保持同一會員身份。';
  if (result.code === 'POINTS_DISABLED') return '店鋪暫未開啟積分抵扣。';
  if (result.status === 429) return '操作太頻繁，請稍後再試。';
  return result.message ?? '下單失敗，請稍後再試。';
}
