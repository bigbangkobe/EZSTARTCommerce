import type { MetadataRoute } from 'next';
import { site } from '../lib/site';
import { LOCALES, altPaths, localePath, type Locale } from '../lib/i18n';
import { fetchProducts } from '../lib/products';

/**
 * 站点地图：只收已发布、明确可索引的页面。
 *
 * 购物袋/结账/会员/登录是个人化页面，既不在 sitemap 里，也在 robots 里 disallow。
 * 商品条目按商品 id 归并三种语言的 slug —— 同一件商品在不同语言下 slug 可能不同，
 * 若只发默认语言的地址，另外两种语言就少了对应入口。
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = `https://${site.domain}`;
  const now = new Date();
  const staticPaths = ['', '/products', '/contact'];

  // sitemap 的 alternate 必须是绝对地址，相对路径爬虫不会解析。
  const absoluteAlternates = (path: string) => Object.fromEntries(
    Object.entries(altPaths(path)).map(([lang, href]) => [lang, `${base}${href}`]));

  const entries: MetadataRoute.Sitemap = staticPaths.flatMap((path) => LOCALES.map(locale => ({
    url: `${base}${localePath(locale, path)}`,
    lastModified: now,
    changeFrequency: path === '' ? 'weekly' as const : 'daily' as const,
    priority: path === '' ? 1 : 0.8,
    alternates: { languages: absoluteAlternates(path) },
  })));

  // 商品：三次列表请求（读缓存）。API 不可用时静默跳过商品，不让整个 sitemap 失败。
  // 上限 100 是接口分页的硬上限，超过会 422，所以这里不猜更大的数字。
  const perLocale = await Promise.all(LOCALES.map(locale => fetchProducts(locale, 100)));
  const slugsById = new Map<string, Map<Locale, string>>();
  LOCALES.forEach((locale, index) => {
    const result = perLocale[index];
    if (!result.ok) return;
    for (const product of result.products) {
      const map = slugsById.get(product.id) ?? new Map<Locale, string>();
      map.set(locale, product.slug);
      slugsById.set(product.id, map);
    }
  });

  for (const slugs of slugsById.values()) {
    const languages: Record<string, string> = {};
    for (const locale of LOCALES) {
      const slug = slugs.get(locale);
      if (slug) languages[locale] = `${base}${localePath(locale, `/products/${encodeURIComponent(slug)}`)}`;
    }
    const fallback = languages['zh-HK'] ?? Object.values(languages)[0];
    if (!fallback) continue;
    languages['x-default'] = languages['zh-HK'] ?? fallback;
    for (const locale of LOCALES) {
      const slug = slugs.get(locale);
      if (!slug) continue;
      entries.push({
        url: `${base}${localePath(locale, `/products/${encodeURIComponent(slug)}`)}`,
        lastModified: now,
        changeFrequency: 'weekly',
        priority: 0.7,
        alternates: { languages },
      });
    }
  }

  return entries;
}
