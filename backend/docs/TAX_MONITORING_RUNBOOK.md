# Tax Monitoring Runbook

## How tax alerts work

- **Where they come from.** Each alert below is an Attention item with
  source `tax_monitoring`, raised by the scheduled job "Tax Monitoring and
  Alerts" (`tax_monitoring_job`, every `TAX_MONITORING_INTERVAL_MINUTES`,
  default 5).
- **Where they appear.** In the Super Admin Attention list, with the same
  severities, SLA clocks and escalation as every other platform alert.
- **When they close.** They resolve automatically once the condition clears.
- **No tenant data.** Alert texts and metrics never name a tenant, invoice
  or customer.
- **To find who is affected:**
  - tenant admins see their own rows at `/billing/tax/governance/transactions`;
  - tax staff see aggregates at `/super-admin/tax/providers`;
  - the live metrics are at `GET /api/v1/super-admin/tax-registry/monitoring`.

Thresholds are settings (in `backend/.env`); the defaults are shown below.

---

## tax.outbox_oldest_unresolved (P1)

**Fires when:** the oldest provider outbox row in PENDING, UNCERTAIN,
REMOTE_COMMITTED or REVIEW_REQUIRED is older than
`TAX_ALERT_OUTBOX_OLDEST_AGE_MINUTES` (30).

**Means:** an invoice is stuck between the provider and us. Its draft is
locked.

**Do:**
1. Check `tax.reconciliation_heartbeat` first. If the worker is down,
   nothing moves (see below).
2. On `/super-admin/tax/providers`, check the counts per state and the
   circuit.
3. The tenant's billing admin opens **Provider transactions**, then **Check
   provider state**:
   - committed at the provider: reconciliation finishes it;
   - not found: retry, or let the grace period cancel it.
4. A row in REVIEW_REQUIRED needs the tenant's two-person decision. Never
   edit outbox rows by hand.

## tax.reconciliation_heartbeat (P1)

**Fires when:** while `TAX_PROVIDER_RECONCILIATION_ENABLED`, the
reconciliation worker:
- has never recorded a heartbeat; or
- last finished more than `TAX_ALERT_HEARTBEAT_STALE_MINUTES` (15) ago; or
- failed its last pass.

**Means:** provider issuing is blocked for everyone; it fails closed.

**Do:**
1. On the VM, check the worker: `systemctl status zoiko-billing-tax-worker`
   (staging: `zoiko-billing-staging-tax-worker`).
2. Read `journalctl -u zoiko-billing-tax-worker -n 100`.
3. Restart it: `sudo systemctl restart zoiko-billing-tax-worker`.
4. If passes keep failing, check database connectivity and the secret store
   (see `tax.secret_store_failures`).
5. Full procedure: `TAX_RECONCILIATION_WORKER.md`.

## tax.circuit_open:\<provider\> (P1)

**Fires when:** a provider's circuit breaker is OPEN after repeated
failures.

**Means:** quotes and issuing through that provider return
PROVIDER_UNAVAILABLE until the cool-down ends. Nothing is sent.

**Do:**
1. Check the provider's status page or contact the provider.
2. The circuit closes by itself after the cool-down if calls succeed.
3. If the provider is down for long, a TAX_PUBLISHER can **Suspend** it on
   `/super-admin/tax/providers` (reason and MFA), and **Resume** it after.
4. Tell support: affected tenants see "Tax provider unavailable" and their
   drafts stay drafts.

## tax.provider_unavailable:\<market\> (P2)

**Fires when:** at least `TAX_ALERT_PROVIDER_UNAVAILABLE_RATE` (20%) of the
quotes in that market were PROVIDER_UNAVAILABLE over the last
`TAX_ALERT_RATE_WINDOW_MINUTES` (60), with at least
`TAX_ALERT_RATE_MIN_QUOTES` (10) quotes. The market is the supply country.

**Means:** that market can't quote through its provider.

**Do:**
1. Check for a related `tax.circuit_open` or `tax.secret_store_failures`
   alert.
2. Check the provider's health for that market.
3. If one tenant's connection is the cause (revoked or untested
   credentials), the tenant admin sees it on **Provider connections**.
   Support can guide them; never change a tenant's credentials.

## tax.not_determined:\<market\> (P3)

**Fires when:** at least `TAX_ALERT_NOT_DETERMINED_RATE` (50%) of the
quotes in that market were NOT_DETERMINED (needs evidence, unsupported, or
a NOT_DETERMINED line) over the window, with the minimum count.

**Means:** invoices can't be issued with governed tax. This is often
expected in a new market: missing classifications, addresses or
registrations.

**Do:**
1. Check whether a rate, pack or availability was just superseded or
   withdrawn (`/super-admin/tax/overview` and the explorer).
2. If not, it is tenant data: the blocking reasons and owners are on each
   tenant's **Exceptions** page.
3. Raise it with the tax lead if a whole market is affected.

**Never:** "fix" it by setting a 0% rate.

## tax.review_backlog (P2)

**Fires when:** `TAX_ALERT_REVIEW_BACKLOG` (5) or more provider outbox rows
are in REVIEW_REQUIRED.

**Means:** people need to decide on drift, unresolved commits or refused
adjustments.

**Do:** tenant billing admins and finance approvers work through
**Provider transactions** (check state, retry, or a two-person void).
Support can remind the tenant admins. Platform staff can't decide for them
(T13).

## tax.secret_store_failures (P1)

**Fires when:** `TAX_ALERT_SECRET_STORE_FAILURES` (1) or more quotes in the
window were refused because provider credentials were unavailable.

**Means:** the secret store (GCP Secret Manager or the Fernet key) can't be
read. Provider quoting and issuing fail closed.

**Do:**
1. **gcp:**
   - check the service account's IAM (`roles/secretmanager.secretAccessor`
     on the tax secrets);
   - check the project and region settings
     (`TAX_SECRET_MANAGER_PROJECT` / `_REGION`);
   - check the Secret Manager status.
2. **fernet:** check that `TAX_PROVIDER_ENCRYPTION_KEY` (or its secret) is
   present and unchanged.
3. Look in the backend log for `SecretStoreUnavailable`. Values are never
   logged.
4. See `TAX_PHASE4D0.md`.

---

## tax.rule_pack_integrity (P1)

**Fires when:** an ACTIVE native rule pack's running code is not the code
its version was approved with. It is checked at startup, on every
monitoring run, and whenever a quote is refused for this reason.

**Means:** a deploy changed a pack's code (or removed it) without a new
approved version. Quotes for that pack's markets are refused with
NOT_DETERMINED / `RULE_PACK_INTEGRITY_FAILED`. Nothing falls back to
another engine. Other markets and legacy invoicing are unaffected.

**Do:**
1. Open the pack in the console (`/super-admin/tax/rule-packs`). It shows
   the approved and running hashes and MISMATCH or CODE_MISSING.
2. Find the deploy that changed `app/modules/tax/rule_packs/`.
3. **If the change was not meant to change the pack:** roll back the
   deploy. The alert clears on the next monitoring run.
4. **If it was:** bump the pack's `version` in code, then register, review
   and publish the new version (two people, with golden tests). The new
   version supersedes the old one, and the alert clears.
5. Never edit `code_hash` in the database; the guard refuses it.
6. See `TAX_PHASE8.md`.

---

## tax.activation_late (P1)

**Fires when:** a SCHEDULED rule-pack or market-availability version is
more than `TAX_ALERT_ACTIVATION_LATE_MINUTES` (10) past its activation
time.

**Means:** a scheduled tax change has not taken effect. Either the
activation job isn't running, or its checks failed (the alert says "check
failed").

**Do:**
1. Open the version in the console. A red alert shows the activation
   error, if any.
2. **Check failed:** fix the cause and the next run (every minute)
   activates it. Common causes:
   - integrity: the pack's code differs (see `tax.rule_pack_integrity`);
   - the regression report is not current: run it;
   - the start date has passed, so it would now be retroactive: cancel the
     schedule (two people) and choose a later start date in a new version.
3. **No error:** the job isn't running. Check the scheduler ("Tax
   Scheduled Activation" in the tracked jobs) and the backend log.
4. To stop it instead: a TAX_PUBLISHER proposes "Cancel scheduled
   activation", and a different TAX_PUBLISHER approves with MFA.

---

## Stopping or reverting a tax change (Phase 8 PR 3)

### Decision tree

1. **Is the problem a version that hasn't activated yet (SCHEDULED)?**
   Cancel the schedule: a TAX_PUBLISHER (or the submitting reviewer)
   proposes, a different TAX_PUBLISHER approves with MFA. Nothing live
   changes.
2. **Is there a known-good earlier version?** Roll back:
   - a TAX_PUBLISHER proposes on the bad version (Propose rollback): choose
     the version to restore, a severity and a reason; acknowledge any
     pending schedule;
   - a different TAX_PUBLISHER approves with MFA; it applies at once.
   - For a pack version that a later version already follows, choose
     quarantine only.
3. **No known-good state, or unsure what is right?** Publish the market as
   **SUSPENDED**: every quote in it is NOT_DETERMINED until a new version is
   published.

### Realistic time to stop

| Action | Steps | People | Expected time (both available) |
|---|---|---|---|
| Rollback | propose, approve with MFA | 2 TAX_PUBLISHERs | 5 to 15 minutes |
| Cancel a schedule | propose, approve with MFA | publisher (or the submitting reviewer) + another publisher | 5 to 15 minutes |
| SUSPENDED | draft, validate, submit (TAX_REVIEWER); approve and publish with MFA (TAX_PUBLISHER) | 2 | 15 to 30 minutes |

**Existing switches:**
- **Provider markets:** P9 provider suspend (one TAX_PUBLISHER with MFA)
  stops a provider at once.
- **Native markets:** no market-scoped single-person stop exists. The
  platform-wide invoice-finalization breaker (a super admin, time-bound)
  stops all invoice issuing for every tenant and market, legacy included;
  it is a last resort, and it stops issuing, not quoting.
- A single-person break-glass market stop is an open policy question in
  `TAX_PHASE8.md`; it is not built.

### Who does what

- **Proposer (TAX_PUBLISHER):** chooses the target, the severity and the
  reason; confirms any pending schedule is cancelled.
- **Approver (a different TAX_PUBLISHER):** reads the reason, the
  regression report (P against V) and the schedule note; approves with
  MFA.
- **On call:** acknowledges the P1 `tax.rollback_applied:<id>` item.
- **Tax lead:** starts the retroactive analysis (PR 4).

### Verify

- The bad version shows **Rolled back** with its date range; the new
  version shows "Restores #P (rollback of #V)" (packs and availability).
- A quote for a date in the range returns `RULE_PACK_ROLLED_BACK`; a quote
  for today uses the restored logic.
- The P1 item states the range and the counts; affected tenants have a
  review item and their admins an email.
- `tax.rule_pack_integrity` stays clear (P's module ships).

### Hand over to retroactive analysis (PR 4)

Approving a pack rollback enqueues its retroactive analysis automatically.
Follow it at `/super-admin/tax/retro` (aggregates and progress); when it is
done, the rollback's P1 item and each affected tenant's review item say so,
and tenants see their own report.

---

## tax.rollback_applied:\<request\> (P1)

**Fires when:** an emergency rollback is applied. It stays open until
acknowledged (it is an event, not a condition).

**Means:** a tax version was rolled back or quarantined. The text gives the
pack or market, the rolled-back date range, the counts of open quotes made
STALE and NOT_DETERMINED, committed quotes for analysis and the number of
organizations affected.

**Do:** follow "Verify" and "Hand over" above, then acknowledge.

---

## tax.retro_analysis:\<id\> (P2, or P1 when it failed)

**Fires when:** a retroactive analysis of a rate or pack change finishes
(P2), or any analysis fails (P1, retried by the job). Rollback analyses
update the rollback's own item instead.

**Means:** issued invoices were compared after a change for past dates. The
text gives organization and document counts and per-currency amounts
(banded below 3 organizations). Nothing issued was changed.

**Do:**
1. Review the aggregates at `/super-admin/tax/retro`.
2. Over-collection: correction drafts arrive with PR 4b; for now tenants
   see a preview in their report.
3. Under-collection: report only; escalate to the tax lead.
4. Failed: check the backend log for the analysis id; the job retries.
5. Acknowledge.

---

## Daily anomaly checks (Phase 7 PR 3)

These come from the daily `tax_anomaly_job`. No invoice is ever changed by
the check or by these steps. Corrections go through credit notes, or the
Phase 7 remediation tooling, with two people.

### tax.anomaly.snapshot (P1)

**Means:** a governed invoice's tax or totals no longer equal its committed
quote. Something wrote to an issued invoice outside the governed path.

**Do:**
1. Treat it as an incident: find what changed the row (deploy, script or
   direct SQL).
2. The tenant's review item lists each difference.
3. Restore from the audit trail only through an approved, documented
   change, never silently.

### tax.anomaly.provider_drift (P1)

**Means:** the provider's committed total differs from ours.

**Do:**
1. On **Provider transactions**, the tenant runs **Check provider state**.
2. If the provider is wrong, raise it with the provider.
3. If we are wrong, correct with a credit note and re-issue, with two
   people.

### tax.anomaly.credits (P2)

**Means:** credit notes total more than the invoice, or credit more tax
than it charged.

**Do:**
1. The tenant's finance approver reviews the credit notes on the review
   item.
2. Void the extra one through the normal credit-note flow.

### tax.anomaly.zero_tax:\<market\> (P2) and tax.anomaly.rate_mix:\<market\> (P3)

**Means:** the share of zero-tax invoices, or the mix of rates, in that
market changed sharply against the last 30 days.

**Do:**
1. Check for a just-published rate, pack or availability change
   (`/super-admin/tax/overview`, the explorer, rule packs).
2. Check for a large tenant onboarding.
3. If it's unexplained, involve the tax lead before more invoices go out.
