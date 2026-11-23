import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { whatsappLink } from '../../../lib/site';
import { altPaths, copyFor, isLocale, type Locale } from '../../../lib/i18n';
import { fetchContentRelease } from '../../../lib/content';
import { fetchProducts } from '../../../lib/products';
import { ProductList } from '../../product-list';
import { ScrollProgress } from '../../scroll-progress';
import AnalyticsTracker from '../../analytics-tracker';
import SectionTracker from '../../section-tracker';

// 目录类页面按请求渲染：构建镜像时 API 还没起，预渲染出来的首页会是「商品无法载入」，
// 而且运营上架后要等 ISR 才能看到。目录数据本身很轻，按请求取更划算。
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  return {
    title: t.seo.products.title,
    description: t.seo.products.description,
    alternates: { canonical: `/${raw}/products`, languages: altPaths('/products') },
  };
}

export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = copyFor[locale];
  // 24 件一批：接口默认只给 25 且上限 100，首屏取满一整批，剩下的交给「载入更多」带游标续取。
  const [result, contentRelease] = await Promise.all([fetchProducts(locale, 24), fetchContentRelease(locale)]);
  const products = result.ok ? result.products : [];

  return (
    <section className="section" data-ez-section="products.list" data-ez-section-id="products:list">
      <div className="container">
        <AnalyticsTracker pageKey="products" locale={locale} />
        <SectionTracker pageKey="products" publishVersionId={contentRelease} locale={locale} />
        {/* 右侧滑动进度条：列表会自动续载，客人滑到哪、还剩多少，有个位置感。 */}
        <ScrollProgress label={t.products.progressLabel} />
        <div className="red-line" />
        <div className="section-head">
          <span className="num">壱</span>
          <h2>{t.products.heading}</h2>
          <span className="jp">{t.products.jp}</span>
        </div>

        {!result.ok ? (
          <div className="empty-state">{t.products.error}</div>
        ) : products.length === 0 ? (
          <div className="empty-state">
            {t.products.empty}
            <div className="cta-row" style={{ justifyContent: 'center', marginTop: 20 }}>
              <a className="btn btn-primary" href={whatsappLink} target="_blank" rel="noopener noreferrer">
                {t.hero.ctaPrimary}
              </a>
            </div>
          </div>
        ) : (
          // 首屏走服务端渲染，其余批次滑到底部附近自动续取：一页只铺 24 张，
          // 但「全部商品」必须真的能看全（之前丢掉了 nextCursor，只到 25 件）。
          <ProductList locale={locale} initial={products} initialCursor={result.nextCursor} />
        )}
      </div>
    </section>
  );
}
