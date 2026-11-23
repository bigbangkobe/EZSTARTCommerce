'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { copyFor, fill, type Locale } from '../lib/i18n';
import { toProduct, type ApiProduct, type Product } from '../lib/product-view';
import { ProductCards } from './product-cards';

/** 每批追加的数量：接口单页上限 100，取 24 是为了首屏与后续批次的行数都对齐网格。 */
const BATCH = 24;
const MARKET = 'HK';
/** 提前一屏开始取：手指滑到底时下一批已经在了，不出现「白掉一下再长出卡片」。 */
const PRELOAD_MARGIN = '900px 0px';

type Status = 'idle' | 'loading' | 'error';

/**
 * 商品列表：首屏由服务端渲染（SEO 有内容），之后滑到底部附近自动续取下一批，像一页铺到底。
 *
 * 为什么要这样：/products 是「全部商品」的唯一入口，接口默认只给一页；之前把 nextCursor 丢掉，
 * 269 件商品里客人只看得到最新 24 件。点击「载入更多」能救，但多一步操作就少一批人看到。
 *
 * /api/v1/* 已被 next.config 的 rewrite 转到 API，所以这里用同源相对路径，
 * 不需要把 API 内网地址暴露给浏览器。
 */
export function ProductList({ locale, initial, initialCursor }: {
  locale: Locale;
  initial: Product[];
  initialCursor: string | null;
}) {
  const t = copyFor[locale].products;
  const [products, setProducts] = useState<Product[]>(initial);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [status, setStatus] = useState<Status>('idle');
  const [mounted, setMounted] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);
  // 并发的第二笔请求没有意义（同一游标会拿到同一批），所以用 ref 挡住而不是靠 state。
  const inFlight = useRef(false);

  useEffect(() => { setMounted(true); }, []);

  const loadMore = useCallback(async () => {
    if (inFlight.current || !cursor) return;
    inFlight.current = true;
    setStatus('loading');
    try {
      const query = new URLSearchParams({ locale, marketCode: MARKET, limit: String(BATCH), cursor });
      const res = await fetch(`/api/v1/storefront/products?${query.toString()}`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { data?: { items?: ApiProduct[]; nextCursor?: string | null } };
      const items = (body.data?.items ?? []).map(toProduct);
      // 商品在翻页途中被下架时游标边界会移动，按 id 去重，宁可少一张也不重复。
      setProducts((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...items.filter((item) => !seen.has(item.id))];
      });
      // 空批次不再保留游标：否则会在底部空转请求。
      setCursor(items.length ? body.data?.nextCursor ?? null : null);
      setStatus('idle');
    } catch {
      // 不自动重试：断网时会一边报错一边狂打请求。留住游标，等客人点「重试」或重新滑回来。
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }, [cursor, locale]);

  useEffect(() => {
    if (!mounted || !cursor || status === 'error') return;
    if (typeof IntersectionObserver === 'undefined') return;
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: PRELOAD_MARGIN });
    observer.observe(node);
    return () => observer.disconnect();
  }, [mounted, cursor, status, loadMore]);

  const supportsAuto = mounted && typeof IntersectionObserver !== 'undefined';

  return (
    <>
      <ProductCards products={products} locale={locale} />
      <div className="product-feed" ref={sentinel}>
        {status === 'loading' && <span className="product-feed-loading" aria-hidden="true">{t.loadingMore}</span>}
        {status === 'error' && (
          <>
            <p className="product-feed-note" role="status">{t.loadFailed}</p>
            <button type="button" className="btn btn-ghost" onClick={() => { setStatus('idle'); void loadMore(); }}>
              {t.retry}
            </button>
          </>
        )}
        {!cursor && status !== 'loading' && (
          <p className="product-feed-note" role="status">{fill(t.allLoaded, { count: products.length })}</p>
        )}
        {/* 没有 IntersectionObserver 的老浏览器退回手动按钮：功能不能因为新交互就丢掉。 */}
        {cursor && mounted && !supportsAuto && status !== 'loading' && (
          <button type="button" className="btn btn-ghost" onClick={() => void loadMore()}>{t.loadMore}</button>
        )}
      </div>
    </>
  );
}

export default ProductList;
