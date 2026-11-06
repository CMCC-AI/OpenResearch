import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['line'], ['json', { outputFile: 'test-results/browser-results.json' }]],
  outputDir: 'test-results/browser',
  use: { browserName: 'chromium', headless: true, baseURL: process.env.ORX_BROWSER_BASE_URL, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
