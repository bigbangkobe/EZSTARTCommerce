import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { site, whatsappLink } from '../../lib/site';
import { altPaths, copyFor, isLocale, localePath, type Locale } from '../../lib/i18n';
import { fetchProducts, formatPrice } from '../../lib/products';
import AnalyticsTracker from '../analytics-tracker';
import SectionTracker from '../section-tracker';

function SectionHead({ num, title, jp }: { num: string; title: string; jp: string }) {
  return (
    <>
      <div className="red-line" />
      <div className="section-head">
        <span className="num">{num}</span>
        <h2>{title}</h2>
        <span className="jp">{jp}</span>
      </div>
    </>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  return {
    title: t.seo.home.title,
    description: t.seo.home.description,
    alternates: { canonical: localePath(raw), languages: altPaths('') },
  };
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = copyFor[locale];
  const result = await fetchProducts(locale);
  const featured = result.ok ? result.products.slice(0, 6) : [];
  const productsHref = localePath(locale, '/products');

  return (
    <>
      <AnalyticsTracker pageKey="home" locale={locale} />
      <SectionTracker pageKey="home" publishVersionId={site.contentRelease} locale={locale} />
      {/* HERO */}
      <section className="hero" data-ez-section="home.hero" data-ez-section-id="home:hero">
        <div className="hero-copy">
          <h1>
            {t.hero.title1}
            <br />
            <span>{t.hero.title2}</span>
          </h1>
          <p>{t.hero.sub}</p>
          <div className="cta-row">
            <a className="btn btn-primary" href={whatsappLink} target="_blank" rel="noopener noreferrer">
              {t.hero.ctaPrimary}
            </a>
            <Link className="btn btn-ghost" href={productsHref} hrefLang={locale}>
              {t.hero.ctaSecondary}
            </Link>
          </div>
        </div>
        <div className="vertical">{t.hero.vertical}</div>
        <div className="logo-card">
          <div className="logo-mark">
            <div className="circle" />
            <div className="text">{site.brand}</div>
          </div>
        </div>
      </section>

      {/* ABOUT */}
      <section className="section" id="about" data-ez-section="home.about" data-ez-section-id="home:about">
        <SectionHead num="壱" title={t.about.heading} jp={t.about.jp} />
        <div className="cards">
          {t.about.cards.map((card) => (
            <div className="card" key={card.glyph}>
              <div className="glyph">{card.glyph}</div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURED PRODUCTS */}
      <section className="section" id="products" data-ez-section="home.products" data-ez-section-id="home:products">
        <SectionHead num="弐" title={t.products.heading} jp={t.products.jp} />
        {!result.ok && featured.length === 0 ? (
          <div className="empty-state">{t.products.error}</div>
        ) : featured.length === 0 ? (
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
            {featured.map((product) => (
              <div className="card product-card" key={product.id}
                data-ez-placement={product.id} data-ez-variant={product.variants[0]?.id ?? undefined}>
                <div className="product-thumb">{product.category ?? t.products.thumbFallback}</div>
                <div className="product-body">
                  <h3>
                    <Link href={localePath(locale, `/products/${encodeURIComponent(product.slug)}`)}>{product.name}</Link>
                  </h3>
                  <div className="product-price">
                    {formatPrice(product.price, product.currency)}
                    <small> {t.common.from}</small>
                  </div>
                  <a className="btn btn-ghost product-cta" href={whatsappLink} target="_blank" rel="noopener noreferrer">
                    {t.products.inquiry}
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
