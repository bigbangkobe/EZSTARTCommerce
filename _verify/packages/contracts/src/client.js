export class ApiResponseError extends Error {
    status;
    code;
    requestId;
    constructor(status, code, requestId) {
        super(code);
        this.status = status;
        this.code = code;
        this.requestId = requestId;
    }
}
/** Same-instance browser client. HTTP-only cookies stay in the browser cookie jar. */
export function createAdminClient(baseUrl, fetcher = fetch) {
    const base = new URL(baseUrl);
    if (base.username || base.password || base.search || base.hash || !['https:', 'http:'].includes(base.protocol)) {
        throw new Error('Invalid API base URL');
    }
    if (!base.pathname.endsWith('/'))
        base.pathname += '/';
    return {
        async login(body) {
            const response = await fetcher(new URL('admin/auth/login', base), {
                method: 'POST', credentials: 'include', cache: 'no-store',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body),
            });
            if (response.status === 200) {
                return { status: 200, body: await response.json() };
            }
            if (response.status === 202) {
                return { status: 202, body: await response.json() };
            }
            // Keep raw provider/server payloads out of exception text and UI logs.
            let code = 'UNEXPECTED_RESPONSE';
            try {
                const payload = await response.json();
                if (typeof payload === 'object' && payload !== null && 'error' in payload) {
                    const error = payload.error;
                    if (typeof error === 'object' && error !== null && 'code' in error &&
                        typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code))
                        code = error.code;
                }
            }
            catch { /* Non-JSON failure is still an API response error. */ }
            throw new ApiResponseError(response.status, code, response.headers.get('X-Request-Id'));
        },
    };
}
