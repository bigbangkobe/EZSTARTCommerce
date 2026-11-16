import type { operations } from '../generated/api.js';

type Login = operations['adminLogin'];
type Json<T> = T extends { content: { 'application/json': infer Value } } ? Value : never;
export type AdminLoginRequest = Json<Login['requestBody']>;
export type AdminLoginResult =
  | { status: 200; body: Json<Login['responses'][200]> }
  | { status: 202; body: Json<Login['responses'][202]> };

export class ApiResponseError extends Error {
  constructor(readonly status: number, readonly code: string, readonly requestId: string | null) {
    super(code);
  }
}

/** Same-instance browser client. HTTP-only cookies stay in the browser cookie jar. */
export function createAdminClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || !['https:', 'http:'].includes(base.protocol)) {
    throw new Error('Invalid API base URL');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';

  return {
    async login(body: AdminLoginRequest): Promise<AdminLoginResult> {
      const response = await fetcher(new URL('admin/auth/login', base), {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 200) {
        return { status: 200, body: await response.json() as Json<Login['responses'][200]> };
      }
      if (response.status === 202) {
        return { status: 202, body: await response.json() as Json<Login['responses'][202]> };
      }
      // Keep raw provider/server payloads out of exception text and UI logs.
      let code = 'UNEXPECTED_RESPONSE';
      try {
        const payload: unknown = await response.json();
        if (typeof payload === 'object' && payload !== null && 'error' in payload) {
          const error: unknown = payload.error;
          if (typeof error === 'object' && error !== null && 'code' in error &&
              typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)) code = error.code;
        }
      } catch { /* Non-JSON failure is still an API response error. */ }
      throw new ApiResponseError(response.status, code, response.headers.get('X-Request-Id'));
    },
  };
}
