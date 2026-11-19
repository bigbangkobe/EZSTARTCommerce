import { expect, test } from '@playwright/test';

const shop = 'http://127.0.0.1:3002';
const token = 'A'.repeat(43);

const pageDoc = {
  id: 'a1b2c3d4-1234-4234-8234-123456789abc', pageKey: 'about', pageType: 'standard', status: 'published',
  position: 0, scheduledAt: null, publishedAt: '2026-11-19T02:00:00.000Z', version: 4,
  translations: [
    { locale: 'zh-HK', title: '關於我們', slug: 'about-hk', seoTitle: null, seoDescription: null, indexable: true, publishedSlug: 'about-hk' },
  ],
  blocks: [{ id: 'intro', type: 'rich_text', visible: true, position: 0, config: { heading: '關於我們', paragraphs: ['內容'] } }],
  publishedVersion: { version: 3, status: 'published', publishedAt: '2026-11-19T02:00:00.000Z', note: null, releaseSeq: 9 },
  versions: [{ version: 3, status: 'published', publishedAt: '2026-11-19T02:00:00.000Z', note: null, releaseSeq: 9 }],
  contentRelease: 'cr-9', createdAt: '2026-11-19T01:00:00.000Z', updatedAt: '2026-11-19T02:00:00.000Z',
};

const redirectDoc = {
  id: 'b1b2c3d4-1234-4234-8234-123456789abc', locale: 'zh-HK', fromPath: '/zh-HK/pages/about-old',
  toPath: '/zh-HK/pages/about-hk', statusCode: 301, pageKey: 'about', auto: true, createdAt: '2026-11-19T02:00:00.000Z',
};

test('an editor issues a preview link and manages redirects', async ({ page }) => {
  const writes: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    writes.push({ method, path: url.pathname, body: request.postDataJSON() as Record<string, unknown> | null });
    if (url.pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, csrfToken: 'csrf-test-token',
        permissionCodes: ['content.read', 'content.write', 'content.publish', 'content.preview'] } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/pages')) {
      return route.fulfill({ json: { data: { items: [pageDoc], nextCursor: null, hasMore: false }, meta: { requestId: 'req' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/redirects')) {
      return route.fulfill({ json: { data: { items: [redirectDoc], nextCursor: null, hasMore: false }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/preview-token')) {
      return route.fulfill({ status: 201, json: { data: { token, path: `/zh-HK/preview/${token}?viewport=desktop`,
        locale: 'zh-HK', viewport: 'desktop', expiresAt: '2026-11-19T04:00:00.000Z', pageVersion: 4 }, meta: { requestId: 'req' } } });
    }
    if (method === 'POST' && url.pathname.endsWith('/redirects')) {
      return route.fulfill({ status: 201, json: { data: redirectDoc, meta: { requestId: 'req' } } });
    }
    if (method === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ json: { data: {}, meta: { requestId: 'req' } } });
  });

  await page.goto('/admin/content');
  await expect(page.getByRole('heading', { name: '内容页与发布版本' })).toBeVisible();

  // 预览链接：绑定当前草稿版本，链接短期有效。
  await page.getByRole('button', { name: '预览链接' }).click();
  const section = page.getByRole('heading', { name: /预览链接/ }).locator('xpath=ancestor::section[1]');
  await expect(section.getByRole('link', { name: `/zh-HK/preview/${token}?viewport=desktop` })).toBeVisible();
  const issued = writes.find(write => write.path.endsWith('/preview-token'));
  expect(issued?.body).toEqual({ locale: 'zh-HK', viewport: 'desktop', expectedVersion: 4 });

  // 重定向面板：自动登记的记录可复核，手工登记带上语言与两端路径。
  const redirectSection = page.getByRole('heading', { name: 'URL 重定向' }).locator('xpath=ancestor::section[1]');
  await expect(redirectSection.getByRole('heading', { name: /about-old → .*about-hk/ })).toBeVisible();
  await redirectSection.locator('input[name="fromPath"]').fill('/zh-HK/pages/legacy');
  // 用回车提交：手机视口下按钮在长表单底部，点击会因滚动位置与命中测试不一致而不稳定，
  // 回车是同一表单提交路径，也更接近手机上填完就提交的习惯。
  await redirectSection.locator('input[name="toPath"]').fill('/zh-HK/pages/about-hk');
  await redirectSection.locator('input[name="toPath"]').press('Enter');
  await expect(page.locator('p.notice')).toContainText('重定向已登记');
  const created = writes.filter(write => write.method === 'POST' && write.path.endsWith('/redirects')).at(-1);
  expect(created?.body).toEqual({ locale: 'zh-HK', fromPath: '/zh-HK/pages/legacy', toPath: '/zh-HK/pages/about-hk' });
});

test('a preview URL without a valid token fails closed and is never indexable', async ({ page, request }) => {
  // 伪造/过期 token 一律 404；入口层同时加上 noindex 头，避免草稿被爬虫收录。
  const response = await request.get(`${shop}/zh-HK/preview/${'B'.repeat(43)}`, { maxRedirects: 0 });
  expect(response.status()).toBe(404);
  expect(response.headers()['x-robots-tag']).toContain('noindex');
  expect(response.headers()['cache-control']).toContain('no-store');

  await page.goto(`${shop}/zh-HK/preview/${'B'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: '找不到這個頁面' })).toBeVisible();
  // 预览页不能加载埋点：草稿访问不该进入任何统计。
  expect(await page.locator('script[src*="analytics"]').count()).toBe(0);
});
