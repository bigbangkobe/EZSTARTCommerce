import { NextResponse, type NextRequest } from 'next/server';

/**
 * 入口层两件事（M04 第二批）：
 *
 * 1. 旧地址 301：改过 slug 的页面由后台登记重定向。清单在实例内缓存 30 秒，
 *    命中才跳——不让每个请求都回源，也不让重定向表随页面数线性增加开销。
 * 2. 预览页响应头：noindex + no-store。预览页本身还在 [locale] 布局里，
 *    必须在这里补 HTTP 头，否则爬虫仍可能抓到一个「像线上页面」的草稿。
 *
 * 失败即放行：清单取不到或结构异常时直接 next()，让正常路由去处理（该 404 就 404），
 * 不能因为一张运维表不可用而把整站挡掉。
 */

const apiBase = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';
const CACHE_TTL_MS = 30_000;

type Rule = { toPath: string; statusCode: 301 | 308 };
let cache: { at: number; rules: Map<string, Rule> } = { at: 0, rules: new Map() };

async function redirectRules(): Promise<Map<string, Rule>> {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.rules;
  const rules = new Map<string, Rule>();
  try {
    const res = await fetch(`${apiBase}/api/v1/storefront/redirects`, { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { data?: { items?: { fromPath?: unknown; toPath?: unknown; statusCode?: unknown }[] } };
      for (const item of body.data?.items ?? []) {
        if (typeof item.fromPath !== 'string' || typeof item.toPath !== 'string') continue;
        // 只接受站内路径：接口已经校验过，这里再挡一次，避免坏数据把入口变成外链跳板。
        if (!item.fromPath.startsWith('/') || !item.toPath.startsWith('/') || item.toPath.startsWith('//')) continue;
        rules.set(item.fromPath, { toPath: item.toPath, statusCode: item.statusCode === 308 ? 308 : 301 });
      }
    }
  } catch {
    // 忽略：本轮到点后重试，期间按「没有重定向」处理。
  }
  cache = { at: Date.now(), rules };
  return rules;
}

// Next 16 把 middleware 改名为 proxy：文件名与导出名必须一起改，否则入口层不会生效。
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname.includes('/preview/')) {
    const response = NextResponse.next();
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    return response;
  }

  try {
    const rules = await redirectRules();
    const rule = rules.get(pathname);
    if (rule) return NextResponse.redirect(new URL(`${rule.toPath}${search}`, request.url), rule.statusCode);
  } catch {
    // 同上：入口层不能成为单点故障。
  }
  return NextResponse.next();
}

export const config = {
  // API 走 rewrites，静态资源与站点地图不需要入口层判断。
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
