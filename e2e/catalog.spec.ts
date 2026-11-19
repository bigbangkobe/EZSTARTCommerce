import { test, expect } from '@playwright/test';

const category = { id: 'cat-1', parentId: null, position: 0, enabled: true, version: 1,
  translations: [{ locale: 'zh-CN', name: '雪茄', slug: 'cigars' }] };
const product = { id: 'product-1', baseSku: 'CIGAR-1', brandId: null, categoryIds: ['cat-1'], marketCodes: ['HK'], status: 'draft',
  translations: [{ locale: 'zh-CN', name: '雪茄一號', slug: 'cigar-no-1', shortDescription: null, description: null, seoTitle: null, seoDescription: null }],
  variants: [{ id: 'variant-1', sku: 'CIGAR-1-50', optionValues: { size: '50ml' }, priceMinor: 12800, compareAtMinor: null,
    currency: 'HKD', status: 'active', onHand: 0, reserved: 0, available: 0 }],
  media: [], version: 1, createdAt: '2026-11-16T02:00:00.000Z', updatedAt: '2026-11-16T02:00:00.000Z' };

test('catalog lists products, creates a three-language draft and publishes with the current version', async ({ page }, info) => {
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'owner-1' },
      permissionCodes: ['catalog.read', 'catalog.write', 'catalog.publish'], csrfToken: 'csrf-test-token' } } });
    if (url.pathname.endsWith('/categories')) return route.fulfill({ json: { data: { items: [category] } } });
    if (url.pathname.endsWith('/brands')) return route.fulfill({ json: { data: { items: [] } } });
    if (url.pathname.endsWith('/products') && method === 'GET') return route.fulfill({ json: { data: { items: [product], nextCursor: null, hasMore: false } } });
    if (method !== 'GET') {
      writes.push({ path: url.pathname, method, body: request.postDataJSON() ?? {} });
      const isPublish = url.pathname.endsWith('/publish');
      return route.fulfill({ status: isPublish ? 200 : 201, json: { data: isPublish
        ? { productId: 'product-1', version: 2, status: 'active', publishedAt: '2026-11-16T02:00:00.000Z', jobId: null }
        : product } });
    }
    return route.fulfill({ json: { data: { items: [] } } });
  });

  await page.goto('/admin/catalog');
  await expect(page.getByRole('heading', { name: '商品目录', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /雪茄一號/ })).toBeVisible();
  await page.getByRole('region', { name: '商品列表' }).screenshot({ path: `.local-tools/catalog-${info.project.name}.png` });

  const create = page.getByRole('region', { name: '新建商品草稿', exact: true });
  await create.locator('input[name="name:zh-CN"]').fill('雪茄二號');
  await create.locator('input[name="slug:zh-CN"]').fill('cigar-no-2');
  await create.locator('input[name="name:zh-HK"]').fill('雪茄二號');
  await create.locator('input[name="slug:zh-HK"]').fill('cigar-no-2-hk');
  await create.locator('input[name="name:en"]').fill('Cigar No.2');
  await create.locator('input[name="slug:en"]').fill('cigar-no-2-en');
  await create.getByLabel('雪茄', { exact: true }).check();
  await create.getByLabel('市场代码（逗号分隔，须已审核并启用）').fill('HK');
  await create.locator('input[name="sku:0"]').fill('CIGAR-2-50');
  await create.locator('input[name="options:0"]').fill('size=50ml');
  await create.locator('input[name="price:0"]').fill('9800');
  await create.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('草稿已建立；补齐三语内容并确认市场后再发布。')).toBeVisible();

  const created = writes.find(write => write.method === 'POST' && write.path.endsWith('/products'));
  expect((created?.body['translations'] as unknown[]).length).toBe(3);
  expect((created?.body['variants'] as { sku: string; priceMinor: number; currency: string }[])[0]).toMatchObject({ sku: 'CIGAR-2-50', priceMinor: 9800, currency: 'HKD' });
  expect(created?.body['marketCodes']).toEqual(['HK']);

  await page.getByRole('button', { name: '发布 雪茄一號', exact: true }).click();
  await expect(page.getByText('商品已发布到指定市场。')).toBeVisible();
  const publish = writes.find(write => write.path.endsWith('/publish'));
  expect(publish?.body).toMatchObject({ expectedVersion: 1, marketCodes: ['HK'] });
});

test('accounts without catalog.read only see a permission notice', async ({ page }) => {
  await page.route('**/api/v1/admin/**', route => route.fulfill({ json: { data: { user: { id: 'reader' }, permissionCodes: ['staff.read'], csrfToken: 'read-token' } } }));
  await page.goto('/admin/catalog');
  await expect(page.getByRole('heading', { name: '没有商品读取权限', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存草稿' })).toHaveCount(0);
});

test('an operator gives a category its slugs so the storefront category page becomes reachable', async ({ page }) => {
  // 生产上分类常常只有名称没有 slug；没有 slug 的分类前台不列出，分类页也就无从进入。
  const bare = { id: 'cat-2', parentId: null, position: 0, enabled: true, version: 3,
    translations: [{ locale: 'zh-CN', name: '茶葉', slug: null }] };
  const writes: { path: string; body: Record<string, unknown>; ifMatch: string | undefined }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'owner-1' },
      permissionCodes: ['catalog.read', 'catalog.write'], csrfToken: 'csrf-test-token' } } });
    if (url.pathname.endsWith('/categories') && method === 'GET') return route.fulfill({ json: { data: { items: [bare] } } });
    if (url.pathname.endsWith('/brands')) return route.fulfill({ json: { data: { items: [] } } });
    if (url.pathname.endsWith('/products') && method === 'GET') return route.fulfill({ json: { data: { items: [], nextCursor: null, hasMore: false } } });
    if (method === 'PATCH' && url.pathname.includes('/categories/')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() ?? {}, ifMatch: request.headers()['if-match'] });
      return route.fulfill({ json: { data: { ...bare, version: 4, translations: [{ locale: 'zh-HK', name: '茶葉', slug: 'teas' }] } } });
    }
    return route.fulfill({ json: { data: { items: [] } } });
  });

  await page.goto('/admin/catalog');
  await expect(page.getByText('zh-CN: 无 slug（前台不可见）')).toBeVisible();
  await page.getByRole('button', { name: '编辑分类', exact: true }).click();

  const editor = page.getByRole('region', { name: '编辑分类「茶葉」' });
  await editor.locator('input[name="cat-name:zh-HK"]').fill('茶葉');
  await editor.locator('input[name="cat-slug:zh-HK"]').fill('teas');
  await editor.locator('input[name="cat-name:en"]').fill('Tea');
  await editor.locator('input[name="cat-slug:en"]').fill('teas-en');
  await editor.getByRole('button', { name: '保存分类' }).click();
  await expect(page.getByText('分类已更新；前台分类页与站点地图最多半分钟内生效。')).toBeVisible();

  const patch = writes[0];
  expect(patch?.path).toContain('cat-2');
  // 版本用 If-Match 带上：两个人同时改分类时后到的那位会拿到 409，而不是互相覆盖。
  expect(patch?.ifMatch).toBe('"3"');
  // 简体沿用原有名称（原本就没有 slug，保持空着）；新填的两门语言带上各自地址。
  expect(patch?.body['translations']).toEqual([
    { locale: 'zh-CN', name: '茶葉' },
    { locale: 'zh-HK', name: '茶葉', slug: 'teas' },
    { locale: 'en', name: 'Tea', slug: 'teas-en' },
  ]);
  expect(patch?.body['enabled']).toBe(true);
});
