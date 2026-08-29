import { test, expect } from '@playwright/test';

// Billing Assistant error-fallback regression.
//
// Regression: when the very first message of a NEW conversation failed
// (POST /sessions), handleSend previously appended ONLY the alarmist
// "I ran into a temporary issue..." system bubble — the user's typed
// query was added to the view only after session creation succeeded, so
// the panel appeared to show a lone error with no triggering message.
//
// Contract under test:
//   - Opening the panel never shows that error unprompted (background
//     failures — listSessions / session restore — stay silent).
//   - A failed first message keeps the user's message visible and shows a
//     soft, non-alarming notice instead of the generic error language.
//
// Self-contained: auth is localStorage-only, so a dev-only identity
// drives the UI; failures are simulated with request interception, so the
// backend is not required.

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

const TEMPORARY_ISSUE = /I ran into a temporary issue/i;

async function openAssistant(page, routeHandler) {
  await page.addInitScript((session) => {
    for (const [key, value] of Object.entries(session)) {
      localStorage.setItem(key, value);
    }
  }, SESSION);
  if (routeHandler) await page.route('**/api/chatbot/sessions*', routeHandler);
  await page.goto('/organization-admin/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open AI Billing Assistant' }).click();
  return page.getByRole('complementary', { name: 'AI Billing Assistant' });
}

test('fresh open never shows the generic error unprompted', async ({ page }) => {
  const panel = await openAssistant(page);

  // Background session-list/restore failing (fake token → 401) must stay
  // silent: the panel shows the normal greeting + quick actions instead.
  await expect(panel.getByText(/Ask me about invoices/i)).toBeVisible();
  await expect(panel.locator('.ab-cat-btn')).toHaveCount(9);
  await expect(panel).not.toContainText(TEMPORARY_ISSUE);
  await expect(panel).not.toContainText("Couldn't reach the assistant just now");
});

test('failed session history load keeps the greeting, no error bubble', async ({ page }) => {
  const panel = await openAssistant(page, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' });
      return;
    }
    await route.continue();
  });

  await expect(panel.getByText(/Ask me about invoices/i)).toBeVisible();
  await expect(panel).not.toContainText(TEMPORARY_ISSUE);
  await expect(panel).not.toContainText("Couldn't reach the assistant just now");
});

test('failed first message keeps the query visible with a soft notice', async ({ page }) => {
  const panel = await openAssistant(page, async (route) => {
    if (route.request().method() === 'POST') await route.abort();
    else await route.continue();
  });

  await page.getByLabel('Type your billing question').fill('What is my current balance?');
  await page.getByRole('button', { name: 'Send message' }).click();

  // The user's message must be rendered (never a lone error with no query).
  await expect(panel.getByText('What is my current balance?', { exact: true })).toBeVisible();

  // Soft, non-alarming notice instead of the generic error language.
  await expect(panel.getByText(/Couldn't reach the assistant just now/i)).toBeVisible();
  await expect(panel).not.toContainText(TEMPORARY_ISSUE);
});