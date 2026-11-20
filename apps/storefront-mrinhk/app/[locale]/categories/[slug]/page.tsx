import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { DEFAULT_LOCALE, copyFor, isLocale, localePath, type Locale } from '../../../../lib/i18n';
import { fetchCategory } from '../../../../lib/categories';
import { fetchRedirect } from '../../../../lib/content';
import { ProductCards } from '../../../product-cards';
import AnalyticsTracker from '../../../analytics-tracker';
import SectionTracker from '../../../section-tracker';

export const revalidate = 30;

/** hreflang 只写分类真实存在的语言；缺译时不编一个指向 404 的地址。 */
function languagesFor(alternates: { locale: string; slug: string }[]): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const alternate of alternates) {
    if (!isLocale(alternate.locale)) continue;
    languages[alternate.locale] = localePath(alternate.locale as Locale, `/categories/${encodeURIComponent(alternate.slug)}`);
  }
  if (languages[DEFAULT_LOCALE]) languages['x-default'] = languages[DEFAULT_LOCALE]!;
  return languages;
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }): Promise<Metadata> {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  const result = await fetchCategory(decodeURIComponent(slug), raw);
  if (!result.ok) {
    // 取不到分类时不要让搜索引擎把一个空壳页收进去；真不存在的分类由页面层 404。
    return { title: t.seo.categories.title, description: t.seo.categories.description,
      robots: { index: false, follow: false } };
  }
  const languages = languagesFor(result.alternates);
  return {
    title: result.category.name,
    description: result.category.description ?? t.seo.categories.description,
    alternates: {
      canonical: localePath(raw, `/categories/${encodeURIComponent(result.category.slug)}`),
      ...(Object.keys(languages).length ? { languages } : {}),
    },
  };
}

export default async function CategoryPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = copyFor[locale];
  const result = await fetchCategory(decodeURIComponent(slug), locale);
  if (!result.ok && result.error === 'not_found') {
    // 改过 slug 的旧分类地址：服务端登记过 301 才跳，没登记就照常 404（不猜目标）。
    const target = await fetchRedirect(localePath(locale, `/categories/${decodeURIComponent(slug)}`));
    if (target) permanentRedirect(target.toPath);
    notFound();
  }

  const pageKey = `category:${decodeURIComponent(slug)}`;
  if (!result.ok) {
    return (
      <section className="section" data-ez-section="category.detail" data-ez-section-id="category:detail">
        <div className="red-line" />
        <div className="section-head"><span className="num">壱</span><h2>{t.categories.heading}</h2>
          <span className="jp">{t.categories.jp}</span></div>
        <div className="empty-state">{t.categories.error}</div>
      </section>
    );
  }

  const { category, layout, products, contentRelease } = result;
  const sections = layout?.sections.length ? layout.sections : null;

  return (
    <>
      <AnalyticsTracker pageKey={pageKey} locale={locale} />
      <SectionTracker pageKey={pageKey} publishVersionId={contentRelease} locale={locale} />
      <section className="section" data-ez-section="category.detail" data-ez-section-id={`category:${category.id}`}>
        <div className="red-line" />
        <div className="section-head">
          <span className="num">壱</span>
          <h2>{category.name}</h2>
          <span className="jp">{t.categories.jp}</span>
        </div>
        {category.description && <p className="category-intro">{category.description}</p>}
        <p><small><Link href={localePath(locale, '/categories')}>{t.categories.all}</Link></small></p>

        {sections ? sections.map((section) => (
          // 区块标题由运营按语言填写；这里不再拼「此分类的商品」之类的固定前缀。
          <div key={section.sectionId} data-ez-section={`category.${section.sectionId}`}
            data-ez-section-id={`category:${category.id}:${section.sectionId}`}>
            <h3 className="category-section-title">{section.title}</h3>
            <ProductCards products={section.products} locale={locale} />
          </div>
        )) : products.length ? (
          <div data-ez-section="category.products" data-ez-section-id={`category:${category.id}:products`}>
            <ProductCards products={products} locale={locale} />
          </div>
        ) : (
          <div className="empty-state">{t.products.empty}</div>
        )}
      </section>
    </>
  );
}
