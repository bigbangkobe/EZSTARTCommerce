import Link from 'next/link';
import { site, whatsappLink } from '../lib/site';
import { copyFor, type Locale } from '../lib/i18n';
import type { ContentBlock, ContentPage } from '../lib/content';

/**
 * 内容页渲染（M04）：已发布页与预览页共用同一套区块版式。
 *
 * 共用很重要：预览如果换了版式，就不是「发布后会是什么样」的检查了。
 * 差异只在数据来源（已发布快照 vs 草稿）与外壳（预览没有埋点、带视口框）。
 */

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

export function ContentView({ page, locale, sectionPrefix, viewport, browseHref, indexHref }: {
  page: Pick<ContentPage, 'pageKey' | 'title' | 'blocks'>;
  locale: Locale;
  /** 埋点用的区块前缀；预览页传 null（预览不写分析事件）。 */
  sectionPrefix: string | null;
  viewport?: 'mobile' | 'desktop';
  /** 已发布页底部的「浏览商品」入口；预览页不显示（预览不是导购场景）。 */
  browseHref?: string;
  /** 内容索引入口：正文看完后除了买商品，也常想找同一类别的另一篇。 */
  indexHref?: string;
}) {
  const body = (
    <>
      <div className="red-line" />
      <h1>{page.title}</h1>
      {page.blocks.map(block => (
        <BlockView key={block.id} block={block} locale={locale}
          sectionKey={sectionPrefix ? `${sectionPrefix}.${block.id}` : `preview.${page.pageKey}.${block.id}`} />
      ))}
      {(browseHref || indexHref) && (
        <p className="content-meta">
          {browseHref && <Link href={browseHref}>{copyFor[locale].common.browseProducts}</Link>}
          {browseHref && indexHref && ' · '}
          {indexHref && <Link href={indexHref}>{copyFor[locale].pagesIndex.back}</Link>}
        </p>
      )}
      <p className="content-meta">
        <small>{site.brand} {site.brandLatin} · {copyFor[locale].footer.builtFor}</small>
      </p>
    </>
  );
  if (viewport === 'mobile') {
    return (
      <article className="content-page preview-frame">{body}</article>
    );
  }
  return <article className="content-page">{body}</article>;
}

export default ContentView;
