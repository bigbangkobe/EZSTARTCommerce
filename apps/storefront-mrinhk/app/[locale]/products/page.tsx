import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { site, whatsappLink } from '../../../lib/site';
import { altPaths, copyFor, isLocale, localePath, type Locale } from '../../../lib/i18n';
import { fetchContentRelease } from '../../../lib/content';
import { fetchProducts, formatPrice } from '../../../lib/products';
import AnalyticsTracker from '../../analytics-tracker';
import SectionTracker from '../../section-tracker';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  return {
    title: t.seo.products.title,
    description: t.seo.products.description,
    alternates: { canonical: localePath(raw, '/products'), languages: altPaths('/products') },
  };
}

export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = copyFor[locale];
  const [result, contentRelease] = await Promise.all([fetchProducts(locale), fetchContentRelease(locale)]);
  const products = result.ok ? result.products : [];

  return (
    <section className="section" data-ez-section="products.list" data-ez-section-id="products:list">
      <AnalyticsTracker pageKey="products" locale={locale} />
      <SectionTracker pageKey="products" publishVersionId={contentRelease} locale={locale} />
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
        <div className="cards">
          {products.map((product) => (
            <div className="card product-card" key={product.id}
              data-ez-placement={product.id} data-ez-variant={product.variants[0]?.id ?? undefined}>
              <div className="product-thumb">{product.name}</div>
              <div className="product-body">
                <h3>
                  <Link href={localePath(locale, `/products/${encodeURIComponent(product.slug)}`)}>{product.name}</Link>
                </h3>
                <div className="product-price">
                  {formatPrice(product.price, product.currency)}
                  <small> {t.common.from}</small>
                </div>
                {!product.inStock && <p className="product-stock">{t.common.soldOut}</p>}
                <Link className="btn btn-ghost product-cta"
                  href={localePath(locale, `/products/${encodeURIComponent(product.slug)}`)}>
                  {t.products.viewDetail}
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
