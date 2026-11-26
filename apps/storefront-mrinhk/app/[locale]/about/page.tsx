import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { site, whatsappLink } from '../../../lib/site';
import { altPaths, copyFor, isLocale, localePath } from '../../../lib/i18n';
import { jsonLdScript, organizationJsonLd } from '../../../lib/jsonld';

/**
 * 「關於 IN先生」全文页。
 *
 * 公司简介是 Google 搜索里最常被引用的一段：独立、稳定、可索引的 URL 让它能被收录，
 * 并作为品牌实体页被结构化数据引用。三语文案集中在 i18n（aboutPage），
 * 与首页引子分开维护——首页只讲一句，这里讲完整。
 */
export function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  return params.then(({ locale: raw }) => {
    if (!isLocale(raw)) notFound();
    const page = copyFor[raw].aboutPage;
    const path = '/about';
    return {
      title: page.seoTitle,
      description: page.seoDescription,
      alternates: { canonical: localePath(raw, path), languages: altPaths(path) },
      openGraph: {
        type: 'website',
        title: page.seoTitle,
        description: page.seoDescription,
        url: localePath(raw, path),
        siteName: `${site.brand} ${site.brandLatin}`.trim(),
      },
    };
  });
}

export default async function AboutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  const page = t.aboutPage;

  return (
    <article className="content-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLdScript(organizationJsonLd(raw))} />
      <div className="red-line" />
      <h1>{page.title}</h1>
      <section className="content-block">
        <p>{page.lead}</p>
        {page.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        <p className="content-footnote">{page.footnote}</p>
      </section>

      <section className="content-block">
        <h2>{t.about.heading}</h2>
        <div className="cards">
          {t.about.cards.map(card => (
            <div className="card" key={card.glyph}>
              <div className="glyph">{card.glyph}</div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      <p className="content-meta">
        <Link href={localePath(raw, '/products')} hrefLang={raw}>{t.common.browseProducts}</Link>
        {' · '}
        <a href={whatsappLink} target="_blank" rel="noopener noreferrer">{t.common.whatsapp}</a>
      </p>
      <p className="content-meta"><small>{site.brand} {site.brandLatin} · {t.footer.builtFor}</small></p>
    </article>
  );
}
