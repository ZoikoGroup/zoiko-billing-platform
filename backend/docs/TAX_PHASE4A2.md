# Global Tax — Phase 4a-2: Provider Connections, Corrections, Regime Changes

The admin half of Phase 4a (plan: `TAX_PHASE4_PLAN.md`). It runs against the
fake only.

**Not switched on:**
- `PROVIDER_REGISTRY` is empty in production.
- No production credential can be stored (4d gate).
- No provider activation exists.

The exact request and response shapes for the frontend are in
`TAX_CONTROL_CENTER_API.md`.

## What changed

| Area | Summary |
|---|---|
| **Provider connections** | `tax_provider_connections` holds a seller entity's connection to a provider: environment (SANDBOX/PRODUCTION) and mode (ESTIMATE_ONLY/COMMIT). A billing admin proposes and a different finance approver approves. There is **no URL anywhere**: `PROVIDER_REGISTRY` (code) maps provider and environment to an allowlisted `https://` endpoint, and the request schema refuses any extra field (`base_url`, `endpoint`, …) with 422. `test_connection` calls only the allowlisted endpoint and records health without echoing credentials. |
| **Credentials** | `SecretStore` interface; interim `FernetSecretStore` under `TAX_PROVIDER_ENCRYPTION_KEY`. That key is dedicated: refused if unset or equal to the MFA key. Credentials are write-only: responses show `present`, `last_rotated_at` and the masked `last4`. Rotation replaces and deletes the old secret. Set, rotate and revoke are all audited. **Revocation** deletes the secret and makes the connection `SUSPENDED` (T16): quotes and issuing through it fail closed. Resuming needs new credentials, a request by one person and approval by another. **Production credentials are refused** until `TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED` is enabled at the 4d gate (GCP Secret Manager). |
| **Provider activations** | `PROVIDER_APPROVED` activations reference exactly one `provider_connection_id`. Approval requires that connection to be APPROVED, credentialed, for the same seller entity, with a registered provider. A provider market is approved three times, each by two people: the platform market, the tenant connection and the tenant activation. The resolver builds the adapter from the connection: the allowlisted endpoint, the stored credential and the connection's mode. A connection that isn't usable makes the activation non-effective, which gives NOT_DETERMINED and blocks issue. |
| **Nexus** | The commit payload's `seller.registered_jurisdictions` lists every jurisdiction and tax type where the entity holds a valid registration (with its number) or an approved legal basis on the tax date. 4a-1 already sets REVIEW_REQUIRED when the provider applies tax outside the activations. Activations themselves need a registration or legal basis. |
| **Quotes and outbox** | `tax_quotes.provider_connection_id` records the connection that computed the quote (frozen). Outbox rows carry it, so issuing, reconciliation and corrections all use the same connection. |
| **Exemption certificates (model, T14)** | `reason_code`. Evidence upload accepts PDF, PNG or JPEG: the declared type must match the file signature, the size limit is `TAX_EVIDENCE_MAX_BYTES` (5 MB), and the server-computed SHA-256 is checked against the client's `sha256` when sent. Storage is content-addressed per tenant in `tax_evidence_files`: write-once, deletable only by the erasure purge. A certificate's evidence is attached once (ORM and Postgres guard). Download is tenant-only: platform roles get 403 (T13). Expiry still raises review items through the Phase 2 sweep. No certificate creates an automatic 0% (they are used in 4c). |
| **Corrections by reference (T15/T18)** | A governed credit note on a provider-committed invoice writes an `ADJUST` outbox row in the same commit. The row carries the original transaction id and the signed adjustment payload, and is delivered through `adapter.adjust`. A refusal goes to REVIEW_REQUIRED (the credit stands; a person settles the provider side). An ambiguous outcome becomes UNCERTAIN and is resolved by `transaction_state(adjust key)`. Cancelling or voiding a provider-committed invoice writes a `VOID` row in the same commit and voids the provider transaction by reference. |
| **Product question 6** | `POST /regime` now **proposes** a change in either direction (`tax_regime_changes`). A different finance approver decides it, and the approver's decision applies it. GOVERNED is re-checked for eligibility at approval. The entity's version is bumped, so open quotes go stale. Issued invoices and committed quotes are never touched. The settings toggle refuses changing a GOVERNED entity's regime. |
| **Stuck-transaction API** | `GET /provider-transactions` (tenant, newest first, B3) and `GET …/{id}`. Actions: `check-state` (read-only), `retry` (only rows that failed on our side or are unresolved; uncommitted rows go back through a state lookup), and `void-request` / `void-approve` (two people; void by reference only if the invoice was never sent). |
| **Contract** | `adapter.adjust()` and `adapter.test_connection()`. The conformance suite gains `check_adjust_by_reference`. |
| **Migration** | `b5e9d2c7a4f1`: four tables, the new columns, Postgres guards (new tables; activation, certificate, quote and outbox guards recreated with the new frozen columns; certificate evidence write-once). `CRITICAL_COLUMNS` updated. |

## Decisions to review

1. **Enabling GOVERNED is now two-person too.**
   - In 3b, `POST /regime` with GOVERNED switched immediately for an org
     admin. The working assumption for question 6 said leaving needs "the
     same two-person approval as enabling", and your rule says nothing new is
     approvable by a single user. So both directions are now proposals.
   - This is a behaviour change on an existing route. No frontend uses it
     yet.
2. **Tenant approvals have no MFA step-up**, and that hasn't changed.
   - Connections and regime changes use exactly the activations' path: a
     finance approver who is not the proposer.
   - Tenant activations never had MFA step-up; only platform registry
     decisions do.
   - Adding step-up to all tenant tax approvals would be a separate,
     consistent change. Should it be done?
3. **Revocation is a single-person action** (billing admin). It only ever
   freezes, which is the safe direction. Resuming needs two people.
4. **A refused ADJUST goes to review and does not reverse the credit
   note.** The legal credit stands, and a person settles the provider side.

## Credential key rotation (interim Fernet store)

1. Generate a new Fernet key. Keep the old one available.
2. For every connection with credentials, have a tenant billing admin
   re-enter the credentials (`PUT …/credentials`). Each re-entry is
   encrypted under the new key and the old secret row is deleted. Rotation
   is audited per connection.
   - A bulk re-encryption job (old key to new key, no plaintext logged) is
     the alternative. It is not built in 4a-2.
3. Switch `TAX_PROVIDER_ENCRYPTION_KEY` to the new key and restart.
   Connections not yet re-entered fail closed ("could not be decrypted"),
   giving PROVIDER_UNAVAILABLE and no issuing. Re-enter them.
4. Destroy the old key.

**The pseudonymous customer-reference key** (plan change 9) is not used yet.
When it is, rotating it requires the remapping step in the plan.

GCP Secret Manager replaces this store at the 4d gate. Until then
`TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED` stays false.

## Tests

| Test file | Covers |
|---|---|
| `tests/test_tax_phase4a2.py` (24) | Connection two-person approval and audit; unknown provider; test-connection to the allowlisted host only; write-only and masked credentials (ciphertext only); rotation audited and the old secret deleted; **revocation freezes (T16)**; resume with new credentials and two people; production credentials refused; dedicated key required; provider activation needs an approved connection; **issue end to end through the connection, with the registered-jurisdiction set in the payload**; estimate-only connection; certificate evidence typed, hashed, write-once and tenant-scoped, plus the size limit; **T15** adjust by reference, idempotent; **T18** full credit nets to zero; adjust timeout settled by state lookup; refused adjust goes to review; void on cancellation; **question 6** switch-back two-person and issued records untouched; settings toggle refused; enabling two-person; stuck void two-person; retry |
| `tests/privacy/test_tax_phase4a2_api.py` (20) | **No SSRF** (`base_url`, `endpoint`, `url`, `host` give 422); test-connection host; credentials never in any response; revocation over HTTP; two-person connection approval; **T13** (platform roles get 403 on connections, transactions, certificates, evidence and regime changes; other tenants get 404); certificate upload and download; B3 on every new list; connection paging; regime-change routes |
| `tests/test_tax_provider_conformance.py` | `check_adjust_by_reference` added |
| `tests/test_tax_phase4a2_pg.py` (5, Postgres only, CI tax step) | Tables and triggers; frozen connection keys; activation and quote keep their connection; certificate evidence write-once and retained; issue and credit through a connection on Postgres |

**Changed fixtures:**
- The 3a world registers the fake in `PROVIDER_REGISTRY` and creates an
  approved, credentialed sandbox connection for its provider activation.
- The 3b `govern()` helper proposes, then a different user approves.
- The 3b T12 source scan now checks every `.tax_regime =` assignment.
- `tests/conftest.py` sets a per-session test key for
  `TAX_PROVIDER_ENCRYPTION_KEY`.

**CI result:** _see PR_.
