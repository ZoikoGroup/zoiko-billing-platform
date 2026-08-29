import { test, expect } from '@playwright/test';

// Billing Assistant header regression — the assistant panel header
// (title/status + new chat, history, theme, expand, close controls) must
// stay fully visible on every page that mounts the BillingShell. It is
// occluded on desktop when the app's fixed TopBar (z-50, 65px) overlaps
// the panel's top, which previously hid the whole header bar.
//
// No real credentials: the app treats localStorage as the auth source, so
// a dev-only identity drives the UI; the check is purely geometric and
// does not depend on the backend being reachable.

const SESSION = {
  zoiko_billing_access: 'dev-ui-test-token',
  zoiko_billing_user: JSON.stringify({
    user_id: 1,
    name: 'QA Org Admin',
    email: 'qa@test.local',
    role: 'org_admin',
    organization_id: 1,
  }),
};

const ROUTES = [
  '/organization-admin/dashboard',
  '/organization-admin/users',
  '/billing/workspace/dashboard',
];

for (const route of ROUTES) {
  test(`Billing Assistant header fully visible on ${route}`, async ({ page }) => {
    await page.addInitScript((session) => {
      for (const [key, value] of Object.entries(session)) {
        localStorage.setItem(key, value);
      }
    }, SESSION);

    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Open AI Billing Assistant' }).click();

    const panel = page.getByRole('complementary', { name: 'AI Billing Assistant' });
    await expect(panel).toBeVisible();

    // Geometry: the panel header must not be covered by the app TopBar.
    const probe = await page.evaluate(() => {
      const appBar = document.querySelector('header');
      const panelHeader = document.querySelector('[role="complementary"] header');
      if (!appBar || !panelHeader) return null;
      const tb = appBar.getBoundingClientRect();
      const ph = panelHeader.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(ph.bottom, tb.bottom) - Math.max(ph.top, tb.top));
      const el = document.elementFromPoint((ph.left + ph.right) / 2, (ph.top + ph.bottom) / 2);
      return {
        headerTop: ph.top,
        topbarBottom: tb.bottom,
        overlap,
        hitIsInPanelHeader: !!(el && panelHeader.contains(el)),
      };
    });

    expect(probe).not.toBeNull();
    expect(probe.headerTop).toBeGreaterThanOrEqual(probe.topbarBottom);
    expect(probe.overlap).toBe(0);
    expect(probe.hitIsInPanelHeader).toBe(true);

    // Title + online status.
    await expect(panel.getByText('Billing Assistant', { exact: true })).toBeVisible();
    await expect(panel.getByText(/Online/i)).toBeVisible();

    // All header controls.
    await expect(panel.getByRole('button', { name: 'New conversation' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Recent conversations' })).toBeVisible();
    await expect(panel.getByRole('button', { name: /theme/i })).toBeVisible();
    await expect(panel.getByRole('button', { name: /(\bexpand\b|\bcollapse\b)/i })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Close assistant panel' })).toBeVisible();
  });
}