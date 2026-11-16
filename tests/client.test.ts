import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiResponseError, createAdminClient } from '../packages/contracts/src/client.js';

test('generated login response narrows by HTTP status and MFA nextAction', async () => {
  let sent: RequestInit | undefined;
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://shop.example.com/api/v1/admin/auth/login');
    sent = init;
    return new Response(JSON.stringify({ data: { challengeId: 'challenge-1', nextAction: 'enroll_mfa', expiresAt: '2026-10-19T10:00:00Z' },
      meta: { requestId: 'req-1' } }), { status: 202 });
  };
  const client = createAdminClient('https://shop.example.com/api/v1', mockFetch);
  const result = await client.login({ email: 'staff@example.com', password: 'example-password' });
  assert.equal(sent?.credentials, 'include');
  assert.equal(sent?.cache, 'no-store');
  if (result.status !== 202) assert.fail('Expected challenge');
  if (result.body.data.nextAction === 'enroll_mfa') {
    assert.equal(result.body.data.challengeId, 'challenge-1');
    // @ts-expect-error Enrollment challenges never contain verification methods.
    void result.body.data.allowedMethods;
  } else {
    result.body.data.allowedMethods satisfies ('totp' | 'recovery_code')[];
  }
});

test('client reports stable errors and suppresses internal error detail', async () => {
  const client = createAdminClient('https://shop.example.com/api/v1/', async () =>
    new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'private upstream error' } }),
      { status: 429, headers: { 'X-Request-Id': 'req-2' } }));
  await assert.rejects(() => client.login({ email: 'staff@example.com', password: 'example-password' }),
    (error: unknown) => error instanceof ApiResponseError && error.code === 'RATE_LIMITED' &&
      error.status === 429 && error.requestId === 'req-2' && !error.message.includes('private'));
});
