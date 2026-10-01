import { test, expect } from "@playwright/test";

// SUB-02 regression: "Create Plan form loses input after typing one word."
//
// Root cause (billing-ui.jsx Modal component): the focus-trap effect
// depended on [open, onClose]. Every real caller passes onClose as a fresh
// inline arrow function on each render (e.g. onClose={() => setOpen(false)}),
// so that dependency changed identity on every keystroke's re-render. The
// effect's cleanup unconditionally refocused the element that had focus
// right before the modal opened (the "Create Plan" button) -- stealing
// focus away from whatever field the user was actively typing into after
// the very first character. React's controlled `value` stayed internally
// correct; only real browser focus was lost, so only a real per-keystroke
// typing simulation (not Playwright's .fill(), which sets the value in one
// shot) reproduces it. Fixed by reading onClose through a ref instead of a
// dependency, so the effect only re-runs when `open` itself actually toggles.
//
// This must run against the real Vite dev server + backend (no mocking):
// the bug is about real DOM focus during real re-renders, which jsdom-based
// component tests did not reproduce.

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const TOKEN = Date.now().toString(36);
const ADMIN_EMAIL = `modalfocus-${TOKEN}@zoiko-demo.com`;
const ADMIN_PASSWORD = "Demo#Pass12345";

test("Create Plan modal retains focus while typing (SUB-02)", async ({ page }) => {
  test.setTimeout(120000);

  await page.goto(`${BASE_URL}/register`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#orgName", { timeout: 25000 });
  await page.fill("#orgName", `Modal Focus Regression ${TOKEN}`);
  await page.fill("#adminName", "Modal Focus Admin");
  await page.fill("#adminEmail", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await page.fill("#phone", "+91 98765 43210");
  await page.fill("#industry", "Technology");
  await page.fill("#address", "Test Address");
  await page.fill("#city", "Mumbai");
  try { await page.selectOption("#country", { label: "India" }, { timeout: 15000 }); } catch { /* default is fine */ }
  await page.waitForTimeout(500);
  await page.check("#termsAccepted");
  await Promise.all([
    page.waitForURL(/\/register\/success/, { timeout: 60000 }),
    page.click('button[type="submit"]'),
  ]);

  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 25000 });
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/(dashboard|organization-admin|billing)/, { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);

  await page.goto(`${BASE_URL}/billing/subscriptions/plans`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Plans/i).first().waitFor({ timeout: 25000 });
  await page.getByRole("button", { name: /create plan|new plan|\+ plan/i }).first().click();

  const nameInput = page.getByPlaceholder("e.g. Basic Monthly");
  await nameInput.waitFor({ timeout: 10000 });

  // Real, slow, per-keystroke typing -- a single fireEvent.change/.fill()
  // call does not exercise the re-render-per-keystroke path that triggered
  // the bug.
  await nameInput.pressSequentially("Basic Monthly Plan", { delay: 80 });
  await expect(nameInput).toHaveValue("Basic Monthly Plan");

  // Typing in a second field afterwards must not have clobbered the first.
  const codeInput = page.getByPlaceholder("e.g. basic-monthly");
  await codeInput.pressSequentially("basic-monthly-regress", { delay: 60 });
  await expect(codeInput).toHaveValue("basic-monthly-regress");
  await expect(nameInput).toHaveValue("Basic Monthly Plan");
});
