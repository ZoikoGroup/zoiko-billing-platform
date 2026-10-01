import { test, expect } from '@playwright/test';

// Phase 7 (Billing performance remediation) — measures real in-app SPA
// navigation performance for the highest-traffic Billing pages: sidebar
// click -> route resolved -> required API calls settled -> page usable.
// Real backend, no mocking, real login, matches existing spec conventions
// (see docs/BILLING_PERFORMANCE_REMEDIATION_REPORT.md for methodology and
// results). This file is both the initial measurement instrument and a
// repeatable regression check — rerun it any time to get a fresh
// before/after comparison against the recorded baseline in that report.

const BASE_URL = 'http://127.0.0.1:5173';
const ORG_ADMIN_EMAIL = process.env.PERF_EMAIL;
const ORG_ADMIN_PASSWORD = process.env.PERF_PASSWORD;

function summarize(entries) {
  const apiEntries = entries.filter((e) => e.isApi);
  const slowest = apiEntries.slice().sort((a, b) => b.duration - a.duration)[0];
  return {
    requestCount: apiEntries.length,
    slowest: slowest ? { url: slowest.url, duration: slowest.duration, size: slowest.size } : null,
    totalApiTime: apiEntries.reduce((sum, e) => sum + e.duration, 0),
    totalBytes: apiEntries.reduce((sum, e) => sum + (e.size || 0), 0),
  };
}

async function measureNavigation(page, act, label) {
  const entries = [];
  const inflight = new Map();

  const onRequest = (req) => {
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    inflight.set(req, Date.now());
  };
  const onResponse = async (response) => {
    const req = response.request();
    const start = inflight.get(req);
    if (start === undefined) return;
    inflight.delete(req);
    let size = 0;
    const lengthHeader = response.headers()['content-length'];
    if (lengthHeader) {
      size = parseInt(lengthHeader, 10) || 0;
    } else {
      try {
        const body = await response.body();
        size = body.length;
      } catch {
        // ignore (e.g. aborted/redirected) -- size stays 0, timing is unaffected
      }
    }
    entries.push({
      url: req.url().replace(BASE_URL, ''),
      duration: Date.now() - start,
      size,
      // Backend calls hit the API origin (localhost:8001); billing-domain
      // endpoints are NOT under a literal "/api/" path segment (e.g.
      // "/billing/customers"), so match by origin, not by substring.
      isApi: req.url().startsWith('http://localhost:8001'),
    });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  const t0 = Date.now();
  await act();
  const tUsable = Date.now();
  // Let any trailing requests still in flight at the "usable" instant settle
  // so their duration/size is captured, without extending the reported
  // navigation time itself.
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  page.off('request', onRequest);
  page.off('response', onResponse);

  const nav = tUsable - t0;
  const summary = summarize(entries);
  console.log(
    `PERF ${label} | nav=${nav}ms | apiCalls=${summary.requestCount} | ` +
    `totalApiTime=${summary.totalApiTime}ms | totalBytes=${summary.totalBytes} | ` +
    `slowest=${summary.slowest ? `${summary.slowest.url} (${summary.slowest.duration}ms, ${summary.slowest.size}B)` : 'n/a'}`
  );
  for (const e of entries.filter((e) => e.isApi)) {
    console.log(`  - ${e.url} :: ${e.duration}ms :: ${e.size}B`);
  }
  return { label, nav, ...summary, entries: entries.filter((e) => e.isApi) };
}

async function openSidebarSection(page, sectionLabel) {
  // .count()/.isVisible() read the DOM synchronously with no retry, so
  // checking immediately after a navigation (before React has committed the
  // sidebar render) can see a false "not found". waitFor() actually
  // auto-waits/retries, so wait for the exact section header first.
  const button = page.getByRole('button', { name: sectionLabel, exact: true });
  await button.waitFor({ state: 'visible', timeout: 10000 });
  const expanded = await button.getAttribute('aria-expanded');
  if (expanded !== 'true') await button.click();
}

// Each test gets Playwright's default fresh page/context (not shared across
// tests) and logs in itself before measuring. This costs one extra login
// per page (~0.7s, logged separately and excluded from the page's own
// navigation number) but keeps each measurement's browser memory footprint
// independent — this sandbox has ~1-1.5GB free RAM, and a single
// long-lived page accumulating 10+ navigations' worth of DOM/JS state was
// observed to crash the renderer partway through a run using one shared page.
async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', ORG_ADMIN_EMAIL);
  await page.fill('input[type="password"]', ORG_ADMIN_PASSWORD);
  const t0 = Date.now();
  await Promise.all([
    page.waitForURL(/\/dashboard|\/billing/, { timeout: 15000 }),
    page.click('button:has-text("Sign In")'),
  ]);
  // Wait for the landing page's own data fetch to actually finish (its
  // greeting only renders once loading=false), not just for a quiet network
  // window -- otherwise a same-page request that started a moment too late
  // can still be in flight when the *next* test's measurement window opens
  // and gets misattributed to it.
  await page.getByText(/Good (morning|afternoon|evening)/).first().waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`PERF login-to-dashboard | nav=${Date.now() - t0}ms`);
}

test.describe('Billing performance audit (real backend)', () => {
  test.skip(!ORG_ADMIN_EMAIL || !ORG_ADMIN_PASSWORD, 'PERF_EMAIL / PERF_PASSWORD not set.');

  test('Dashboard', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Overview');
      // Two links share the accessible name "Dashboard" for org_admin (the
      // workspace-level "/organization-admin/dashboard" link plus this
      // section's own "/billing" link) -- target by href to disambiguate.
      await page.locator('a[href="/billing"]', { hasText: 'Dashboard' }).click();
      await expect(page.getByText(/dashboard/i).first()).toBeVisible();
    }, 'Dashboard');
  });

  test('Customers list', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Customers');
      await page.getByRole('link', { name: 'Customer List', exact: true }).click();
      await expect(page.getByRole('button', { name: /new customer/i })).toBeVisible();
    }, 'Customers');
  });

  test('Customer Profile (detail)', async ({ page }) => {
    await login(page);
    await openSidebarSection(page, 'Customers');
    await page.getByRole('link', { name: 'Customer List', exact: true }).click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await measureNavigation(page, async () => {
      const row = page.locator('table tbody tr').first();
      const resp = page.waitForResponse(
        (r) => r.url().startsWith('http://localhost:8001') && /\/billing\/customers\/\d+$/.test(new URL(r.url()).pathname),
        { timeout: 10000 }
      ).catch(() => {});
      await row.click();
      await expect(page).toHaveURL(/\/billing\/customers\/\d+/);
      await resp;
    }, 'Customer Profile');
  });

  test('Products list', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Products');
      await page.getByRole('link', { name: 'Product List', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Add Product', exact: true })).toBeVisible();
    }, 'Products');
  });

  // These pages' own SPA-navigation resolves as soon as the URL changes,
  // before the lazy chunk finishes loading or the page's own list data has
  // arrived -- so waiting only on the URL understates real "usable" time.
  // Wait for the actual list-data response as the "usable" signal instead.
  function waitForListResponse(page, pathFragment) {
    return page.waitForResponse(
      (r) => r.url().startsWith('http://localhost:8001') && r.url().includes(pathFragment),
      { timeout: 10000 }
    ).catch(() => {});
  }

  test('Pricing', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Pricing');
      const resp = waitForListResponse(page, '/billing/pricing-plans');
      await page.getByRole('link', { name: 'Pricing Plans', exact: true }).click();
      await resp;
      await expect(page).toHaveURL(/\/billing\/pricing$/);
    }, 'Pricing');
  });

  test('Quotations list', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Quotations');
      const resp = waitForListResponse(page, '/billing/quotations');
      await page.getByRole('link', { name: 'Quotation List', exact: true }).click();
      await resp;
      await expect(page).toHaveURL(/\/billing\/quotations$/);
    }, 'Quotations');
  });

  test('Contracts list', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Contracts');
      const resp = waitForListResponse(page, '/billing/contracts');
      await page.getByRole('link', { name: 'Contract List', exact: true }).click();
      await resp;
      await expect(page).toHaveURL(/\/billing\/contracts$/);
    }, 'Contracts');
  });

  test('Subscriptions list', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Subscriptions');
      const resp = waitForListResponse(page, '/billing/subscriptions');
      await page.getByRole('link', { name: 'Subscription List', exact: true }).click();
      await resp;
      await expect(page).toHaveURL(/\/billing\/subscriptions$/);
    }, 'Subscriptions');
  });

  test('Invoices list', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Invoicing');
      const resp = waitForListResponse(page, '/billing/invoices');
      await page.getByRole('link', { name: 'Invoice List', exact: true }).click();
      await resp;
      await expect(page).toHaveURL(/\/billing\/invoices$/);
    }, 'Invoices');
  });

  test('Payments list', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Payments');
      const resp = waitForListResponse(page, '/billing/payments');
      await page.getByRole('link', { name: 'Payment List', exact: true }).click();
      await resp;
      await expect(page).toHaveURL(/\/billing\/payments$/);
    }, 'Payments');
  });

  test('Reports', async ({ page }) => {
    await login(page);
    await measureNavigation(page, async () => {
      await openSidebarSection(page, 'Overview');
      const resp = waitForListResponse(page, '/billing/payments');
      await page.getByRole('link', { name: 'Reports', exact: true }).click();
      await expect(page).toHaveURL(/\/billing\/reports$/);
      await resp;
    }, 'Reports');
  });
});
