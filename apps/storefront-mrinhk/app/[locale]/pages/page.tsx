import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { altPaths, copyFor, isLocale, localePath } from '../../../lib/i18n';
import { fetchPage, fetchPages, pageExcerpt, type ContentPageSummary } from '../../../lib/content';
import AnalyticsTracker from '../../analytics-tracker';

export const revalidate = 60;

/**
 * 内容索引（M04 第七批）：站内所有**可索引**的已发布内容页，按类型分组。
 *
 * 三条口径：
 * - 只列 `indexable` 的页面：列表本身要被搜索引擎收录，把 noindex 页面摆在这里
 *   等于用列表页替它们开路，与后台「不进索引」的意图冲突；
 * - 分组顺序固定（公告 → 专稿 → FAQ → 条款 → 其他），不按标题排序：
 *   运营新增一页时不该让整页顺序洗牌，访客记忆的「公告在最上面」要一直成立；
 * - 摘要取自已发布快照的区块正文，取不到就只显示标题——不编造一句话填充版面。
 *
 * 接口不可用时显示空态而不是 404：索引页不是关键路径（详情页仍可直接访问），
 * 但把已分享出去的入口变成 404 会连标题都看不到。
 */

/** 分组顺序：新增类型必须显式落到某个分组，不认识的一律进「其他」。 */
const TYPE_ORDER = ['announcement', 'article', 'faq', 'policy', 'standard'] as const;
type GroupKey = typeof TYPE_ORDER[number];
/** 一次最多列 40 页：详情请求是逐个取的，超出这个量索引页本身就没人翻了。 */
const MAX_LISTED = 40;

function groupOf(pageType: string): GroupKey {
  return (TYPE_ORDER as readonly string[]).includes(pageType) ? pageType as GroupKey : 'standard';
}

type IndexItem = ContentPageSummary & { excerpt: string | null };

/** 已发布清单 → 带摘要的条目；详情取不到的页面直接丢掉，不留下点进去是 404 的链接。 */
async function loadIndex(locale: string): Promise<IndexItem[]> {
  const summaries = (await fetchPages(locale)).filter(page => page.indexable).slice(0, MAX_LISTED);
  const details = await Promise.all(summaries.map(page => fetchPage(page.slug, locale)));
  return summaries.flatMap((summary, index) => {
    const detail = details[index];
    if (!detail) return [];
    return [{ ...summary, excerpt: pageExcerpt(detail.blocks) }];
  });
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  // 没有任何可索引内容时，索引页自己也不进索引：一页只有「暂无内容」不值得被收录。
  const items = await loadIndex(raw);
  return {
    title: t.seo.pages.title,
    description: t.seo.pages.description,
    alternates: { canonical: localePath(raw, '/pages'), languages: altPaths('/pages') },
    ...(items.length === 0 ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function ContentIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw;
  const t = copyFor[locale];
  const items = await loadIndex(locale);

  const groups = TYPE_ORDER
    .map(type => ({ type, label: t.pagesIndex.types[type], items: items.filter(item => groupOf(item.pageType) === type) }))
    .filter(group => group.items.length > 0);

  return (
    <section className="section" data-ez-section="pages.index" data-ez-section-id="pages:index">
      <AnalyticsTracker pageKey="pages.index" locale={locale} />
      <div className="red-line" />
      <div className="section-head">
        <span className="num">参</span>
        <h2>{t.pagesIndex.heading}</h2>
        <span className="jp">{t.pagesIndex.jp}</span>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">{t.pagesIndex.empty}</div>
      ) : (
        <>
          <p className="content-meta">{t.pagesIndex.intro}</p>
          {groups.map(group => (
            <section key={group.type} className="content-block"
              data-ez-section={`pages.index.${group.type}`} data-ez-section-id={`pages:${group.type}`}>
              <h3>{group.label}</h3>
              <ul className="category-list">
                {group.items.map(item => (
                  <li key={item.pageKey}>
                    <Link href={localePath(locale, `/pages/${encodeURIComponent(item.slug)}`)} hrefLang={locale}>
                      {item.title}
                    </Link>
                    {item.excerpt && <p>{item.excerpt}</p>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </section>
  );
}
