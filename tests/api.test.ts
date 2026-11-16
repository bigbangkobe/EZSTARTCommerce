import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../apps/api/src/app.js';

test('HTTP liveness, readiness and errors preserve envelopes without exposing internals', async () => {
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const live = await fetch(base + '/api/v1/health/live', { headers: { 'X-Request-Id': 'test-request' } });
    assert.equal(live.status, 200);
    assert.equal(live.headers.get('x-request-id'), 'test-request');
    assert.deepEqual(await live.json(), { data: { status: 'alive' }, meta: { requestId: 'test-request' } });
    const ready = await fetch(base + '/api/v1/health/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.headers.get('cache-control'), 'no-store');
    const error = await ready.json() as { error: { code: string; fieldErrors: unknown[]; requestId: string } };
    assert.equal(error.error.code, 'SERVICE_NOT_READY');
    assert.equal(error.error.requestId, ready.headers.get('x-request-id'));
    const missing = await fetch(base + '/api/v1/admin/auth/session');
    assert.equal(missing.status, 503); // No database-backed identity service; no fake session.
    const payload = await missing.text();
    assert.ok(!payload.includes('stack'));
    assert.ok(!payload.includes('Cannot GET'));
  } finally { await app.close(); }
});
