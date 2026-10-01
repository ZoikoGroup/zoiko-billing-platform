import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';

const BASE_URL = 'http://127.0.0.1:5173';
const EMAIL = 'qa-browser@zoiko-test.com';
const PASSWORD = 'TestPass123!';

let screenshotDir;
const findings = [];

function logFinding(severity, page, desc) {
  findings.push({ severity, page, description: desc });
  console.log(`[${severity}] ${page}: ${desc}`);
}

test.describe('Org Admin — Deep DOM/CSS Audit', () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    screenshotDir = `test-results/org-admin-deep-${Date.now()}`;
    mkdirSync(screenshotDir, { recursive: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });

  test.afterAll(async () => {
    if (page) await page.close();
    const md = [`# Org Admin Deep DOM/CSS Audit\n\n`];
    findings.forEach(f => md.push(`- [${f.severity}] ${f.page}: ${f.description}\n`));
    writeFileSync(`${screenshotDir}/deep-audit.md`, md.join(''));
    console.log(`\nTotal findings: ${findings.length}`);
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

  test('DASHBOARD — Layout & Spacing', async () => {
    await page.goto(`${BASE_URL}/organization-admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // 1. Check sidebar-to-content gutter
    const mainContent = await page.evaluate(() => {
      const sidebar = document.querySelector('nav, [class*="sidebar"], aside');
      const main = document.querySelector('main, [class*="main"], [role="main"]');
      const body = document.body;
      
      const sidebarRect = sidebar?.getBoundingClientRect();
      const mainRect = main?.getBoundingClientRect();
      const bodyWidth = body.scrollWidth;
      const viewportWidth = window.innerWidth;
      
      return {
        hasHorizontalOverflow: bodyWidth > viewportWidth + 5,
        bodyWidth,
        viewportWidth,
        sidebarWidth: sidebarRect?.width || 0,
        mainLeft: mainRect?.left || 0,
        gap: mainRect ? mainRect.left - (sidebarRect?.right || 0) : 'unknown',
      };
    });
    
    if (mainContent.hasHorizontalOverflow) {
      logFinding('HIGH', 'Dashboard', `Horizontal overflow: body ${mainContent.bodyWidth}px > viewport ${mainContent.viewportWidth}px`);
    } else {
      console.log(`  No horizontal overflow: ${mainContent.bodyWidth}px <= ${mainContent.viewportWidth}px`);
    }
    console.log(`  Sidebar width: ${mainContent.sidebarWidth}px, Main left: ${mainContent.mainLeft}px`);

    // 2. Check KPI card alignment
    const kpiCards = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('button[class*="rounded-xl"][class*="border"]'));
      return cards.map(c => {
        const r = c.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      });
    });
    
    if (kpiCards.length >= 2) {
      const uniqueLefts = [...new Set(kpiCards.map(c => c.left))];
      if (uniqueLefts.length > 3) {
        logFinding('MEDIUM', 'Dashboard', `KPI cards have ${uniqueLefts.length} different left positions - alignment issue`);
      } else {
        console.log(`  KPI cards aligned: ${uniqueLefts.length} unique left positions`);
      }
    }

    // 3. Check heading hierarchy
    const headings = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({
        tag: h.tagName,
        text: h.textContent?.trim().substring(0, 60),
        fontSize: getComputedStyle(h).fontSize,
      }));
    });
    console.log(`  Headings: ${headings.length}`);
    headings.forEach(h => console.log(`    ${h.tag} (${h.fontSize}): ${h.text}`));

    // 4. Check for hardcoded $ in any text node
    const dollarCheck = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      const dollarTexts = [];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent;
        if (text && /\$\d/.test(text)) {
          dollarTexts.push(text.trim().substring(0, 80));
        }
      }
      return dollarTexts;
    });
    
    if (dollarCheck.length > 0) {
      logFinding('CRITICAL', 'Dashboard', `Hardcoded $ found in text nodes: ${JSON.stringify(dollarCheck)}`);
    } else {
      console.log(`  No hardcoded $ in text nodes`);
    }

    // 5. Check hero banner currency display
    const heroText = await page.evaluate(() => {
      const hero = document.querySelector('[class*="relative"][class*="flex"][class*="justify-between"]');
      return hero?.textContent?.trim().substring(0, 200) || 'hero not found';
    });
    console.log(`  Hero text: ${heroText}`);

    // 6. Check page padding
    const pagePadding = await page.evaluate(() => {
      const mainEl = document.querySelector('[class*="font-"][class*="Inter"]');
      if (!mainEl) return 'no main element found';
      const style = getComputedStyle(mainEl);
      return { paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, paddingTop: style.paddingTop };
    });
    console.log(`  Page padding: ${JSON.stringify(pagePadding)}`);

    // 7. Check if BillingShell provides the gutter (check if page adds its own)
    const duplicatePadding = await page.evaluate(() => {
      // Check if the content div has padding that duplicates BillingShell
      const contentDivs = Array.from(document.querySelectorAll('[class*="font-"][class*="Inter"]'));
      return contentDivs.map(d => ({
        classes: d.className.substring(0, 100),
        padding: getComputedStyle(d).paddingLeft,
      }));
    });
    console.log(`  Content divs with padding: ${JSON.stringify(duplicatePadding)}`);
  });

  test('DASHBOARD — Responsive @ 768px', async () => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`${BASE_URL}/organization-admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      overflow: document.body.scrollWidth > window.innerWidth + 5,
    }));
    
    if (overflow.overflow) {
      logFinding('HIGH', 'Dashboard Mobile', `Horizontal overflow at 768px: ${overflow.bodyWidth}px > ${overflow.viewportWidth}px`);
    }
    await page.screenshot({ path: `${screenshotDir}/05-dashboard-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('USERS — Layout & Spacing', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/organization-admin/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // 1. Check table alignment
    const tableInfo = await page.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return 'no table found';
      const headers = Array.from(table.querySelectorAll('th')).map(th => ({
        text: th.textContent?.trim(),
        width: th.getBoundingClientRect().width,
        textAlign: getComputedStyle(th).textAlign,
      }));
      const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr => {
        const cells = Array.from(tr.querySelectorAll('td'));
        return cells.map(td => ({
          width: td.getBoundingClientRect().width,
          textAlign: getComputedStyle(td).textAlign,
          content: td.textContent?.trim().substring(0, 40),
        }));
      });
      return { headers, rowCount: rows.length, firstRow: rows[0] };
    });
    
    console.log(`  Table headers: ${JSON.stringify(tableInfo.headers)}`);
    console.log(`  Table rows: ${tableInfo.rowCount}`);
    if (tableInfo.firstRow) {
      console.log(`  First row cells: ${JSON.stringify(tableInfo.firstRow)}`);
    }

    // 2. Check summary cards alignment
    const summaryCards = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[class*="rounded-xl"][class*="border"][class*="p-4"]'));
      return cards.map(c => {
        const r = c.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      });
    });
    console.log(`  Summary cards: ${JSON.stringify(summaryCards)}`);

    // 3. Check filter toolbar alignment
    const toolbar = await page.evaluate(() => {
      const searchInput = document.querySelector('input[placeholder*="Search"]');
      const searchRect = searchInput?.getBoundingClientRect();
      return {
        searchLeft: Math.round(searchRect?.left || 0),
        searchWidth: Math.round(searchRect?.width || 0),
      };
    });
    console.log(`  Search input: left=${toolbar.searchLeft}, width=${toolbar.searchWidth}`);

    // 4. Check status pills rendering
    const pills = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span[class*="rounded-full"]'));
      return spans.filter(s => {
        const t = s.textContent?.trim().toLowerCase();
        return ['active', 'pending', 'invited', 'deactivated', 'suspended'].includes(t);
      }).map(s => ({
        text: s.textContent?.trim(),
        bg: getComputedStyle(s).backgroundColor,
        color: getComputedStyle(s).color,
        height: s.getBoundingClientRect().height,
      }));
    });
    console.log(`  Status pills: ${JSON.stringify(pills)}`);

    // 5. Check horizontal overflow
    const overflow = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      overflow: document.body.scrollWidth > window.innerWidth + 5,
    }));
    if (overflow.overflow) {
      logFinding('HIGH', 'Users', `Horizontal overflow: ${overflow.bodyWidth}px > ${overflow.viewportWidth}px`);
    }
  });

  test('USERS — Responsive @ 768px', async () => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`${BASE_URL}/organization-admin/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      overflow: document.body.scrollWidth > window.innerWidth + 5,
    }));
    
    if (overflow.overflow) {
      logFinding('HIGH', 'Users Mobile', `Horizontal overflow at 768px: ${overflow.bodyWidth}px`);
    }
    await page.screenshot({ path: `${screenshotDir}/06-users-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('USERS — Responsive @ 390px (phone)', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/organization-admin/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      overflow: document.body.scrollWidth > window.innerWidth + 5,
    }));
    
    if (overflow.overflow) {
      logFinding('HIGH', 'Users Phone', `Horizontal overflow at 390px: ${overflow.bodyWidth}px`);
    }
    await page.screenshot({ path: `${screenshotDir}/07-users-phone.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('ORGANIZATION — Layout Check', async () => {
    await page.goto(`${BASE_URL}/organization-admin/organization`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const orgInfo = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1, h2')).map(h => h.textContent?.trim().substring(0, 60));
      const dollarCheck = (() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent && /\$\d/.test(walker.currentNode.textContent)) return true;
        }
        return false;
      })();
      const overflow = document.body.scrollWidth > window.innerWidth + 5;
      return { headings, dollarCheck, overflow, bodyWidth: document.body.scrollWidth, viewportWidth: window.innerWidth };
    });
    
    if (orgInfo.dollarCheck) {
      logFinding('CRITICAL', 'Organization', 'Hardcoded $ found');
    }
    if (orgInfo.overflow) {
      logFinding('HIGH', 'Organization', `Horizontal overflow: ${orgInfo.bodyWidth}px`);
    }
    console.log(`  Organization headings: ${JSON.stringify(orgInfo.headings)}`);
  });

  test('PRIVILEGED ACCESS LOG — Layout Check', async () => {
    await page.goto(`${BASE_URL}/organization-admin/privileged-access-log`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const palInfo = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1, h2')).map(h => h.textContent?.trim().substring(0, 60));
      const textContent = document.body.textContent?.trim().substring(0, 500);
      const overflow = document.body.scrollWidth > window.innerWidth + 5;
      return { headings, textContent, overflow, bodyWidth: document.body.scrollWidth };
    });
    
    if (palInfo.overflow) {
      logFinding('HIGH', 'Privileged Access Log', `Horizontal overflow: ${palInfo.bodyWidth}px`);
    }
    console.log(`  PAL headings: ${JSON.stringify(palInfo.headings)}`);
    console.log(`  PAL text: ${palInfo.textContent?.substring(0, 200)}`);
  });

  test('FINAL — Responsive Dashboard @ 390px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/organization-admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      overflow: document.body.scrollWidth > window.innerWidth + 5,
    }));
    if (overflow.overflow) {
      logFinding('HIGH', 'Dashboard Phone', `Horizontal overflow at 390px: ${overflow.bodyWidth}px`);
    }
    await page.screenshot({ path: `${screenshotDir}/08-dashboard-phone.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  });
});
