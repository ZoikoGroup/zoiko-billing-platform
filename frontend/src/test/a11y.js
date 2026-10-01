import { expect } from "vitest";
import { axe as runAxe, toHaveNoViolations } from "jest-axe";

// Shared accessibility-test helper (Priority 5 remediation — axe-core was
// installed but never actually invoked by any test before this). Reused by
// both shared-component and Billing-page a11y specs so every test file
// gets the same `toHaveNoViolations()` matcher and the same axe() runner.
expect.extend(toHaveNoViolations);

// Component-level tests render one page/component in isolation (just a
// router, no surrounding App shell), so there's never a <header>/<nav>/
// <main> around them — axe's "region" rule ("all page content should be
// contained by landmarks") always fires here, for a reason that's about the
// test harness, not the app: the real app wraps every page in that shell
// (see App.jsx), and that page-level structure is what the Playwright E2E
// suite (frontend/tests/billing-revenue-lifecycle.spec.js) exercises against
// the real, fully-assembled DOM. Disabling "region" only in this component-
// level helper — narrowly, with this explanation — avoids a false positive
// on every single page test rather than papering over a real one.
export async function axe(container, options = {}) {
  return runAxe(container, {
    ...options,
    rules: { region: { enabled: false }, ...(options.rules || {}) },
  });
}
