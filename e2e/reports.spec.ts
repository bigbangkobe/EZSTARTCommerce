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

test('an operator views the anonymous funnel with five steps and grouping', async ({ page }) => {
  const funnelResult = {
    reportKey: 'funnel', metricDefinitionVersion: '1.0',
    generatedAt: '2026-11-18T02:00:00.000Z',
    from: '2026-11-11T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z',
    timezone: 'Asia/Hong_Kong', currencies: [], filters: { groupBy: 'step' },
    totals: { sessions: 120, sessionsPurchased: 12, eventCount: 300 },
    rows: [
      { dimensions: { step: '访问' }, metrics: { sessions: 120 } },
      { dimensions: { step: '商品浏览' }, metrics: { sessions: 80, stepRate: 66.67, overallRate: 66.67 } },
      { dimensions: { step: '加入购物车' }, metrics: { sessions: 40, stepRate: 50, overallRate: 33.33 } },
      { dimensions: { step: '开始结账' }, metrics: { sessions: 24, stepRate: 60, overallRate: 20 } },
      { dimensions: { step: '成功下单' }, metrics: { sessions: 12, stepRate: 50, overallRate: 10 } },
    ],
    coverage: { sourceOrderCount: 12, lastDataAt: '2026-11-17T10:00:00.000Z', complete: true, note: '服务端订单归因' },
  };
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-3' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['reports.view'] } } });
    }
    if (method === 'GET' && url.pathname.includes('/reports/funnel')) {
      return route.fulfill({ json: { data: funnelResult, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });
  await page.goto('/admin/reports');
  await page.getByRole('combobox').first().selectOption('funnel');
  // 漏斗专用筛选出现。
  await expect(page.getByText('分组')).toBeVisible();
  await page.getByRole('button', { name: '生成报表' }).click();
  await expect(page.getByRole('heading', { name: '访问漏斗' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '成功下单' })).toBeVisible();
  await expect(page.getByText(/样本不足 20 时不展示/)).toBeVisible();
});

test('an operator reviews section placement performance with section filters', async ({ page }) => {
  const placementResult = {
    reportKey: 'placement', metricDefinitionVersion: '1.0',
    generatedAt: '2026-11-18T02:00:00.000Z',
    from: '2026-11-11T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z',
    timezone: 'Asia/Hong_Kong', currencies: ['HKD'], filters: { groupBy: 'section' },
    totals: { sections: 2, impressionSessions: 641, clicks: 96, addToCarts: 33, orderCount: 8,
      orderItems: 9, netRevenueMinor: 288000, unallocatedRefundMinor: 0 },
    rows: [
      { dimensions: { sectionKey: 'home.hero', currency: 'HKD' }, metrics: { impressionSessions: 420,
        clicks: 70, clickSessions: 66, addToCarts: 24, addSessions: 22, orderItems: 6, orderCount: 6,
        clickRate: 15.71, addRate: 5.24, orderRate: 1.43, netRevenueMinor: 198000 } },
      { dimensions: { sectionKey: 'home.products', currency: 'HKD' }, metrics: { impressionSessions: 12,
        clicks: 3, clickSessions: 3, addToCarts: 1, addSessions: 1, orderItems: 0, orderCount: 0,
        insufficientSample: 1 } },
    ],
    coverage: { sourceOrderCount: 8, lastDataAt: '2026-11-17T18:00:00.000Z', complete: true,
      note: '区块埋点采集正常。' },
  };
  const queries: string[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-4' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['reports.view'] } } });
    }
    if (method === 'GET' && url.pathname.includes('/reports/placement')) {
      queries.push(url.search);
      return route.fulfill({ json: { data: placementResult, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/reports');
  await page.getByRole('combobox').first().selectOption('placement');
  const sectionInput = page.getByRole('textbox', { name: '区块' });
  const versionInput = page.getByRole('textbox', { name: '发布版本' });
  await expect(versionInput).toBeVisible();
  await sectionInput.fill('home.hero');
  await versionInput.fill('rel-2026-11');
  await page.getByRole('button', { name: '生成报表' }).click();

  await expect(page.getByRole('heading', { name: '区块陈列效果', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'home.hero' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'home.products' })).toBeVisible();
  await expect(page.getByText('HKD 1980.00').first()).toBeVisible();
  await expect(page.getByText('是（曝光会话 < 20）').first()).toBeVisible();
  await expect(page.getByText(/50% 可见持续 1 秒/)).toBeVisible();
  expect(queries.at(-1)).toContain('groupBy=section');
  expect(queries.at(-1)).toContain('sectionKey=home.hero');
  expect(queries.at(-1)).toContain('publishVersionId=rel-2026-11');
});
