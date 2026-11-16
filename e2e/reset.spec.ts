import { test, expect } from '@playwright/test';

test('reset request always reports the same accepted outcome and stores nothing', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const bodies: unknown[] = [];
  await page.route('**/api/v1/admin/auth/password-reset', async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { data: { requestAccepted: true } } });
  });
  const response = await page.goto('/admin/reset-password');
  await page.screenshot({ path: `.local-tools/reset-${testInfo.project.name}.png`, fullPage: true });
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response?.headers()['x-robots-tag']).toContain('noindex');
  expect(response?.headers()['content-security-policy']).toContain("'nonce-");
  await page.getByLabel('员工邮箱').fill('maybe@example.test');
  await page.getByRole('button', { name: '发送重设链接' }).click();
  await expect(page.getByRole('heading', { name: '请查收邮件' })).toBeVisible();
  await expect(page.getByText(/如果该邮箱已注册/)).toBeVisible();
  expect(bodies[0]).toEqual({ email: 'maybe@example.test' });
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('reset completion clears the fragment, posts the credential once and keeps it out of storage', async ({ page }) => {
  const token = 'test-only-reset-token-1234567890123456789012';
  const bodies: { resetToken?: string; newPassword?: string }[] = [];
  await page.route('**/api/v1/admin/auth/password-reset', async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { data: { requestAccepted: true } } });
  });
  await page.goto(`/admin/reset-password#${token}`);
  await expect(page).toHaveURL(/reset-password$/);
  await expect(page.getByRole('heading', { name: '设置新密码' })).toBeVisible();
  await page.locator('input[name="password"]').fill('My-new-long-password-123');
  await page.getByRole('button', { name: '设置新密码' }).click();
  await expect(page.getByRole('heading', { name: '密码已重设' })).toBeVisible();
  expect(bodies[0]).toEqual({ resetToken: token, newPassword: 'My-new-long-password-123' });
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole('link', { name: /返回登录/ }).click();
  await expect(page.getByRole('heading', { name: '登录店铺后台' })).toBeVisible();
  await expect(page.getByRole('link', { name: /忘记密码/ })).toBeVisible();
});

test('an invalid reset token shows a safe error without provider detail', async ({ page }) => {
  await page.route('**/api/v1/admin/auth/password-reset', route =>
    route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'internal secret must not be displayed' } } }));
  await page.goto('/admin/reset-password#expired-test-token-12345678901234567890');
  await page.locator('input[name="password"]').fill('My-new-long-password-123');
  await page.getByRole('button', { name: '设置新密码' }).click();
  await expect(page.getByRole('region').getByRole('alert')).toContainText('重设链接已失效');
  await expect(page.getByText('internal secret must not be displayed')).toHaveCount(0);
});
