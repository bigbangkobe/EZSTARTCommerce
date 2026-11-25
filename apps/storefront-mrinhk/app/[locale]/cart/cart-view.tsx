'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  api, formatMinor, notifyCartUpdated, removeCartItem, updateCartItem, type CartView,
} from '../../../lib/cart-client';
import { copyFor, fill, localePath, type Locale } from '../../../lib/i18n';

/** 购物袋页：数量修改、删除、小计；服务端永远是价格与库存的权威。 */
export default function CartView({ locale }: { locale: Locale }) {
  const t = copyFor[locale];
  const [cart, setCart] = useState<CartView | null>(null);
  // 401（还没建过袋）也是一种「已加载」：不区分就会一直停在「載入中」。
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api<CartView>('GET', '/storefront/cart');
    setCart(result.ok ? result.data : null);
    setLoaded(true);
    if (!result.ok && result.status !== 401) setError(result.message ?? t.cart.loadError);
  }, [t.cart.loadError]);

  useEffect(() => {
    void load();
    const onUpdated = () => void load();
    window.addEventListener('cart-updated', onUpdated);
    return () => window.removeEventListener('cart-updated', onUpdated);
  }, [load]);

  async function changeQuantity(itemId: string, quantity: number) {
    if (quantity < 1) return;
    setBusyId(itemId);
    setError(null);
    const result = await updateCartItem(itemId, quantity);
    setBusyId(null);
    if (!result.ok) {
      setError(result.code === 'NO_CSRF'
        ? t.common.sessionStale
        : result.code === 'OUT_OF_STOCK' || result.status === 409
          ? t.cart.outOfStock : result.message ?? t.cart.updateError);
      return;
    }
    setCart(result.data);
    notifyCartUpdated();
  }

  async function removeItem(itemId: string) {
    setBusyId(itemId);
    setError(null);
    const result = await removeCartItem(itemId);
    setBusyId(null);
    if (!result.ok) {
      setError(result.code === 'NO_CSRF' ? t.common.sessionStale : result.message ?? t.cart.removeError);
      return;
    }
    await load();
    notifyCartUpdated();
  }

  const empty = loaded && (!cart || cart.items.length === 0) && !error;

  return (
    <section className="section">
      <div className="container">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">参</span>
        <h2>{t.cart.heading}</h2>
        <span className="jp">{t.cart.jp}</span>
      </div>

      {!loaded && !error && <div className="empty-state">{t.common.loading}</div>}
      {error && <div className="empty-state">{error}</div>}
      {empty && (
        <div className="empty-state">
          <p>{t.cart.empty}</p>
          <Link className="btn btn-primary" href={localePath(locale, '/products')} style={{ marginTop: 20 }}>
            {t.common.browseProducts}
          </Link>
        </div>
      )}

      {cart && cart.items.length > 0 && (
        <div className="cart-wrap">
          <table className="cart-table">
            <thead>
              <tr>
                <th>{t.cart.product}</th>
                <th>{t.cart.unitPrice}</th>
                <th>{t.cart.quantity}</th>
                <th>{t.cart.lineTotal}</th>
                <th aria-label={t.common.actions} />
              </tr>
            </thead>
            <tbody>
              {cart.items.map((item) => (
                <tr key={item.id} className={item.available ? '' : 'unavailable'}>
                  <td>
                    <div>{item.productName}</div>
                    {item.variantName && <small>{item.variantName}</small>}
                    {!item.available && <small className="form-note error">{t.cart.unavailable}</small>}
                  </td>
                  <td>{formatMinor(item.unitPriceMinor, cart.currency)}</td>
                  <td>
                    <div className="qty-stepper">
                      <button type="button" aria-label={t.common.decrease} disabled={busyId === item.id}
                        onClick={() => void changeQuantity(item.id, item.quantity - 1)}>−</button>
                      <input type="number" min={1} value={item.quantity} disabled={busyId === item.id}
                        aria-label={t.cart.quantity}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next) && next >= 1) void changeQuantity(item.id, next);
                        }} />
                      <button type="button" aria-label={t.common.increase} disabled={busyId === item.id}
                        onClick={() => void changeQuantity(item.id, item.quantity + 1)}>＋</button>
                    </div>
                  </td>
                  <td>{formatMinor(item.lineSubtotalMinor, cart.currency)}</td>
                  <td>
                    <button className="link-btn" type="button" disabled={busyId === item.id}
                      onClick={() => void removeItem(item.id)}>{t.common.remove}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {cart.warnings.length > 0 && (
            <ul className="cart-warnings">
              {cart.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}

          <div className="cart-summary">
            <div className="summary-line">
              <span>{fill(t.cart.subtotalLine, { count: cart.itemCount })}</span>
              <strong>{formatMinor(cart.subtotalMinor, cart.currency)}</strong>
            </div>
            <p className="form-note">{t.cart.shippingNote}</p>
            <Link className="btn btn-primary" href={localePath(locale, '/checkout')}>{t.cart.checkout}</Link>
          </div>
        </div>
      )}
      </div>
    </section>
  );
}
