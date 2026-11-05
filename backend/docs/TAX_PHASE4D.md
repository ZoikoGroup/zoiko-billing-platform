# Global Tax — Phase 4d: Vendor-Independent Work

Phase 4d connects the real provider. Its vendor gates (Secret Manager, the
reconciliation worker, the launch-gate checklist) are in `TAX_PHASE4D0.md`
and `TAX_LAUNCH_GATES.md`.

This file covers the 4d work that doesn't need the vendor:
- the conformance runner the real adapter will be certified with;
- the two items deferred from 4c.

**Not switched on:** no provider, resolver or US/Canada activation exists in
production.

## What changed

| Area | Summary |
|---|---|
| **Conformance runner** | `run_all(make_adapter, secret=…)` in `tests/tax_provider_conformance` runs every check against an adapter factory and returns a report: per-check status (passed, failed with the reason, skipped with the reason), `failed`, `skipped`, `passed`. The credential is redacted from every detail. Idempotency keys are prefixed per run (`run_id`), so a sandbox that remembers keys can be re-run. **`passed`** requires: no failures, a reason on every skip, and the redaction check having run (a credential given). Command line: `TAX_CONFORMANCE_SECRET=… python -m tests.tax_provider_conformance pkg.module:make_adapter` prints the JSON report (gate 03 evidence) and exits 1 unless it passed. |
| **Manual address resolution** (deferred from 4c) | For an address the resolver couldn't place precisely, where its latest resolution is AMBIGUOUS or NOT_FOUND. Steps: (1) a billing admin proposes the districts (country first, the address's state included, all in the registry and in that country) with a reason; (2) an evidence document is attached once (PDF, PNG or JPEG, hashed and stored like certificate evidence, through the shared `store_evidence_file`); (3) a **different finance approver** approves. Approval needs the evidence and an unchanged address, and re-checks the codes against the registry. It writes a RESOLVED resolution with precision `MANUAL`, resolver `manual` and source `manual:<id>`. That resolution expires like any other. One open proposal per address; proposals can be withdrawn or rejected. Every step is audited. Table `tax_manual_resolution_requests`: key fields frozen, evidence write-once (ORM and Postgres). |
| **Pseudonym remapping export** (deferred from 4c) | During a key rotation, `TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS` (or `…_PREVIOUS_SECRET`, a **numbered** Secret Manager version) holds the outgoing key. `POST /pseudonym-key/remap-export` (billing admin) returns a CSV of `old_customer_ref,new_customer_ref` for every customer on the tenant's provider transactions. Pseudonyms only; no ids, names, emails or key material; `Cache-Control: no-store`; audited as EXPORT with the count and both fingerprints. It is **refused** when: no key was ever acknowledged; the previous key isn't the acknowledged one (a wrong key would give a useless map); or the current key is unchanged. `GET /pseudonym-key` adds `previous_fingerprint` and `remap_export_available`. |
| **Migration** | `b8e2d4f6a0c3`: `tax_manual_resolution_requests` with its tenant record guard and the evidence write-once trigger. `CRITICAL_COLUMNS` updated. |

## The rotation procedure, end to end

1. **Create the new key.** Add a new version of `tax-provider-pseudonym-key`
   in Secret Manager. Don't switch to it yet.
2. **Point the app at both keys.** In the VM `.env`:
   - `TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS_SECRET` = the **current** version
     (the outgoing key);
   - `TAX_PROVIDER_PSEUDONYM_KEY_SECRET` = the **new** version.

   Restart. Provider issuing now blocks with "pseudonym key changed — remap
   required". That is intended: nothing is sent under the new key yet.
3. **Export the remap.** Per tenant, a billing admin runs
   `POST /pseudonym-key/remap-export` and the provider's customer records
   are remapped (provider tooling or support).
4. **Acknowledge the new key.** Per tenant, a billing admin proposes the
   acknowledgement and a different finance approver approves it. Issuing
   resumes.
5. **Clean up.** Once every tenant has acknowledged, remove
   `TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS_SECRET` and restart. Disable the old
   key version in Secret Manager after the retention the DPO sets.

## Decisions to review

1. **Manual resolution only after the resolver has tried.** It is refused
   for an address never resolved, or already RESOLVED by the resolver, so
   it can't bypass the resolver.
2. **The remap covers customers on provider transactions** in states that
   reached the provider (REMOTE_COMMITTED, DONE, VOIDED, UNCERTAIN,
   REVIEW_REQUIRED). A customer only quoted, never committed, is not listed;
   the provider holds nothing for them.
3. **The remap is a download, not a provider API call.** How the provider
   takes the mapping depends on the vendor (4d proper).

## Tests

| Test file | Covers |
|---|---|
| `tests/test_tax_provider_conformance.py` (+5) | `run_all` passes the fake and reports every check; fresh keys per run (a shared ledger run twice); failures reported with the credential redacted; no credential means not passed; the command line |
| `tests/test_tax_phase4d_deferred.py` (16) | Manual resolution: evidence and a second person, then RESOLVED/MANUAL and the quote; only after the resolver failed; code checks (country first, state, registry, duplicates); one open proposal and withdraw; rejection resolves nothing; evidence write-once and the proposal frozen; a changed address invalidates it; it expires like any other; other tenants can't see or decide it. Remap: old/new pairs for provider customers only, audited without key material; wrong outgoing key refused; no rotation refused; the previous-key secret must be a numbered version |
| `tests/privacy/test_tax_phase4d_deferred_api.py` (7) | Manual resolution over HTTP (propose, evidence with hash, maker can't approve, checker approves, evidence view, download, paging); strict request (422 on an empty reason, extra fields, empty codes); **T13**: platform roles get 403 on manual resolutions and the remap, other tenants get 404 or an empty list; the remap CSV is pseudonyms only, no-store, billing admin only |
| `tests/test_tax_phase4c_pg.py` (+1, Postgres) | Manual resolution frozen, evidence write-once, triggers present, and the resulting resolution frozen |

**CI result:** local only (not pushed). The Postgres test runs in CI on push.
