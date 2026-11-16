import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

const image = Buffer.alloc(57, 9);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image, 0);
image.writeUInt32BE(13, 8); image.write('IHDR', 12, 'ascii'); image.writeUInt32BE(8, 16); image.writeUInt32BE(6, 20);
const digest = createHash('sha256').update(image).digest('hex');

const mediaId = '5f0e5b1c-9f7a-4c2b-8d1e-3a6c7b9d0e21';
const ready = { id: mediaId, objectKey: 'media/2026/11/' + mediaId + '.png', contentType: 'image/png', sizeBytes: 57,
  sha256: digest, width: 8, height: 6, originalFileName: 'front.png', status: 'ready',
  url: '/api/v1/media/objects?key=x&expires=1&signature=y', createdAt: '2026-11-16T02:00:00.000Z', updatedAt: '2026-11-16T02:00:00.000Z' };
const pending = { ...ready, id: 'a1b2c3d4-0000-4000-8000-000000000001', originalFileName: 'later.png', status: 'pending', sha256: null,
  width: null, height: null, url: null };

test('media library uploads bytes through the signed target and confirms the digest', async ({ page }, info) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let uploaded = false;
  await page.route('**/api/v1/media/objects**', async route => {
    uploaded = route.request().method() === 'PUT';
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { data: { user: { id: 'owner-1' },
      permissionCodes: ['media.manage'], csrfToken: 'csrf-test-token' } } });
    if (url.pathname.endsWith('/media/upload-target')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ status: 201, json: { data: { mediaId, objectKey: ready.objectKey,
        uploadUrl: '/api/v1/media/objects?key=x&expires=1&signature=y', method: 'PUT', headers: { 'Content-Type': 'image/png' },
        expiresAt: '2026-11-16T02:15:00.000Z', maxSizeBytes: 57 } } });
    }
    if (url.pathname.endsWith('/media/complete')) {
      writes.push({ path: url.pathname, body: request.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ status: 201, json: { data: ready } });
    }
    if (url.pathname.endsWith('/media') && method === 'GET') {
      return route.fulfill({ json: { data: { items: [ready, pending], nextCursor: null, hasMore: false } } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'missing', fieldErrors: [], requestId: 'req' } } });
  });

  await page.goto('/admin/media');
  await expect(page.getByRole('heading', { name: '媒体库', exact: true })).toBeVisible();
  const library = page.getByRole('region', { name: '已上传媒体' });
  await expect(library.getByRole('heading', { name: 'front.png' })).toBeVisible();
  // pending 行没有可读对象，不渲染破图，只提示尚未确认。
  await expect(library.getByText('尚未确认，暂无预览。')).toBeVisible();
  await expect(library.getByText(mediaId)).toBeVisible();
  await library.screenshot({ path: `.local-tools/media-${info.project.name}.png` });

  await page.locator('input[name="file"]').setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('button', { name: '上传', exact: true }).click();
  await expect(page.getByText(/已入库：front\.png/)).toBeVisible();

  expect(uploaded).toBe(true);
  expect(writes[0]!.body).toMatchObject({ fileName: 'front.png', contentType: 'image/png', sizeBytes: 57 });
  expect(writes[1]!.body).toMatchObject({ objectKey: ready.objectKey, sha256: digest });
});

test('media library explains missing permission instead of showing an empty list', async ({ page }) => {
  await page.route('**/api/v1/admin/**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/auth/session')) {
      return route.fulfill({ json: { data: { user: { id: 'staff-1' }, permissionCodes: ['catalog.read'], csrfToken: 'csrf-test-token' } } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'denied', fieldErrors: [], requestId: 'req' } } });
  });
  await page.goto('/admin/media');
  await expect(page.getByRole('heading', { name: '没有媒体管理权限' })).toBeVisible();
});
