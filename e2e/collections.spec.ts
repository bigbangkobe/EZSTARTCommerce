import { expect, test } from '@playwright/test';

const shop = 'http://127.0.0.1:3002';

const catalogueProduct = { id: 'prod-1', baseSku: 'CIGAR-1', brandId: null, categoryIds: ['cat-1'], marketCodes: ['HK'],
  status: 'active', translations: [{ locale: 'zh-CN', name: '雪茄一號', slug: 'cigar-no-1', shortDescription: null,
    description: null, seoTitle: null, seoDescription: null }],
  variants: [], media: [], version: 1, createdAt: '2026-11-19T02:00:00.000Z', updatedAt: '2026-11-19T02:00:00.000Z' };

const stored = { id: 'col-1', position: 0, enabled: true, version: 2, productIds: ['prod-1'], productCount: 1,
  translations: [{ locale: 'zh-HK', name: '秋日選物', slug: 'autumn-picks', description: '店主精選' },
    { locale: 'zh-CN', name: '秋日选物', slug: 'autumn-picks-cn', description: null }] };

test('an operator creates a collection and edits its slug with the current version', async ({ page }) => {
  const writes: { method: string; path: string; body: any; ifMatch: string | undefined }[] = [];

  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' },
        permissionCodes: ['catalog.read', 'catalog.write'], csrfToken: 'csrf-test-token' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/collections')) {
      return route.fulfill({ json: { data: { items: [stored] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/categories')) return route.fulfill({ json: { data: { items: [] } } });
    if (method === 'GET' && url.pathname.endsWith('/brands')) return route.fulfill({ json: { data: { items: [] } } });
    if (method === 'GET' && url.pathname.endsWith('/products')) {
      return route.fulfill({ json: { data: { items: [catalogueProduct], nextCursor: null, hasMore: false } } });
    }
    writes.push({ method, path: url.pathname, body: request.postDataJSON?.() ?? null,
      ifMatch: request.headers()['if-match'] });
    if (method === 'POST') return route.fulfill({ status: 201, json: { data: stored } });
    if (method === 'DELETE') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ json: { data: stored } });
  });

  await page.goto('/admin/catalog');
  await expect(page.getByRole('heading', { name: '商品目录', exact: true })).toBeVisible();

  // 专题是一个独立的策展区：列表显示各语言 slug 与商品件数，没有 slug 的会明确写「前台不可见」。
  const section = page.getByRole('region', { name: '专题（策展）', exact: true });
  await expect(section).toBeVisible();
  // 列表标题按简中名显示（后台列表统一用 zh-CN 作为主标签）。
  await expect(section.getByRole('heading', { name: /秋日选物/ })).toBeVisible();
  await expect(section.getByText(/zh-HK: autumn-picks/)).toBeVisible();

  // 新建：只要名称与 slug 就能先把专题建起来，商品后补。
  await section.getByLabel('新专题名称（简中）').fill('冬季選物');
  await section.getByLabel('专题 slug').fill('winter-picks');
  await section.getByRole('button', { name: '建立专题' }).click();
  await expect(page.getByText('专题已建立；补上商品后前台即可看到。')).toBeVisible();
  const created = writes.find(write => write.method === 'POST' && write.path.endsWith('/collections'));
  expect(created?.body).toEqual({ translations: [{ locale: 'zh-CN', name: '冬季選物', slug: 'winter-picks' }] });

  // 编辑：改繁体 slug 并保存，提交要带 If-Match 版本号与当前商品顺序。
  await section.getByRole('button', { name: '编辑专题' }).click();
  const editor = page.getByRole('region', { name: /编辑专题/ });
  await expect(editor).toBeVisible();
  await editor.locator('input[name="col-slug:zh-HK"]').fill('autumn-edit');
  await editor.getByRole('button', { name: '保存专题' }).click();
  await expect(page.getByText(/专题已保存/)).toBeVisible();

  const patched = writes.find(write => write.method === 'PATCH');
  expect(patched?.path).toBe('/api/v1/admin/collections/col-1');
  expect(patched?.ifMatch).toBe('"2"');
  expect(patched?.body).toMatchObject({ enabled: true, productIds: ['prod-1'] });
  expect(patched?.body.translations.find((item: any) => item.locale === 'zh-HK').slug).toBe('autumn-edit');
});

test('the storefront exposes a collections index in the site navigation', async ({ page }) => {
  await page.goto(`${shop}/zh-HK`);
  // 导航里只有一个「專題」入口；页脚也可能有同名链接，取第一个。
  await page.getByRole('link', { name: '專題', exact: true }).first().click();
  await expect(page).toHaveURL(`${shop}/zh-HK/collections`);
  // 没有专题数据时页面仍然可达，并给出空状态而不是 404。
  await expect(page.locator('[data-ez-section="collections.index"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: '專題', exact: true })).toBeVisible();
});
