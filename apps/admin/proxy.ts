import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString('base64');
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
export const config = { matcher: ['/admin/:path*'] };
