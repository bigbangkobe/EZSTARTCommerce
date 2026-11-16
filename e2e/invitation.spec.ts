import { test, expect } from '@playwright/test';

test('invitation fragment is cleared, MFA completes and recovery codes remain ephemeral', async ({ page }, testInfo) => {
  const token = 'test-only-invitation-token-12345678901234567890';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const bodies: { path: string; body: any }[] = [];
  await page.route('**/api/v1/admin/auth/**', async route => {
    const path = new URL(route.request().url()).pathname;
    bodies.push({ path, body: route.request().postDataJSON() });
    const data = path.endsWith('/accept') ? { nextAction: 'enroll_mfa', challengeId: 'challenge-1' }
      : path.endsWith('/confirm') ? { recoveryCodes: ['RECOVERYCODETEST12345', 'RECOVERYCODETEST67890'] }
      : { enrollmentId: 'enrollment-1', totpSecret: 'JBSWY3DPEHPK3PXP' };
    await route.fulfill({ status: path.endsWith('/accept') ? 202 : 200, json: { data } });
  });
  const response = await page.goto(`/admin/accept-invitation#${token}`);
  await expect(page).toHaveURL(/accept-invitation$/);
  await page.screenshot({ path: `.local-tools/invitation-${testInfo.project.name}.png`, fullPage: true });
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response?.headers()['x-robots-tag']).toContain('noindex');
  expect(response?.headers()['content-security-policy']).toContain("'nonce-");
  await page.getByLabel(/^设置密码/).fill('My-long-password-12345');
  await page.getByRole('button', { name: '设置密码并继续' }).click();
  await expect(page.getByRole('heading', { name: '绑定身份验证器' })).toBeVisible();
  await expect(page.getByText('JBSWY3DPEHPK3PXP', { exact: true })).toBeVisible();
  expect(bodies[0]!.body.invitationToken).toBe(token);
  await page.getByLabel('六位验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '确认绑定' }).click();
  await expect(page.getByText('RECOVERYCODETEST12345', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('我已离线保存恢复码').check();
  await page.getByRole('button', { name: '隐藏恢复码' }).click();
  await expect(page.getByText('RECOVERYCODETEST12345', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('invalid invitations show a safe error and allow password login recovery', async ({ page }) => {
  await page.route('**/api/v1/admin/auth/invitations/accept', route => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'internal secret must not be displayed' } } }));
  await page.goto('/admin/accept-invitation#expired-test-token-12345678901234567890');
  await page.getByLabel(/^设置密码/).fill('My-long-password-12345');
  await page.getByRole('button', { name: '设置密码并继续' }).click();
  await expect(page.getByRole('region').getByRole('alert')).toContainText('凭据已失效');
  await expect(page.getByText('internal secret must not be displayed')).toHaveCount(0);
  await page.getByRole('link', { name: '已设置密码？重新登录' }).click();
  await expect(page.getByRole('heading', { name: '登录店铺后台' })).toBeVisible();
});
