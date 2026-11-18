const api = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';
const url = new URL(api);
if (!['http:', 'https:'].includes(url.protocol) || url.origin !== api || url.username || url.password) throw new Error('Invalid API_INTERNAL_ORIGIN');

// 旧的「无语言前缀」地址一律永久指向默认语言，避免同一内容有两个可索引 URL。
// 根路径用 307：默认语言以后再变时，浏览器不会把旧跳转记成永久。
const DEFAULT_LOCALE = 'zh-HK';
const legacy = ['/products/:slug*', '/contact', '/cart', '/checkout', '/login', '/member'];

export default {
  poweredByHeader: false,
  async redirects() {
    return [
      { source: '/', destination: `/${DEFAULT_LOCALE}`, permanent: false },
      ...legacy.map((source) => ({ source, destination: `/${DEFAULT_LOCALE}${source}`, permanent: true })),
    ];
  },
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }];
  },
};
