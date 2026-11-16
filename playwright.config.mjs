import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir: './e2e', fullyParallel: false, workers: 1, timeout: 30000,
  use: { ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), baseURL: 'http://127.0.0.1:3000', trace: 'off' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }],
  webServer: { command: 'pnpm --filter @ezstart/admin start', url: 'http://127.0.0.1:3000/admin/login', reuseExistingServer: false, timeout: 60000 } });
