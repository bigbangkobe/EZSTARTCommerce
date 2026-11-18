'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  api, createQuote, formatMinor, listShippingMethods, notifyCartUpdated, placeOrder,
  type ApiOutcome, type CartView, type OrderCreatedView, type ShippingMethodView,
} from '../../../lib/cart-client';
import { fetchProfile, type MemberProfileView } from '../../../lib/member-client';
import { trackBeginCheckout } from '../../../lib/analytics-client';
import { site } from '../../../lib/site';
import { copyFor, fill, localePath, type Copy, type Locale } from '../../../lib/i18n';
import MemberNudge from './member-nudge';

/**
 * 结账页：三步一屏（收货资料 → 配送方式 → 付款），全部基于服务端报价，
 * 浏览器只提交选择与地址，不提交任何金额。
 */
export default function CheckoutView({ locale }: { locale: Locale }) {
  const t = copyFor[locale];
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
      // 配送方式名称由服务端按语言返回：这里必须用当前页面的语言，而不是店铺默认语言。
      const result = await listShippingMethods('HK', locale);
      if (cancelled || !result.ok) return;
      setMethods(result.data.items);
      setMethodId((current) => current || result.data.items[0]?.id || '');
    })();
    return () => { cancelled = true; };
  }, [cart, locale]);

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
    void trackBeginCheckout('checkout', locale, site.marketCode);
    const quote = await createQuote({
      cartId: cart.cartId,
      locale,
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
      setError(describe(quote, t));
      // 库存/购物袋状态可能已变化，重读一次
      await loadCart();
      return;
    }
    const placed = await placeOrder(quote.data.quoteId, quote.data.version, 'cod');
    setBusy(false);
    if (!placed.ok) {
      setError(describe(placed, t));
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
          <h2>{t.checkout.confirmed}</h2>
          <span className="jp">{t.checkout.thanks}</span>
        </div>
        <div className="card order-confirmed">
          <div className="order-number">{order.publicOrderNumber}</div>
          <ul className="order-facts">
            <li>{t.checkout.orderStatus}<strong>{order.orderStatus === 'awaiting_confirmation'
              ? t.checkout.awaitingConfirmation : order.orderStatus}</strong></li>
            <li>{t.checkout.paymentMethod}<strong>{t.checkout.cod}</strong></li>
            <li>{t.checkout.amountDue}<strong>{formatMinor(order.totalMinor, order.currency)}</strong></li>
            {order.pointsRedeemed > 0 && <li>{t.checkout.pointsUsed}<strong>{fill(t.checkout.pointsUsedDetail, {
              points: order.pointsRedeemed, value: formatMinor(order.pointsValueMinor, order.currency),
            })}</strong></li>}
          </ul>
          {order.paymentAction?.instructions && <p className="form-note">{order.paymentAction.instructions}</p>}
          <div className="cta-row" style={{ marginTop: 24 }}>
            <Link className="btn btn-primary" href={localePath(locale, '/products')}>{t.common.continueShopping}</Link>
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
        <div className="section-head"><span className="num">肆</span><h2>{t.checkout.heading}</h2>
          <span className="jp">{t.checkout.jp}</span></div>
        <div className="empty-state">
          <p>{t.checkout.emptyCart}</p>
          <Link className="btn btn-primary" href={localePath(locale, '/products')} style={{ marginTop: 20 }}>
            {t.common.browseProducts}
          </Link>
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
      <div className="section-head"><span className="num">肆</span><h2>{t.checkout.heading}</h2>
        <span className="jp">{t.checkout.jp}</span></div>

      <div className="checkout-grid">
        <div className="checkout-main">
          <h3>{t.checkout.contactSection}</h3>
          <div className="form-grid">
            <label>{t.checkout.name}
              <input value={form.fullName} onChange={(e) => update('fullName', e.target.value)}
                placeholder={t.checkout.namePlaceholder} autoComplete="name" /></label>
            <label>{t.checkout.phone}
              <input value={form.phone} onChange={(e) => update('phone', e.target.value)}
                placeholder="+852 9123 4567" inputMode="tel" autoComplete="tel" /></label>
            <label>{t.checkout.city}
              <input value={form.city} onChange={(e) => update('city', e.target.value)}
                placeholder={t.checkout.cityPlaceholder} autoComplete="address-level2" /></label>
            <label>{t.checkout.district}
              <input value={form.district} onChange={(e) => update('district', e.target.value)}
                placeholder={t.checkout.districtPlaceholder} /></label>
            <label className="span-2">{t.checkout.address}
              <input value={form.addressLine1} onChange={(e) => update('addressLine1', e.target.value)}
                placeholder={t.checkout.addressPlaceholder} autoComplete="address-line1" /></label>
            <label className="span-2">{t.checkout.address2}
              <input value={form.addressLine2} onChange={(e) => update('addressLine2', e.target.value)}
                autoComplete="address-line2" /></label>
          </div>

          <h3>{t.checkout.shippingSection}</h3>
          {!methods && <p className="form-note">{t.checkout.methodsLoading}</p>}
          {methods && methods.length === 0 && <p className="form-note error">{t.checkout.noMethods}</p>}
          <div className="method-list">
            {(methods ?? []).map((item) => (
              <label key={item.id} className={`method-option${item.id === methodId ? ' selected' : ''}`}>
                <input type="radio" name="shipping-method" checked={item.id === methodId} onChange={() => setMethodId(item.id)} />
                <span className="method-name">
                  {item.name}
                  {(item.estimatedMinDays ?? item.estimatedMaxDays) && (
                    <small>{fill(t.checkout.estimate, {
                      min: item.estimatedMinDays ?? '–', max: item.estimatedMaxDays ?? '–',
                    })}</small>
                  )}
                </span>
                <strong>{item.feeMinor === 0 ? t.common.freeShipping : formatMinor(item.feeMinor)}</strong>
              </label>
            ))}
          </div>

          <h3>{t.checkout.paymentSection}</h3>
          <div className="method-list">
            {method?.codEnabled ? (
              <label className="method-option selected">
                <input type="radio" checked readOnly />
                <span className="method-name">{t.checkout.cod}<small>{t.checkout.codHint}</small></span>
              </label>
            ) : (
              <p className="form-note">{t.checkout.codUnavailable}</p>
            )}
          </div>

          <label className="agree-row">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>{t.checkout.policyLabel}</span>
          </label>

          {error && <p className="form-note error">{error}</p>}
        </div>

        <aside className="checkout-aside">
          <h3>{t.checkout.summary}</h3>
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
                <span>{t.common.subtotal}</span><strong>{formatMinor(cart.subtotalMinor, cart.currency)}</strong>
              </div>
              <div className="summary-line">
                <span>{t.common.shipping}</span>
                <strong>{method ? (method.feeMinor === 0 ? t.common.freeShipping : formatMinor(method.feeMinor)) : '—'}</strong>
              </div>
              {member?.loyalty.pointsEnabled && member.loyalty.balance > 0 && <label className="summary-line">
                <span>{t.checkout.usePoints}
                  <small>{fill(t.checkout.pointsHint, {
                    balance: member.loyalty.balance, minorPerPoint: member.loyalty.minorPerPoint,
                  })}</small></span>
                <input type="number" min={0} max={member.loyalty.balance} value={pointsToUse}
                  onChange={(event) => setPointsToUse(event.target.value)} placeholder="0" />
              </label>}
              <MemberNudge locale={locale} />
              <p className="form-note">{t.checkout.amountNote}</p>
              <button className="btn btn-primary checkout-btn" type="button" disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? t.checkout.submitting : t.checkout.submit}
              </button>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

/** 把服务端错误码翻译成用户能懂的话；未知错误保留原文。 */
function describe(result: Extract<ApiOutcome<unknown>, { ok: false }>, t: Copy): string {
  if (result.status === 409 || result.code === 'OUT_OF_STOCK') return t.checkout.errorOutOfStock;
  if (result.code === 'MARKET_NOT_AVAILABLE') return t.checkout.errorMarket;
  if (result.code === 'QUOTE_EXPIRED') return t.checkout.errorQuoteExpired;
  if (result.code === 'POINT_BALANCE_INSUFFICIENT') return t.checkout.errorPointsInsufficient;
  if (result.code === 'POINTS_MEMBER_REQUIRED' || result.code === 'POINTS_MEMBER_MISMATCH') return t.checkout.errorPointsMember;
  if (result.code === 'POINTS_DISABLED') return t.checkout.errorPointsDisabled;
  if (result.status === 429) return t.checkout.errorRateLimited;
  return result.message ?? t.checkout.errorGeneric;
}
