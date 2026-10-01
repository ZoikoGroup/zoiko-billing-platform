import { test, expect } from "@playwright/test";

const BASE = "http://127.0.0.1:5173";
const ADMIN = {
  email: "phase20-admin@zoiko-e2e-test.com",
  password: "Phase20E2e#12345",
};

async function login(page) {
  const errs = [];
  const failed = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`console: ${m.text()}`);
  });
  page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url()}`));
  page.on("response", (r) => {
    if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url()}`);
  });

  const t0 = Date.now();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', ADMIN.email);
  await page.fill('input[type="password"]', ADMIN.password);
  await Promise.all([
    page.waitForURL("**/dashboard", { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");
  const loginMs = Date.now() - t0;
  return { errs, failed, loginMs };
}

test.describe("Phase 20 browser journeys (isolated local stack)", () => {
  test("J1: Login -> Org-admin dashboard -> logout", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const a = await login(page);
    expect(a.loginMs, "login completes (<10s)").toBeLessThan(10000);

    await page.goto(`${BASE}/organization-admin/dashboard`, { waitUntil: "networkidle" });
    const h1 = await page.locator("h1").first().textContent();
    expect(h1, "dashboard has heading").toBeTruthy();

    await page.goto(`${BASE}/logout`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    expect(a.errs, "no console/page errors").toEqual([]);
    console.log(`J1 done loginMs=${a.loginMs}ms`);
  });

  test("J2: User management page renders org users", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const a = await login(page);
    const t0 = Date.now();
    await page.goto(`${BASE}/organization-admin/users`, { waitUntil: "networkidle" });
    const loadMs = Date.now() - t0;
    const bodyText = await page.textContent("body");
    expect(bodyText, "User Management present").toContain("User Management");
    expect(a.errs, "no console/page errors").toEqual([]);
    console.log(`J2 done usersLoadMs=${loadMs}ms`);
  });

  test("J3: Plans page renders and has create-plan affordance", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const a = await login(page);
    const t0 = Date.now();
    await page.goto(`${BASE}/billing/subscriptions/plans`, { waitUntil: "networkidle" });
    const loadMs = Date.now() - t0;
    const bodyText = await page.textContent("body");
    expect(bodyText, "Plans heading present").toMatch(/plan/i);
    expect(a.errs, "no console/page errors").toEqual([]);
    console.log(`J3 done plansLoadMs=${loadMs}ms bodyLen=${bodyText.length}`);
  });

  test("J4: Subscriptions page renders", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const a = await login(page);
    const t0 = Date.now();
    await page.goto(`${BASE}/billing/subscriptions`, { waitUntil: "networkidle" });
    const loadMs = Date.now() - t0;
    const bodyText = await page.textContent("body");
    expect(bodyText, "Subscriptions page has content").toMatch(/subscription/i);
    expect(a.errs, "no console/page errors").toEqual([]);
    console.log(`J4 done subscriptionsLoadMs=${loadMs}ms`);
  });

  test("J5: Invoices page renders", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const a = await login(page);
    const t0 = Date.now();
    await page.goto(`${BASE}/billing/invoices`, { waitUntil: "networkidle" });
    const loadMs = Date.now() - t0;
    const bodyText = await page.textContent("body");
    expect(bodyText, "Invoices page has content").toMatch(/invoice/i);
    expect(a.errs, "no console/page errors").toEqual([]);
    console.log(`J5 done invoicesLoadMs=${loadMs}ms`);
  });

  test("J6: Create plan via UI (plan -> pricing -> subscription workflow)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const a = await login(page);

    const planCode = `p20-plan-${Date.now()}`;
    const planName = `Phase20 Plan ${Date.now()}`;

    await page.goto(`${BASE}/billing/subscriptions/plans`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /create plan/i }).click();
    await page.waitForTimeout(500);

    await page.fill('input[placeholder="e.g. basic-monthly"]', planCode);
    await page.fill('input[placeholder="e.g. Basic Monthly"]', planName);
    await page.fill('input[placeholder="0.00"]', "99.00");
    await page.locator('button[type="submit"]').click();

    await expect(page.getByRole("status").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(planName).first()).toBeVisible({ timeout: 10000 });

    const bodyText = await page.textContent("body");
    expect(bodyText, "Plan name visible in table").toContain(planName);
    expect(bodyText, "Plan code visible in table").toContain(planCode);
    expect(bodyText, "Price visible").toContain("99");
    expect(a.errs, "no console/page errors").toEqual([]);
    console.log(`J6 done created=${planCode}`);
  });
});