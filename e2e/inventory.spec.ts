import { test, expect } from '@playwright/test';

const variantId = '6f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const stockRow = { variantId, sku: 'SKU-1', productId: '7f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  productName: 'Linen Shirt', productStatus: 'active', variantStatus: 'active', onHand: 10, reserved: 4,
  available: 6, lowStockLevel: 5, lowStockVersion: 2, lowStockState: 'ok', version: 1,
  updatedAt: '2026-11-16T02:00:00.000Z' };
const movement = { id: '8f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', variantId, type: 'adjustment', quantity: 5,
  stockDelta: 5, onHandAfter: 15, reason: 'Opening stock', reasonCode: null, reference: null, orderId: null,
  caseId: null, actorId: 'staff-1', createdAt: '2026-11-16T03:00:00.000Z' };

test('an operator records a stock adjustment against the version that was read', async ({ page }) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['inventory.read', 'inventory.adjust', 'inventory.manage'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/inventory')) {
      return route.fulfill({ json: { data: { items: [stockRow], hasMore: false, nextCursor: null },
        meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/inventory/movements')) {
      return route.fulfill({ json: { data: { items: [], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/inventory/adjustments')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ status: 201, json: { data: { movement, variantId, onHand: 15, reserved: 4,
        available: 11, version: 2, lowStockLevel: 5, replay: false }, meta: { requestId: 'req' } } });
    }
    if (method === 'PATCH' && url.pathname.endsWith('/inventory/thresholds')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { data: { variantId, lowStockLevel: 8, version: 3, updatedBy: 'staff-1',
        updatedAt: '2026-11-16T04:00:00.000Z' }, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/inventory');
  await expect(page.getByRole('heading', { name: '库存', exact: true })).toBeVisible();
  // 可售数由服务端算好：10 现存、4 预留，页面直接显示 6。
  await expect(page.getByText(/现存 10 · 预留 4 · 可售 6/)).toBeVisible();
  await expect(page.getByText(/库存版本 1/)).toBeVisible();

  await page.getByLabel('调整数量').fill('5');
  await page.getByRole('textbox', { name: '原因', exact: true }).fill('Opening stock');
  await page.getByRole('button', { name: '记一笔调整' }).click();
  await expect(page.getByText(/SKU-1 现存 15，可售 11，版本 2。/)).toBeVisible();

  const adjust = writes.find(entry => entry.path.endsWith('/adjustments'));
  // 提交的是“我看到的版本”，不是随便一个版本号。
  expect(adjust?.body['expectedVersion']).toBe(1);
  expect(adjust?.body['delta']).toBe(5);
  expect(adjust?.body['reason']).toBe('Opening stock');
  expect(adjust?.body['variantId']).toBe(variantId);

  await page.getByLabel('阈值', { exact: true }).fill('8');
  await page.getByRole('button', { name: '保存阈值' }).click();
  await expect(page.getByText('低库存阈值已保存；阈值只影响提醒，不影响可售数量。')).toBeVisible();
  const threshold = writes.find(entry => entry.path.endsWith('/thresholds'));
  // 阈值有自己的版本（2），与库存版本（1）互不干扰。
  expect(threshold?.body['expectedVersion']).toBe(2);
  expect(threshold?.body['lowStockLevel']).toBe(8);
});

test('accounts without inventory.read see a permission notice and no stock table', async ({ page }) => {
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-2' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['orders.read'] } } });
    }
    return route.fulfill({ json: { data: { items: [], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
  });
  await page.goto('/admin/inventory');
  await expect(page.getByText('当前账号没有库存读取权限（inventory.read）。')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);

  // 只读账号看不到调整与阈值表单。
  await page.unroute('**/api/v1/admin/**');
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-3' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['inventory.read'] } } });
    }
    if (url.pathname.endsWith('/inventory')) {
      return route.fulfill({ json: { data: { items: [stockRow], hasMore: false, nextCursor: null },
        meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: { items: [], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
  });
  await page.reload();
  await expect(page.getByText('没有 inventory.adjust 权限，只能查看库存。')).toBeVisible();
  await expect(page.getByRole('button', { name: '记一笔调整' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存阈值' })).toHaveCount(0);
});
