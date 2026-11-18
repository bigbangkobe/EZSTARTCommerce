'use client';

import Link from 'next/link';
import { copyFor, localePath } from '../../lib/i18n';
import { useLocale } from '../../lib/use-locale';

/** 语言段内的 404：文案跟随当前语言，给出回首页与逛商品的出口。 */
export default function NotFound() {
  const { locale, t } = useLocale();
  return (
    <section className="section">
      <div className="red-line" />
      <div className="section-head">
        <span className="num">四〇四</span>
        <h2>{t.notFound.title}</h2>
        <span className="jp">お探しのページ</span>
      </div>
      <div className="empty-state">
        <p>{t.notFound.body}</p>
        <div className="cta-row" style={{ justifyContent: 'center', marginTop: 24 }}>
          <Link className="btn btn-primary" href={localePath(locale)}>{t.notFound.home}</Link>
          <Link className="btn btn-ghost" href={localePath(locale, '/products')}>{t.common.browseProducts}</Link>
        </div>
      </div>
    </section>
  );
}
