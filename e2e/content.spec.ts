import { test, expect } from '@playwright/test';

const pageDoc = {
  id: 'a1b2c3d4-1234-4234-8234-123456789abc', pageKey: 'about', pageType: 'standard', status: 'draft',
  position: 0, scheduledAt: null, publishedAt: null, version: 1,
  translations: [
    { locale: 'en', title: 'About us', slug: 'about-en', seoTitle: null, seoDescription: null, indexable: true, publishedSlug: null },
    { locale: 'zh-CN', title: '关于我们', slug: 'about-cn', seoTitle: null, seoDescription: null, indexable: true, publishedSlug: null },
    { locale: 'zh-HK', title: '關於我們', slug: 'about-hk', seoTitle: null, seoDescription: null, indexable: true, publishedSlug: null },
  ],
  blocks: [],
  publishedVersion: null, versions: [], contentRelease: 'cr-3',
  createdAt: '2026-11-18T02:00:00.000Z', updatedAt: '2026-11-18T02:00:00.000Z',
};

const publishedDoc = {
  ...pageDoc, status: 'published', version: 3, publishedAt: '2026-11-18T03:00:00.000Z',
  publishedVersion: { version: 2, status: 'published', publishedAt: '2026-11-18T03:00:00.000Z' },
  versions: [{ version: 2, status: 'published', publishedAt: '2026-11-18T03:00:00.000Z', note: null, releaseSeq: 3 }],
  translations: pageDoc.translations.map(item => ({ ...item, publishedSlug: item.slug })),
};

test('an editor drafts, previews and publishes a trilingual content page', async ({ page }) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['content.read', 'content.write', 'content.publish'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/pages')) {
      return route.fulfill({ json: { data: { items: [pageDoc], nextCursor: null, hasMore: false }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/pages')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ status: 201, json: { data: pageDoc, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/publish')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { data: { scheduled: false, releaseToken: 'cr-4', page: publishedDoc }, meta: { requestId: 'req' } } });
    }
    if (method === 'PATCH') {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { data: pageDoc, meta: { requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/content');
  await expect(page.getByRole('heading', { name: '内容页与发布版本' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /關於我們/ })).toBeVisible();

  // 新建草稿：三语标题/slug 与区块 JSON 一起提交，页面键不可省略。
  const draft = page.getByRole('heading', { name: '新建内容页草稿' }).locator('xpath=ancestor::section[1]');
  await draft.locator('input[name="pageKey"]').fill('about');
  for (const locale of ['zh-CN', 'zh-HK', 'en']) {
    await draft.locator(`input[name="title:${locale}"]`).fill(locale === 'en' ? 'About us' : '關於我們');
    await draft.locator(`input[name="slug:${locale}"]`).fill(`about-${locale.toLowerCase()}`);
  }
  await draft.getByRole('button', { name: '填入示例区块' }).click();
  await draft.getByRole('button', { name: '预览区块' }).click();
  const preview = page.getByRole('heading', { name: '草稿预览' }).locator('xpath=ancestor::section[1]');
  await expect(preview.getByRole('heading', { name: '關於我們' })).toBeVisible();
  await preview.getByRole('button', { name: '手机' }).click();
  await expect(preview.locator('.content-preview')).toHaveCSS('max-width', '380px');

  await draft.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.locator('p.notice')).toContainText('草稿已建立');

  const created = writes.find(write => write.path.endsWith('/pages'));
  expect(created?.body['pageKey']).toBe('about');
  expect((created?.body['translations'] as unknown[]).length).toBe(3);
  expect((created?.body['blocks'] as { type: string }[])[0]?.type).toBe('rich_text');

  // 发布：带上当前版本号，服务端据此做版本冲突检测。
  await page.getByRole('button', { name: '发布 about' }).click();
  await expect(page.locator('p.notice')).toContainText('已发布');
  const published = writes.find(write => write.path.endsWith('/publish'));
  expect(published?.body['expectedVersion']).toBe(1);
  expect(published?.body['mode']).toBe('immediate');
});

test('a forgotten locale is reported as a fixable problem, not a generic failure', async ({ page }) => {
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['content.read', 'content.publish'] } } });
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/pages')) {
      return route.fulfill({ json: { data: { items: [pageDoc], nextCursor: null, hasMore: false }, meta: { requestId: 'req' } } });
    }
    if (url.pathname.endsWith('/publish')) {
      return route.fulfill({ status: 422, json: { error: { code: 'CONTENT_LOCALE_INCOMPLETE',
        message: 'Invalid request.', fieldErrors: [], requestId: 'req' } } });
    }
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/content');
  await page.getByRole('button', { name: '发布 about' }).click();
  // 错误信息要指出「补哪一种语言」，运营才知道下一步做什么。
  await expect(page.locator('p.error')).toContainText('必须补齐店铺已启用的全部语言');
  // 只读 + 发布权限：不能编辑草稿，因此没有保存按钮。
  await expect(page.getByRole('button', { name: '编辑 about' })).toHaveCount(0);
});

test('an unpublished content address falls back to the localized 404', async ({ page }) => {
  // 前台是独立站点；内容页没有发布快照或接口不可达时必须 404，而不是渲染空壳。
  const response = await page.goto('http://127.0.0.1:3002/zh-HK/pages/does-not-exist');
  expect(response?.status()).toBe(404);
  await expect(page.getByText('找不到這個頁面')).toBeVisible();
});
