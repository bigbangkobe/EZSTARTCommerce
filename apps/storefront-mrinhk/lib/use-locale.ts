'use client';

import { useParams } from 'next/navigation';
import { copyFor, resolveLocale, type Copy, type Locale } from './i18n';

/**
 * 客户端组件取当前语言。
 *
 * 语言来自路由段而不是 cookie 或全局状态：同一个地址在不同语言下必须是
 * 不同 URL，否则 canonical/hreflang 无从谈起，分享出去的链接也会串语言。
 * 非法段按默认语言渲染（页面本身由 layout 决定是否 404）。
 */
export function useLocale(): { locale: Locale; t: Copy } {
  const params = useParams<{ locale?: string | string[] }>();
  const raw = Array.isArray(params?.locale) ? params.locale[0] : params?.locale;
  const locale = resolveLocale(raw);
  return { locale, t: copyFor[locale] };
}
