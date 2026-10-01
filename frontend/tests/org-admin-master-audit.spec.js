import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';

const BASE = 'http://127.0.0.1:5173';
const QA_EMAIL = 'qa-browser@zoiko-test.com';
const QA_PASS = 'TestPass123!';

let dir;
const findings = [];
const performance = [];
const consoleErrors = [];
const networkErrors = [];

function logFinding(severity, page, description) {
  findings.push({ severity, page, description });
  console.log(`[${severity}] ${page}: ${description}`);
}

test.describe('MASTER PROMPT — Full Org Admin Audit', () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    dir = `test-results/master-audit-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));
    page.on('requestfailed', (req) => {
      networkErrors.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText || 'failed'}`);
    });
  });

  test.afterAll(async () => {
    if (page) await page.close();
    writeFileSync(`${dir}/audit-findings.json`, JSON.stringify({
      findings, performance, consoleErrors, networkErrors
    }, null, 2));
  });

  async function gotoPage(path, opts = {}) {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);
        return;
      } catch (e) {
        console.log(`gotoPage attempt ${attempt + 1} failed: ${e.message.substring(0, 80)}`);
        if (attempt < 2) await page.waitForTimeout(3000);
      }
    }
  }

  async function login() {
    await gotoPage('/login');
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.fill('input[type="email"]', QA_EMAIL);
    await page.fill('input[type="password"]', QA_PASS);
    await page.click('button[type="submit"], button:has-text("Sign In")');
    try {
      await page.waitForURL('**/organization-admin/dashboard', { timeout: 15000 });
    } catch {
      await page.waitForURL('**/organization-admin/**', { timeout: 10000 });
    }
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    console.log('Logged in successfully');
  }

  async function navigateViaSidebar(linkText) {
    const hrefMap = {
      'My Organization': '/organization-admin/organization',
      'Privileged Access Log': '/organization-admin/privileged-access-log',
      'User Management': '/organization-admin/users',
      'Dashboard': '/organization-admin/dashboard',
    };
    const href = hrefMap[linkText];
    let link = null;
    // Try role-based selector first (most reliable for React Router NavLink)
    try {
      link = await page.getByRole('link', { name: linkText }).first().elementHandle({ timeout: 3000 });
    } catch {
      // fallback: aside-based
      try {
        link = await page.$(`aside a:has-text("${linkText}")`);
      } catch {
        // last resort: any anchor
        link = await page.$(`a:has-text("${linkText}")`);
      }
    }
    if (link) {
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await page.waitForTimeout(2000);
      return true;
    }
    console.log(`FATAL: Could not find sidebar link "${linkText}"`);
    return false;
  }

  async function ensureLoggedIn() {
    const url = page.url();
    if (!url.includes('organization-admin') || url.includes('login')) {
      await login();
    }
  }

  // ── LOGIN ──
  test('01 — Login as QA org_admin', async () => {
    await login();
  });

  // ── DASHBOARD: Full audit ──
  test('02 — DASHBOARD: Full audit', async () => {
    const start = Date.now();
    await gotoPage('/organization-admin/dashboard');
    const loadTime = Date.now() - start;
    performance.push({ page: 'Dashboard', loadTimeMs: loadTime });
    await page.screenshot({ path: `${dir}/02-dashboard.png`, fullPage: true });

    const headings = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll('h1, h2, h3'));
      return hs.map(h => ({
        tag: h.tagName,
        text: h.textContent?.trim().substring(0, 60),
        fontSize: getComputedStyle(h).fontSize,
        fontWeight: getComputedStyle(h).fontWeight,
      }));
    });
    console.log('Dashboard headings:', JSON.stringify(headings, null, 2));

    const hero = await page.evaluate(() => {
      const heroEl = document.querySelector('[style*="linear-gradient"][style*="0B1220"]');
      if (!heroEl) return { found: false };
      const text = heroEl.textContent;
      return {
        found: true,
        hasCurrency: /[$€£₹]/.test(text),
        hasHardcodedDollar: /\$\d/.test(text),
        text: text?.substring(0, 300),
      };
    });
    console.log('Hero:', JSON.stringify(hero, null, 2));
    if (hero.hasHardcodedDollar) logFinding('CRITICAL', 'Dashboard', 'Hardcoded $ in hero section');

    const kpiCards = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[class*="rounded-xl"][class*="border"]'));
      return buttons.map(b => ({
        text: b.textContent?.trim().substring(0, 60),
        left: b.getBoundingClientRect().left,
        width: b.getBoundingClientRect().width,
      }));
    });
    console.log(`KPI cards found: ${kpiCards.length}`);
    kpiCards.forEach(k => console.log(`  Card: "${k.text}" left=${k.left} width=${k.width}`));

    const recentSection = await page.evaluate(() => {
      const table = document.querySelector('table');
      const rows = table ? Array.from(table.querySelectorAll('tbody tr')) : [];
      const emptyState = document.querySelector('[class*="text-center"] p');
      return {
        hasTable: !!table,
        rowCount: rows.length,
        hasEmptyState: !!emptyState,
        emptyText: emptyState?.textContent?.substring(0, 100),
      };
    });
    console.log('Recent Customers:', JSON.stringify(recentSection, null, 2));

    const currencies = await page.evaluate(() => {
      const body = document.body.textContent;
      const matches = body.match(/[$€£₹]\s*[\d,]+\.?\d*/g) || [];
      const hardcodedDollar = body.match(/\$\d/g) || [];
      return { matches, hardcodedDollarCount: hardcodedDollar.length };
    });
    console.log('Currency matches:', JSON.stringify(currencies, null, 2));
    if (currencies.hardcodedDollarCount > 0) {
      logFinding('CRITICAL', 'Dashboard', `Found ${currencies.hardcodedDollarCount} hardcoded $ patterns`);
    }

    const padding = await page.evaluate(() => {
      const pageContent = document.querySelector('.font-\\[\\\'Inter\\\'');
      return {
        paddingLeft: pageContent ? getComputedStyle(pageContent).paddingLeft : 'N/A',
        paddingRight: pageContent ? getComputedStyle(pageContent).paddingRight : 'N/A',
      };
    });
    console.log('Page padding:', JSON.stringify(padding, null, 2));

    const overflow = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      viewWidth: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    console.log('Overflow:', JSON.stringify(overflow, null, 2));
    if (overflow.overflow) logFinding('HIGH', 'Dashboard', `Horizontal overflow: doc=${overflow.docWidth} > view=${overflow.viewWidth}`);

    const gutter = await page.evaluate(() => {
      const sidebar = document.querySelector('nav') || document.querySelector('[class*="sidebar"]') || document.querySelector('aside');
      const main = document.querySelector('main') || document.querySelector('[class*="main"]');
      return {
        sidebarWidth: sidebar?.getBoundingClientRect().width || 'N/A',
        mainLeft: main?.getBoundingClientRect().left || 'N/A',
        gap: main && sidebar ? main.getBoundingClientRect().left - sidebar.getBoundingClientRect().width : 'N/A',
      };
    });
    console.log('Gutter:', JSON.stringify(gutter, null, 2));
  });

  // ── DASHBOARD: Responsive — resize viewport only, no re-navigation ──
  test('03 — DASHBOARD: Responsive @ 768px', async () => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/03-dashboard-768.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`Dashboard 768px overflow: ${overflow}`);
    if (overflow) logFinding('HIGH', 'Dashboard', 'Horizontal overflow at 768px');
  });

  test('04 — DASHBOARD: Responsive @ 390px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/04-dashboard-390.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`Dashboard 390px overflow: ${overflow}`);
    if (overflow) logFinding('HIGH', 'Dashboard', 'Horizontal overflow at 390px');
  });

  // ── Reset viewport ──
  test('05 — Reset viewport to 1440', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
  });

  // ── USER MANAGEMENT: Full audit ──
  test('06 — USER MANAGEMENT: Full audit', async () => {
    const start = Date.now();
    await gotoPage('/organization-admin/users');
    const loadTime = Date.now() - start;
    performance.push({ page: 'User Management', loadTimeMs: loadTime });
    await page.screenshot({ path: `${dir}/06-users.png`, fullPage: true });

    const statusTrace = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tbody tr'));
      return rows.map(r => {
        const cells = Array.from(r.querySelectorAll('td'));
        const name = cells[0]?.textContent?.trim().substring(0, 30);
        const role = cells[1]?.textContent?.trim();
        const statusEl = cells[2]?.querySelector('span');
        const pillText = statusEl?.textContent?.trim();
        const pillBg = statusEl ? getComputedStyle(statusEl).backgroundColor : 'N/A';
        const lastActive = cells[3]?.textContent?.trim();
        return { name, role, pillText, pillBg, lastActive };
      });
    });
    console.log('Status trace:', JSON.stringify(statusTrace, null, 2));

    const summary = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[class*="rounded-xl"][class*="border"]'));
      const summaryCards = cards.filter(c => /Total|Active|Invited|Suspended/.test(c.textContent));
      return summaryCards.map(c => ({
        text: c.textContent?.trim().substring(0, 40),
        width: c.getBoundingClientRect().width,
        left: c.getBoundingClientRect().left,
      }));
    });
    console.log('Summary cards:', JSON.stringify(summary, null, 2));

    const tableHeaders = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('th'));
      return ths.map(th => ({
        text: th.textContent?.trim(),
        left: th.getBoundingClientRect().left,
        textAlign: getComputedStyle(th).textAlign,
      }));
    });
    console.log('Table headers:', JSON.stringify(tableHeaders, null, 2));

    const inviteBtn = await page.$('button:has-text("Invite User")');
    console.log(`Invite button found: ${!!inviteBtn}`);
    if (inviteBtn) {
      await inviteBtn.click();
      await page.waitForTimeout(500);
      const modal = await page.$('[class*="fixed"][class*="inset-0"]');
      console.log(`Invite modal opened: ${!!modal}`);
      if (modal) {
        const formFields = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
          const selects = Array.from(document.querySelectorAll('select'));
          return { inputs: inputs.length, selects: selects.length };
        });
        console.log('Invite form:', JSON.stringify(formFields, null, 2));
        await page.screenshot({ path: `${dir}/06b-invite-modal.png`, fullPage: true });
        const cancel = await page.$('button:has-text("Cancel")');
        if (cancel) await cancel.click();
        await page.waitForTimeout(300);
      }
    }

    const editBtn = await page.$('button[title="Edit user"]');
    console.log(`Edit button found: ${!!editBtn}`);
    if (editBtn) {
      await editBtn.click();
      await page.waitForTimeout(500);
      const modal = await page.$('[class*="fixed"][class*="inset-0"]');
      console.log(`Edit modal opened: ${!!modal}`);
      if (modal) {
        await page.screenshot({ path: `${dir}/06c-edit-modal.png`, fullPage: true });
        const cancel = await page.$('button:has-text("Cancel")');
        if (cancel) await cancel.click();
        await page.waitForTimeout(300);
      }
    }

    const deactivateBtn = await page.$('button[title="Deactivate"]');
    console.log(`Deactivate button found: ${!!deactivateBtn}`);

    const reactivateBtn = await page.$('button[title="Reactivate"]');
    console.log(`Reactivate button found: ${!!reactivateBtn}`);

    const resendBtn = await page.$('button[title="Resend invitation"]');
    console.log(`Resend invitation button found: ${!!resendBtn}`);

    const searchInput = await page.$('input[placeholder*="Search"]');
    if (searchInput) {
      await searchInput.fill('QA');
      await page.waitForTimeout(600);
      const rowsAfterSearch = await page.$$('tbody tr');
      console.log(`After search "QA": ${rowsAfterSearch.length} rows`);
      await searchInput.fill('');
      await page.waitForTimeout(600);
    }

    const filterTabs = await page.$$('button:has-text("All"), button:has-text("Active"), button:has-text("Pending"), button:has-text("Invited"), button:has-text("Suspended")');
    console.log(`Status filter tabs: ${filterTabs.length}`);

    const pagination = await page.evaluate(() => {
      const pageLabel = Array.from(document.querySelectorAll('span')).find(s => /\d+ \/ \d+/.test(s.textContent));
      return pageLabel?.textContent?.trim() || 'N/A';
    });
    console.log(`Pagination: ${pagination}`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`Users overflow: ${overflow}`);
    if (overflow) logFinding('HIGH', 'Users', 'Horizontal overflow');
  });

  // ── USER MANAGEMENT: Responsive — viewport-only ──
  test('07 — USER MANAGEMENT: Responsive @ 768px', async () => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/07-users-768.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`Users 768px overflow: ${overflow}`);
  });

  test('08 — USER MANAGEMENT: Responsive @ 390px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/08-users-390.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`Users 390px overflow: ${overflow}`);
  });

  test('09 — Reset viewport', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
  });

  // ── MY ORGANIZATION ──
  test('10 — MY ORGANIZATION: Full audit', async () => {
    let navOk = await navigateViaSidebar('My Organization');
    if (!navOk || !page.url().includes('/organization')) {
      console.log('Sidebar nav to Org failed, using direct navigation...');
      await gotoPage('/organization-admin/organization');
    }
    const start = Date.now();
    await page.waitForTimeout(500);
    performance.push({ page: 'My Organization', loadTimeMs: Date.now() - start });
    await page.screenshot({ path: `${dir}/10-organization.png`, fullPage: true });

    const orgData = await page.evaluate(() => {
      const text = document.body.textContent;
      const editBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Edit'));
      return {
        hasCurrency: /currency/i.test(text),
        hasHardcodedDollar: /\$\d/.test(text),
        hasIndustry: /industry/i.test(text),
        hasAddress: /address/i.test(text),
        hasTimezone: /timezone/i.test(text),
        hasEditButton: editBtns.length > 0,
        bodyLength: text?.length,
        url: window.location.href,
        snippet: text?.substring(0, 300),
      };
    });
    console.log('Org page:', JSON.stringify(orgData, null, 2));

    if (!orgData.url.includes('/organization')) {
      logFinding('CRITICAL', 'Org', `Navigated to ${orgData.url} instead of /organization-admin/organization`);
    }

    // Test Edit button — wait for page content to fully render
    try {
      await page.waitForSelector('button:has-text("Edit")', { timeout: 5000 });
    } catch {
      console.log('Edit button not found after 5s wait');
    }
    const editBtn = await page.$('button:has-text("Edit")');
    if (editBtn) {
      await editBtn.click();
      await page.waitForTimeout(1000);
      const modal = await page.$('[class*="fixed"][class*="inset-0"], .glass.modal, [class*="modal"]');
      console.log(`Edit org modal opened: ${!!modal}`);
      await page.screenshot({ path: `${dir}/10b-edit-org-modal.png`, fullPage: true });
      const cancel = await page.$('button:has-text("Cancel")');
      if (cancel) await cancel.click();
      await page.waitForTimeout(300);
    } else {
      console.log('WARNING: Edit button not found on Organization page');
      logFinding('MEDIUM', 'Org', 'Edit button not found');
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`Org overflow: ${overflow}`);
    if (overflow) logFinding('HIGH', 'Org', 'Horizontal overflow');
  });

  // ── PRIVILEGED ACCESS LOG ──
  test('11 — PRIVILEGED ACCESS LOG: Full audit', async () => {
    let navOk = await navigateViaSidebar('Privileged Access Log');
    if (!navOk || !page.url().includes('/privileged-access-log')) {
      console.log('Sidebar nav to PAL failed, using direct navigation...');
      await gotoPage('/organization-admin/privileged-access-log');
    }
    const start = Date.now();
    await page.waitForTimeout(500);
    performance.push({ page: 'Privileged Access Log', loadTimeMs: Date.now() - start });
    await page.screenshot({ path: `${dir}/11-pal.png`, fullPage: true });

    const palData = await page.evaluate(() => {
      const text = document.body.textContent;
      return {
        hasEmptyState: /no.*log|no.*access|no.*entries|no support/i.test(text),
        hasDescription: /time-boxed|read-only|record/i.test(text),
        hasEntries: /requested|reason|ticket|correlation/i.test(text),
        bodyLength: text?.length,
        url: window.location.href,
        snippet: text?.substring(0, 300),
      };
    });
    console.log('PAL page:', JSON.stringify(palData, null, 2));

    if (!palData.url.includes('/privileged-access-log')) {
      logFinding('CRITICAL', 'PAL', `Navigated to ${palData.url} instead of /privileged-access-log`);
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`PAL overflow: ${overflow}`);
    if (overflow) logFinding('HIGH', 'PAL', 'Horizontal overflow');
  });

  // ── CONSOLE + NETWORK AUDIT ──
  test('12 — CONSOLE + NETWORK audit', async () => {
    console.log(`\nConsole errors: ${consoleErrors.length}`);
    consoleErrors.forEach(e => console.log(`  ERROR: ${e}`));
    console.log(`\nNetwork errors: ${networkErrors.length}`);
    networkErrors.forEach(e => console.log(`  FAILED: ${e}`));
    if (consoleErrors.length > 0) logFinding('HIGH', 'Console', `${consoleErrors.length} console errors`);
    if (networkErrors.length > 0) logFinding('HIGH', 'Network', `${networkErrors.length} network errors`);
  });

  // ── SIDEBAR NAVIGATION AUDIT ──
  test('13 — SIDEBAR NAVIGATION audit', async () => {
    await gotoPage('/organization-admin/dashboard');
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="organization-admin"]'));
      return anchors.map(a => ({
        href: a.getAttribute('href'),
        text: a.textContent?.trim().substring(0, 30),
        visible: a.getBoundingClientRect().width > 0,
      }));
    });
    console.log('Sidebar links:', JSON.stringify(links, null, 2));

    for (const link of links) {
      if (link.href && link.visible) {
        await gotoPage(link.href);
        const url = page.url();
        const ok = url.includes(link.href);
        console.log(`  ${link.text} → ${url} ${ok ? '✓' : '✗'}`);
        if (!ok) logFinding('HIGH', 'Navigation', `Sidebar link "${link.text}" navigated to ${url} instead of ${link.href}`);
      }
    }
  });

  // ── PERFORMANCE SUMMARY ──
  test('14 — PERFORMANCE summary', async () => {
    console.log('\nPerformance measurements:');
    performance.forEach(p => {
      console.log(`  ${p.page}: ${p.loadTimeMs}ms`);
      if (p.loadTimeMs > 5000) logFinding('MEDIUM', 'Performance', `${p.page} loaded in ${p.loadTimeMs}ms (>5s)`);
    });
  });

  // ── FINDINGS SUMMARY ──
  test('15 — FINDINGS summary', async () => {
    console.log('\n=== FINDINGS ===');
    if (findings.length === 0) {
      console.log('No issues found!');
    } else {
      findings.forEach(f => console.log(`[${f.severity}] ${f.page}: ${f.description}`));
    }
    console.log(`\nTotal findings: ${findings.length}`);
    console.log(`Console errors: ${consoleErrors.length}`);
    console.log(`Network errors: ${networkErrors.length}`);
  });
});
