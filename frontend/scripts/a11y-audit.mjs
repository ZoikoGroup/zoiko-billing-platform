/*
 * scripts/a11y-audit.mjs
 * ----------------------
 * ZB-SA-CMD-003 §17 — automated WCAG 2.2 AA validation of the Command Center
 * surface using Playwright (real Chromium) + axe-core.
 *
 * Method: the PRODUCTION BUILD (dist/) is served and driven; every /api/**
 * call is intercepted and answered with representative mock payloads so the
 * real pages render their real components. This audits the frontend UI layer
 * honestly — it does NOT exercise the backend. Results are written to
 * ../../docs/a11y-audit-results.json for the launch-readiness record.
 *
 * Usage: node scripts/a11y-audit.mjs
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const AXE_SRC = readFileSync(fileURLToPath(new URL("../node_modules/axe-core/axe.min.js", import.meta.url)), "utf8");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
  ".json": "application/json", ".ico": "image/x-icon",
};

// Minimal static file server over dist/ with SPA fallback.
function serve() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let path = join(DIST, decodeURIComponent(req.url.split("?")[0]));
      try {
        const body = readFileSync(path);
        res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
        res.end(body);
      } catch {
        try {
          const body = readFileSync(join(DIST, "index.html"));
          res.writeHead(200, { "content-type": "text/html" });
          res.end(body);
        } catch {
          res.writeHead(500); res.end("dist/ missing — run npm run build first");
        }
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const USER = {
  id: 1, email: "audit@example.com", role: "super_admin",
  first_name: "A11y", last_name: "Audit", organization_id: null,
  platform_role: "platform_administrator",
};

const SWITCH = {
  id: 1, scope: "tenant_invoice_finalization", enabled: true, reason: null,
  expires_at: null, changed_by_user_id: null, changed_by_email: null,
  changed_at: new Date().toISOString(), created_at: new Date().toISOString(),
};

const COUNTS = { p0: 1, p1: 0, p2: 2, p3: 1, total_open: 4, sla_breaches: 0 };

const ITEM = (i) => ({
  id: i, source: "job_failure", source_key: `job:demo_${i}`,
  title: `Demo failing job ${i}`, description: "mock payload for a11y audit",
  severity: "p2", status: "open", organization_id: null, owner_user_id: null,
  occurrence_count: 2, correlation_id: "c" + i,
  opened_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
  acknowledged_at: null, assigned_at: null, mitigating_at: null, monitoring_at: null,
  resolved_at: null, closed_at: null, reopened_at: null, resolution_code: null,
  suppressed_until: null, suppression_reason: null,
  sla_ack_deadline: new Date().toISOString(), sla_mitigate_deadline: new Date().toISOString(),
});

const JOB = (name) => ({
  job_name: name, display_name: name, last_status: "succeeded",
  last_started_at: new Date().toISOString(), last_finished_at: new Date().toISOString(),
  last_error: null, run_count_24h: 5, failure_count_24h: 0,
  freshness: "fresh", freshness_age_seconds: 120, expected_interval_minutes: 60,
});

const MOCKS = [
  { match: /\/api\/super-admin\/attention\/counts/, body: COUNTS },
  { match: /\/api\/super-admin\/attention$/, body: { items: [ITEM(1), ITEM(2)] } },
  { match: /\/api\/super-admin\/privileged-access\/active/, body: null },
  { match: /\/api\/super-admin\/telemetry\/jobs/, body: { jobs: [JOB("recurring_billing_job"), JOB("dunning_process_job")], scheduler_enabled: true } },
  { match: /\/api\/super-admin\/telemetry\/organizations/, body: { total_organizations: 3, active_organizations: 3, suspended_organizations: 0 } },
  {
    match: /\/api\/super-admin\/triage\/summary/,
    body: {
      generated_at: new Date().toISOString(),
      incidents: { counts: COUNTS, top_items: [ITEM(1), ITEM(2)] },
      pipeline_stages: [JOB("recurring_billing_job")],
      scheduler_enabled: true,
      safety_controls: [
        { scope: "tenant_dunning", display_name: "Suspend dunning/retries", enabled: false, expires_at: new Date().toISOString(), reason: "mock" },
        { scope: "commercial_subscription_charging", display_name: "Pause commercial subscription charging", enabled: true, expires_at: null, reason: null },
      ],
      critical_events: [{ id: 1, action: "ACTIVATE", entity_type: "BillingKillSwitch", entity_id: 1, actor_email: "a@b.c", reason: "mock", created_at: new Date().toISOString() }],
    },
  },
  { match: /\/api\/super-admin\/circuit-breakers$/, body: { breakers: [], generated_at: new Date().toISOString() } },
  { match: /\/api\/super-admin\/circuit-breakers\/[a-z-]+$/, body: SWITCH },
  { match: /\/api\/super-admin\/billing-kill-switch/, body: SWITCH },
  { match: /\/api\/super-admin\/dashboard\/stats/, body: {} },
  { match: /\/api\/super-admin\/metric-dictionary/, body: { metrics: [] } },
  { match: /\/api\/super-admin\/launch-readiness/, body: { overall_status: "CONDITIONAL", items: [] } },
  { match: /\/api\/super-admin\/financial-consistency/, body: { state: "VERIFIED", scope: "internal_allocation_consistency", total_invoices_checked: 12, over_allocated_count: 0, over_allocated_examples: [], under_allocated_paid_count_informational: 0, coverage_note: "mock" } },
  { match: /\/api\/super-admin\/approval-requests/, body: { requests: [], total: 0 } },
  { match: /\/api\/super-admin\/search/, body: { query: "x", results: [] } },
  { match: /\/api\/super-admin\/commercial-reporting/, body: {
    generated_at: new Date().toISOString(),
    accounts: { total: 2, by_status: { active: 2 } },
    subscriptions: { total_ever: 3, total_open: 2, by_status: { active: 2 }, open_by_plan: [{ plan_id: 1, plan_code: "GROWTH", plan_name: "Growth", open_subscriptions: 2 }] },
    mrr: { state: "computed", amount: "100.00", currencies: [{ currency: "USD", monthly_amount: "100.00", subscriptions: 2 }], coverage: { open_subscriptions_total: 2, open_subscriptions_priced: 2, plans_with_published_price: 1 }, basis: "mock" },
    plane: "PLATFORM",
    honesty_notes: ["Counts are real database rows; nothing is estimated."],
  } },
  { match: /\/api\/super-admin\/organizations/, body: { total: 1, organizations: [{
    id: 1, organization_code: "ORG-A11Y", organization_name: "A11y Demo Org",
    country: "US", currency: "USD", is_active: true, lifecycle_state: "active",
    billing_classification: null, billing_source: null,
    commercial_account_status: "active", can_charge: true,
    subscription_status: "active", subscription_plan_code: "GROWTH",
    total_users: 4, active_users: 4, org_admins: 1, unverified_users: 0,
    open_incident_count: 0, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), last_activity_at: new Date().toISOString(),
    plane: "TENANT",
  }] } },
  { match: /\/api\/super-admin\/health/, body: { database: "connected" } },
];

const PAGES = [
  { name: "login", path: "/login" },
  { name: "dashboard", path: "/super-admin/dashboard" },
  { name: "triage", path: "/super-admin/triage" },
  { name: "kill-switch", path: "/super-admin/kill-switch" },
  { name: "governance", path: "/super-admin/governance" },
  { name: "reliability", path: "/super-admin/reliability" },
  { name: "support-access", path: "/super-admin/support-access" },
  { name: "tenant-health", path: "/super-admin/tenant-health" },
  { name: "launch-readiness", path: "/super-admin/launch-readiness" },
  // Phase 3 surfaces
  { name: "organizations", path: "/super-admin/organizations" },
  { name: "users", path: "/super-admin/users" },
  { name: "platform-lifecycle", path: "/super-admin/platform/lifecycle" },
  { name: "commercial-plans", path: "/super-admin/commercial/plans" },
  { name: "commercial-subscriptions", path: "/super-admin/commercial/subscriptions" },
  { name: "commercial-entitlements", path: "/super-admin/commercial/entitlements" },
  { name: "plane1-billing", path: "/super-admin/commercial/invoices" },
  { name: "financial-operations", path: "/super-admin/financial-operations" },
  { name: "audit-logs", path: "/super-admin/audit-logs" },
];

async function main() {
  const server = await serve();
  const port = server.address().port;

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Seed a session so ProtectedRoute admits the super_admin surface.
  await page.addInitScript(([user]) => {
    localStorage.setItem("zoiko_billing_access", "audit-token");
    localStorage.setItem("zoiko_billing_refresh", "audit-refresh");
    localStorage.setItem("zoiko_billing_user", JSON.stringify(user));
  }, [USER]);

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const hit = MOCKS.find((m) => m.match.test(url));
    if (hit) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hit.body) });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  mkdirSync(fileURLToPath(new URL("../../docs", import.meta.url)), { recursive: true });
  const results = [];

  for (const target of PAGES) {
    await page.goto(`http://127.0.0.1:${port}${target.path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600); // allow lazy chunks to settle
    await page.addScriptTag({ content: AXE_SRC });
    const axeResults = await page.evaluate(() => window.axe.run(document, {
      resultTypes: ["violations"],
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
    }));
    results.push({
      page: target.name,
      url: target.path,
      violations: axeResults.violations.map((v) => ({
        id: v.id, impact: v.impact, tags: v.tags,
        help: v.help, nodes: v.nodes.length,
        samples: v.nodes.slice(0, 5).map((n) => n.html.slice(0, 220)),
      })),
      passes: axeResults.passes.length,
      incomplete: axeResults.incomplete.length,
    });
    console.log(`audited ${target.path}: ${axeResults.violations.length} violation rule(s)`);
  }

  await browser.close();
  server.close();

  writeFileSync(
    fileURLToPath(new URL("../../docs/a11y-audit-results.json", import.meta.url)),
    JSON.stringify({ generated_at: new Date().toISOString(), standard: "WCAG 2.2 AA (axe-core)", results }, null, 2)
  );
  console.log("written docs/a11y-audit-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
