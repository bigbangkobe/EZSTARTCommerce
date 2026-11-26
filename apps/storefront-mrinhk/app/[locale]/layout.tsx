import type { Metadata } from 'next';
import Link from 'next/link';
import { site, whatsappHref } from '../../lib/site';
import {
  LOCALES, HTML_LANG, OG_LOCALE, altPaths, copyFor, isLocale, localePath, resolveLocale, type Locale,
} from '../../lib/i18n';
import { fetchPages } from '../../lib/content';
import { fetchCategories } from '../../lib/categories';
import { fetchTheme, themeCssVariables } from '../../lib/theme';
import CartLink from '../cart-link';
import LocaleSwitcher from '../locale-switcher';
import MemberLink from '../member-link';
import '../globals.css';

/**
 * 语言段是根布局：三种语言各自一套 URL，html lang 与 canonical 都从这里定。
 * 不在 middleware 里重写，是为了让「哪个 URL 对应哪种语言」在路由层面就确定，
 * 静态渲染、缓存与搜索引擎看到的完全一致。
 */
export function generateStaticParams() {
  return LOCALES.map(locale => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : 'zh-HK';
  const t = copyFor[locale];
  // 主题配置覆盖品牌名；未配置时用 site.ts 兜底，行为与改造前一致。
  const theme = await fetchTheme().catch(() => null);
  const brandName = theme?.brand.name ?? site.brand;
  const brandLatin = theme?.brand.brandLatin ?? site.brandLatin;
  const brandFull = `${brandName} ${brandLatin}`.trim();
  const base = new URL(`https://${site.domain}`);
  return {
    metadataBase: base,
    title: { default: t.seo.home.title, template: `%s | ${brandFull}` },
    description: t.seo.home.description,
    applicationName: brandFull,
    alternates: { canonical: localePath(locale), languages: altPaths('') },
    openGraph: {
      type: 'website',
      siteName: brandFull,
      locale: OG_LOCALE[locale],
      title: t.seo.home.title,
      description: t.seo.home.description,
      url: localePath(locale),
    },
    robots: { index: true, follow: true },
  };
}

const WHATSAPP_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.1-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
);

/** 印章里的两字缩写：优先取品牌拉丁名最后一个词（Mr. IN → IN），没有拉丁名就用中文首字。 */
function sealText(brandLatin: string, brandName: string) {
  const latin = brandLatin.replace(/[^A-Za-z ]/g, ' ').trim();
  const words = latin.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] ?? '';
  if (last.length >= 2) return last.slice(0, 2).toUpperCase();
  if (latin.length >= 2) return latin.slice(0, 2).toUpperCase();
  return Array.from(brandName)[0] ?? 'IN';
}

export default async function LocaleLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  // 布局本身不判定 404：每个页面在拿到参数后会调 notFound()，这样能落到
  // app/[locale]/not-found.tsx 的自定义 404（带页头页脚、跟随语言），
  // 而不是 Next 内置的裸 404。这里只为渲染外壳选一个语言。
  const locale: Locale = resolveLocale(raw);
  const t = copyFor[locale];
  // 主题配置覆盖品牌/配色/WhatsApp；未配置时全部回退 site.ts 与默认 tokens。
  const theme = await fetchTheme().catch(() => null);
  const brandName = theme?.brand.name ?? site.brand;
  const brandLatin = theme?.brand.brandLatin ?? site.brandLatin;
  const brandTagline = theme?.brand.tagline ?? site.tagline;
  const whatsappNumber = theme?.brand.whatsappNumber ?? site.whatsappNumber;
  const whatsappGreeting = theme?.brand.whatsappGreeting ?? site.whatsappGreeting;
  // 页脚展示本地号码（客人认的是 8 位），链接必须带区号：wa.me 只认 E.164。
  const waLink = whatsappHref(whatsappNumber, whatsappGreeting);
  const cssVars = theme ? themeCssVariables(theme) : null;
  // 已发布内容页由后台维护：页脚只列当前语言下真实存在的地址，撤下的页面自动消失。
  const pages = await fetchPages(locale).catch(() => []);
  // 分类做成页头「分类条」：客人是靠分类找货的，只藏在 /categories 里等于没有导航。
  const { items: categories } = await fetchCategories(locale)
    .catch(() => ({ items: [] as { id: string; name: string; slug: string | null }[] }));
  const topCategories = categories.filter(item => item.slug).slice(0, 12);
  const seal = sealText(brandLatin, brandName);

  return (
    <html lang={HTML_LANG[locale]}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@500;700;900&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='40' fill='%23BC002D'/%3E%3C/svg%3E"
        />
      </head>
      <body style={cssVars ?? undefined}>
        <a className="skip-link" href="#main">{t.nav.skipToContent}</a>

        <div className="topbar">
          <div className="container topbar-inner">
            <p className="topbar-note">
              <span>{t.shell.topbarNote}</span>
              <span className="topbar-sep" aria-hidden="true" />
              <span className="topbar-ship">{t.shell.topbarShipping}</span>
            </p>
            <div className="topbar-links">
              <LocaleSwitcher />
              <MemberLink />
              <CartLink />
            </div>
          </div>
        </div>

        <header className="site-header">
          <div className="container header-inner">
            <Link className="brand" href={localePath(locale)} hrefLang={locale}>
              <span className="brand-seal" aria-hidden="true">{seal}</span>
              <span className="brand-text">
                <strong>{brandName}</strong>
                <small>{brandTagline}</small>
              </span>
            </Link>

            <nav className="site-nav" aria-label={t.nav.home}>
              <Link href={localePath(locale, '/about')} hrefLang={locale}>{t.about.heading}</Link>
              <Link href={localePath(locale, '/products')} hrefLang={locale}>{t.nav.products}</Link>
              <Link href={localePath(locale, '/categories')} hrefLang={locale}>{t.nav.categories}</Link>
              <Link href={localePath(locale, '/collections')} hrefLang={locale}>{t.nav.collections}</Link>
              <Link href={localePath(locale, '/contact')} hrefLang={locale}>{t.nav.contact}</Link>
            </nav>

            <a className="header-cta" href={waLink} target="_blank" rel="noopener noreferrer">
              <span className="header-cta-icon">{WHATSAPP_ICON}</span>
              <span className="header-cta-text">{t.common.whatsapp}</span>
            </a>
          </div>

          <div className="cat-strip">
            <div className="container cat-strip-inner">
              <Link className="cat-chip cat-chip-all" href={localePath(locale, '/categories')} hrefLang={locale}>
                {t.shell.allCategories}
              </Link>
              {topCategories.map(category => (
                <Link key={category.id} className="cat-chip"
                  href={localePath(locale, `/categories/${encodeURIComponent(category.slug!)}`)} hrefLang={locale}>
                  {category.name}
                </Link>
              ))}
              <span className="cat-strip-sep" aria-hidden="true" />
              <Link className="cat-chip cat-chip-nav" href={localePath(locale, '/products')} hrefLang={locale}>{t.nav.products}</Link>
              <Link className="cat-chip cat-chip-nav" href={localePath(locale, '/collections')} hrefLang={locale}>{t.nav.collections}</Link>
              <Link className="cat-chip cat-chip-nav" href={localePath(locale, '/contact')} hrefLang={locale}>{t.nav.contact}</Link>
            </div>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="site-footer">
          <div className="container footer-grid">
            <div className="footer-brand">
              <span className="brand-seal" aria-hidden="true">{seal}</span>
              <strong>{brandName}</strong>
              <p>{t.shell.footerAboutBody}</p>
              <a className="footer-wa" href={waLink} target="_blank" rel="noopener noreferrer">
                <span className="footer-wa-icon">{WHATSAPP_ICON}</span>
                {whatsappNumber}
              </a>
            </div>

            <nav className="footer-col" aria-label={t.shell.footerShop}>
              <h2>{t.shell.footerShop}</h2>
              <Link href={localePath(locale, '/products')} hrefLang={locale}>{t.nav.products}</Link>
              <Link href={localePath(locale, '/categories')} hrefLang={locale}>{t.nav.categories}</Link>
              <Link href={localePath(locale, '/collections')} hrefLang={locale}>{t.nav.collections}</Link>
            </nav>

            <nav className="footer-col" aria-label={t.shell.footerHelp}>
              <h2>{t.shell.footerHelp}</h2>
              <Link href={localePath(locale, '/about')} hrefLang={locale}>{t.about.heading}</Link>
              <Link href={localePath(locale, '/contact')} hrefLang={locale}>{t.nav.contact}</Link>
              {pages.length > 0 && (
                <Link href={localePath(locale, '/pages')} hrefLang={locale}>{t.pagesIndex.back}</Link>
              )}
              {pages.slice(0, 4).map(page => (
                <Link key={page.pageKey} href={localePath(locale, `/pages/${page.slug}`)} hrefLang={locale}>
                  {page.title}
                </Link>
              ))}
            </nav>

            <div className="footer-col">
              <h2>{t.shell.footerContact}</h2>
              <Link href={localePath(locale, '/member')} hrefLang={locale}>{t.nav.memberCenter}</Link>
              <a href={waLink} target="_blank" rel="noopener noreferrer">WhatsApp · {whatsappNumber}</a>
              <span className="footer-muted">{site.domain}</span>
            </div>
          </div>
          <div className="container footer-base">
            <span className="seal"><span className="dot" aria-hidden="true" />{brandName} · {site.domain}</span>
            <span>© 2026 {brandLatin}. {t.footer.rights}.</span>
          </div>
        </footer>

        <a className="wa-float" href={waLink} target="_blank" rel="noopener noreferrer" aria-label={t.common.whatsapp}>
          <span className="wa-float-icon">{WHATSAPP_ICON}</span>
        </a>
      </body>
    </html>
  );
}
