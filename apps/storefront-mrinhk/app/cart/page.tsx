'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  api, formatMinor, notifyCartUpdated, removeCartItem, updateCartItem, type CartView,
} from '../../lib/cart-client';

/** 购物袋页：数量修改、删除、小计；服务端永远是价格与库存的权威。 */
export default function CartPage() {
  const [cart, setCart] = useState<CartView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api<CartView>('GET', '/storefront/cart');
    setCart(result.ok ? result.data : null);
    if (!result.ok && result.status !== 401) setError(result.message ?? '購物袋暫時無法載入');
  }, []);

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
      setError(result.code === 'OUT_OF_STOCK' || result.status === 409
        ? '存貨不足，未能調整數量。' : result.message ?? '更新失敗，請稍後再試。');
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
      setError(result.message ?? '刪除失敗，請稍後再試。');
      return;
    }
    await load();
    notifyCartUpdated();
  }

  const empty = cart && cart.items.length === 0;

  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">参</span>
        <h2>購物袋</h2>
        <span className="jp">お買物かご</span>
      </div>

      {!cart && !error && <div className="empty-state">載入中…</div>}
      {error && <div className="empty-state">{error}</div>}
      {empty && (
        <div className="empty-state">
          <p>購物袋是空的。</p>
          <Link className="btn btn-primary" href="/products" style={{ marginTop: 20 }}>瀏覽商品</Link>
        </div>
      )}

      {cart && cart.items.length > 0 && (
        <div className="cart-wrap">
          <table className="cart-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>單價</th>
                <th>數量</th>
                <th>小計</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {cart.items.map((item) => (
                <tr key={item.id} className={item.available ? '' : 'unavailable'}>
                  <td>
                    <div>{item.productName}</div>
                    {item.variantName && <small>{item.variantName}</small>}
                    {!item.available && <small className="form-note error">此項已無法購買，請先刪除</small>}
                  </td>
                  <td>{formatMinor(item.unitPriceMinor, cart.currency)}</td>
                  <td>
                    <div className="qty-stepper">
                      <button type="button" aria-label="減少" disabled={busyId === item.id}
                        onClick={() => void changeQuantity(item.id, item.quantity - 1)}>−</button>
                      <input type="number" min={1} value={item.quantity} disabled={busyId === item.id}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next) && next >= 1) void changeQuantity(item.id, next);
                        }} />
                      <button type="button" aria-label="增加" disabled={busyId === item.id}
                        onClick={() => void changeQuantity(item.id, item.quantity + 1)}>＋</button>
                    </div>
                  </td>
                  <td>{formatMinor(item.lineSubtotalMinor, cart.currency)}</td>
                  <td>
                    <button className="link-btn" type="button" disabled={busyId === item.id}
                      onClick={() => void removeItem(item.id)}>刪除</button>
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
              <span>小計（{cart.itemCount} 件）</span>
              <strong>{formatMinor(cart.subtotalMinor, cart.currency)}</strong>
            </div>
            <p className="form-note">運費與優惠將於結帳時計算。</p>
            <Link className="btn btn-primary" href="/checkout">去結帳</Link>
          </div>
        </div>
      )}
    </section>
  );
}
