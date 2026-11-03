// @ts-check
/**
 * Mobile responsiveness checks (Phase 5) — no backend needed.
 *
 * Every fetch / XHR is answered here from fictional fixtures, whatever host it
 * targets, and every other request leaving localhost is aborted, so this spec
 * can never reach a real API or database. Sessions are seeded into
 * localStorage (fake token with a far-future expiry).
 *
 * Runs in the iPhone 13 / Pixel 7 / iPad (gen 7) projects (Chromium with each
 * device's viewport, touch and user agent — layout, not Safari rendering) and
 * the desktop project.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

// ── fixtures (fictional) ────────────────────────────────────────────────────
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_TOKEN = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "1", exp: 4102444800 })}.sig`;

const USERS = {
  org_admin: { id: 1, email: "orgadmin@example.com", first_name: "Olivia", last_name: "Admin", name: "Olivia Admin", role: "org_admin", organization_id: 1 },
  billing_admin: { id: 2, email: "billing@example.com", first_name: "Bill", last_name: "Admin", name: "Bill Admin", role: "billing_admin", organization_id: 1 },
  super_admin: { id: 3, email: "platform@example.com", first_name: "Sam", last_name: "Super", name: "Sam Super", role: "super_admin", organization_id: null },
};

const CUSTOMERS = [1, 2, 3].map((i) => ({
  id: i, customer_code: `CUST-00${i}`, display_name: `Example Customer ${i}`, company_name: `Example Customer ${i} Ltd`,
  email: `customer${i}@example.com`, status: "active", customer_type: "business", currency: "USD",
  outstanding_balance: 1200 * i, credit_limit: 10000, created_at: "2026-09-01T10:00:00Z",
}));
const INVOICES = [1, 2, 3, 4].map((i) => ({
  id: i, invoice_number: `INV-2026-0000${i}`, customer_id: 1, customer_name: "Example Customer 1",
  status: ["draft", "sent", "paid", "overdue"][i - 1], issue_date: "2026-10-01", due_date: "2026-10-31",
  total_amount: 1000 * i, paid_amount: i === 3 ? 3000 : 0, balance_due: i === 3 ? 0 : 1000 * i, currency: "USD",
}));
const list = (items) => ({ items, total: items.length, page: 1, per_page: 20 });

/** [pathname regex, body] — first match wins; everything else gets an empty list. */
const FIXTURES = [
  [/\/billing\/customers\/\d+$/, CUSTOMERS[0]],
  [/\/billing\/customers$/, list(CUSTOMERS)],
  [/\/billing\/invoices\/\d+$/, { ...INVOICES[1], items: [] }],
  [/\/billing\/invoices$/, list(INVOICES)],
];

async function serveFixtures(context) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (["fetch", "xhr"].includes(req.resourceType())) {
      if (req.method() !== "GET") return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      const hit = FIXTURES.find(([re]) => re.test(url.pathname));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hit ? hit[1] : list([])) });
    }
    return local ? route.fallback() : route.abort();
  });
}

async function signIn(context, role) {
  await context.addInitScript(([token, user]) => {
    localStorage.setItem("zoiko_billing_access", token);
    localStorage.setItem("zoiko_billing_refresh", token);
    localStorage.setItem("zoiko_billing_user", JSON.stringify(user));
  }, [FAKE_TOKEN, USERS[role]]);
}

async function open(page, path) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
}

const isPhone = (page) => (page.viewportSize()?.width ?? 1280) < 640;

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return Math.max(document.documentElement.scrollWidth - innerWidth, main ? main.scrollWidth - main.clientWidth : 0);
  });
}

async function axeSeriousViolations(page) {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    // @ts-ignore axe is injected above
    const r = await window.axe.run(document, { resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "critical" || v.impact === "serious")
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.nodes[0]?.target?.join(" ")} — ${(v.nodes[0]?.html || "").slice(0, 160)} — ${(v.nodes[0]?.failureSummary || "").replace(/\s+/g, " ").slice(0, 200)}`);
  });
}

// ── pages ───────────────────────────────────────────────────────────────────
const PAGES = [
  { role: "org_admin", path: "/billing", name: "billing dashboard" },
  { role: "org_admin", path: "/billing/invoices", name: "invoice list", primary: /^Create Invoice$/ },
  { role: "org_admin", path: "/billing/customers", name: "customer list", primary: /^(New|Add) Customer$/ },
  { role: "org_admin", path: "/billing/customers/1", name: "customer detail" },
  { role: "org_admin", path: "/billing/invoices/create", name: "invoice create", primary: /^(Next|Continue)$/ },
  { role: "billing_admin", path: "/billing/workspace/dashboard", name: "workspace dashboard" },
  { role: "super_admin", path: "/super-admin/dashboard", name: "super-admin dashboard" },
];

for (const p of PAGES) {
  test.describe(`${p.name} (${p.role})`, () => {
    test.beforeEach(async ({ context }) => {
      await serveFixtures(context);
      await signIn(context, p.role);
    });

    test("no horizontal overflow; primary action visible and tappable", async ({ page }) => {
      await open(page, p.path);
      await expect(page.locator("main")).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      if (p.primary) {
        const btn = page.locator("main").getByRole("button", { name: p.primary }).first();
        await btn.scrollIntoViewIfNeeded();
        await expect(btn).toBeVisible();
        if (isPhone(page)) expect((await btn.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    });

    test("no critical or serious axe violations", async ({ page }) => {
      await open(page, p.path);
      const violations = await axeSeriousViolations(page);
      expect(violations, violations.join("\n")).toEqual([]);
    });
  });
}

test.describe("login (public)", () => {
  test.beforeEach(async ({ context }) => serveFixtures(context));

  test("no horizontal overflow; sign-in button tappable", async ({ page }) => {
    await open(page, "/login");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    const btn = page.locator('button[type="submit"]');
    await expect(btn).toBeVisible();
    if (isPhone(page)) expect((await btn.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test("no critical or serious axe violations", async ({ page }) => {
    await open(page, "/login");
    const violations = await axeSeriousViolations(page);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

test.describe("shell on phones", () => {
  test.beforeEach(async ({ context }) => {
    await serveFixtures(context);
    await signIn(context, "org_admin");
  });

  test("drawer opens, locks scrolling, and closes with Escape", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 1280) >= 1024, "drawer is only used below lg");
    await open(page, "/billing");
    const toggle = page.getByRole("button", { name: "Toggle navigation" }).first();
    await toggle.click();
    await expect.poll(() => page.evaluate(() => (document.querySelector("aside")?.getBoundingClientRect().left ?? -999) >= -1)).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow === "hidden"
      || getComputedStyle(document.querySelector("main")).overflowY === "hidden")).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => (document.querySelector("aside")?.getBoundingClientRect().left ?? 0) < -10)).toBe(true);
  });

  test("AI assistant button overlaps no other control", async ({ page }) => {
    await open(page, "/billing/invoices");
    const hits = await page.evaluate(() => {
      const launcher = document.querySelector('[aria-label="Open AI Billing Assistant"]');
      if (!launcher) return [];
      const L = launcher.getBoundingClientRect();
      return [...document.querySelectorAll("button, a[href], input, select")]
        .filter((el) => el !== launcher && !launcher.contains(el) && el.getBoundingClientRect().width > 0)
        .filter((el) => { const r = el.getBoundingClientRect(); return r.left < L.right && r.right > L.left && r.top < L.bottom && r.bottom > L.top; })
        .filter((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(Math.max(r.left, L.left) + 1, Math.max(r.top, L.top) + 1); return top === launcher || launcher.contains(top); })
        .map((el) => (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30));
    });
    expect(hits).toEqual([]);
  });

  test("New Customer dialog: Create button visible without scrolling", async ({ page }) => {
    await open(page, "/billing/customers");
    await page.locator("main").getByRole("button", { name: /^(New|Add) Customer$/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const create = dialog.getByRole("button", { name: /^(Create|Create Customer|Save)/ }).last();
    await expect(create).toBeVisible();
    const box = await create.boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 9999);
  });
});
