import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir: './e2e', fullyParallel: false, workers: 1, timeout: 30000,
  use: { ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), baseURL: 'http://127.0.0.1:3000', trace: 'off' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }],
  webServer: [
    { command: 'pnpm --filter @ezstart/admin start', url: 'http://127.0.0.1:3000/admin/login', reuseExistingServer: false, timeout: 60000 },
    // 前台三语参考主题：先构建再启动，测的是生产产物而不是 dev 编译。
    {
      command: 'pnpm --filter @ezstart/storefront-mrinhk build && pnpm --filter @ezstart/storefront-mrinhk start',
      url: 'http://127.0.0.1:3002/zh-HK',
      reuseExistingServer: false,
      timeout: 180000,
    },
  ] });
