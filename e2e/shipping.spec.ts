import { test, expect } from '@playwright/test';

const zone = { id: 'zone-hk', code: 'HK', nameByLocale: { en: 'Hong Kong', 'zh-HK': '香港' },
  countryCodes: ['HK'], regionCodes: [], priority: 0, enabled: true, version: 1 };
const rate = { id: 'rate-standard', code: 'STANDARD', nameByLocale: { en: 'Standard delivery' }, zoneIds: ['zone-hk'],
  fixedFeeMinor: 3_000, freeAboveMinor: 20_000, currency: 'HKD', estimatedMinDays: 1, estimatedMaxDays: 3,
  codEnabled: true, enabled: true, version: 1 };

test('shipping configuration posts minor-unit amounts with CSRF and shows live methods', async ({ page }) => {
  const writes: { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'owner-1' },
      permissionCodes: ['shipping.manage'], csrfToken: 'csrf-test-token' } } });
    if (method === 'GET' && url.pathname.endsWith('/shipping/zones')) return route.fulfill({ json: { data: { items: [zone] } } });
    if (method === 'GET' && url.pathname.endsWith('/shipping/rates')) return route.fulfill({ json: { data: { items: [rate] } } });
    // 试算也是 POST，必须先于通用写入分支匹配，否则会被当成配置写入。
    if (url.pathname.endsWith('/shipping/quote-preview')) return route.fulfill({ json: { data: { currency: 'HKD',
      methods: [{ id: 'rate-standard', code: 'STANDARD', name: 'Standard delivery', feeMinor: 3_000,
        estimatedMinDays: 1, estimatedMaxDays: 3, codEnabled: true }] } } });
    if (method === 'POST' || method === 'PATCH') {
      writes.push({ method, path: url.pathname, ifMatch: request.headers()['if-match'] ?? null,
        body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ status: method === 'POST' ? 201 : 200, json: { data: zone, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: { items: [] } } });
  });

  await page.goto('/admin/shipping');
  await expect(page.getByRole('heading', { name: '配送与结账', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /HK/ })).toBeVisible();
  await expect(page.getByText('HKD 30.00，满 HKD 200.00 免邮')).toBeVisible();

  const zoneForm = page.locator('form').filter({ hasText: '新建配送区' });
  await zoneForm.getByLabel('编码').fill('mo');
  await zoneForm.getByLabel('名称（英文）').fill('Macao');
  await zoneForm.getByLabel('国家/地区代码').fill('mo');
  await zoneForm.getByRole('button', { name: '创建配送区' }).click();
  await expect(page.getByText('配送区已创建。')).toBeVisible();
  const zoneWrite = writes.find(write => write.path.endsWith('/shipping/zones'));
  expect(zoneWrite?.method).toBe('POST');
  expect(zoneWrite?.body['countryCodes']).toEqual(['mo']);
  expect(zoneWrite?.body['nameByLocale']).toEqual({ en: 'Macao' });

  const rateForm = page.locator('form').filter({ hasText: '新建配送方式' });
  await rateForm.getByLabel('编码').fill('express');
  await rateForm.getByLabel('名称（英文）').fill('Express');
  await rateForm.getByLabel(/HK —/).check();
  await rateForm.getByLabel(/固定运费/).fill('45.50');
  await rateForm.getByLabel(/免邮门槛/).fill('300');
  await rateForm.getByLabel(/支持货到付款/).check();
  await rateForm.getByRole('button', { name: '创建配送方式' }).click();
  await expect(page.getByText('配送方式已创建。')).toBeVisible();
  const rateWrite = writes.filter(write => write.path.endsWith('/shipping/rates'))[0]!;
  expect(rateWrite.body['fixedFeeMinor']).toBe(4_550);
  expect(rateWrite.body['freeAboveMinor']).toBe(30_000);
  expect(rateWrite.body['zoneIds']).toEqual(['zone-hk']);
  expect(rateWrite.body['currency']).toBe('HKD');
  expect(rateWrite.body['codEnabled']).toBe(true);

  await page.getByLabel('国家/地区代码').last().fill('HK');
  await page.getByLabel(/商品小计/).fill('100');
  await page.getByRole('button', { name: '试算' }).click();
  await expect(page.getByText('STANDARD — Standard delivery：HKD 30.00')).toBeVisible();
});

test('disabling a rate sends If-Match with the version that was read', async ({ page }) => {
  const writes: { method: string; path: string; ifMatch: string | null; body: unknown }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'owner-1' },
      permissionCodes: ['shipping.manage'], csrfToken: 'csrf-test-token' } } });
    if (request.method() === 'PATCH') {
      writes.push({ method: 'PATCH', path: url.pathname, ifMatch: request.headers()['if-match'] ?? null, body: request.postDataJSON() });
      return route.fulfill({ json: { data: { ...rate, enabled: false, version: 2 } } });
    }
    if (url.pathname.endsWith('/shipping/zones')) return route.fulfill({ json: { data: { items: [zone] } } });
    if (url.pathname.endsWith('/shipping/rates')) return route.fulfill({ json: { data: { items: [rate] } } });
    return route.fulfill({ json: { data: {} } });
  });

  await page.goto('/admin/shipping');
  await page.getByRole('article').filter({ hasText: 'STANDARD' }).getByRole('button', { name: '停用' }).click();
  await expect(page.getByText('已停用；停用后该区域/方式不再参与结账。')).toBeVisible();
  expect(writes[0]!.ifMatch).toBe('"1"');
  expect(writes[0]!.body).toEqual({ enabled: false });
});

test('accounts without shipping.manage cannot change configuration', async ({ page }) => {
  await page.route('**/api/v1/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'reader' },
      permissionCodes: ['catalog.read'], csrfToken: 'read-token' } } });
    return route.fulfill({ json: { data: { items: [] } } });
  });
  await page.goto('/admin/shipping');
  await expect(page.getByText('当前账号没有配送配置权限（shipping.manage）。')).toBeVisible();
  await expect(page.getByRole('button', { name: '创建配送区' })).toBeDisabled();
});
