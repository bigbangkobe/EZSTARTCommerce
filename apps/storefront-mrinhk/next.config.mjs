const api = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';
const url = new URL(api);
if (!['http:', 'https:'].includes(url.protocol) || url.origin !== api || url.username || url.password) throw new Error('Invalid API_INTERNAL_ORIGIN');
export default { poweredByHeader: false, async rewrites() { return [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }]; } };
