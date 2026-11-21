import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { notFound } from 'next/navigation';
import { whatsappLink } from '../../../../lib/site';
import { altPaths, copyFor, fill, isLocale, localePath, type Locale } from '../../../../lib/i18n';
import { fetchProduct, formatPrice } from '../../../../lib/products';
import { productHue, productInitial } from '../../../product-cards';
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
      <div className="container">
        <AnalyticsTracker pageKey={`product:${slug}`} locale={locale} variantId={product.variants[0]?.id} />
        <nav className="breadcrumb" aria-label={t.nav.home}>
          <Link href={localePath(locale)} hrefLang={locale}>{t.nav.home}</Link>
          <span aria-hidden="true">/</span>
          <Link href={localePath(locale, '/products')} hrefLang={locale}>{t.nav.products}</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{product.name}</span>
        </nav>

        <div className="detail-layout">
          <div className="detail-media" style={{ '--h': String(productHue(product.name)) } as CSSProperties}>
            {product.image
              ? <img src={product.image} alt={product.name} />
              : <span className="detail-mark" aria-hidden="true">{productInitial(product.name)}</span>}
            {!product.inStock && <span className="product-flag">{t.common.soldOut}</span>}
          </div>

          <div className="detail-info">
            <p className="eyebrow">{t.products.jp}</p>
            <h1>{product.name}</h1>
            <p className="detail-price">
              {formatPrice(product.price, product.currency)}
              <small>{t.common.from}</small>
            </p>
            <p className="detail-desc">{product.description ?? t.productDetail.noDescription}</p>

            <h2 className="detail-sub">{t.productDetail.specs}</h2>
            <ul className="detail-specs">
              {product.variants.map((variant) => (
                <li key={variant.id}>
                  <span className="detail-spec-name">
                    {Object.entries(variant.optionValues).map(([key, value]) => `${key} ${value}`).join(' / ') || variant.sku}
                  </span>
                  <span className="detail-spec-price">{formatPrice(variant.price, variant.currency)}</span>
                  <span className="detail-spec-stock">
                    {variant.available > 0
                      ? fill(t.productDetail.stock, { count: variant.available })
                      : t.productDetail.outOfStock}
                  </span>
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
      </div>
    </section>
  );
}
