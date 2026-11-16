import { test, expect } from '@playwright/test';

const line = { id: 'line-1', sku: 'SKU-1', productName: 'Test Product', variantName: 'M', quantity: 2,
  unitPriceMinor: 10_000, lineTotalMinor: 20_000, shippedQuantity: 0, allocatedQuantity: 0 };
const baseOrder = { id: 'order-1', publicOrderNumber: 'EZ-20261116-ABC123', orderStatus: 'awaiting_confirmation',
  paymentStatus: 'cod_due', fulfillmentStatus: 'unfulfilled', currency: 'HKD', subtotalMinor: 20_000,
  discountMinor: 0, shippingMinor: 3_000, taxMinor: 0, totalMinor: 23_000, version: 1, paymentMethodCode: 'cod',
  customerNote: null, placedAt: '2026-11-16T02:00:00.000Z', lines: [line],
  addressSnapshot: { recipientName: 'Buyer', addressLine1: '1 Queen Road', city: 'Hong Kong', countryCode: 'HK' },
  contact: { email: 'b***@example.com', phone: '***4567', fullName: 'B**' }, cancellation: null,
  shipments: [] as Record<string, unknown>[],
  statusHistory: [{ id: 'event-1', fromStatus: null, toStatus: 'awaiting_confirmation', reason: 'order_placed',
    actorType: 'customer', createdAt: '2026-11-16T02:00:00.000Z' }],
  notes: [] as Record<string, unknown>[] };
const summary = { id: 'order-1', publicOrderNumber: 'EZ-20261116-ABC123', orderStatus: 'awaiting_confirmation',
  paymentStatus: 'cod_due', currency: 'HKD', totalMinor: 23_000, contactMasked: 'b***@example.com',
  createdAt: '2026-11-16T02:00:00.000Z' };

/** 一个会随写操作变化的极简后端：页面动作后要重新拉详情，静态 mock 会看不到新包裹。 */
function mockApi(state: { order: typeof baseOrder; shipments: Record<string, unknown>[] }) {
  return async (route: import('@playwright/test').Route) => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'staff-1' },
      permissionCodes: ['orders.read', 'orders.cancel', 'orders.update', 'orders.address_change', 'shipments.manage'],
      csrfToken: 'csrf-test-token' } } });
    if (method === 'GET' && url.pathname.endsWith('/orders')) {
      return route.fulfill({ json: { data: { items: [summary], hasMore: false, nextCursor: null } } });
    }
    if (method === 'GET' && /\/orders\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ json: { data: { ...state.order, shipments: state.shipments } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/cancel')) {
      state.order = { ...state.order, orderStatus: 'cancelled', version: 2,
        cancellation: { cancelledAt: '2026-11-16T03:00:00.000Z', reasonCode: 'admin_cancelled',
          reason: 'Customer changed their mind', customerNotified: true } };
      return route.fulfill({ json: { data: state.order, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/shipments')) {
      const body = request.postDataJSON() as { items: { orderItemId: string; quantity: number }[] };
      const shipment = { id: `shipment-${state.shipments.length + 1}`, status: 'created', carrierCode: 'SF',
        carrierName: null, trackingNumber: 'SF123', dispatchedAt: null, deliveredAt: null, version: 1,
        items: body.items };
      state.shipments.push(shipment);
      return route.fulfill({ status: 201, json: { data: shipment, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/dispatch')) {
      const id = url.pathname.split('/').at(-2);
      state.shipments = state.shipments.map(item => item['id'] === id
        ? { ...item, status: 'dispatched', dispatchedAt: '2026-11-16T04:00:00.000Z', version: 2 } : item);
      return route.fulfill({ json: { data: state.shipments.find(item => item['id'] === id), meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/notes')) {
      const body = request.postDataJSON() as { note: string };
      const note = { id: 'note-1', note: body.note, authorId: 'staff-1', createdAt: '2026-11-16T05:00:00.000Z' };
      state.order = { ...state.order, notes: [note] };
      return route.fulfill({ status: 201, json: { data: note, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  };
}

test('order detail masks contact and cancellation carries version, idempotency and reason', async ({ page }) => {
  const state = { order: { ...baseOrder, shipments: [] as Record<string, unknown>[] }, shipments: [] as Record<string, unknown>[] };
  const writes: { path: string; body: Record<string, unknown>; key: string | null }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') writes.push({ path: new URL(request.url()).pathname,
      body: request.postDataJSON() as Record<string, unknown>, key: request.headers()['idempotency-key'] ?? null });
    return mockApi(state)(route);
  });

  await page.goto('/admin/orders');
  await expect(page.getByRole('heading', { name: '订单', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'EZ-20261116-ABC123' })).toBeVisible();
  await expect(page.getByText('联系人：B** · b***@example.com · ***4567')).toBeVisible();
  await expect(page.getByText('总额 HKD 230.00 · 付款方式 cod')).toBeVisible();

  const cancelForm = page.locator('form').filter({ hasText: '取消原因' });
  await cancelForm.getByLabel('取消原因').fill('Customer changed their mind');
  await cancelForm.getByLabel('已通知顾客').check();
  await cancelForm.getByRole('button', { name: '取消订单' }).click();
  await expect(page.getByText('订单已取消，库存预留已释放。')).toBeVisible();

  const cancel = writes.find(write => write.path.endsWith('/cancel'))!;
  expect(cancel.body['expectedVersion']).toBe(1);
  expect(cancel.body['reason']).toBe('Customer changed their mind');
  expect(cancel.body['customerNotified']).toBe(true);
  expect(cancel.key).toBeTruthy();
});

test('parcels are created with line quantities and dispatched with the read version', async ({ page }) => {
  const state = { order: { ...baseOrder, shipments: [] as Record<string, unknown>[] }, shipments: [] as Record<string, unknown>[] };
  const writes: { path: string; body: Record<string, unknown>; ifMatch: string | null }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') writes.push({ path: new URL(request.url()).pathname,
      body: request.postDataJSON() as Record<string, unknown>, ifMatch: request.headers()['if-match'] ?? null });
    return mockApi(state)(route);
  });

  await page.goto('/admin/orders');
  await page.getByLabel(/SKU-1 发货数量/).fill('1');
  await page.getByLabel('追踪号').fill('SF123');
  await page.getByRole('button', { name: '创建包裹' }).click();
  await expect(page.getByText('包裹已创建，尚未扣减库存。')).toBeVisible();
  const created = writes.find(write => write.path.endsWith('/shipments'))!;
  expect(created.body['items']).toEqual([{ orderItemId: 'line-1', quantity: 1 }]);
  expect(created.body['trackingNumber']).toBe('SF123');

  // 刷新后新包裹出现在详情里，发货按钮带着读到的版本号与幂等键。
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(page.getByText('待发货 · SF · SF123 · SKU-1×1')).toBeVisible();
  await page.getByRole('button', { name: '发货' }).click();
  await expect(page.getByText('包裹已发出，库存已扣减。')).toBeVisible();
  const dispatched = writes.find(write => write.path.endsWith('/dispatch'))!;
  expect(dispatched.ifMatch).toBe('"1"');
  expect(typeof dispatched.body['dispatchedAt']).toBe('string');
});

test('accounts without orders.read see the permission notice and no order table', async ({ page }) => {
  await page.route('**/api/v1/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'reader' },
      permissionCodes: ['catalog.read'], csrfToken: 'read-token' } } });
    return route.fulfill({ json: { data: { items: [] } } });
  });
  await page.goto('/admin/orders');
  await expect(page.getByText('当前账号没有订单读取权限（orders.read）。')).toBeVisible();
  // 没有读取权限时不渲染列表，也不该给出“暂无订单”这种误导性空态。
  await expect(page.getByRole('heading', { name: '订单列表' })).toHaveCount(0);
  await expect(page.getByText('暂无订单。')).toHaveCount(0);
});
