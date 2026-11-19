import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { copyFor, isLocale, localePath, type Locale } from '../../../../lib/i18n';
import { fetchPage, fetchRedirect, type ContentPage } from '../../../../lib/content';
import ContentView from '../../../content-view';
import SectionTracker from '../../../section-tracker';

/**
 * 内容页（M04）：正文来自后台内容 CMS 的**已发布快照**，不再写死在前台代码里。
 *
 * 三种行为边界：
 * - 未发布/已撤下 → 接口 404 → 这里 notFound()，草稿没有公开地址；
 * - indexable=false → 页面可见但 noindex，不进站点地图；
 * - canonical 指向**实际渲染的那个语言**，语言不存在时不会伪造一个地址出去。
 */

function alternateLanguages(page: ContentPage): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const alternate of page.alternates) {
    if (isLocale(alternate.locale)) languages[alternate.locale] = localePath(alternate.locale, `/pages/${alternate.slug}`);
  }
  const fallback = languages['zh-HK'] ?? Object.values(languages)[0];
  if (fallback) languages['x-default'] = fallback;
  return languages;
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }): Promise<Metadata> {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const page = await fetchPage(slug, raw);
  if (!page) return { title: copyFor[raw].notFound.title, robots: { index: false, follow: false } };
  return {
    title: page.seoTitle ?? page.title,
    ...(page.seoDescription ? { description: page.seoDescription } : {}),
    alternates: {
      canonical: localePath((isLocale(page.locale) ? page.locale : raw), `/pages/${page.slug}`),
      languages: alternateLanguages(page),
    },
    ...(page.indexable ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function ContentPageView({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const page = await fetchPage(slug, locale);
  if (!page) {
    // 改过 slug 的旧地址：服务端登记过 301 才跳，没登记就照常 404（不猜目标）。
    const target = await fetchRedirect(localePath(locale, `/pages/${slug}`));
    if (target) permanentRedirect(target.toPath);
    notFound();
  }

  return (
    <>
      <SectionTracker pageKey={`page.${page.pageKey}`} publishVersionId={page.contentRelease} locale={locale} />
      <ContentView page={page} locale={locale} sectionPrefix={`page.${page.pageKey}`}
        browseHref={localePath(locale, '/products')} />
    </>
  );
}
