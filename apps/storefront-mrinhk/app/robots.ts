import type { MetadataRoute } from 'next';
import { site } from '../lib/site';

/**
 * robots：公开营销页可抓取；购物袋、结账、会员、登录与接口一律不抓。
 * sitemap 指向带语言前缀的条目，避免爬虫把 308 跳转当成唯一地址。
 */
export default function robots(): MetadataRoute.Robots {
  const base = `https://${site.domain}`;
  return {
    rules: [{
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/*/cart', '/*/checkout', '/*/member', '/*/login'],
    }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
