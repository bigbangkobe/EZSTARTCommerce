'use client';

import { useState } from 'react';
import { copyFor, type Locale } from '../lib/i18n';
import { toProduct, type ApiProduct, type Product } from '../lib/product-view';
import { ProductCards } from './product-cards';

/** 每批追加的数量：接口单页上限 100，取 24 是为了让首屏与后续批次的行数都对齐网格。 */
const BATCH = 24;
const MARKET = 'HK';

/**
 * 商品列表：首屏由服务端渲染（SEO 有内容），之后的批次由浏览器带游标续取。
 *
 * 为什么要这样：/products 是「全部商品」的唯一入口，接口默认只给一页，
 * 之前把 nextCursor 丢掉，269 件商品里客人只看得到最新 24 件，且没有任何翻页。
 *
 * /api/v1/* 已被 next.config 的 rewrite 转到 API，所以这里用同源相对路径，
 * 不需要把 API 内网地址暴露给浏览器。
 */
export function ProductList({ locale, initial, initialCursor }: {
  locale: Locale;
  initial: Product[];
  initialCursor: string | null;
}) {
  const [products, setProducts] = useState<Product[]>(initial);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const t = copyFor[locale].products;

  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const query = new URLSearchParams({ locale, marketCode: MARKET, limit: String(BATCH), cursor });
      const res = await fetch(`/api/v1/storefront/products?${query.toString()}`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { data?: { items?: ApiProduct[]; nextCursor?: string | null } };
      const items = body.data?.items ?? [];
      // 空批次不再保留游标：否则按钮会一直点，却什么也加载不出来。
      setProducts((prev) => [...prev, ...items.map(toProduct)]);
      setCursor(items.length ? body.data?.nextCursor ?? null : null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ProductCards products={products} locale={locale} />
      {cursor && (
        <div className="cta-row" style={{ justifyContent: 'center', marginTop: 28 }}>
          <button type="button" className="btn btn-ghost" onClick={loadMore} disabled={busy}>
            {busy ? t.loadingMore : t.loadMore}
          </button>
        </div>
      )}
      {failed && <div className="empty-state">{t.loadFailed}</div>}
    </>
  );
}

export default ProductList;
