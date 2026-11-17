import { test, expect } from '@playwright/test';

const memberId = '3f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const tierId = '4f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const tier = { id: tierId, code: 'GOLD', nameByLocale: { 'zh-HK': '金卡會員', en: 'Gold' }, rank: 2,
  minLifetimeSpendMinor: 500_000, minorPerPoint: null, benefits: ['優先客服'], status: 'active', version: 3,
  createdAt: '2026-11-17T02:00:00.000Z', updatedAt: '2026-11-17T03:00:00.000Z' };
const settings = { enabled: true, minorPerPoint: 100, pointsExpiryMonths: 12, version: 4,
  updatedAt: '2026-11-17T03:00:00.000Z' };
const member = { id: memberId, memberNo: 'MB-20261117-000001', status: 'active', joinedAt: '2026-11-17T01:00:00.000Z',
  consentRef: 'storefront-otp', version: 1, lifetimeSpendMinor: 620_000, tier: { id: tierId, code: 'GOLD', rank: 2,
    nameByLocale: { 'zh-HK': '金卡會員', en: 'Gold' } },
  customer: { id: '5f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', displayName: 'Chan Tai Man', email: 'c***@example.com' } };
const ledger = { id: '6f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', deltaPoints: 620, balanceAfter: 620, entryType: 'earn',
  sourceType: 'order', sourceRef: 'EZ-20261117-AAAAAA', reasonCode: 'order_completed', reason: null,
  ruleVersion: 'loyalty-v1', createdAt: '2026-11-17T03:30:00.000Z' };

/** 后台会员页：读等级目录与某位会员的账，写口径与人工调整都要带上「我读到的版本」与幂等键。 */
test('the loyalty console edits settings and adjusts points against the version and key it was given', async ({ page }, testInfo) => {
  const writes: { path: string; body: Record<string, unknown>; ifMatch: string | null; key: string | null }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'owner-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['members.manage', 'points.adjust', 'customers.read_masked'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/loyalty')) {
      return route.fulfill({ json: { data: { settings, tiers: [tier] }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/admin/members')) {
      return route.fulfill({ json: { data: { items: [member], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && /\/members\/[^/]+\/points$/.test(url.pathname)) {
      return route.fulfill({ json: { data: { member, balance: 620, accountStatus: 'active', minorPerPoint: 100,
        enabled: true, items: [ledger], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (method === 'PATCH' && url.pathname.endsWith('/loyalty/settings')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown>,
        ifMatch: request.headers()['if-match'] ?? null, key: request.headers()['idempotency-key'] ?? null });
      return route.fulfill({ json: { data: { ...settings, ...(request.postDataJSON() as object), version: 5 },
        meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/points-adjustments')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown>,
        ifMatch: request.headers()['if-match'] ?? null, key: request.headers()['idempotency-key'] ?? null });
      return route.fulfill({ status: 201, json: { data: { ...ledger, id: 'new-entry', deltaPoints: 50, balanceAfter: 670 },
        meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/members');
  await expect(page.getByRole('heading', { name: '会员与积分', exact: true })).toBeVisible();
  // 口径与等级目录都来自后台接口：暂停/发放、换算率、有效期一起显示。
  await expect(page.getByText(/状态 发放中/)).toBeVisible();
  await expect(page.getByText(/每 100 分（最小货币单位）得 1 点/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'GOLD', exact: true })).toBeVisible();
  // 等级名同时出现在等级阶梯与会员行的「等级」列，这里只断言至少渲染出来了。
  await expect(page.getByRole('cell', { name: '金卡會員', exact: true }).first()).toBeVisible();
  // 会员行默认选中第一位，积分账随即加载。
  await expect(page.getByRole('cell', { name: 'MB-20261117-000001', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'c***@example.com', exact: true })).toBeVisible();
  await expect(page.getByText(/积分余额/)).toContainText('620');
  await expect(page.getByRole('cell', { name: 'order_completed', exact: true })).toBeVisible();

  await page.getByLabel(/^换算率/).fill('200');
  await page.getByRole('button', { name: '保存积分口径' }).click();
  await expect(page.getByText(/积分口径已保存/)).toBeVisible();
  const saved = writes.find(entry => entry.path.endsWith('/loyalty/settings'));
  // 提交的是「我读到的版本」（4），不是随便一个数字。
  expect(saved?.ifMatch).toBe('"4"');
  expect(saved?.body['minorPerPoint']).toBe(200);
  expect(saved?.body['enabled']).toBe(true);
  expect(saved?.body['pointsExpiryMonths']).toBe(12);

  await page.getByLabel(/^变动点数/).fill('50');
  await page.getByLabel(/^原因码/).fill('goodwill');
  await page.getByLabel(/^原因说明/).fill('客服補償：配送延誤');
  // 调整表单在超长页面最底部。桌面用鼠标点；移动端项目走键盘提交——Edge 的移动模拟在
  // 这种深度的元素上会把点击坐标算偏（元素中心实测命中的就是按钮本身），换成回车既避开
  // 模拟器的问题，也是真人能用到的路径。
  const submit = page.getByRole('button', { name: '登记调整' });
  await submit.scrollIntoViewIfNeeded();
  if (testInfo.project.name === 'mobile') { await submit.focus(); await page.keyboard.press('Enter'); }
  else await submit.click();
  await expect(page.getByText(/已登记 \+50 点，调整后余额 670/)).toBeVisible();
  const adjust = writes.find(entry => entry.path.endsWith('/points-adjustments'));
  expect(adjust?.path).toContain(memberId);
  expect(adjust?.body['deltaPoints']).toBe(50);
  expect(adjust?.body['reasonCode']).toBe('goodwill');
  // 幂等键必须有值：没有它，网络重试就会变成两次加减。
  expect(adjust?.key).toBeTruthy();
});

test('viewing the ledger does not require points.adjust, and adjusting does', async ({ page }) => {
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['members.manage', 'customers.read_masked'] } } });
    }
    if (url.pathname.endsWith('/loyalty')) {
      return route.fulfill({ json: { data: { settings, tiers: [tier] }, meta: { requestId: 'req' } } });
    }
    if (url.pathname.endsWith('/admin/members')) {
      return route.fulfill({ json: { data: { items: [member], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (/\/members\/[^/]+\/points$/.test(url.pathname)) {
      return route.fulfill({ json: { data: { member, balance: 620, accountStatus: 'active', minorPerPoint: 100,
        enabled: true, items: [ledger], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });
  await page.goto('/admin/members');
  await expect(page.getByText(/积分余额/)).toContainText('620');
  // 能看见账，但没有 points.adjust 就不能改账。
  await expect(page.getByText('当前账号没有 points.adjust 权限，只能查看积分账。')).toBeVisible();
  await expect(page.getByRole('button', { name: '登记调整' })).toHaveCount(0);
});

test('accounts without members.manage get a permission notice instead of member data', async ({ page }) => {
  await page.route('**/api/v1/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-2' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['orders.read'] } } });
    }
    return route.fulfill({ json: { data: { items: [], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
  });
  await page.goto('/admin/members');
  await expect(page.getByText('当前账号没有会员读取权限（members.manage）。')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});
