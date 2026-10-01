import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';

const BASE_URL = 'http://127.0.0.1:5173';
const API_URL = 'http://127.0.0.1:8001';
const EMAIL = 'qa-browser@zoiko-test.com';
const PASSWORD = 'TestPass123!';

const report = {
  consoleErrors: [],
  networkErrors: [],
  apiCalls: [],
  findings: [],
};

let screenshotDir;

test.describe('Org Admin — Live Browser Audit', () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    screenshotDir = `test-results/org-admin-audit-${Date.now()}`;
    mkdirSync(screenshotDir, { recursive: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    page.on('console', msg => {
      if (msg.type() === 'error') {
        report.consoleErrors.push(`[error] ${msg.text()}`);
      }
    });

    page.on('response', response => {
      const url = response.url();
      const status = response.status();
      if (url.includes('/api/')) {
        report.apiCalls.push({ url, status, method: response.request().method() });
        if (status >= 400) {
          report.networkErrors.push({ url, status, method: response.request().method() });
        }
      }
    });
  });

  test.afterAll(async () => {
    if (page) await page.close();
    const md = [`# Org Admin Browser Audit\n\n`, `## Console Errors\n`];
    report.consoleErrors.forEach(e => md.push(`- ${e}\n`));
    md.push(`\n## Network Errors\n`);
    report.networkErrors.forEach(e => md.push(`- ${e.method} ${e.url} → ${e.status}\n`));
    md.push(`\n## API Calls\n`);
    report.apiCalls.forEach(e => md.push(`- ${e.method} ${e.url} → ${e.status}\n`));
    md.push(`\n## Findings\n`);
    report.findings.forEach(f => md.push(`- [${f.severity}] ${f.page}: ${f.description}\n`));
    writeFileSync(`${screenshotDir}/audit-report.md`, md.join(''));
  });

  test('Login', async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${screenshotDir}/00-login.png`, fullPage: true });

    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);

    await Promise.all([
      page.waitForURL('**/dashboard', { timeout: 15000 }),
      page.click('button[type="submit"], button:has-text("Sign In")'),
    ]);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('dashboard');
  });

  test('Dashboard — Full Page Screenshot', async () => {
    await page.goto(`${BASE_URL}/organization-admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${screenshotDir}/01-dashboard-full.png`, fullPage: true });

    const h1 = await page.$eval('h1', el => el.textContent).catch(() => '');
    console.log(`Dashboard heading: "${h1}"`);

    // Check for KPIs
    const kpiTexts = await page.$$eval('[class*="rounded-xl"][class*="border"]', els =>
      els.map(el => el.textContent?.trim().substring(0, 100))
    );
    console.log(`KPI cards found: ${kpiTexts.length}`);
    kpiTexts.forEach(t => console.log(`  KPI: ${t}`));
  });

  test('Dashboard — Check for currency display', async () => {
    const body = await page.textContent('body');
    const hasHardcodedDollar = /\$\d/.test(body) && !body.includes('₹') && !body.includes('€') && !body.includes('£');
    if (hasHardcodedDollar) {
      report.findings.push({ severity: 'CRITICAL', page: 'Dashboard', description: 'Hardcoded $ found in page content' });
    }
    console.log(`Hardcoded $ detected: ${hasHardcodedDollar}`);

    // Check for currency symbols
    const currencies = ['₹', '$', '€', '£'];
    currencies.forEach(c => {
      if (body.includes(c)) console.log(`  Currency symbol found: ${c}`);
    });
  });

  test('User Management — Full Page Screenshot', async () => {
    await page.goto(`${BASE_URL}/organization-admin/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${screenshotDir}/02-users-full.png`, fullPage: true });

    // Get all status pills
    const statusPills = await page.$$eval('span', els =>
      els.filter(el => {
        const t = el.textContent?.trim().toLowerCase();
        return t === 'active' || t === 'pending' || t === 'invited' || t === 'deactivated' || t === 'suspended';
      }).map(el => el.textContent?.trim())
    );
    console.log(`Status pills found: ${JSON.stringify(statusPills)}`);

    // Get all user rows
    const userRows = await page.$$eval('tr', rows =>
      rows.filter(r => r.querySelector('td')).map(r => r.textContent?.trim().substring(0, 120))
    );
    console.log(`User rows: ${userRows.length}`);
    userRows.forEach(r => console.log(`  Row: ${r}`));
  });

  test('User Management — Check status correctness', async () => {
    // Expected: qa-browser (active), invited-ba (invited), deactivated (deactivated), finance (active)
    const bodyText = await page.textContent('body');
    
    // Check if "Pending" is incorrectly shown for active users
    const pendingCount = (bodyText.match(/\bPending\b/g) || []).length;
    const activeCount = (bodyText.match(/\bActive\b/g) || []).length;
    const invitedCount = (bodyText.match(/\bInvited\b/g) || []).length;
    const deactivatedCount = (bodyText.match(/\bDeactivated\b/g) || []).length;
    
    console.log(`Status counts - Active: ${activeCount}, Pending: ${pendingCount}, Invited: ${invitedCount}, Deactivated: ${deactivatedCount}`);
    
    if (pendingCount > 0) {
      report.findings.push({ severity: 'CRITICAL', page: 'Users', description: `Found ${pendingCount} "Pending" labels - should be Active/Invited/Deactivated` });
    }
  });

  test('User Management — Check summary cards', async () => {
    const summaryCards = await page.$$eval('div[class*="rounded-xl"][class*="border"][class*="p-4"]', els =>
      els.map(el => el.textContent?.trim().substring(0, 80))
    );
    console.log(`Summary cards: ${summaryCards.length}`);
    summaryCards.forEach(c => console.log(`  Card: ${c}`));
  });

  test('My Organization — Full Page Screenshot', async () => {
    await page.goto(`${BASE_URL}/organization-admin/organization`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${screenshotDir}/03-organization-full.png`, fullPage: true });
    
    const bodyText = await page.textContent('body');
    console.log(`Organization page length: ${bodyText?.length}`);
  });

  test('Privileged Access Log — Full Page Screenshot', async () => {
    await page.goto(`${BASE_URL}/organization-admin/privileged-access-log`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${screenshotDir}/04-privileged-access-log-full.png`, fullPage: true });
    
    const bodyText = await page.textContent('body');
    console.log(`Privileged Access Log page length: ${bodyText?.length}`);
  });

  test('Dashboard — Console Errors Summary', async () => {
    console.log(`\n=== CONSOLE ERRORS: ${report.consoleErrors.length} ===`);
    report.consoleErrors.forEach(e => console.log(e));
    
    console.log(`\n=== NETWORK ERRORS: ${report.networkErrors.length} ===`);
    report.networkErrors.forEach(e => console.log(`  ${e.method} ${e.url} → ${e.status}`));
    
    console.log(`\n=== API CALLS: ${report.apiCalls.length} ===`);
    report.apiCalls.forEach(e => console.log(`  ${e.method} ${e.url} → ${e.status}`));
  });
});
