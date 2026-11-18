import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { site, whatsappLink } from '../../../../lib/site';
import { copyFor, isLocale, localePath, type Locale } from '../../../../lib/i18n';
import { fetchPage, type ContentBlock, type ContentPage } from '../../../../lib/content';
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

/** 区块渲染：每种类型对应一个固定版式；配置在服务端已按类型白名单校验过。 */
function BlockView({ block, sectionKey, locale }: { block: ContentBlock; sectionKey: string; locale: Locale }) {
  const config = block.config;
  const text = (key: string): string | null => (typeof config[key] === 'string' ? (config[key] as string) : null);
  if (block.type === 'rich_text') {
    const paragraphs = Array.isArray(config['paragraphs']) ? (config['paragraphs'] as string[]) : [];
    return (
      <section className="content-block" data-ez-section={sectionKey} data-ez-section-id={sectionKey}>
        {text('heading') && <h2>{text('heading')}</h2>}
        {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        {text('footnote') && <p className="content-footnote">{text('footnote')}</p>}
      </section>
    );
  }
  if (block.type === 'faq_list') {
    const items = Array.isArray(config['items']) ? (config['items'] as { question: string; answer: string }[]) : [];
    return (
      <section className="content-block" data-ez-section={sectionKey} data-ez-section-id={sectionKey}>
        {items.map((item, index) => (
          <details key={index} className="faq-item">
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </section>
    );
  }
  if (block.type === 'contact_card') {
    const email = text('email');
    return (
      <section className="content-block contact-card" data-ez-section={sectionKey} data-ez-section-id={sectionKey}>
        {text('heading') && <h2>{text('heading')}</h2>}
        {text('body') && <p>{text('body')}</p>}
        {email && <p><a href={`mailto:${email}`}>{email}</a></p>}
        {config['showWhatsApp'] === true && (
          <a className="btn btn-primary" href={whatsappLink} target="_blank" rel="noopener noreferrer">
            {copyFor[locale].common.whatsapp}
          </a>
        )}
      </section>
    );
  }
  if (block.type === 'notice') {
    return (
      <aside className={`content-notice ${String(config['tone'] ?? 'info')}`}
        data-ez-section={sectionKey} data-ez-section-id={sectionKey}>
        {text('text')}
      </aside>
    );
  }
  // 注册表之外的类型不会出现在快照里（服务端发布时已拒绝），这里保持沉默而不是渲染原始数据。
  return null;
}

export default async function ContentPageView({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const page = await fetchPage(slug, locale);
  if (!page) notFound();
  const t = copyFor[locale];

  return (
    <>
      <SectionTracker pageKey={`page.${page.pageKey}`} publishVersionId={page.contentRelease} locale={locale} />
      <article className="content-page">
        <div className="red-line" />
        <h1>{page.title}</h1>
        {page.blocks.map(block => (
          <BlockView key={block.id} block={block} locale={locale} sectionKey={`page.${page.pageKey}.${block.id}`} />
        ))}
        <p className="content-meta">
          <Link href={localePath(locale, '/products')}>{t.common.browseProducts}</Link>
        </p>
        <p className="content-meta">
          <small>{site.brand} {site.brandLatin} · {t.footer.builtFor}</small>
        </p>
      </article>
    </>
  );
}
