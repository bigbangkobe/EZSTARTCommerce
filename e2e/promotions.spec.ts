import { test, expect } from '@playwright/test';

const couponId = '6f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const usage = { reservedCount: 1, redeemedCount: 2, releasedCount: 0, expiredCount: 0,
  returnedCount: 0, usedCount: 3 };
const coupon = { id: couponId, code: 'WELCOME-10', codeMasked: 'WE***10', status: 'active',
  discountType: 'percent', discountValue: 1000, currency: 'HKD',
  validFrom: '2026-11-01T00:00:00.000Z', validUntil: '2026-12-31T23:59:59.000Z',
  minSubtotalMinor: 5000, totalLimit: 100, perCustomerLimit: 1, eligibleProductIds: [],
  eligibleCategoryIds: [], memberTierIds: [], refundPolicy: 'restore', version: 1,
  createdBy: 'staff-1', createdAt: '2026-11-16T02:00:00.000Z', updatedAt: '2026-11-16T02:00:00.000Z',
  usage };
const redemption = { id: '8f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', orderId: '7f2c1d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  publicOrderNumber: 'EZ-20261116-ABC123', status: 'redeemed', discountMinor: 1200, currency: 'HKD',
  customerRef: '9f2ab3c1', reservedAt: '2026-11-16T03:00:00.000Z', redeemedAt: '2026-11-16T03:05:00.000Z',
  releasedAt: null, expiresAt: null, ruleVersion: 1 };

test('an operator creates a coupon, reviews usage and disables it with a reason', async ({ page }) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let created = false;
  let disabled = false;
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['coupons.read', 'coupons.manage'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/coupons')) {
      return route.fulfill({ json: { data: { items: created ? [coupon] : [], hasMore: false, nextCursor: null },
        meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/coupons')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      created = true;
      return route.fulfill({ status: 201, json: { data: coupon, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/redemptions')) {
      return route.fulfill({ json: { data: { items: created ? [redemption] : [], hasMore: false,
        nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/disable')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      disabled = true;
      return route.fulfill({ json: { data: { ...coupon, status: 'disabled', version: 2 },
        meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/coupons');
  await expect(page.getByRole('heading', { name: '优惠券', exact: true })).toBeVisible();
  await expect(page.getByText('还没有符合条件的优惠券。')).toBeVisible();

  await page.getByLabel('券码', { exact: true }).fill('welcome-10');
  await page.getByLabel('力度', { exact: false }).fill('10');
  await page.getByLabel('生效时间').fill('2026-11-01T00:00');
  await page.getByLabel('失效时间').fill('2026-12-31T23:59');
  await page.getByLabel(/最低消费/).fill('5000');
  await page.getByLabel(/总发放额度/).fill('100');
  await page.getByLabel(/每人限用次数/).fill('1');
  await page.getByLabel(/整单退款后/).selectOption('restore');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText(/已创建优惠券 WELCOME-10/)).toBeVisible();

  // 小写输入被归一化为大写券码；百分比按基点（bps）提交。
  const create = writes.find(entry => entry.path.endsWith('/coupons'));
  expect(create?.body['code']).toBe('WELCOME-10');
  expect(create?.body['discountType']).toBe('percent');
  expect(create?.body['discountValue']).toBe(1000);
  expect(create?.body['minSubtotalMinor']).toBe(5000);
  expect(create?.body['totalLimit']).toBe(100);
  expect(create?.body['perCustomerLimit']).toBe(1);
  expect(create?.body['refundPolicy']).toBe('restore');

  // 用量口径可见：占额度 3 = 预占 1 + 已核销 2 − 已返还 0。
  await expect(page.getByText(/占额度 3/)).toBeVisible();
  await expect(page.getByText('EZ-20261116-ABC123')).toBeVisible();
  // 核销列表里只能看到不可逆摘要，看不到原始联系方式。
  await expect(page.getByText('9f2ab3c1')).toBeVisible();

  await page.getByLabel('停用原因').fill('活动提前结束');
  await page.getByRole('button', { name: '停用这张券' }).click();
  await expect(page.getByText(/已停用 WELCOME-10/)).toBeVisible();

  const disable = writes.find(entry => entry.path.endsWith('/disable'));
  expect(disabled).toBe(true);
  expect(disable?.body['reason']).toBe('活动提前结束');
  // 停用请求不能夹带规则字段：改规则走 PATCH，停用只带原因。
  expect(disable?.body['discountValue']).toBeUndefined();
});

const tierId = 'a1b2c3d4-0000-4222-8333-444455556666';
const memberId1 = 'b1b2c3d4-0000-4222-8333-444455556666';
const memberId2 = 'c1b2c3d4-0000-4222-8333-444455556666';
const batch = { id: 'd1b2c3d4-0000-4222-8333-444455556666', couponId, channel: 'account_only',
  recipientCount: 2, recipientMemberIds: [memberId1, memberId2], status: 'pending',
  confirmedRecipientCount: null, idempotencyKey: 'batch:d1b2c3d4', createdAt: '2026-11-18T00:00:00.000Z',
  issuedAt: null };

test('an operator tags a coupon with a member tier and issues a reviewed batch', async ({ page }) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let issued = false;
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['coupons.read', 'coupons.manage', 'coupons.issue', 'members.manage'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/loyalty')) {
      return route.fulfill({ json: { data: { tiers: [{ id: tierId, code: 'VIP', rank: 1, status: 'active',
        nameByLocale: { 'zh-HK': '貴賓' } }] }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/coupons')) {
      return route.fulfill({ json: { data: { items: [coupon], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/coupons')) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path: url.pathname, body });
      return route.fulfill({ status: 201, json: { data: { ...coupon, code: String(body['code'] ?? coupon.code) },
        meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/redemptions')) {
      return route.fulfill({ json: { data: { items: [], hasMore: false, nextCursor: null }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/coupon-batches')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ status: 201, json: { data: batch, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.includes('/issue')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      issued = true;
      return route.fulfill({ status: 202, json: { data: { ...batch, status: 'issued', confirmedRecipientCount: 2,
        issuedAt: '2026-11-18T01:00:00.000Z' }, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/coupons');
  await expect(page.getByRole('heading', { name: '优惠券', exact: true })).toBeVisible();
  // 会员等级可勾选：专属券创建时带上 memberTierIds。
  await page.getByLabel('券码', { exact: true }).fill('vip-10');
  await page.getByLabel('力度', { exact: false }).fill('10');
  await page.getByLabel('生效时间').fill('2026-11-01T00:00');
  await page.getByLabel('失效时间').fill('2026-12-31T23:59');
  await page.getByRole('checkbox', { name: /貴賓/ }).check();
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText(/已创建优惠券 VIP-10/)).toBeVisible();
  const create = writes.find(entry => entry.path.endsWith('/coupons'));
  expect(create?.body['memberTierIds']).toEqual([tierId]);

  // 批量发放：建批冻结人数后按人数复核确认。
  await page.getByLabel('会员 ID 列表').fill(`${memberId1}, ${memberId2}`);
  await page.getByRole('button', { name: '建立发放批次' }).click();
  await expect(page.getByText(/已建批，冻结收件人数 2 位/)).toBeVisible();
  await page.getByLabel('确认发放人数').fill('2');
  await page.getByRole('button', { name: '确认发放' }).click();
  await expect(page.getByText(/已确认发放 2 位会员/)).toBeVisible();
  expect(issued).toBe(true);
  const issue = writes.find(entry => entry.path.includes('/issue'));
  expect(issue?.body['confirmedRecipientCount']).toBe(2);
});
