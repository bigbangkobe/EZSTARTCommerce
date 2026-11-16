import { test, expect } from '@playwright/test';

const entries = [
  { id: 'audit-1', actorId: 'owner-1', action: 'admin.role.created', objectId: 'role-1', result: 'success', requestId: 'req-1', reason: null,
    occurredAt: '2026-11-16T02:00:00.000Z' },
  { id: 'audit-2', actorId: null, action: 'admin.login', objectId: null, result: 'denied', requestId: 'req-2', reason: null,
    occurredAt: '2026-11-16T01:59:00.000Z' },
];

test('audit records render read-only with pagination and no write controls', async ({ page }, info) => {
  const requests: string[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'owner-1' }, permissionCodes: ['audit.read'], csrfToken: 'csrf-test-token' } } });
    requests.push(url.search);
    if (url.searchParams.has('cursor')) return route.fulfill({ json: { data: { items: [entries[0]], nextCursor: null, hasMore: false } } });
    return route.fulfill({ json: { data: { items: [entries[1]], nextCursor: 'audit-1', hasMore: true } } });
  });
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: '审计记录', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'admin.login', exact: true })).toBeVisible();
  await expect(page.getByText('操作者：未认证 · 对象：— · 请求：req-2')).toBeVisible();
  await expect(page.getByRole('button', { name: /编辑|删除/ })).toHaveCount(0);
  await page.getByRole('region', { name: '最近事件' }).screenshot({ path: `.local-tools/audit-${info.project.name}.png` });
  await page.getByRole('button', { name: '加载更多记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'admin.role.created', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'admin.login', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更多记录', exact: true })).toHaveCount(0);
  expect(requests.some(search => search.includes('limit=25'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('accounts without audit.read see a permission notice instead of records', async ({ page }) => {
  await page.route('**/api/v1/admin/**', route => route.fulfill({ json: { data: { user: { id: 'reader' }, permissionCodes: ['staff.read'], csrfToken: 'read-token' } } }));
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: '没有读取权限', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '最近事件' })).toHaveCount(0);
});
