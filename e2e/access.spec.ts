import { test, expect } from '@playwright/test';

test('roles, invitations and staff changes send CSRF and current versions', async ({ page }, info) => {
  const permissions = ['staff.read', 'staff.manage', 'roles.manage', 'catalog.read', 'catalog.write'];
  const role = { id: 'role-operator', name: '商品运营', description: '目录查看', permissionCodes: ['catalog.read'], version: 1 };
  const roles = [role];
  const users = [{ id: 'staff-1', email: 'staff@example.test', displayName: '小林', status: 'active', roleIds: [role.id], version: 3 }];
  const writes: { path: string; method: string; body: any; version: string | undefined }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    let data: any;
    if (path.endsWith('/auth/session')) data = { user: { id: 'owner-1' }, permissionCodes: permissions, csrfToken: 'csrf-test-token' };
    else if (request.method() === 'GET') data = { items: path.endsWith('/roles') ? roles : users, nextCursor: null, hasMore: false };
    else {
      expect(request.headers()['x-csrf-token']).toBe('csrf-test-token');
      const body = request.postDataJSON(); const method = request.method();
      writes.push({ path, method, body, version: request.headers()['if-match'] });
      if (path.endsWith('/roles') && method === 'POST') { const created = { ...body, id: 'role-new', version: 1 }; roles.push(created); data = created; }
      else if (path.endsWith('/roles/role-operator')) { expect(request.headers()['if-match']).toBe('"1"'); Object.assign(role, body, { version: 2 }); data = role; }
      else if (path.endsWith('/users/staff-1')) { expect(request.headers()['if-match']).toBe('"3"'); Object.assign(users[0], body, { version: 4 }); data = users[0]; }
      else data = { id: 'created-staff', version: 1 };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto('/admin/access');
  await expect(page.getByRole('heading', { name: '员工与角色', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '小林', exact: true })).toBeVisible();
  await page.getByRole('region', { name: '员工列表' }).screenshot({ path: `.local-tools/staff-${info.project.name}.png` });
  const create = page.getByRole('region', { name: '创建角色', exact: true });
  await create.getByLabel('角色名称', { exact: true }).fill('只读目录');
  await create.getByLabel('catalog.read', { exact: true }).check();
  await create.getByLabel('我已核对角色权限并确认保存').check();
  await create.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('角色已保存');
  await expect(page.getByRole('heading', { name: '只读目录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑角色 商品运营', exact: true }).click();
  const editRole = page.getByRole('region', { name: '编辑角色', exact: true });
  await editRole.getByLabel('catalog.write', { exact: true }).check();
  await editRole.getByLabel('我已核对角色权限并确认保存').check();
  await editRole.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('角色已保存');
  await page.getByRole('button', { name: '编辑 小林', exact: true }).click();
  const editStaff = page.getByRole('region', { name: '编辑员工', exact: true });
  await editStaff.getByRole('combobox', { name: '账号状态', exact: true }).selectOption('suspended');
  await editStaff.getByLabel('我确认此次修改，并知悉旧会话和邀请将失效').check();
  await editStaff.getByRole('button', { name: '保存员工', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('员工资料已保存');
  await expect(page.getByText('状态：已停用 · 版本 4')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '撤销 小林 的会话', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('员工会话已撤销');
  const invite = page.getByRole('region', { name: '邀请员工', exact: true });
  await invite.getByLabel('员工邮箱', { exact: true }).fill('new@example.test');
  await invite.getByLabel('显示姓名', { exact: true }).fill('新员工');
  await invite.getByLabel('商品运营', { exact: true }).check();
  await invite.getByRole('button', { name: '建立员工邀请', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('投递队列');
  expect(writes).toHaveLength(5);
  expect(writes.find(write => write.method === 'PATCH' && write.path.includes('/roles/'))?.body.permissionCodes).toEqual(['catalog.read', 'catalog.write']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('read-only staff sessions do not show write controls', async ({ page }) => {
  await page.route('**/api/v1/admin/**', route => route.fulfill({ json: { data: route.request().url().includes('/auth/session')
    ? { user: { id: 'reader' }, permissionCodes: ['staff.read'], csrfToken: 'read-token' }
    : { items: [{ id: 'staff-1', email: 'staff@example.test', displayName: '小林', status: 'active', roleIds: [], version: 1 }], hasMore: false, nextCursor: null } } }));
  await page.goto('/admin/access');
  await expect(page.getByRole('heading', { name: '小林', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑 小林', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '邀请员工', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '创建角色', exact: true })).toHaveCount(0);
});

test('loading more staff preserves the first page', async ({ page }) => {
  await page.route('**/api/v1/admin/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'reader' }, permissionCodes: ['staff.read'], csrfToken: 'reader-token' } } });
    const second = url.searchParams.has('cursor');
    return route.fulfill({ json: { data: { items: [{ id: second ? 'two' : 'one', email: second ? 'two@example.test' : 'one@example.test', displayName: second ? '第二页员工' : '第一页员工', status: 'active', roleIds: [], version: 1 }], hasMore: !second, nextCursor: second ? null : 'next-page' } } });
  });
  await page.goto('/admin/access');
  await expect(page.getByRole('heading', { name: '第一页员工', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加载更多员工', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第二页员工', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '第一页员工', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更多员工', exact: true })).toHaveCount(0);
});
