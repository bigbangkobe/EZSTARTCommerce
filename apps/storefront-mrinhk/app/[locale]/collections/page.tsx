import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { altPaths, copyFor, fill, isLocale, localePath } from '../../../lib/i18n';
import { fetchCollections } from '../../../lib/collections';
import AnalyticsTracker from '../../analytics-tracker';

export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  return {
    title: t.seo.collections.title,
    description: t.seo.collections.description,
    alternates: { canonical: localePath(raw, '/collections'), languages: altPaths('/collections') },
  };
}

/**
 * 专题索引（M04 第五批）：只列启用、当前语言有地址、且至少有一件可售商品的专题。
 * 接口不可用时显示「暂时无法加载」而不是 404——空专题页会让已分享出去的入口消失。
 */
export default async function CollectionsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  const { ok, items } = await fetchCollections(raw);

  return (
    <section className="section" data-ez-section="collections.index" data-ez-section-id="collections:index">
      <AnalyticsTracker pageKey="collections.index" locale={raw} />
      <div className="red-line" />
      <div className="section-head">
        <span className="num">弐</span>
        <h2>{t.collections.heading}</h2>
        <span className="jp">{t.collections.jp}</span>
      </div>
      {!ok ? (
        <div className="empty-state">{t.collections.error}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">{t.collections.empty}</div>
      ) : (
        <ul className="category-list">
          {items.map((collection) => (
            <li key={collection.id}>
              <Link href={localePath(raw, `/collections/${encodeURIComponent(collection.slug)}`)}>{collection.name}</Link>
              {collection.description && <p>{collection.description}</p>}
              <p className="collection-count">{fill(t.collections.count, { count: collection.productCount })}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
