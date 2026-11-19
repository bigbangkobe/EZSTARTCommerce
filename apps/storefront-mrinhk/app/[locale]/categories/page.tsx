import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { altPaths, copyFor, isLocale, localePath } from '../../../lib/i18n';
import { fetchCategories } from '../../../lib/categories';

export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  return {
    title: t.seo.categories.title,
    description: t.seo.categories.description,
    alternates: { canonical: localePath(raw, '/categories'), languages: altPaths('/categories') },
  };
}

/**
 * 分类索引：只列启用中的分类。
 * 接口不可用时显示「暂时无法加载」而不是 404——空分类页会让已收录的入口消失。
 */
export default async function CategoriesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const t = copyFor[raw];
  const { ok, items } = await fetchCategories(raw);

  return (
    <section className="section" data-ez-section="categories.index" data-ez-section-id="categories:index">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">壱</span>
        <h2>{t.categories.heading}</h2>
        <span className="jp">{t.categories.jp}</span>
      </div>
      {!ok ? (
        <div className="empty-state">{t.categories.error}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">{t.categories.empty}</div>
      ) : (
        <ul className="category-list">
          {items.map((category) => (
            <li key={category.id}>
              <Link href={localePath(raw, `/categories/${encodeURIComponent(category.slug!)}`)}>{category.name}</Link>
              {category.description && <p>{category.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
