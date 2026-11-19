import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { copyFor, isLocale, type Locale } from '../../../../lib/i18n';
import { fetchPreview } from '../../../../lib/content';
import ContentView from '../../../content-view';

/**
 * 预览页（M04 第二批）：带短期 token 才能看**草稿**。
 *
 * 与已发布内容页的三点差别：
 * - 数据来自草稿（隐藏区块仍然不显示：预览是「发布后会是什么样」，不是编辑器）；
 * - 永远 noindex + no-store，并且**不加载区块埋点**，预览不能污染线上统计；
 * - 语言来自 URL 段，必须与 token 绑定的语言一致，否则 404（不能靠改地址偷看别的语言草稿）。
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ locale: string; token: string }> }): Promise<Metadata> {
  const { locale: raw, token } = await params;
  if (!isLocale(raw)) notFound();
  const page = await fetchPreview(token);
  if (!page || page.locale !== raw) return { title: copyFor[raw].notFound.title, robots: { index: false, follow: false } };
  return { title: `${page.title} · ${copyFor[raw].common.previewBadge}`,
    robots: { index: false, follow: false, nocache: true } };
}

export default async function PreviewPage({ params }: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: raw, token } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const page = await fetchPreview(token);
  if (!page || page.locale !== raw) notFound();

  return (
    <div className="preview-shell">
      <p className="preview-notice" role="status">
        {copyFor[locale].common.previewBadge} · {page.viewport === 'mobile' ? 'Mobile' : 'Desktop'} ·{' '}
        {new Date(page.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
      </p>
      {/* 视口以 token 绑定值为准：改查询串不能把手机预览变成桌面排版。 */}
      <ContentView page={page} locale={locale} sectionPrefix={null} viewport={page.viewport} />
    </div>
  );
}
