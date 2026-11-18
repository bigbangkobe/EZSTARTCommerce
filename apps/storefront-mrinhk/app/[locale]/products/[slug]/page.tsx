import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { whatsappLink } from '../../../../lib/site';
import { altPaths, copyFor, fill, isLocale, localePath, type Locale } from '../../../../lib/i18n';
import { fetchProduct, formatPrice } from '../../../../lib/products';
import AddToCartForm from './add-to-cart-form';
import AnalyticsTracker from '../../../analytics-tracker';

export const revalidate = 60;

export async function generateMetadata({ params }: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  const product = await fetchProduct(slug, raw);
  if (!product) return { title: t.notFound.title, robots: { index: false, follow: true } };
  const path = `/products/${encodeURIComponent(slug)}`;
  return {
    title: product.name,
    description: product.description ?? t.products.empty,
    alternates: { canonical: localePath(raw, path), languages: altPaths(path) },
    openGraph: {
      type: 'website',
      title: product.name,
      description: product.description ?? t.seo.products.description,
      url: localePath(raw, path),
    },
  };
}

export default async function ProductDetailPage({ params }: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = copyFor[locale];
  const product = await fetchProduct(slug, locale);
  if (!product) notFound();

  return (
    <section className="section">
      <AnalyticsTracker pageKey={`product:${slug}`} locale={locale} variantId={product.variants[0]?.id} />
      <div className="red-line" />
      <div className="section-head">
        <span className="num">弐</span>
        <h2>{product.name}</h2>
        <span className="jp">{t.products.jp}</span>
      </div>

      <div className="card product-card">
        <div className="product-thumb">{product.name}</div>
        <div className="product-body">
          <div className="product-price">
            {formatPrice(product.price, product.currency)}
            <small> {t.common.from}</small>
          </div>
          <p>{product.description ?? t.productDetail.noDescription}</p>

          <h3>{t.productDetail.specs}</h3>
          <ul>
            {product.variants.map((variant) => (
              <li key={variant.id}>
                {Object.entries(variant.optionValues).map(([key, value]) => `${key} ${value}`).join(' / ') || variant.sku}
                {' — '}
                {formatPrice(variant.price, variant.currency)}
                {variant.available > 0
                  ? fill(t.productDetail.stock, { count: variant.available })
                  : t.productDetail.outOfStock}
              </li>
            ))}
          </ul>

          <AddToCartForm productName={product.name} variants={product.variants} locale={locale} />

          <div className="cta-row secondary-cta">
            <a className="btn btn-ghost" href={whatsappLink} target="_blank" rel="noopener noreferrer">
              {t.products.inquiry}
            </a>
            <Link className="btn btn-ghost" href={localePath(locale, '/products')} hrefLang={locale}>
              {t.common.backToProducts}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
