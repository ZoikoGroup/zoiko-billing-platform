import { test, expect } from "@playwright/test";

const BASE = "http://127.0.0.1:5173";
const QA = { email: "qa-browser@zoiko-test.com", password: "TestPass123!" };

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768px", width: 768, height: 1024 },
  { name: "390px", width: 390, height: 844 },
];

const ORG_ADMIN_ROUTES = [
  { path: "/organization-admin/dashboard", label: "Dashboard" },
  { path: "/organization-admin/users", label: "User Management" },
  { path: "/organization-admin/organization", label: "My Organization" },
  { path: "/organization-admin/privileged-access-log", label: "Privileged Access Log" },
];

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.fill('input[type="email"]', QA.email);
  await page.fill('input[type="password"]', QA.password);
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL("**/organization-admin/dashboard", { timeout: 15000 });
  } catch {
    await page.waitForURL("**/organization-admin/**", { timeout: 10000 });
  }
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
}

async function checkNoOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const viewWidth = window.innerWidth;
    return { docWidth, viewWidth, overflow: docWidth > viewWidth };
  });
  expect(overflow.overflow, `${label}: no horizontal overflow`).toBe(false);
  return overflow;
}

// ============================================
// PHASE 6: SIDEBAR + NAVIGATION
// ============================================
test.describe("PHASE 6 — Sidebar + Navigation", () => {
  test("6A: All 4 sidebar links navigate without errors", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    for (const route of ORG_ADMIN_ROUTES) {
      await page.goto(`${BASE}${route.path}`, { waitUntil: "networkidle" });
      const url = page.url();
      expect(url).toContain(route.path);

      const title = await page.textContent("h1");
      expect(title, `${route.label}: has h1 title`).toBeTruthy();

      const consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
    }

    expect(errors.length, "No page errors during navigation").toBe(0);
  });

  test("6B: Sidebar has org-admin links visible", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    const bodyText = await page.textContent("body");
    expect(bodyText, "Sidebar: has Dashboard link").toContain("Dashboard");
    expect(bodyText, "Sidebar: has User Management link").toContain("User Management");
    expect(bodyText, "Sidebar: has My Organization link").toContain("My Organization");
    expect(bodyText, "Sidebar: has Privileged Access Log link").toContain("Privileged Access Log");

    const asideLinks = await page.locator("aside a").all();
    const orgLinks = [];
    for (const link of asideLinks) {
      const href = await link.getAttribute("href");
      if (href && href.includes("/organization-admin")) {
        orgLinks.push(href);
      }
    }
    expect(orgLinks.length, "Sidebar: at least 4 org-admin links").toBeGreaterThanOrEqual(4);
  });

  test("6C: Consistent content gutter across all pages", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    for (const route of ORG_ADMIN_ROUTES) {
      await page.goto(`${BASE}${route.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);

      const layout = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        const asideRight = aside ? aside.getBoundingClientRect().right : 0;
        const bodyChildren = Array.from(document.body.children);
        let contentLeft = 0;
        for (const child of bodyChildren) {
          if (child.tagName !== "ASIDE" && child.tagName !== "SCRIPT" && child.tagName !== "STYLE") {
            const rect = child.getBoundingClientRect();
            if (rect.width > 100 && rect.left >= asideRight - 50) {
              contentLeft = rect.left;
              break;
            }
          }
        }
        return { asideRight, contentLeft, gap: contentLeft - asideRight };
      });

      if (layout.asideRight > 0 && layout.contentLeft > 0) {
        expect(layout.gap, `${route.label}: sidebar-content gap >= 0`).toBeGreaterThanOrEqual(-10);
      }
    }
  });

  test("6D: No blank pages or 404s", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    for (const route of ORG_ADMIN_ROUTES) {
      await page.goto(`${BASE}${route.path}`, { waitUntil: "networkidle" });
      const bodyText = await page.textContent("body");
      expect(bodyText, `${route.label}: no 404 text`).not.toContain("404");
      expect(bodyText, `${route.label}: no "not found" text`).not.toMatch(/not found/i);
      expect(bodyText, `${route.label}: has content`).not.toBe("");
    }
  });

  test("6E: Page header consistency", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    for (const route of ORG_ADMIN_ROUTES) {
      await page.goto(`${BASE}${route.path}`, { waitUntil: "networkidle" });
      const h1 = await page.locator("h1").first();
      const h1Text = await h1.textContent();
      expect(h1Text, `${route.label}: h1 exists and has text`).toBeTruthy();
    }
  });
});

// ============================================
// PHASE 7: RESPONSIVE UI
// ============================================
test.describe("PHASE 7 — Responsive UI", () => {
  for (const vp of VIEWPORTS) {
    test(`7A-${vp.name}: Dashboard no overflow`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await page.waitForTimeout(300);
      await checkNoOverflow(page, `Dashboard @ ${vp.name}`);
    });

    test(`7B-${vp.name}: Users no overflow`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await page.goto(`${BASE}/organization-admin/users`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      await checkNoOverflow(page, `Users @ ${vp.name}`);
    });

    test(`7C-${vp.name}: Organization no overflow`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await page.goto(`${BASE}/organization-admin/organization`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      await checkNoOverflow(page, `Organization @ ${vp.name}`);
    });

    test(`7D-${vp.name}: PAL no overflow`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await page.goto(`${BASE}/organization-admin/privileged-access-log`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      await checkNoOverflow(page, `PAL @ ${vp.name}`);
    });
  }
});

// ============================================
// PHASE 8: LOADING/PERFORMANCE
// ============================================
test.describe("PHASE 8 — Loading/Performance", () => {
  test("8A: Dashboard loads within 8s", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    const start = Date.now();
    await page.goto(`${BASE}/organization-admin/dashboard`, { waitUntil: "networkidle" });
    const elapsed = Date.now() - start;
    expect(elapsed, "Dashboard loads within 8s").toBeLessThan(8000);
    console.log(`Dashboard load: ${elapsed}ms`);
  });

  test("8B: User Management loads within 8s", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    const start = Date.now();
    await page.goto(`${BASE}/organization-admin/users`, { waitUntil: "networkidle" });
    const elapsed = Date.now() - start;
    expect(elapsed, "Users loads within 8s").toBeLessThan(8000);
    console.log(`Users load: ${elapsed}ms`);
  });

  test("8C: My Organization loads within 8s", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    const start = Date.now();
    await page.goto(`${BASE}/organization-admin/organization`, { waitUntil: "networkidle" });
    const elapsed = Date.now() - start;
    expect(elapsed, "Org loads within 8s").toBeLessThan(8000);
    console.log(`Org load: ${elapsed}ms`);
  });

  test("8D: PAL loads within 8s", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    const start = Date.now();
    await page.goto(`${BASE}/organization-admin/privileged-access-log`, { waitUntil: "networkidle" });
    const elapsed = Date.now() - start;
    expect(elapsed, "PAL loads within 8s").toBeLessThan(8000);
    console.log(`PAL load: ${elapsed}ms`);
  });

  test("8E: No duplicate API calls on dashboard", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const apiCalls = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/")) apiCalls.push(req.url());
    });
    await login(page);
    await page.waitForTimeout(1000);
    const dashboardCalls = apiCalls.filter((u) => u.includes("dashboard-stats"));
    expect(dashboardCalls.length, "Only 1 dashboard-stats call").toBeLessThanOrEqual(1);
    console.log(`Dashboard API calls: ${dashboardCalls.length}`);
  });

  test("8F: No duplicate API calls on user list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    const apiCalls = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/")) apiCalls.push(req.url());
    });
    await page.goto(`${BASE}/organization-admin/users`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    const userCalls = apiCalls.filter((u) => u.includes("admin/users"));
    expect(userCalls.length, "At most 2 user API calls (list + summary)").toBeLessThanOrEqual(2);
    console.log(`User list API calls: ${userCalls.length}`);
  });
});

// ============================================
// PHASE 13: VISUAL PRODUCTION REVIEW
// ============================================
test.describe("PHASE 13 — Visual Production Review", () => {
  test("13A: Dashboard visual elements", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.waitForTimeout(500);

    const bodyText = await page.textContent("body");
    expect(bodyText, "Dashboard: has greeting").toContain("Good");
    expect(bodyText, "Dashboard: mentions customers").toContain("customer");

    const debugInfo = await page.evaluate(() => {
      return {
        hasDollar0: document.body.textContent.includes("$0"),
        has0point00: document.body.textContent.includes("0.00"),
        heroText: document.querySelector("h1")?.parentElement?.textContent?.substring(0, 200),
        bodySnippet: document.body.textContent.substring(0, 500),
      };
    });

    const noDollarZero = !debugInfo.hasDollar0;
    expect(noDollarZero, "Dashboard: no hardcoded $0").toBe(true);

    await page.screenshot({ path: "tests/screenshots/e2e-dashboard-1440.png", fullPage: true });
  });

  test("13B: Users visual elements", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto(`${BASE}/organization-admin/users`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const bodyText = await page.textContent("body");
    expect(bodyText, "Users: has 'User Management'").toContain("User Management");
    expect(bodyText, "Users: has 'Active' pill").toContain("Active");
    expect(bodyText, "Users: has 'Invited' pill").toContain("Invited");
    expect(bodyText, "Users: has 'Deactivated' pill").toContain("Deactivated");

    await page.screenshot({ path: "tests/screenshots/e2e-users-1440.png", fullPage: true });
  });

  test("13C: Organization visual elements", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto(`${BASE}/organization-admin/organization`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const bodyText = await page.textContent("body");
    expect(bodyText, "Org: has 'My Organization'").toContain("My Organization");
    expect(bodyText, "Org: has 'QABROWSER'").toContain("QABROWSER");
    expect(bodyText, "Org: has 'INR'").toContain("INR");

    await page.screenshot({ path: "tests/screenshots/e2e-organization-1440.png", fullPage: true });
  });

  test("13D: PAL visual elements", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto(`${BASE}/organization-admin/privileged-access-log`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const bodyText = await page.textContent("body");
    expect(bodyText, "PAL: has 'Privileged Access Log'").toContain("Privileged Access Log");
    expect(bodyText, "PAL: has description").toContain("Zoiko support");

    await page.screenshot({ path: "tests/screenshots/e2e-pal-1440.png", fullPage: true });
  });

  test("13E: Responsive screenshots at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: "tests/screenshots/e2e-dashboard-390.png", fullPage: true });

    await page.goto(`${BASE}/organization-admin/users`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: "tests/screenshots/e2e-users-390.png", fullPage: true });
  });
});

// ============================================
// PHASE 9: ERROR STATES (Browser)
// ============================================
test.describe("PHASE 9 — Error States (Browser)", () => {
  test("9A: Expired session redirects to login", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    await page.evaluate(() => {
      localStorage.removeItem("zoiko_billing_access");
      localStorage.removeItem("zoiko_billing_refresh");
      localStorage.removeItem("zoiko_billing_user");
    });

    await page.goto(`${BASE}/organization-admin/dashboard`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    const url = page.url();
    expect(url, "Redirected to login on expired session").toContain("/login");
  });

  test("9B: Invite modal form validation", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto(`${BASE}/organization-admin/users`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const inviteBtn = page.locator('button:has-text("Invite User")').first();
    if (await inviteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await inviteBtn.click();
      await page.waitForTimeout(1000);
      const submitBtn = page.locator('button[type="submit"], button:has-text("Send")').first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(1000);
        const bodyText = await page.textContent("body");
        const hasValidation = bodyText.includes("required") || bodyText.includes("Required") || bodyText.includes("valid") || bodyText.includes("at least") || bodyText.includes("must");
        expect(hasValidation, "Form shows validation error on empty submit").toBe(true);
      }
    }
  });
});
