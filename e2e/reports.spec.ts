import { test, expect } from '@playwright/test';

const reportResult = {
  reportKey: 'sales_summary', metricDefinitionVersion: '1.0',
  generatedAt: '2026-11-18T02:00:00.000Z',
  from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z',
  timezone: 'Asia/Hong_Kong', currencies: ['HKD'], filters: { marketCode: null },
  totals: { orderCount: 3, placedMinor: 38000, collectedMinor: 23000, netSalesMinor: 18000 },
  rows: [
    { dimensions: { currency: 'HKD' }, metrics: { orderCount: 3, placedMinor: 38000, collectedMinor: 23000, netSalesMinor: 18000 } },
  ],
  coverage: { sourceOrderCount: 3, lastDataAt: '2026-11-06T10:00:00.000Z', complete: true, note: '3 笔订单进入统计' },
};
const exportJob = {
  id: 'a1b2c3d4-1234-4234-8234-123456789abc', reportKey: 'sales_summary', format: 'csv', status: 'completed',
  fileName: 'sales_summary-2026-11-18.csv', rowCount: 1,
  downloadUrl: '/api/v1/admin/report-exports/a1b2c3d4-1234-4234-8234-123456789abc/download',
  includePii: false, filters: {}, createdAt: '2026-11-18T02:00:00.000Z',
  completedAt: '2026-11-18T02:00:00.000Z', expiresAt: '2026-11-18T02:30:00.000Z',
};

test('a finance user generates a report and exports CSV', async ({ page }) => {
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['reports.view', 'reports.export'] } } });
    }
    if (method === 'GET' && url.pathname.includes('/reports/')) {
      return route.fulfill({ json: { data: reportResult, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/report-exports')) {
      writes.push(request.postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 202, json: { data: exportJob, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/reports');
  await expect(page.getByRole('heading', { name: '经营报表', exact: true })).toBeVisible();
  // 有导出权限才出现导出按钮。
  await expect(page.getByRole('button', { name: '导出 CSV' })).toBeVisible();

  await page.getByRole('button', { name: '生成报表' }).click();
  await expect(page.getByRole('heading', { name: '销售汇总' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('口径版本 1.0');
  await expect(page.getByRole('cell', { name: '订单数' })).toBeVisible();
  await expect(page.getByText('HKD 380.00').first()).toBeVisible();

  await page.getByRole('button', { name: '导出 CSV' }).click();
  await expect(page.getByText('导出已就绪，可点击下载。')).toBeVisible();
  await expect(page.getByRole('link', { name: '下载 CSV' })).toBeVisible();
  expect(writes[0]?.['reportKey']).toBe('sales_summary');
  expect(writes[0]?.['format']).toBe('csv');
});

test('an account without reports.view sees a permission notice', async ({ page }) => {
  await page.route('**/api/v1/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-2' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['orders.read'] } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });
  await page.goto('/admin/reports');
  await expect(page.getByText(/没有报表读取权限/)).toBeVisible();
});
