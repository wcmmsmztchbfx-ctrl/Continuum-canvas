import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/performance', fullyParallel: false, workers: 1,
  timeout: 180_000, reporter: [['list'], ['json', { outputFile: '.runtime/performance/results.json' }]],
  outputDir: '.runtime/performance/artifacts',
  use: { baseURL: 'http://127.0.0.1:4373', channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, trace: 'off' },
  webServer: { command: 'node scripts/performance/server.mjs', url: 'http://127.0.0.1:4373',
    reuseExistingServer: false, timeout: 120_000 },
})
