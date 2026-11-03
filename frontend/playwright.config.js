// @ts-check
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  timeout: 120000,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report' }]
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Mobile responsiveness (tests/mobile-responsive.spec.js only). All run in
    // Chromium with the device's viewport, touch and user agent — WebKit isn't
    // installed here, so this checks layout, not Safari rendering.
    {
      name: 'iphone-13',
      testMatch: /mobile-responsive\.spec\.js/,
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
    {
      name: 'pixel-7',
      testMatch: /mobile-responsive\.spec\.js/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'ipad-gen-7',
      testMatch: /mobile-responsive\.spec\.js/,
      use: { ...devices['iPad (gen 7)'], browserName: 'chromium' },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
  },
});
