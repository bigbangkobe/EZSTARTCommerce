import { test, expect } from '@playwright/test';

const codMethod = { id: 'method-cod', providerCode: 'cod', environment: 'production', displayName: 'Cash on delivery',
  enabled: true, approvalStatus: 'approved', approvalReference: 'built_in_default', approvedAt: '2026-11-16T00:00:00.000Z',
  publicConfig: { instructions: 'Pay the courier on delivery.' }, secretConfigured: false, secretFingerprint: null,
  connectionStatus: 'unverified', version: 1 };
const manualMethod = { id: 'method-manual', providerCode: 'manual_bank_transfer', environment: 'production',
  displayName: 'Manual bank transfer', enabled: false, approvalStatus: 'unapproved', approvalReference: null,
  approvedAt: null, publicConfig: {}, secretConfigured: false, secretFingerprint: null, connectionStatus: 'unverified',
  version: 3 };
const pendingPayment = { id: 'payment-1', publicPaymentNumber: 'PAY-20261116-AB12CD', orderId: 'order-1',
  publicOrderNumber: 'EZ-20261116-ABC123', providerCode: 'cod', environment: 'production', channel: 'cod',
  status: 'collected', amountMinor: 23_000, currency: 'HKD', providerTransactionId: null,
  paidAt: '2026-11-16T04:00:00.000Z', returnedAt: null, reference: 'COD-778', failureCode: null, failureMessage: null,
  recordedBy: 'staff-1', version: 2, createdAt: '2026-11-16T02:00:00.000Z', updatedAt: '2026-11-16T04:00:00.000Z',
  events: [{ id: 'event-1', type: 'collected', fromStatus: 'pending', toStatus: 'collected', source: 'admin',
    actorId: 'staff-1', occurredAt: '2026-11-16T04:00:00.000Z' }] };

test('payment configuration is versioned, redacted and refuses raw credentials', async ({ page }) => {
  const patches: { body: Record<string, unknown>; ifMatch: string | null }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' },
        permissionCodes: ['payment.config', 'payments.read'], csrfToken: 'csrf-test-token' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/payment-methods')) {
      return route.fulfill({ json: { data: { items: [codMethod, manualMethod] }, meta: { requestId: 'req' } } });
    }
    if (method === 'PATCH' && url.pathname.endsWith('/payment-methods')) {
      patches.push({ body: request.postDataJSON() as Record<string, unknown>, ifMatch: request.headers()['if-match'] ?? null });
      return route.fulfill({ json: { data: { ...manualMethod, enabled: true, approvalStatus: 'approved',
        approvalReference: 'ticket-1', secretConfigured: true, secretFingerprint: 'a1b2c3d4e5f60718', version: 4 },
        meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/payments')) {
      return route.fulfill({ json: { data: { items: [pendingPayment], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && /\/payments\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: { data: pendingPayment, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/payments');
  await expect(page.getByRole('heading', { name: '付款', exact: true })).toBeVisible();
  await expect(page.getByText(/manual_bank_transfer · production · 已停用 · 批准 未批准 · 凭证 未配置 · 版本 3/)).toBeVisible();

  const form = page.locator('form').filter({ hasText: '凭证引用' }).last();
  await form.getByLabel('批准依据').fill('ticket-1');
  await form.getByLabel('凭证引用').fill('secret://prod/bank');
  await form.getByLabel('收款说明').fill('Bank: 012-345-678');
  await form.getByLabel('启用该方式').check();
  await form.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('manual_bank_transfer 配置已保存。')).toBeVisible();

  expect(patches.length).toBe(1);
  expect(patches[0]!.ifMatch).toBe('"3"');
  expect(patches[0]!.body['providerCode']).toBe('manual_bank_transfer');
  expect(patches[0]!.body['enabled']).toBe(true);
  expect(patches[0]!.body['secretRef']).toBe('secret://prod/bank');
  expect(patches[0]!.body['approvalReference']).toBe('ticket-1');
  expect(patches[0]!.body['publicConfig']).toEqual({ accountSummary: 'Bank: 012-345-678' });

  // 台账与事件都来自服务端，页面不复算状态。
  await expect(page.getByText(/PAY-20261116-AB12CD/).first()).toBeVisible();
  await expect(page.getByText(/已收 · cod · cod · HKD 230\.00 · 版本 2/)).toBeVisible();
  await expect(page.getByText(/pending → collected · collected · admin/)).toBeVisible();
});

test('cash collection is recorded from the order with the version the operator saw', async ({ page }) => {
  const writes: { body: Record<string, unknown>; ifMatch: string | null; key: string | null }[] = [];
  const order = { id: 'order-1', publicOrderNumber: 'EZ-20261116-ABC123', orderStatus: 'shipped',
    paymentStatus: 'cod_due', fulfillmentStatus: 'fulfilled', currency: 'HKD', subtotalMinor: 20_000,
    discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: 23_000, version: 4, paymentMethodCode: 'cod',
    customerNote: null, placedAt: '2026-11-16T02:00:00.000Z', lines: [], addressSnapshot: null,
    contact: { email: 'b***@example.com', phone: '***4567', fullName: 'B**' }, cancellation: null, shipments: [],
    statusHistory: [], notes: [] };
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' },
        permissionCodes: ['orders.read', 'payments.collect'], csrfToken: 'csrf-test-token' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/orders')) {
      return route.fulfill({ json: { data: { items: [{ id: 'order-1', publicOrderNumber: 'EZ-20261116-ABC123',
        orderStatus: 'shipped', paymentStatus: 'cod_due', currency: 'HKD', totalMinor: 23_000,
        contactMasked: 'b***@example.com', createdAt: '2026-11-16T02:00:00.000Z' }], hasMore: false, nextCursor: null } } });
    }
    if (method === 'GET' && /\/orders\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: { data: order } });
    }
    if (method === 'POST' && url.pathname.endsWith('/payment-result')) {
      writes.push({ body: request.postDataJSON() as Record<string, unknown>, ifMatch: request.headers()['if-match'] ?? null,
        key: request.headers()['idempotency-key'] ?? null });
      return route.fulfill({ json: { data: { orderId: 'order-1', orderPaymentStatus: 'collected', orderVersion: 5,
        payment: pendingPayment }, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/orders');
  await expect(page.getByRole('heading', { name: '登记收款' })).toBeVisible();
  await expect(page.getByLabel('金额')).toHaveValue('230.00');
  await page.getByLabel('参考号').fill('COD-778');
  await page.getByRole('button', { name: '保存收款结果' }).click();
  await expect(page.getByText('收款结果已登记，订单付款状态已更新。')).toBeVisible();

  expect(writes.length).toBe(1);
  expect(writes[0]!.ifMatch).toBe('"4"');
  expect(writes[0]!.key).toBeTruthy();
  expect(writes[0]!.body['outcome']).toBe('collected');
  expect(writes[0]!.body['amountMinor']).toBe(23_000);
  expect(writes[0]!.body['expectedVersion']).toBe(4);
  expect(writes[0]!.body['reference']).toBe('COD-778');
});
