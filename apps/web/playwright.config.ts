import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E tests against a running stack (API + worker + web) with mock
 * integrations and the demo seed. Start everything first:
 *   npm run infra:up && npm run db:migrate && npm run db:seed
 *   npm run dev            # or the production builds
 * then: npm run test:e2e
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--disable-gpu', '--disable-dev-shm-usage', '--use-gl=swiftshader'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
