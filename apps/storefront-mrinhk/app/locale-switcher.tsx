'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LOCALE_LABEL, LOCALE_SHORT, LOCALES, copyFor, isLocale, localePath } from '../lib/i18n';

/**
 * 页头语言切换：只换 URL 的第一段，保留当前页面。
 *
 * 不用 cookie 记住语言：链接本身就是语言，复制给别人不会跑偏。
 * 同语言的那一项不可点（aria-current），避免用户以为可以"再次切换"。
 */
export default function LocaleSwitcher() {
  const pathname = usePathname() ?? '/';
  const segments = pathname.split('/').filter(Boolean);
  const current = isLocale(segments[0]) ? segments[0] : null;
  const rest = current ? segments.slice(1) : segments;
  const target = rest.length ? `/${rest.join('/')}` : '';

  return (
    <span className="lang-switch" role="group" aria-label={copyFor[current ?? 'zh-HK'].common.language}>
      {LOCALES.map(locale => {
        const active = locale === current;
        return (
          <Link
            key={locale}
            href={localePath(locale, target)}
            hrefLang={locale}
            aria-current={active ? 'true' : undefined}
            title={LOCALE_LABEL[locale]}
            className={active ? 'lang-active' : undefined}
          >
            {LOCALE_SHORT[locale]}
          </Link>
        );
      })}
    </span>
  );
}
