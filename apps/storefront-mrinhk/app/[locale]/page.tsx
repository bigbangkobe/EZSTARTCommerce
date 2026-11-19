import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { site, whatsappLink } from '../../lib/site';
import { altPaths, copyFor, isLocale, localePath, type Locale } from '../../lib/i18n';
import { fetchProducts } from '../../lib/products';
import { fetchContentRelease } from '../../lib/content';
import { fetchMerchandising } from '../../lib/merchandising';
import { ProductCards } from '../product-cards';
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
  const [result, contentRelease, merch] = await Promise.all([
    fetchProducts(locale), fetchContentRelease(locale), fetchMerchandising(locale)]);
  const featured = result.ok ? result.products.slice(0, 6) : [];
  const productsHref = localePath(locale, '/products');

  return (
    <>
      <AnalyticsTracker pageKey="home" locale={locale} />
      <SectionTracker pageKey="home" publishVersionId={contentRelease} locale={locale} />
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

      {/* MERCHANDISING：后台发布过版面就按版面渲染，否则退回主题默认精选 */}
      {merch.ok && merch.sections.length > 0 ? merch.sections.map((section, index) => (
        <section className="section" key={section.sectionId} id={`merch-${section.sectionId}`}
          data-ez-section={`home.${section.sectionId}`} data-ez-section-id={`home:${section.sectionId}`}>
          <div className="red-line" />
          <div className="section-head">
            <span className="num">{String(index + 1).padStart(2, '0')}</span>
            <h2>{section.title}</h2>
            <span className="jp">{t.products.jp}</span>
          </div>
          <ProductCards products={section.products} locale={locale} />
        </section>
      )) : (
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
          ) : <ProductCards products={featured} locale={locale} />}
        </section>
      )}
    </>
  );
}
