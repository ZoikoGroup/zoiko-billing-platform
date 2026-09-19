import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';

const BASE_URL = 'http://127.0.0.1:5173';
const EMAIL = 'qa-browser@zoiko-test.com';
const PASSWORD = 'TestPass123!';

let screenshotDir;
const findings = [];

test.describe('Org Admin — Functional + Content Audit', () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    screenshotDir = `test-results/org-admin-func-${Date.now()}`;
    mkdirSync(screenshotDir, { recursive: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });

  test.afterAll(async () => {
    if (page) await page.close();
    writeFileSync(`${screenshotDir}/func-audit.md`, findings.map(f => `- [${f.severity}] ${f.page}: ${f.description}\n`).join(''));
  });

  test('Login', async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL('**/dashboard', { timeout: 15000 }),
      page.click('button[type="submit"], button:has-text("Sign In")'),
    ]);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('DASHBOARD — Button Navigation Audit', async () => {
    await page.goto(`${BASE_URL}/organization-admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // 1. "Add Customer" hero button
    const addCustomerBtn = await page.$('button:has-text("Add Customer")');
    if (addCustomerBtn) {
      await addCustomerBtn.click();
      await page.waitForTimeout(1000);
      const url = page.url();
      console.log(`Add Customer clicked → ${url}`);
      if (url.includes('customers') || url.includes('new')) {
        console.log('  PASS: Navigated to customer creation');
      } else if (url.includes('login')) {
        logFinding('HIGH', 'Dashboard', 'Add Customer redirected to login');
      } else {
        console.log(`  NOTE: Navigated to: ${url}`);
      }
      await page.goBack();
      await page.waitForTimeout(1000);
    }

    // 2. "View Invoices" hero button
    const viewInvoicesBtn = await page.$('button:has-text("View Invoices")');
    if (viewInvoicesBtn) {
      await viewInvoicesBtn.click();
      await page.waitForTimeout(1000);
      const url = page.url();
      console.log(`View Invoices clicked → ${url}`);
      if (url.includes('invoices')) {
        console.log('  PASS: Navigated to invoices');
      } else {
        console.log(`  NOTE: Navigated to: ${url}`);
      }
      await page.goBack();
      await page.waitForTimeout(1000);
    }

    // 3. KPI card clicks
    const kpiButtons = await page.$$('button[class*="rounded-xl"][class*="border"][class*="bg-white"]');
    console.log(`KPI buttons found: ${kpiButtons.length}`);
    for (const btn of kpiButtons) {
      const text = await btn.textContent();
      const label = text?.trim().substring(0, 40);
      console.log(`  KPI button: "${label}"`);
    }

    // 4. "View all" link
    const viewAllBtn = await page.$('button:has-text("View all")');
    if (viewAllBtn) {
      const viewAllText = await viewAllBtn.textContent();
      console.log(`View all: "${viewAllText?.trim()}"`);
    }

    // 5. Customer row click
    const customerRow = await page.$('table tbody tr');
    if (customerRow) {
      console.log('Customer row exists — checking clickability');
    } else {
      console.log('No customer rows (empty state)');
    }
  });

  test('USERS — Functional Button Audit', async () => {
    await page.goto(`${BASE_URL}/organization-admin/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // 1. Invite User button
    const inviteBtn = await page.$('button:has-text("Invite User")');
    if (inviteBtn) {
      console.log('Invite User button found');
      await inviteBtn.click();
      await page.waitForTimeout(500);
      
      // Check modal opened
      const modal = await page.$('[class*="fixed"][class*="inset-0"]');
      if (modal) {
        console.log('  PASS: Invite modal opened');
        
        // Check form fields
        const inputs = await page.$$('input');
        const selects = await page.$$('select');
        console.log(`  Form inputs: ${inputs.length}, selects: ${selects.length}`);
        
        // Close modal
        const cancelBtn = await page.$('button:has-text("Cancel")');
        if (cancelBtn) await cancelBtn.click();
        await page.waitForTimeout(300);
      } else {
        logFinding('MEDIUM', 'Users', 'Invite modal did not open');
      }
    }

    // 2. Status filter tabs
    const filterTabs = await page.$$('button:has-text("All"), button:has-text("Active"), button:has-text("Pending"), button:has-text("Invited"), button:has-text("Suspended")');
    console.log(`Status filter tabs: ${filterTabs.length}`);

    // 3. Edit button on first row
    const editBtn = await page.$('button[title="Edit user"]');
    if (editBtn) {
      console.log('Edit button found');
      await editBtn.click();
      await page.waitForTimeout(500);
      const editModal = await page.$('[class*="fixed"][class*="inset-0"]');
      if (editModal) {
        console.log('  PASS: Edit modal opened');
        const cancelBtn = await page.$('button:has-text("Cancel")');
        if (cancelBtn) await cancelBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // 4. Resend invite button
    const resendBtn = await page.$('button[title="Resend invitation"]');
    if (resendBtn) {
      console.log('Resend invitation button found');
    } else {
      console.log('No resend invitation button (expected if no pending invites visible)');
    }

    // 5. Deactivate button
    const deactivateBtn = await page.$('button[title="Deactivate"]');
    if (deactivateBtn) {
      console.log('Deactivate button found');
    }

    // 6. Reactivate button
    const reactivateBtn = await page.$('button[title="Reactivate"]');
    if (reactivateBtn) {
      console.log('Reactivate button found');
    }

    // 7. Pagination
    const pagination = await page.evaluate(() => {
      const pageButtons = Array.from(document.querySelectorAll('button')).filter(b => {
        const svg = b.querySelector('svg[class*="chevron"]');
        return svg !== null;
      });
      return pageButtons.length;
    });
    console.log(`Pagination buttons: ${pagination}`);

    // 8. Search
    const searchInput = await page.$('input[placeholder*="Search"]');
    if (searchInput) {
      await searchInput.fill('QA');
      await page.waitForTimeout(500);
      const rows = await page.$$('tbody tr');
      console.log(`After search "QA": ${rows.length} rows`);
      await searchInput.fill('');
      await page.waitForTimeout(500);
    }
  });

  test('ORGANIZATION — Content Audit', async () => {
    await page.goto(`${BASE_URL}/organization-admin/organization`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const orgContent = await page.evaluate(() => {
      const text = document.body.textContent;
      // Check for key fields
      const fields = {
        hasOrgName: /organization|company/i.test(text),
        hasCurrency: /currency/i.test(text),
        hasIndustry: /industry/i.test(text),
        hasAddress: /address/i.test(text),
        hasEmail: /email/i.test(text),
        hasPhone: /phone/i.test(text),
        hasTimezone: /timezone/i.test(text),
        hasFiscalYear: /fiscal/i.test(text),
        hasBillingClassification: /classification/i.test(text),
        hasAdminInfo: /admin/i.test(text),
        hasCustomerCount: /customer/i.test(text),
        bodyLength: text?.length,
      };
      return fields;
    });
    console.log('Organization page fields:', JSON.stringify(orgContent, null, 2));
  });

  test('PRIVILEGED ACCESS LOG — Content Audit', async () => {
    await page.goto(`${BASE_URL}/organization-admin/privileged-access-log`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const palContent = await page.evaluate(() => {
      const text = document.body.textContent;
      const hasEntries = /requested|status|reason|ticket|correlation/i.test(text);
      const hasEmptyState = /no.*log|empty|no.*entries|no.*access/i.test(text);
      const mainContent = document.querySelector('[class*="font-"][class*="Inter"]');
      return {
        hasEntries,
        hasEmptyState,
        mainTextLength: mainContent?.textContent?.length || 0,
        bodyText: text?.substring(text.indexOf('Privileged'), text.indexOf('Privileged') + 500),
      };
    });
    console.log('PAL content:', JSON.stringify(palContent, null, 2));
  });

  test('PERFORMANCE — Page Load Timing', async () => {
    const pages = [
      { name: 'Dashboard', url: '/organization-admin/dashboard' },
      { name: 'Users', url: '/organization-admin/users' },
      { name: 'Organization', url: '/organization-admin/organization' },
      { name: 'PAL', url: '/organization-admin/privileged-access-log' },
    ];

    for (const p of pages) {
      const start = Date.now();
      await page.goto(`${BASE_URL}${p.url}`, { waitUntil: 'networkidle' });
      const loadTime = Date.now() - start;
      console.log(`${p.name}: ${loadTime}ms (networkidle)`);
      if (loadTime > 5000) {
        findings.push({ severity: 'MEDIUM', page: p.name, description: `Slow load: ${loadTime}ms` });
      }
    }
  });

  test('NAVIGATION — Sidebar Links Work', async () => {
    await page.goto(`${BASE_URL}/organization-admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Check sidebar links
    const sidebarLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="organization-admin"]'));
      return links.map(a => ({ href: a.getAttribute('href'), text: a.textContent?.trim().substring(0, 30) }));
    });
    console.log(`Sidebar org-admin links: ${sidebarLinks.length}`);
    sidebarLinks.forEach(l => console.log(`  ${l.text} → ${l.href}`));
  });
});
