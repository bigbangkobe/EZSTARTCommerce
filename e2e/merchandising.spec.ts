import { expect, test } from '@playwright/test';

const shop = 'http://127.0.0.1:3002';

test('an operator edits, publishes and withdraws the home merchandising layout', async ({ page }) => {
  const writes: { method: string; path: string; body: any }[] = [];
  let layout = { pageKey: 'home', kind: 'home', status: 'draft', version: 1, sections: [], published: null,
    publishedAt: null, versions: [], issues: [], contentRelease: 'cr-3', updatedAt: null };

  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    writes.push({ method, path: url.pathname, body });
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['content.read', 'content.write', 'content.publish'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/merchandising/products')) {
      return route.fulfill({ json: { data: { markets: ['HK'], categories: [{ id: 'cat-1', name: '雪茄' }],
        items: [
          { id: 'prod-live', name: '雪茄一號', status: 'active', publishedAt: '2026-11-01T00:00:00.000Z',
            markets: ['HK'], sellable: true, reasons: [] },
          { id: 'prod-draft', name: '未上架商品', status: 'draft', publishedAt: null, markets: [],
            sellable: false, reasons: ['PRODUCT_NOT_ACTIVE'] },
        ] }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/merchandising/pages')) {
      return route.fulfill({ json: { data: { items: [
        { pageKey: 'home', kind: 'home', targetId: null, name: null, status: layout.status, version: layout.version },
        { pageKey: 'category:cat-1', kind: 'category', targetId: 'cat-1', name: '雪茄', status: 'none', version: 0 },
      ] }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/merchandising/home')) {
      return route.fulfill({ json: { data: layout, meta: { requestId: 'req' } } });
    }
    if (method === 'PATCH') {
      layout = { ...layout, version: layout.version + 1, sections: body?.sections ?? [], issues: [],
        updatedAt: '2026-11-19T03:00:00.000Z' } as typeof layout;
      return route.fulfill({ json: { data: layout, meta: { requestId: 'req' } } });
    }
    if (url.pathname.endsWith('/publish')) {
      layout = { ...layout, status: 'published', version: layout.version + 1,
        published: { version: layout.version + 1, publishedAt: '2026-11-19T03:05:00.000Z' } } as typeof layout;
      return route.fulfill({ json: { data: { ...layout, releaseToken: 'cr-4' }, meta: { requestId: 'req' } } });
    }
    if (url.pathname.endsWith('/unpublish')) {
      layout = { ...layout, status: 'draft', version: layout.version + 1, published: null } as typeof layout;
      return route.fulfill({ json: { data: layout, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/merchandising');
  await expect(page.getByRole('heading', { name: '页面陈列', exact: true })).toBeVisible();
  // 线上版本是只读输入框：未发布时明确写出「前台用主题默认布局」，避免运营以为已经在用草稿。
  await expect(page.getByRole('textbox', { name: '线上版本' })).toHaveValue('未发布（前台用主题默认布局）');

  // 新增一个商品网格，补齐三语标题后保存。
  await page.getByRole('button', { name: '新增商品网格' }).click();
  await page.getByLabel('简体标题').fill('本月精选');
  await page.getByLabel('繁體标题').fill('本月精選');
  await page.getByLabel('English标题').fill('Featured');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText(/草稿已保存/)).toBeVisible();
  const saved = writes.find(write => write.method === 'PATCH');
  expect(saved?.body.expectedVersion).toBe(1);
  expect(saved?.body.sections[0].titleByLocale.en).toBe('Featured');

  // 发布后线上版本出现，按钮切换为「撤下」。
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByText(/已发布（版本/)).toBeVisible();
  expect(writes.some(write => write.path.endsWith('/publish'))).toBe(true);

  await page.getByRole('button', { name: '撤下' }).click();
  await expect(page.getByText(/已撤下/)).toBeVisible();
  const withdrawn = writes.find(write => write.path.endsWith('/unpublish'));
  expect(withdrawn?.body.reason.length).toBeGreaterThan(0);

  // 手工模式下不合格商品是禁选项，并显示具体原因。
  await page.getByLabel('排序方式').selectOption('manual');
  await expect(page.getByText('未上架商品')).toBeVisible();
  await expect(page.getByText(/商品未上架/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /未上架商品/ })).toBeDisabled();
});

test('the home page keeps the themed layout when no merchandising is published', async ({ page }) => {
  // 前台首页是服务端渲染，无法用浏览器层拦截 API；这里验证真正会出事的边界：
  // 没有可用版面（接口 404/不可达）时首页不能被陈列打空，必须仍渲染主题默认区块。
  await page.goto(`${shop}/zh-HK`);
  await expect(page.locator('[data-ez-section="home.hero"]')).toBeVisible();
  await expect(page.locator('[data-ez-section="home.products"]')).toBeVisible();
  // 未发布版面不会凭空多出后台配置的区块。
  await expect(page.locator('[data-ez-section="home.featured"]')).toHaveCount(0);
});

test('an operator lays out a category page with products from that category only', async ({ page }) => {
  const calls: { method: string; path: string; search: string; body: any }[] = [];
  const body_sections = (request: any) => request.postDataJSON?.()?.sections ?? [];
  let layout: any = { pageKey: 'category:cat-1', kind: 'category', targetId: 'cat-1', status: 'draft', version: 1,
    sections: [], published: null, publishedAt: null, versions: [], issues: [], contentRelease: 'cr-1', updatedAt: null };

  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    calls.push({ method, path: url.pathname, search: url.search, body: request.postDataJSON?.() ?? null });
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['content.read', 'content.write', 'content.publish'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/merchandising/pages')) {
      return route.fulfill({ json: { data: { items: [
        { pageKey: 'home', kind: 'home', targetId: null, name: null, status: 'none', version: 0 },
        { pageKey: 'category:cat-1', kind: 'category', targetId: 'cat-1', name: '雪茄', status: 'none', version: 0 },
      ] }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/merchandising/products')) {
      // 分类版面只列本分类商品：请求必须带上 categoryId，服务端才收敛候选范围。
      return route.fulfill({ json: { data: { markets: ['HK'], categories: [{ id: 'cat-1', name: '雪茄' }],
        items: [{ id: 'prod-cigar', name: '雪茄一號', status: 'active', publishedAt: '2026-11-01T00:00:00.000Z',
          markets: ['HK'], sellable: true, reasons: [] }] }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/merchandising/home')) {
      // 控制台进来先加载首页版面；这里必须返回完整形状，否则渲染会读到 undefined。
      return route.fulfill({ json: { data: { pageKey: 'home', kind: 'home', status: 'draft', version: 1, sections: [],
        published: null, publishedAt: null, versions: [], issues: [], contentRelease: 'cr-1', updatedAt: null },
        meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.includes('/merchandising/category')) {
      return route.fulfill({ json: { data: layout, meta: { requestId: 'req' } } });
    }
    if (method === 'PATCH') {
      layout = { ...layout, version: layout.version + 1, sections: body_sections(request) };
      return route.fulfill({ json: { data: layout, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/merchandising');
  // 页面下拉现在按作用域标前缀（分类/专题），同一个分类名不会和专题名混淆。
  await page.getByLabel('页面').selectOption({ label: '分类 · 雪茄（未配置）' });
  await expect(page.getByRole('textbox', { name: '线上版本' })).toHaveValue('未发布（前台用主题默认布局）');

  await page.getByRole('button', { name: '新增商品网格' }).click();
  await page.getByLabel('简体标题').fill('本月精选');
  await page.getByLabel('繁體标题').fill('本月精選');
  await page.getByLabel('English标题').fill('Featured');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText(/草稿已保存/)).toBeVisible();

  const patch = calls.find(call => call.method === 'PATCH');
  expect(patch?.path).toContain('category:cat-1');
  expect(patch?.body.sections[0].titleByLocale.en).toBe('Featured');
  const pickerCall = calls.filter(call => call.method === 'GET' && call.path.endsWith('/merchandising/products'));
  expect(pickerCall.some(call => call.search.includes('categoryId=cat-1'))).toBe(true);
});

test('the category index renders its heading even when the catalogue API is unavailable', async ({ page }) => {
  await page.goto(`${shop}/zh-HK/categories`);
  await expect(page.locator('[data-ez-section="categories.index"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: '分類', exact: true })).toBeVisible();
});
