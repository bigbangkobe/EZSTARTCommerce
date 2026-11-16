import { test, expect } from '@playwright/test';

const config = {
  displayName: '晨光商行', locales: ['zh-CN', 'zh-HK', 'en'], defaultLocale: 'zh-CN', baseCurrency: 'HKD',
  timezone: 'Asia/Hong_Kong', featureFlags: { guestCheckout: true, memberOtpLogin: true, codPayment: true, onlinePayment: false, ageVerification: false },
  marketProfiles: [
    { marketCode: 'HK', enabled: true, eligibleProductIds: [], reviewStatus: 'approved', reviewValidUntil: null },
    { marketCode: 'MO', enabled: false, eligibleProductIds: [], reviewStatus: 'pending', reviewValidUntil: null },
  ],
  brandAssets: { logoMediaId: null, faviconMediaId: null }, version: 3, updatedAt: '2026-11-16T02:00:00.000Z',
};

test('store settings load, save with If-Match and gate disabled markets', async ({ page }, info) => {
  const writes: { method: string; path: string; ifMatch: string | null; body: unknown }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'owner-1' },
      permissionCodes: ['store.settings.manage', 'audit.read'], csrfToken: 'csrf-test-token' } } });
    if (method !== 'GET') {
      writes.push({ method, path: url.pathname, ifMatch: request.headers()['if-match'] ?? null,
        body: request.postDataJSON() });
      return route.fulfill({ json: { data: { ...config, displayName: '晨光商行二店', version: 4 }, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: config, meta: { requestId: 'req' } }, headers: { ETag: '"3"' } });
  });

  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: '店铺设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('店铺名称')).toHaveValue('晨光商行');
  await expect(page.getByRole('heading', { name: /MO/ })).toBeVisible();
  // 未审核的市场不能直接开启。
  await expect(page.getByRole('button', { name: '开启 MO 交易' })).toBeDisabled();
  await page.getByRole('region', { name: '市场与交易资格' }).screenshot({ path: `.local-tools/settings-${info.project.name}.png` });

  await page.getByLabel('店铺名称').fill('晨光商行二店');
  await page.getByLabel('我已核对语言、币种与时区，并确认保存').check();
  await page.getByRole('button', { name: '保存店铺设置' }).click();
  await expect(page.getByText('店铺设置已保存，并写入审计记录。')).toBeVisible();
  const save = writes.find(write => write.method === 'PATCH' && write.path.endsWith('/store-config'));
  expect(save?.ifMatch).toBe('"3"');
  expect((save?.body as { displayName: string }).displayName).toBe('晨光商行二店');
  expect((save?.body as { featureFlags: Record<string, boolean> }).featureFlags['onlinePayment']).toBe(false);
});

test('recording a market review posts the typed evidence and does not enable the market', async ({ page }) => {
  const writes: { path: string; ifMatch: string | null; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'owner-1' },
      permissionCodes: ['store.settings.manage'], csrfToken: 'csrf-test-token' } } });
    if (request.method() === 'POST' && url.pathname.includes('/reviews')) {
      writes.push({ path: url.pathname, ifMatch: request.headers()['if-match'] ?? null, body: request.postDataJSON() });
      return route.fulfill({ json: { data: { id: 'review-1', marketCode: 'MO', decision: 'approved', evidenceReference: 'LEGAL-1',
        reason: '客户律师确认', reviewedBy: 'owner-1', reviewedAt: '2026-11-16T02:10:00.000Z', validUntil: null, storeConfigVersion: 4 } } });
    }
    return route.fulfill({ json: { data: config, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/settings');
  const market = page.getByRole('article').filter({ hasText: 'MO' });
  await market.getByLabel('依据引用').fill('LEGAL-1');
  await market.getByLabel('说明').fill('客户律师确认');
  await market.getByLabel('确认市场代码').fill('MO');
  await market.getByLabel('我确认本结论由客户或其顾问提供，仅记录依据').check();
  await market.getByRole('button', { name: '记录 MO 审核结论' }).click();
  await expect(page.getByText('审核结论已追加记录；审核通过不会自动开启市场。')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]!.path).toContain('/markets/MO/reviews');
  expect(writes[0]!.ifMatch).toBe('"3"');
  expect(writes[0]!.body['confirmedMarketCode']).toBe('MO');
  expect(writes[0]!.body['decision']).toBe('approved');
});

test('accounts without store.settings.manage only see a permission notice', async ({ page }) => {
  await page.route('**/api/v1/admin/**', route => route.fulfill({ json: { data: { user: { id: 'reader' }, permissionCodes: ['staff.read'], csrfToken: 'read-token' } } }));
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: '没有店铺设置权限', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存店铺设置' })).toHaveCount(0);
});
