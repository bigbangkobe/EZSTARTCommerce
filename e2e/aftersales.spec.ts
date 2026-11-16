import { test, expect } from '@playwright/test';

const caseSummary = { id: 'case-1', publicCaseNumber: 'AS-20261116-AB12CD', publicOrderNumber: 'EZ-20261116-ABC123',
  caseType: 'return', status: 'submitted', reason: 'Wrong size', currency: 'HKD', orderTotalMinor: 23_000,
  requestedRefundMinor: 20_000, approvedRefundMinor: null, refundedMinor: 0, refundableMinor: 23_000, version: 1,
  paymentStatus: 'collected', createdAt: '2026-11-16T02:00:00.000Z', contactMasked: 'b***@example.com' };

const caseDetail = { ...caseSummary, orderId: 'order-1', orderStatus: 'completed', pendingRefundMinor: 0,
  items: [{ orderItemId: 'line-1', sku: 'SKU-1', productName: 'Test Product', variantName: 'M', orderedQuantity: 2,
    requestedQuantity: 2, approvedQuantity: null, amountMinor: null, disposed: null, receivedQuantity: 0,
    inspectedQuantity: 0 }],
  refunds: [{ id: 'refund-1', publicRefundNumber: 'REF-20261116-AB12CD', status: 'requested', amountMinor: 10_000,
    currency: 'HKD', channel: 'manual', createdAt: '2026-11-16T03:00:00.000Z', executedAt: null },
  { id: 'refund-2', publicRefundNumber: 'REF-20261116-EF34GH', status: 'approved', amountMinor: 5_000,
    currency: 'HKD', channel: 'manual', createdAt: '2026-11-16T03:10:00.000Z', executedAt: null }],
  returns: [], receipts: [], inspections: [],
  events: [{ id: 'event-1', type: 'created', fromStatus: null, toStatus: 'submitted', note: 'Wrong size',
    createdAt: '2026-11-16T02:00:00.000Z' }] };

test('an after-sales case is reviewed and its refunds approved and paid out with proof', async ({ page }) => {
  const writes: { path: string; body: Record<string, unknown>; ifMatch: string | null }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    const record = () => writes.push({ path: url.pathname, body: (request.postDataJSON() ?? {}) as Record<string, unknown>,
      ifMatch: request.headers()['if-match'] ?? null });
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['aftersales.read', 'aftersales.manage', 'aftersales.approve', 'aftersales.inspect',
          'refunds.create', 'refund.approve', 'refund.execute'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/after-sales')) {
      return route.fulfill({ json: { data: { items: [caseSummary], hasMore: false, nextCursor: null },
        meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && /\/after-sales\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: { data: caseDetail, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && /\/refunds\/[^/]+\/approve$/.test(url.pathname)) {
      record();
      return route.fulfill({ json: { data: { ...caseDetail.refunds[0], status: 'approved' }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/approve')) {
      record();
      return route.fulfill({ json: { data: { ...caseDetail, status: 'approved', approvedRefundMinor: 20_000,
        version: 2, items: [{ ...caseDetail.items[0], approvedQuantity: 2, amountMinor: 20_000 }] },
        meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && /\/refunds\/[^/]+\/execute$/.test(url.pathname)) {
      record();
      return route.fulfill({ json: { data: { ...caseDetail.refunds[1], status: 'refunded',
        executedAt: '2026-11-16T05:00:00.000Z' }, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/aftersales');
  await expect(page.getByRole('heading', { name: '售后', exact: true })).toBeVisible();
  await expect(page.getByText(/AS-20261116-AB12CD/).first()).toBeVisible();
  // 案件详情展示可退余额，而不是让页面自己算订单总额。
  await expect(page.getByText(/可退余额 HKD 230\.00/)).toBeVisible();
  await expect(page.getByText(/申请 2 · 已收 0 · 已检 0/)).toBeVisible();

  await page.getByRole('button', { name: '批准案件' }).click();
  await expect(page.getByText('案件已批准。取消类会同时取消订单并释放库存预留。')).toBeVisible();
  const approve = writes.find(entry => entry.path.endsWith('/approve'));
  expect(approve?.ifMatch).toBe('"1"');
  expect(approve?.body['reason']).toBeTruthy();

  // 待审批的退款由另一个权限批准；已批准的退款需要凭据才能登记为已退。
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(page.getByText(/REF-20261116-AB12CD 已批准/)).toBeVisible();
  await page.getByLabel('退款凭据').fill('PAYOUT-778');
  await page.getByRole('button', { name: '登记已退款' }).click();
  await expect(page.getByText(/REF-20261116-EF34GH 已登记退款/)).toBeVisible();

  const execute = writes.find(entry => entry.path.endsWith('/execute'));
  expect(execute?.body['reference']).toBe('PAYOUT-778');
  expect(execute?.body['reason']).toBe('Paid out to customer');
});

test('a case is created from an order with server-side line selection', async ({ page }) => {
  const writes: Record<string, unknown>[] = [];
  const order = { id: 'order-1', publicOrderNumber: 'EZ-20261116-ABC123', orderStatus: 'completed',
    paymentStatus: 'collected', currency: 'HKD', totalMinor: 23_000, version: 3,
    lines: [{ id: 'line-1', sku: 'SKU-1', productName: 'Test Product', variantName: 'M', quantity: 2,
      lineTotalMinor: 20_000 }] };
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['aftersales.read', 'aftersales.manage'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/after-sales')) {
      return route.fulfill({ json: { data: { items: [], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && /\/orders\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: { data: order, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/after-sales')) {
      writes.push(request.postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 201, json: { data: caseSummary, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/aftersales?orderId=order-1');
  await expect(page.getByLabel('订单 ID')).toHaveValue('order-1');
  await page.getByRole('button', { name: '载入订单' }).click();
  await expect(page.getByText(/EZ-20261116-ABC123 · completed · 付款 collected/)).toBeVisible();

  await page.getByLabel('SKU-1 申请数量').fill('2');
  await page.getByLabel('类型').selectOption('return');
  // 「原因」同时是搜索框提示词的一部分，这里只在建案表单内定位。
  const createForm = page.locator('form').filter({ has: page.getByRole('button', { name: '建立案件' }) });
  await createForm.getByLabel('原因', { exact: true }).fill('Wrong size');
  await createForm.getByRole('button', { name: '建立案件' }).click();
  await expect(page.getByText(/案件 AS-20261116-AB12CD 已建立/)).toBeVisible();

  expect(writes.length).toBe(1);
  expect(writes[0]!['orderId']).toBe('order-1');
  expect(writes[0]!['caseType']).toBe('return');
  expect(writes[0]!['items']).toEqual([{ orderItemId: 'line-1', quantity: 2 }]);
  expect(writes[0]!['reason']).toBe('Wrong size');
});
