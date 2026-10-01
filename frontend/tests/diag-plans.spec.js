import { test, expect } from '@playwright/test';

const BASE = 'http://127.0.0.1:5173';
const ORG_A_ADMIN = 'orga-admin@phase18.test.com';
const PASSWORD = 'Phase18#12345';

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', ORG_A_ADMIN);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button:has-text("Sign In")');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

test('diag: where does org_admin land after goto plans', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/billing/subscriptions/plans`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  console.log('FINAL_URL=' + page.url());
  await page.screenshot({ path: 'diag-plans.png' });
  const heading = page.getByRole('heading', { name: 'Subscription Plans' });
  console.log('PLANS_HEADING_VISIBLE=' + await heading.isVisible().catch(() => false));
  console.log('H1S=' + await page.locator('h1').allTextContents().catch(() => []));
  console.log('BODY_SNIP=' + JSON.stringify((await page.locator('main').innerText().catch(() => '')).slice(0, 400)));
  expect(true).toBeTruthy();
});
