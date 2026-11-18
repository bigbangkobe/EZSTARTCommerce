'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type CartView } from '../lib/cart-client';
import { localePath } from '../lib/i18n';
import { useLocale } from '../lib/use-locale';

/** 页头购物袋徽标：未建袋/空袋显示 0；监听 cart-updated 事件即时刷新。 */
export default function CartLink() {
  const { locale, t } = useLocale();
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    // 没建过袋会 401，属正常：显示 0，不建袋（建袋留给真正加购的动作）
    const result = await api<CartView>('GET', '/storefront/cart');
    setCount(result.ok ? result.data.itemCount : 0);
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener('cart-updated', refresh);
    return () => window.removeEventListener('cart-updated', refresh);
  }, [refresh]);

  return (
    <Link href={localePath(locale, '/cart')} className="cart-link" aria-label={t.nav.cart}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M6 7h12l1.2 12.2a1 1 0 0 1-1 1.1H5.8a1 1 0 0 1-1-1.1L6 7Z" />
        <path d="M9 10V6a3 3 0 0 1 6 0v4" />
      </svg>
      <span>{t.nav.cart}</span>
      <span className={`cart-badge${count ? ' has-items' : ''}`}>{count ?? '–'}</span>
    </Link>
  );
}
