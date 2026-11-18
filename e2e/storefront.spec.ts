import { expect, test } from '@playwright/test';

// 前台是独立部署的站点（3002），与后台不同源，所以这里用绝对地址而不是 baseURL。
const shop = 'http://127.0.0.1:3002';

test('the storefront redirects the bare root and legacy paths to a language URL', async ({ page, request }) => {
  await page.goto(`${shop}/`);
  await expect(page).toHaveURL(`${shop}/zh-HK`);

  // 旧地址是 308：同一内容不能同时存在于带语言与不带语言两个 URL 上。
  const legacy = await request.get(`${shop}/products`, { maxRedirects: 0 });
  expect(legacy.status()).toBe(308);
  expect(legacy.headers()['location']).toBe('/zh-HK/products');
});

test('each language renders its own URL, html lang and hreflang cluster', async ({ page }) => {
  await page.goto(`${shop}/en`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle(/Mr\. IN/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://mrinhk.com/en');
  await expect(page.locator('link[rel="alternate"][hreflang="zh-CN"]'))
    .toHaveAttribute('href', 'https://mrinhk.com/zh-CN');
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]'))
    .toHaveAttribute('href', 'https://mrinhk.com/zh-HK');
  // 导航文案跟随语言，不是把同一份中文塞进三种 lang。
  await expect(page.getByRole('link', { name: 'Shop', exact: true })).toBeVisible();

  await page.goto(`${shop}/zh-CN`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans-CN');
  await expect(page.getByRole('link', { name: '商品', exact: true }).first()).toBeVisible();
});

test('the language switch keeps the visitor on the same page', async ({ page }) => {
  await page.goto(`${shop}/zh-HK/products`);
  await page.locator('.lang-switch').getByRole('link', { name: '简' }).click();
  await expect(page).toHaveURL(`${shop}/zh-CN/products`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans-CN');
  // 切换后仍停在商品页，且当前语言标为不可点的当前项。
  await expect(page.locator('.lang-switch a[aria-current="true"]')).toHaveText('简');
});

test('the bag speaks the language of its URL', async ({ page }) => {
  await page.route('**/api/v1/storefront/cart', route => route.fulfill({
    json: {
      data: {
        cartId: 'cart-e2e', currency: 'HKD', locale: 'en', itemCount: 2, subtotalMinor: 30000,
        items: [{
          id: 'item-e2e', variantId: 'variant-e2e', sku: 'SKU-E2E', productName: 'Matcha bowl',
          variantName: null, quantity: 2, unitPriceMinor: 15000, lineSubtotalMinor: 30000,
          available: true, availableQuantity: 5,
        }],
        warnings: [], expiresAt: '2026-12-01T00:00:00.000Z',
      },
      meta: { requestId: 'req-e2e' },
    },
  }));

  await page.goto(`${shop}/en/cart`);
  await expect(page.getByRole('heading', { name: 'Your bag' })).toBeVisible();
  await expect(page.getByText('Subtotal (2 items)')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Checkout' })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://mrinhk.com/en/cart');

  await page.goto(`${shop}/zh-CN/cart`);
  await expect(page.getByRole('heading', { name: '购物袋' })).toBeVisible();
  await expect(page.getByRole('link', { name: '去结账' })).toBeVisible();
});

test('robots and sitemap only expose public localized URLs', async ({ request }) => {
  const robots = await (await request.get(`${shop}/robots.txt`)).text();
  expect(robots).toContain('Sitemap: https://mrinhk.com/sitemap.xml');
  expect(robots).toContain('Disallow: /*/checkout');
  expect(robots).toContain('Disallow: /api/');

  const sitemap = await (await request.get(`${shop}/sitemap.xml`)).text();
  expect(sitemap).toContain('https://mrinhk.com/en/products');
  expect(sitemap).toContain('hreflang="zh-CN"');
  // 个人化页面不进站点地图。
  expect(sitemap).not.toContain('/cart');
  expect(sitemap).not.toContain('/checkout');
});

test('a missing product is a real 404 in the visitor language', async ({ page }) => {
  const response = await page.goto(`${shop}/en/products/no-such-product-e2e`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to home' })).toBeVisible();
});
