import type { Metadata } from 'next';
import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { site, whatsappHref } from '../../lib/site';
import { altPaths, copyFor, isLocale, localePath, type Locale } from '../../lib/i18n';
import { fetchProducts, type ProductResult } from '../../lib/products';
import { fetchContentRelease } from '../../lib/content';
import { fetchCategories, type CategorySummary } from '../../lib/categories';
import { fetchMerchandising, type MerchResult } from '../../lib/merchandising';
import { fetchTheme, type ThemeSection } from '../../lib/theme';
import { ProductCards } from '../product-cards';
import AnalyticsTracker from '../analytics-tracker';
import SectionTracker from '../section-tracker';
import { jsonLdScript, organizationJsonLd } from '../../lib/jsonld';

function SectionHead({ num, title, jp, action }: {
  num: string; title: string; jp: string; action?: { href: string; label: string };
}) {
  return (
    <>
      <div className="red-line" />
      <div className="section-head">
        <span className="num">{num}</span>
        <h2>{title}</h2>
        <span className="jp">{jp}</span>
        {action && (
          <Link className="section-more" href={action.href}>
            {action.label}<span aria-hidden="true">→</span>
          </Link>
        )}
      </div>
    </>
  );
}

// 目录类页面按请求渲染：构建镜像时 API 还没起，预渲染出来的首页会是「商品无法载入」，
// 而且运营上架后要等 ISR 才能看到。目录数据本身很轻，按请求取更划算。
export const dynamic = 'force-dynamic';

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

/** 未在主题里配置时的默认首页区块顺序——与改造前的硬编码顺序一致，只是补了分类与承诺条。 */
const DEFAULT_SECTIONS: ThemeSection[] = [
  { type: 'hero' },
  { type: 'category_grid' },
  { type: 'product_grid', params: { sectionId: 'featured', limit: 6 } },
  { type: 'promises' },
  { type: 'about' },
];

/** 区块序号：主题可增删区块，写死「壱弐参」会在缺区块时跳号。 */
const MARKS = ['壱', '弐', '参', '肆', '伍', '陸', '漆', '捌', '玖'];
function sectionMarks(sections: ThemeSection[]) {
  let cursor = 0;
  const map = new Map<number, string>();
  sections.forEach((section, index) => {
    if (section.type === 'hero') return;
    map.set(index, MARKS[cursor] ?? String(cursor + 1));
    cursor += 1;
  });
  return map;
}

function ordinal(base: string, offset: number) {
  const index = MARKS.indexOf(base);
  return index >= 0 ? MARKS[index + offset] ?? String(index + offset + 1) : base;
}

function renderHero(locale: Locale, brandName: string, tagline: string, waLink: string, productCountLabel: string) {
  const t = copyFor[locale];
  const productsHref = localePath(locale, '/products');
  return (
    <section className="hero" data-ez-section="home.hero" data-ez-section-id="home:hero">
      <div className="container hero-inner">
        <div className="hero-copy">
          <p className="eyebrow">{t.shell.heroEyebrow}</p>
          <h1>{t.hero.title1}<br /><span>{t.hero.title2}</span></h1>
          <p className="hero-sub">{t.hero.sub}</p>
          <div className="cta-row">
            <Link className="btn btn-primary" href={productsHref} hrefLang={locale}>{t.hero.ctaSecondary}</Link>
            <a className="btn btn-ghost" href={waLink} target="_blank" rel="noopener noreferrer">{t.hero.ctaPrimary}</a>
          </div>
          <ul className="hero-chips">
            {t.shell.heroChips.map(chip => <li key={chip}>{chip}</li>)}
          </ul>
        </div>

        <div className="hero-board" aria-hidden="true">
          <div className="hero-card">
            <span className="hero-card-seal">{brandName}</span>
            <strong className="hero-card-title">{t.shell.heroVisualTitle}</strong>
            <span className="hero-card-brand">{tagline}</span>
          </div>
          <div className="hero-tag">
            <span className="hero-tag-label">{t.nav.products}</span>
            <strong>{productCountLabel}</strong>
            <span className="hero-tag-note">{t.shell.heroVisualNote}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function renderCategoryGrid(locale: Locale, categories: CategorySummary[], num: string) {
  const t = copyFor[locale];
  if (categories.length === 0) return null;
  return (
    <section className="section section-tight" id="categories"
      data-ez-section="home.categories" data-ez-section-id="home:categories">
      <div className="container">
        <SectionHead num={num} title={t.shell.categoriesLabel} jp={t.categories.jp}
          action={{ href: localePath(locale, '/categories'), label: t.shell.viewAll }} />
        <div className="cat-grid">
          {categories.slice(0, 8).map((category, index) => (
            <Link className="cat-tile" key={category.id}
              href={localePath(locale, `/categories/${encodeURIComponent(category.slug!)}`)}
              style={{ '--i': index } as { [key: string]: number }}>
              <span className="cat-tile-index">{String(index + 1).padStart(2, '0')}</span>
              <strong>{category.name}</strong>
              {category.description && <small>{category.description}</small>}
              <span className="cat-tile-arrow" aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function renderProductGrid(locale: Locale, result: ProductResult, merch: MerchResult, waLink: string, limit: number, num: string) {
  const t = copyFor[locale];
  const featured = result.ok ? result.products.slice(0, limit) : [];
  if (merch.ok && merch.sections.length > 0) {
    return merch.sections.map((section, index) => (
      <section className="section" key={section.sectionId} id={`merch-${section.sectionId}`}
        data-ez-section={`home.${section.sectionId}`} data-ez-section-id={`home:${section.sectionId}`}>
        <div className="container">
          <SectionHead num={ordinal(num, index)} title={section.title} jp={t.products.jp} />
          <ProductCards products={section.products} locale={locale} />
        </div>
      </section>
    ));
  }
  return (
    <section className="section" id="products" data-ez-section="home.products" data-ez-section-id="home:products">
      <div className="container">
        <SectionHead num={num} title={t.products.heading} jp={t.products.jp}
          action={{ href: localePath(locale, '/products'), label: t.shell.browseAll }} />
        {!result.ok && featured.length === 0 ? (
          <div className="empty-state">{t.products.error}</div>
        ) : featured.length === 0 ? (
          <div className="empty-state">
            {t.products.empty}
            <div className="cta-row" style={{ justifyContent: 'center', marginTop: 20 }}>
              <a className="btn btn-primary" href={waLink} target="_blank" rel="noopener noreferrer">{t.hero.ctaPrimary}</a>
            </div>
          </div>
        ) : <ProductCards products={featured} locale={locale} />}
      </div>
    </section>
  );
}

function renderPromises(locale: Locale, num: string) {
  const t = copyFor[locale];
  return (
    <section className="section section-tight" id="promises"
      data-ez-section="home.promises" data-ez-section-id="home:promises">
      <div className="container">
        <SectionHead num={num} title={t.shell.promiseHeading} jp={t.shell.promiseJp} />
        <ul className="promise-grid">
          {t.shell.promises.map(item => (
            <li className="promise" key={item.glyph}>
              <span className="promise-glyph" aria-hidden="true">{item.glyph}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * 首页「关于」区块：一段引子 + 三张卡 + 全文入口。
 *
 * 整段公司简介是长文，放不了首页也不该放首页——正文由后台内容页维护（pageKey=about-us），
 * 这里只负责把「你是谁、凭什么信你」讲清楚，并把客人送到全文。内容页没发布时整段链接不渲染，
 * 不留死链。
 */
function renderAbout(locale: Locale, num: string, aboutHref: string | null) {
  const t = copyFor[locale];
  return (
    <section className="section" id="about" data-ez-section="home.about" data-ez-section-id="home:about">
      <div className="container">
        <SectionHead num={num} title={t.about.heading} jp={t.about.jp} />
        <p className="about-intro">{t.about.intro}</p>
        <div className="cards">
          {t.about.cards.map(card => (
            <div className="card" key={card.glyph}>
              <div className="glyph">{card.glyph}</div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </div>
          ))}
        </div>
        {aboutHref && (
          <p className="about-more">
            <Link className="section-more" href={aboutHref} hrefLang={locale}>
              {t.about.more}<span aria-hidden="true">→</span>
            </Link>
          </p>
        )}
      </div>
    </section>
  );
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const [result, contentRelease, merch, theme, categoryResult] = await Promise.all([
    fetchProducts(locale), fetchContentRelease(locale), fetchMerchandising(locale), fetchTheme(),
    fetchCategories(locale).catch(() => ({ ok: false, items: [] as CategorySummary[] }))]);

  // 主题配置决定品牌、WhatsApp 与首页区块顺序；未配置时全部回退默认值，行为与改造前一致。
  const brandName = theme?.brand.name ?? site.brand;
  const tagline = theme?.brand.tagline ?? site.tagline;
  const whatsappGreeting = theme?.brand.whatsappGreeting ?? '你好，想向你查詢詳情';
  // 号码统一走 whatsappHref：主题里填的可能是本地 8 位号码，wa.me 只认 E.164。
  const waLink = whatsappHref(theme?.brand.whatsappNumber ?? site.whatsappNumber, whatsappGreeting);
  const sections = theme?.homeSections?.length ? theme.homeSections : DEFAULT_SECTIONS;
  const categories = categoryResult.items.filter(item => item.slug);
  // 首页角标用接口给的真实总数；拿不到时才退回「第一页条数」并标个 +。
  const productCount = result.ok ? result.products.length : 0;
  const productTotal = result.ok ? result.total : null;
  const productCountLabel = productTotal ? `${productTotal}` : productCount > 0 ? `${productCount}+` : '—';
  const marks = sectionMarks(sections);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLdScript(organizationJsonLd(locale))} />
      <AnalyticsTracker pageKey="home" locale={locale} />
      <SectionTracker pageKey="home" publishVersionId={contentRelease} locale={locale} />
      {sections.map((section, index) => {
        // 注册表之外的类型（历史配置）跳过，不影响其余区块渲染。
        switch (section.type) {
          case 'hero':
            return <Fragment key={`hero-${index}`}>{renderHero(locale, brandName, tagline, waLink, productCountLabel)}</Fragment>;
          case 'category_grid':
            return <Fragment key={`cat-${index}`}>{renderCategoryGrid(locale, categories, marks.get(index) ?? '')}</Fragment>;
          case 'promises':
            return <Fragment key={`promise-${index}`}>{renderPromises(locale, marks.get(index) ?? '')}</Fragment>;
          case 'about':
            return <Fragment key={`about-${index}`}>{renderAbout(locale, marks.get(index) ?? '',
              localePath(locale, '/about'))}</Fragment>;
          case 'product_grid': {
            const limit = typeof section.params?.limit === 'number' ? section.params.limit : 6;
            return <Fragment key={`grid-${index}`}>{renderProductGrid(locale, result, merch, waLink, limit, marks.get(index) ?? '')}</Fragment>;
          }
          case 'rich_text':
          case 'faq':
          case 'content_card':
            // 这些区块的完整渲染将在 P2 随 CMS 内容绑定落地；当前版本安全跳过。
            return null;
          default: return null;
        }
      })}
    </>
  );
}
