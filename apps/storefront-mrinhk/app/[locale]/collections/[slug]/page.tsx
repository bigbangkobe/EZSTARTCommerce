import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { DEFAULT_LOCALE, copyFor, isLocale, localePath, type Locale } from '../../../../lib/i18n';
import { fetchCollection } from '../../../../lib/collections';
import { fetchRedirect } from '../../../../lib/content';
import { ProductCards } from '../../../product-cards';
import AnalyticsTracker from '../../../analytics-tracker';
import SectionTracker from '../../../section-tracker';

export const revalidate = 30;

/** hreflang 只写专题真实存在的语言；缺译时不编一个指向 404 的地址。 */
function languagesFor(alternates: { locale: string; slug: string }[]): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const alternate of alternates) {
    if (!isLocale(alternate.locale)) continue;
    languages[alternate.locale] = localePath(alternate.locale as Locale, `/collections/${encodeURIComponent(alternate.slug)}`);
  }
  if (languages[DEFAULT_LOCALE]) languages['x-default'] = languages[DEFAULT_LOCALE]!;
  return languages;
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }): Promise<Metadata> {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  const result = await fetchCollection(decodeURIComponent(slug), raw);
  if (!result.ok) {
    // 取不到专题时不要让搜索引擎把一个空壳页收进去；真不存在的专题由页面层 404/301。
    return { title: t.seo.collections.title, description: t.seo.collections.description,
      robots: { index: false, follow: false } };
  }
  const languages = languagesFor(result.alternates);
  return {
    title: result.collection.name,
    description: result.collection.description ?? t.seo.collections.description,
    alternates: {
      canonical: localePath(raw, `/collections/${encodeURIComponent(result.collection.slug)}`),
      ...(Object.keys(languages).length ? { languages } : {}),
    },
  };
}

export default async function CollectionPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = copyFor[locale];
  const result = await fetchCollection(decodeURIComponent(slug), locale);
  if (!result.ok && result.error === 'not_found') {
    // 改过 slug 的旧地址：服务端登记过 301 才跳，没登记就照常 404（不猜目标）。
    const target = await fetchRedirect(localePath(locale, `/collections/${decodeURIComponent(slug)}`));
    if (target) permanentRedirect(target.toPath);
    notFound();
  }

  const pageKey = `collection:${decodeURIComponent(slug)}`;
  if (!result.ok) {
    return (
      <section className="section" data-ez-section="collection.detail" data-ez-section-id="collection:detail">
        <div className="red-line" />
        <div className="section-head"><span className="num">弐</span><h2>{t.collections.heading}</h2>
          <span className="jp">{t.collections.jp}</span></div>
        <div className="empty-state">{t.collections.error}</div>
      </section>
    );
  }

  const { collection, layout, products, contentRelease } = result;
  const sections = layout?.sections.length ? layout.sections : null;

  return (
    <>
      <AnalyticsTracker pageKey={pageKey} locale={locale} />
      <SectionTracker pageKey={pageKey} publishVersionId={contentRelease} locale={locale} />
      <section className="section" data-ez-section="collection.detail" data-ez-section-id={`collection:${collection.id}`}>
        <div className="red-line" />
        <div className="section-head">
          <span className="num">弐</span>
          <h2>{collection.name}</h2>
          <span className="jp">{t.collections.jp}</span>
        </div>
        {collection.description && <p className="category-intro">{collection.description}</p>}
        <p><small><Link href={localePath(locale, '/collections')}>{t.collections.all}</Link></small></p>

        {sections ? sections.map((section) => (
          // 区块标题由运营按语言填写；这里不再拼「这个专题的商品」之类的固定前缀。
          <div key={section.sectionId} data-ez-section={`collection.${section.sectionId}`}
            data-ez-section-id={`collection:${collection.id}:${section.sectionId}`}>
            <h3 className="category-section-title">{section.title}</h3>
            <ProductCards products={section.products} locale={locale} />
          </div>
        )) : products.length ? (
          // 没有版面时按运营编排的顺序平铺：专题的意义就是「我挑的先后」。
          <div data-ez-section="collection.products" data-ez-section-id={`collection:${collection.id}:products`}>
            <ProductCards products={products} locale={locale} />
          </div>
        ) : (
          <div className="empty-state">{t.products.empty}</div>
        )}
      </section>
    </>
  );
}
