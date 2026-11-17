import { test, expect } from '@playwright/test';

const openId = '7f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const lateId = '8f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const deleteId = '9f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const owner = { id: '1f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', displayName: '店主' };

function row(overrides: Record<string, unknown> = {}) {
  return { id: openId, requestNumber: 'PR-20261117-0001', requestType: 'access', sourceChannel: 'email', scope: ['profile'],
    customerRef: 'chan@example.com', customerId: null, customerName: null, verificationState: 'pending',
    verificationMethod: null, verificationEvidenceRef: null, verifiedAt: null, verifier: null, status: 'received',
    receivedAt: '2026-11-10T02:00:00.000Z', dueAt: '2026-12-10T02:00:00.000Z', overdueDays: 0, owner, reviewer: null,
    decisionAt: null, decisionReason: null, retentionExceptionRef: null, exportJobRef: null, completedAt: null,
    ruleVersion: 'privacy-v1', version: 1, createdAt: '2026-11-10T02:00:00.000Z', updatedAt: '2026-11-10T02:00:00.000Z', ...overrides };
}
const settings = { dueDays: 30, version: 3, updatedAt: '2026-11-17T03:00:00.000Z' };
const history = [
  { action: 'privacy.request.created', actorName: '店主', result: 'success', reason: 'access via email',
    occurredAt: '2026-11-10T02:00:00.000Z' },
];

/** 资料请求队列：到期优先排序、逾期可见，受理要按契约把「顾客说要什么」记下来。 */
test('the privacy queue shows what is overdue and registers a request as described', async ({ page }) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const late = row({ id: lateId, requestNumber: 'PR-20261110-0002', requestType: 'delete', customerRef: 'lee@example.com',
    receivedAt: '2026-10-01T02:00:00.000Z', dueAt: '2026-10-31T02:00:00.000Z', overdueDays: 17 });
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: owner, csrfToken: 'csrf-test-token',
        permissionCodes: ['privacy.read', 'privacy.manage', 'privacy.verify', 'privacy.process', 'customers.read_masked'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/privacy-requests')) {
      return route.fulfill({ json: { data: { items: [late, row()], nextCursor: null, hasMore: false,
        summary: { open: 2, overdue: 1 }, settings }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && /\/privacy-requests\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: { data: { ...row(), history }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/privacy-requests')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ status: 201, json: { data: row({ id: 'new-request', requestNumber: 'PR-20261117-0003' }),
        meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/privacy');
  await expect(page.getByRole('heading', { name: '资料请求', exact: true })).toBeVisible();
  // 逾期件排在前面，并且必须在列表里说出来逾期几天。
  await expect(page.getByText('共 2 件未结案，其中 1 件已逾期')).toBeVisible();
  await expect(page.getByText('逾期 17 天')).toBeVisible();
  await expect(page.getByText('PR-20261110-0002')).toBeVisible();
  await expect(page.getByText(/受理后须在/)).toBeVisible();

  // 受理：类型、来源、自述身份与范围原样提交，空的范围不会被当成一个空字符串类别。
  await page.getByLabel(/^类型/).selectOption('correct');
  await page.getByLabel(/^来源/).selectOption('phone');
  await page.getByLabel(/^申请人自述身份/).fill('  lee@example.com ');
  await page.getByLabel(/^范围/).fill('profile, orders , ');
  await page.getByLabel(/^范围/).press('Enter');

  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.body).toEqual({ requestType: 'correct', sourceChannel: 'phone',
    customerRef: 'lee@example.com', scope: ['profile', 'orders'] });
  await expect(page.getByText(/已受理 PR-20261117-0003/)).toBeVisible();
});

/** 决定区：删除类请求「标记完成」时必须填保留依据，且没有核验权限时不显示核验表单。 */
test('a deletion cannot be marked done without naming the retention rule', async ({ page }) => {
  const writes: { body: Record<string, unknown>; key: string | null }[] = [];
  const verified = row({ id: deleteId, requestNumber: 'PR-20261117-0009', requestType: 'delete',
    verificationState: 'verified', verificationMethod: 'email_reply', verifiedAt: '2026-11-11T02:00:00.000Z',
    verifier: owner, status: 'verified' });
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: owner, csrfToken: 'csrf-test-token',
        permissionCodes: ['privacy.read', 'privacy.process'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/privacy-requests')) {
      return route.fulfill({ json: { data: { items: [verified], nextCursor: null, hasMore: false,
        summary: { open: 1, overdue: 0 }, settings }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && /\/privacy-requests\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: { data: { ...verified, history }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/complete')) {
      writes.push({ body: request.postDataJSON() as Record<string, unknown>, key: request.headers()['idempotency-key'] ?? null });
      return route.fulfill({ json: { data: { ...verified, status: 'completed', completedAt: '2026-11-17T04:00:00.000Z',
        retentionExceptionRef: 'retention-v1#order-history' }, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/privacy');
  await expect(page.getByRole('heading', { name: 'PR-20261117-0009：删除' })).toBeVisible();
  // 没有 privacy.verify：核验表单不出现，已经核验过的事实仍然要显示出来。
  await expect(page.getByRole('heading', { name: '核验身份' })).toHaveCount(0);
  await expect(page.getByText(/核验 已完成（email_reply/)).toBeVisible();
  await expect(page.getByText('与「审计记录」是同一份事实')).toBeVisible();

  await page.getByLabel(/^决定/).selectOption('completed');
  // 选择「标记完成」后才会出现保留依据，并且是必填。
  const retention = page.getByLabel(/^保留例外依据/);
  await expect(retention).toBeVisible();
  await page.getByLabel(/^原因/).fill('个人资料已按保留规则删除，订单按税务要求保留');
  await retention.fill('retention-v1#order-history');
  await retention.press('Enter');

  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.body).toEqual({ decision: 'completed', reason: '个人资料已按保留规则删除，订单按税务要求保留',
    retentionExceptionRef: 'retention-v1#order-history' });
  // 决定要带幂等键：重试不会把一次完成写成两次。
  expect(writes[0]!.key).toBeTruthy();
  await expect(page.getByText(/PR-20261117-0009 已记录/)).toBeVisible();
});
