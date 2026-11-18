import type { Metadata } from 'next';
import { altPaths, copyFor, localePath, type Copy, type Locale } from './i18n';

/**
 * 每页的 SEO 元数据：标题、描述、canonical 与三语 alternate 一次给全。
 * canonical 永远是「带语言前缀的那个地址」，不带前缀的旧地址由 308 指过来，
 * 否则同一内容会有两个可索引 URL。
 *
 * noindex 只给个人化页面（购物袋/结账/会员/登录）——它们对搜索引擎没有价值，
 * 收录反而会把用户的私人页面暴露在结果里。
 */
export function pageMetadata(locale: Locale, path: string, key: keyof Copy['seo'],
  { index = true }: { index?: boolean } = {}): Metadata {
  const seo = copyFor[locale].seo[key];
  return {
    title: seo.title,
    description: seo.description,
    alternates: { canonical: localePath(locale, path), languages: altPaths(path) },
    ...(index ? {} : { robots: { index: false, follow: true } }),
  };
}
