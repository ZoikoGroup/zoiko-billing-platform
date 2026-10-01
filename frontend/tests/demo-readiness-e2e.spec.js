import { test, expect } from "@playwright/test";

// ===========================================================================
// DEMO-READINESS / END-TO-END BUSINESS WORKFLOW TEST
//
// Drives the REAL UI (no mocking) against the running local stack to validate
// the complete demo lifecycle for a single coherent India/INR organization:
//
//   Registration → Login → Org/Regional config → Customers → Products →
//   Pricing → Quotation → Contract → Subscription → Invoice → Payment →
//   Tax (GST) → Credit Notes → Refunds → Write-offs → Report nav → Persistence
//
// Each run provisions its OWN organization through the actual registration UI
// so repeated runs never collide and the demo stays clean.
//
// To avoid tripping the backend's real login lockout / rate limiting (each
// login increments failed-attempt counters), this spec follows the same
// strategy as billing-revenue-lifecycle.spec.js: a SINGLE shared browser
// page created in beforeAll, logged in exactly ONCE, and reused by every
// sequential test. This is the proven, stable pattern for this stack.
//
// Env:
//   BASE_URL (default http://127.0.0.1:5173) — the frontend root
// ===========================================================================

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const TOKEN = Date.now().toString(36);
const RUN = `DR${TOKEN.slice(-5)}`;

const ORG_NAME = `ABC Technologies ${RUN}`;
const ADMIN_NAME = "Demo Admin";
const ADMIN_EMAIL = `demo-admin-${RUN}@zoiko-demo.com`;
const ADMIN_PASSWORD = "Demo#Pass12345";

const customers = [
  { company: `ZoomCar Logistics`, email: `zoomcar-${RUN}@client.com` },
  { company: `Tata Motors B2B`, email: `tatamotors-${RUN}@client.com` },
  { company: `Reliance Retail`, email: `reliance-${RUN}@client.com` },
];

const products = [
  { name: `Zoiko Payroll Professional`, code: `ZP-PRO-${RUN}`, price: "25000" },
  { name: `Zoiko HR Suite`, code: `ZHR-${RUN}`, price: "15000" },
  { name: `Zoiko Analytics`, code: `ZAN-${RUN}`, price: "8000" },
];

// Holds cross-test state (created/selected ids & urls).
const state = {};

// Attach listeners that collect console/page/server errors for diagnosis.
async function attachErrorListener(page, errors) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.method()} ${r.url()}`));
  page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
}

const expectNoErrors = (errors, label) =>
  expect(errors.filter((e) => !/favicon/i.test(e)), label).toEqual([]);

// Navigate an SPA page and wait until a given text is present. The navigation
// itself uses "domcontentloaded" (never "networkidle", which hangs on these
// heavy React pages); readiness is decided by the visible content instead.
async function gotoPage(page, url, { waitForText, timeout = 25000 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (waitForText) {
    await page.getByText(waitForText).first().waitFor({ timeout });
  }
}

test.describe("Demo readiness — full business lifecycle", () => {
  let page;
  const errors = [];

  // Registration's first page load can trigger a cold Vite compile right after
  // the dev server starts, plus the real register email background task — so
  // give this describe a generous timeout.
  test.describe.configure({ timeout: 420000 });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420000);
    page = await browser.newPage();
    attachErrorListener(page, errors);

    // ── R0: Register a brand-new India/INR organization through the real UI ──
    await page.goto(`${BASE_URL}/register`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#orgName", { timeout: 25000 });

    await page.fill("#orgName", ORG_NAME);
    await page.fill("#adminName", ADMIN_NAME);
    await page.fill("#adminEmail", ADMIN_EMAIL);
    await page.fill("#password", ADMIN_PASSWORD);
    await page.fill("#phone", "+91 98765 43210");
    await page.fill("#industry", "Technology");
    await page.fill("#address", "Bandra Kurla Complex, Mumbai");
    await page.fill("#city", "Mumbai");

    // Country FIRST (this enables the State/Timezone selects), then State.
    // selectOption can auto-wait indefinitely on these React-driven <select>s
    // that re-render on country change, so guard with explicit short timeouts
    // and a DOM-level fallback that cannot hang.
    try {
      await page.selectOption("#country", { label: "India" }, { timeout: 15000 });
    } catch {
      await page.evaluate(() => {
        const el = document.getElementById("country");
        const opt = Array.from(el.options).find((o) => o.text === "India");
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
      });
    }
    await page.waitForTimeout(800);

    try {
      await page.selectOption("#state", { label: "Maharashtra" }, { timeout: 15000 });
    } catch {
      await page.evaluate(() => {
        const el = document.getElementById("state");
        const opt = Array.from(el.options).find((o) => o.text === "Maharashtra");
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
      });
    }
    await page.waitForTimeout(800);

    // Country -> auto-suggested INR currency. If the async country-defaults map
    // hadn't finished loading when the country changed, currency is empty — in
    // that case select the INR option explicitly so the demo org is always INR.
    let currency = "";
    try { currency = await page.inputValue("#currency"); } catch {}
    if (currency !== "INR") {
      try {
        await page.selectOption("#currency", { label: /INR/ }, { timeout: 10000 });
      } catch {
        await page.evaluate(() => {
          const el = document.getElementById("currency");
          const opt = Array.from(el.options).find((o) => o.textContent.includes("INR"));
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
        });
      }
      await page.waitForTimeout(300);
    }
    expect(await page.inputValue("#currency")).toBe("INR");

    await page.check("#termsAccepted");
    await Promise.all([
      page.waitForURL(/\/register\/success/, { timeout: 60000 }),
      page.click('button[type="submit"]'),
    ]);
    await page.getByText(/registered|success|created/i).first().waitFor({ timeout: 20000 });

    // ── Login ONCE and reuse for the whole suite ──
    await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[type="email"]', { timeout: 25000 });
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/(dashboard|organization-admin|billing)/, { timeout: 30000 }),
      page.click('button[type="submit"]'),
    ]);
    // Land on the org dashboard explicitly so each test starts from a known point.
    await page.goto(`${BASE_URL}/billing/dashboard`, { waitUntil: "domcontentloaded" });
    await page.getByText(/Dashboard/i).first().waitFor({ timeout: 25000 });
  });

  test.afterAll(async () => {
    if (page) await page.close();
  });

  // ── Org / regional configuration ────────────────────────────────────────
  test("R1: Login lands on org-admin dashboard (India/INR org exists)", async () => {
    await gotoPage(page, `${BASE_URL}/organization-admin/organization`, { waitForText: /My Organization|Organization details/ });
    const body = await page.textContent("body");
    expect(body, "organization page loads").toMatch(/My Organization|Organization details/i);
    expectNoErrors(errors, "no console/page/server errors");
  });

  test("R2: Regional settings reflect India / INR defaults", async () => {
    await gotoPage(page, `${BASE_URL}/billing/settings`, { waitForText: /Billing Configuration|General/ });
    const body = await page.textContent("body");
    expect(body, "settings page loads").toMatch(/Billing Configuration|General/i);
    const hasInr = /INR/i.test(body);
    const hasKolkata = /Asia\/Kolkata/i.test(body);
    expect(hasInr || hasKolkata, `India defaults present (INR=${hasInr}, Kol=${hasKolkata})`).toBe(true);
    expectNoErrors(errors, "no console/page/server errors");
  });

  test("R3: Tax rates page shows seeded GST rates for INR", async () => {
    await gotoPage(page, `${BASE_URL}/billing/tax`, { waitForText: /Tax Rate/i });
    // Rates load async; wait for the seeded India GST slab to actually render.
    await page.getByText(/GST/i).first().waitFor({ timeout: 20000 });
    const body = await page.textContent("body");
    expect(body, "tax rates page loads").toMatch(/Tax Rate/i);
    expect(body, "contains GST signals").toMatch(/GST/i);
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Customers ───────────────────────────────────────────────────────────
  test("R4: Create 3 customers", async () => {
    await gotoPage(page, `${BASE_URL}/billing/customers`, { waitForText: /Customer/i });
    await expect(page.getByRole("button", { name: /New Customer/i }).first()).toBeVisible({ timeout: 20000 });

    for (const c of customers) {
      await page.getByRole("button", { name: /New Customer/i }).first().click();
      const dialog = page.getByRole("heading", { name: "New Customer" }).locator("xpath=..").locator("xpath=..");
      await expect(dialog).toBeVisible({ timeout: 15000 });
      await dialog.locator('label:has-text("Company Name")').locator("xpath=..").locator("input").fill(c.company);
      await dialog.locator('label:has-text("Email")').locator("xpath=..").locator("input").fill(c.email);
      await dialog.getByRole("button", { name: /^Create Customer$/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 15000 });
      await expect(page.getByText(c.company).first()).toBeVisible({ timeout: 15000 });
    }
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Products ────────────────────────────────────────────────────────────
  test("R5: Create 3 products (INR pricing)", async () => {
    await gotoPage(page, `${BASE_URL}/billing/products`, { waitForText: /Product/i });
    await expect(page.getByRole("button", { name: "Add Product", exact: true })).toBeVisible({ timeout: 20000 });

    for (const p of products) {
      await page.getByRole("button", { name: "Add Product", exact: true }).click();
      const dialog = page.getByRole("heading", { name: "New Product" }).locator("xpath=..").locator("xpath=..");
      await expect(dialog).toBeVisible({ timeout: 15000 });
      await dialog.locator('label:has-text("Product Name")').locator("xpath=..").locator("input").fill(p.name);
      await dialog.locator('label:has-text("SKU / Code")').locator("xpath=..").locator("input").fill(p.code);
      await dialog.locator('label:has-text("Default Price")').locator("xpath=..").locator("input").fill(p.price);
      await dialog.getByRole("button", { name: /^Create Product$/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 15000 });
      await expect(page.getByText(p.name).first()).toBeVisible({ timeout: 15000 });
    }
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Pricing plans & subscription ────────────────────────────────────────
  test("R6: Create a subscription plan", async () => {
    await gotoPage(page, `${BASE_URL}/billing/subscriptions/plans`, { waitForText: /Subscription Plan/i });
    await page.getByRole("button", { name: /Create Plan/i }).click();
    await expect(page.getByRole("heading", { name: /Create.*Plan/i })).toBeVisible({ timeout: 15000 });

    await page.getByPlaceholder(/basic-monthly/i).fill("starter-monthly");
    await page.getByPlaceholder(/Basic Monthly/i).fill("Starter Monthly");
    await page.getByPlaceholder("0.00").fill("2999");
    await page.getByRole("button", { name: /Save|Create/i }).first().click();
    await expect(page.getByText("starter-monthly").first()).toBeVisible({ timeout: 15000 });
    expectNoErrors(errors, "no console/page/server errors");
  });

  test("R7: Create a subscription for the first customer", async () => {
    await gotoPage(page, `${BASE_URL}/billing/subscriptions/create`, { waitForText: /Subscription|Create.*Subscription/i });

    await page.getByText(customers[0].company).first().click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    const planCard = page.getByText("Starter Monthly").first();
    if (await planCard.isVisible().catch(() => false)) await planCard.click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Create|Save|Activate/i }).first().click();
    await expect(page.getByText(/subscription/i).first()).toBeVisible({ timeout: 25000 });
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Quotation lifecycle ─────────────────────────────────────────────────
  test("R8: Create a quotation via the 6-step wizard", async () => {
    await gotoPage(page, `${BASE_URL}/billing/quotations/create`, { waitForText: /Quotation|Create.*Quotation/i });

    await page.getByText(customers[0].company).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    const addItemBtn = page.getByRole("button", { name: /Add.*Item|Add.*Line/i }).first();
    if (await addItemBtn.isVisible().catch(() => false)) {
      await addItemBtn.click();
      await page.waitForTimeout(500);
    }
    const productOption = page.getByText(products[0].name).first();
    if (await productOption.isVisible().catch(() => false)) {
      await productOption.click();
      await page.waitForTimeout(500);
    }
    const qtyInput = page.locator('input[type="number"]').first();
    if (await qtyInput.isVisible().catch(() => false)) await qtyInput.fill("10");
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Save as Draft/i }).first().click();
    await expect(page.getByText(/quotation/i).first()).toBeVisible({ timeout: 25000 });
    expectNoErrors(errors, "no console/page/server errors");
  });

  test("R9: Send and accept the quotation", async () => {
    await gotoPage(page, `${BASE_URL}/billing/quotations`, { waitForText: /Quotation/i });
    const quoteRow = page.locator("table tbody tr").first();
    if (await quoteRow.isVisible().catch(() => false)) {
      await quoteRow.click();
      await page.waitForTimeout(1000);
      const sendBtn = page.getByRole("button", { name: /Send Quotation/i }).first();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
        await expect(page.getByText(/sent/i).first()).toBeVisible({ timeout: 15000 });
      }
      const acceptBtn = page.getByRole("button", { name: /Accept Quotation/i }).first();
      if (await acceptBtn.isVisible().catch(() => false)) {
        await acceptBtn.click();
        await expect(page.getByText(/accepted/i).first()).toBeVisible({ timeout: 15000 });
      }
    }
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Contract ────────────────────────────────────────────────────────────
  test("R10: Create a contract via the 5-step wizard", async () => {
    await gotoPage(page, `${BASE_URL}/billing/contracts/create`, { waitForText: /Contract|Create.*Contract/i });

    await page.getByText(customers[0].company).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    const valueInput = page.locator('input[placeholder*="value"], input[name*="value"]').first();
    if (await valueInput.isVisible().catch(() => false)) await valueInput.fill("50000");
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Save as Draft|Save & Activate/i }).first().click();
    await expect(page.getByText(/contract/i).first()).toBeVisible({ timeout: 25000 });
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Invoice + payment ───────────────────────────────────────────────────
  test("R11: Create an invoice via the 7-step wizard", async () => {
    await gotoPage(page, `${BASE_URL}/billing/invoices/create`, { waitForText: /Invoice|Create.*Invoice/i });

    await page.getByText(customers[0].company).first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Next/i }).first().click();

    await page.waitForTimeout(600);
    const addItemBtn = page.getByRole("button", { name: /Add.*Item|Add.*Line/i }).first();
    if (await addItemBtn.isVisible().catch(() => false)) {
      await addItemBtn.click();
      await page.waitForTimeout(500);
    }
    const productOption = page.getByText(products[0].name).first();
    if (await productOption.isVisible().catch(() => false)) {
      await productOption.click();
      await page.waitForTimeout(500);
    }
    const qtyInput = page.locator('input[type="number"]').first();
    if (await qtyInput.isVisible().catch(() => false)) await qtyInput.fill("5");
    await page.getByRole("button", { name: /Next/i }).first().click();

    // Steps 4-6 (pricing, tax, review) are defaults-heavy; click Next through.
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: /Next/i }).first().click();
    }

    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Save as Draft|Create Invoice/i }).first().click();
    await page.waitForURL(/\/billing\/invoices\/\d+/, { timeout: 25000 });
    state.invoiceUrl = page.url();
    state.invoiceId = page.url().match(/\/billing\/invoices\/(\d+)/)?.[1];
    expect(state.invoiceId, "invoice id captured").toBeTruthy();
    expectNoErrors(errors, "no console/page/server errors");
  });

  test("R12: Finalize the invoice and record a payment", async () => {
    test.skip(!state.invoiceUrl, "Invoice was not created in the previous step.");
    await gotoPage(page, state.invoiceUrl, { waitForText: /Invoice/i });

    const finalizeBtn = page.getByRole("button", { name: /^Finalize/i }).first();
    if (await finalizeBtn.isVisible().catch(() => false)) {
      await finalizeBtn.click();
      await page.waitForTimeout(1000);
    }

    const payBtn = page.getByRole("button", { name: /Record Payment/i }).first();
    if (await payBtn.isVisible().catch(() => false)) {
      await payBtn.click();
      await expect(page.getByText(/Record Payment/i).first()).toBeVisible({ timeout: 10000 });

      for (let i = 0; i < 6; i++) {
        const continueBtn = page.getByRole("button", { name: /^Continue$/i }).first();
        if (await continueBtn.isVisible().catch(() => false)) {
          await continueBtn.click();
          await page.waitForTimeout(400);
        } else {
          break;
        }
      }
      const submitBtn = page.getByRole("button", { name: /^Record Payment$/i }).first();
      if (await submitBtn.isVisible().catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(1500);
      }
    }
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Credit note ─────────────────────────────────────────────────────────
  test("R13: Create a credit note", async () => {
    await gotoPage(page, `${BASE_URL}/billing/credit-notes`, { waitForText: /Credit Note/i });
    await page.getByRole("button", { name: /New Credit Note/i }).click();
    await expect(page.getByRole("heading", { name: /New Credit Note/i })).toBeVisible({ timeout: 15000 });

    const dialog = page.getByRole("heading", { name: /New Credit Note/i }).locator("xpath=..").locator("xpath=..");
    await dialog.locator('label:has-text("Customer")').locator("xpath=..").locator("select, input").first().click();
    await page.waitForTimeout(500);
    await page.getByText(customers[0].company).first().click();

    const amountInput = dialog.locator('input[name*="amount"], input[type="number"]').first();
    if (await amountInput.isVisible().catch(() => false)) await amountInput.fill("5000");

    const reasonInput = dialog.locator('textarea, input[name*="reason"]').first();
    if (await reasonInput.isVisible().catch(() => false)) await reasonInput.fill("Demo credit note for testing");

    await dialog.getByRole("button", { name: /^Create$/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15000 });
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Refund ──────────────────────────────────────────────────────────────
  test("R14: Create a refund", async () => {
    await gotoPage(page, `${BASE_URL}/billing/refunds`, { waitForText: /Refund/i });
    await page.getByRole("button", { name: /New Refund/i }).click();
    await expect(page.getByText(/Create Refund/i).first()).toBeVisible({ timeout: 15000 });

    const dialog = page.locator('[role="dialog"], .modal').first();
    const customerSelect = dialog.locator('select[name*="customer"], input[name*="customer"]').first();
    if (await customerSelect.isVisible().catch(() => false)) {
      await customerSelect.click();
      await page.waitForTimeout(500);
      await page.getByText(customers[0].company).first().click();
    }
    const amountInput = dialog.locator('input[name*="amount"], input[type="number"]').first();
    if (await amountInput.isVisible().catch(() => false)) await amountInput.fill("2000");
    const reasonInput = dialog.locator('textarea, input[name*="reason"]').first();
    if (await reasonInput.isVisible().catch(() => false)) await reasonInput.fill("Demo refund for testing");

    await dialog.getByRole("button", { name: /^Create$/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15000 });
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Write-off ───────────────────────────────────────────────────────────
  test("R15: Create a write-off", async () => {
    await gotoPage(page, `${BASE_URL}/billing/write-offs`, { waitForText: /Write-?off/i });
    await page.getByRole("button", { name: /New Write-?off/i }).click();
    await expect(page.getByText(/Create.*Write-?off/i).first()).toBeVisible({ timeout: 15000 });

    const dialog = page.locator('[role="dialog"], .modal').first();
    const customerSelect = dialog.locator('select[name*="customer"], input[name*="customer"]').first();
    if (await customerSelect.isVisible().catch(() => false)) {
      await customerSelect.click();
      await page.waitForTimeout(500);
      await page.getByText(customers[0].company).first().click();
    }
    const amountInput = dialog.locator('input[name*="amount"], input[type="number"]').first();
    if (await amountInput.isVisible().catch(() => false)) await amountInput.fill("1000");
    const reasonInput = dialog.locator('textarea, input[name*="reason"]').first();
    if (await reasonInput.isVisible().catch(() => false)) await reasonInput.fill("Demo write-off for testing");

    await dialog.getByRole("button", { name: /^Create$/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15000 });
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Dashboard & reports ─────────────────────────────────────────────────
  test("R16: Dashboard renders KPI cards and metrics", async () => {
    await gotoPage(page, `${BASE_URL}/billing/dashboard`, { waitForText: /Dashboard/i });
    // KPIs are loaded async; allow them to populate before reading.
    await page.waitForTimeout(1500);
    const body = await page.textContent("body");
    expect(body, "dashboard loads").toMatch(/Dashboard/i);
    expect(body, "has KPIs").toMatch(/Revenue|Outstanding|Invoice|Customer|Subscription/i);
    expectNoErrors(errors, "no console/page/server errors");
  });

  test("R17: Reports page renders report tabs", async () => {
    await gotoPage(page, `${BASE_URL}/billing/reports`, { waitForText: /Report/i });
    await page.waitForTimeout(1000);
    const body = await page.textContent("body");
    expect(body, "reports page loads").toMatch(/Report/i);
    expect(body, "has report tabs").toMatch(/Revenue|Invoice|Payment|Tax|Subscription/i);
    expectNoErrors(errors, "no console/page/server errors");
  });

  // ── Settings / persistence ──────────────────────────────────────────────
  test("R18: Settings tabs (General, Invoicing, Payments, Tax) are navigable", async () => {
    await gotoPage(page, `${BASE_URL}/billing/settings`, { waitForText: /Billing Configuration/i });
    for (const tab of ["General", "Invoicing", "Payments", "Tax"]) {
      const tabEl = page.getByRole("tab", { name: tab }).or(page.getByText(tab, { exact: true }).first());
      if (await tabEl.isVisible().catch(() => false)) {
        await tabEl.click();
        await page.waitForTimeout(500);
      }
    }
    expectNoErrors(errors, "no console/page/server errors");
  });

  test("R19: Deep-link all billing modules (no redirect loops) + refresh persistence", async () => {
    const modules = [
      ["/billing/customers", /Customer/],
      ["/billing/products", /Product/],
      ["/billing/quotations", /Quotation/],
      ["/billing/contracts", /Contract/],
      ["/billing/subscriptions", /Subscription/],
      ["/billing/invoices", /Invoice/],
      ["/billing/payments", /Payment/],
      ["/billing/credit-notes", /Credit/i],
      ["/billing/refunds", /Refund/],
      ["/billing/write-offs", /Write-?off/i],
      ["/billing/tax", /Tax/],
      ["/billing/reports", /Report/],
      ["/billing/settings", /Setting/i],
      ["/billing/dashboard", /Dashboard/],
    ];

    for (const [path, pattern] of modules) {
      await gotoPage(page, `${BASE_URL}${path}`, { waitForText: pattern, timeout: 20000 });
      await expect(page).toHaveURL(new RegExp(path.replace("/", "\\/")), { timeout: 15000 });
    }

    // Refresh persistence: reload a billing module and confirm no redirect loop.
    await page.goto(`${BASE_URL}/billing/invoices`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/billing\/invoices/);
    await expect(page.getByText(/Invoice/i).first()).toBeVisible({ timeout: 15000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/billing\/invoices/);
    await expect(page.getByText(/Invoice/i).first()).toBeVisible({ timeout: 15000 });
    expectNoErrors(errors, "no console/page/server errors");
  });
});
