# Global Tax — Phase 4d-0, PR 1: GCP Secret Manager

The first vendor-independent 4d gate: provider credentials and tax keys in
GCP Secret Manager.

**Not switched on:**
- The default store is still `fernet`.
- `TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED` stays false.
- No provider is registered.

Production moves to Secret Manager when our GCP admin has provisioned the
items in the provisioning section below.

## What changed

| Area | Summary |
|---|---|
| **`GcpSecretManagerStore`** | Implements `SecretStore` (`secret_store.py`). One secret per provider connection: `tax-provider-{env}-org{org_id}-conn{connection_id}`, labelled `purpose=tax-provider`, `org_id`, `connection_id`, `environment`. Replication is user-managed in `TAX_SECRET_MANAGER_REGION` (or automatic when empty). The database keeps only `credential_store`, `credential_secret_name` (resource name), `credential_version` and `credential_previous_version`; never the value. |
| **Org-label check** | Every read (and every reuse of an existing secret name) first checks the secret's `org_id` and `connection_id` labels against the caller's connection. A mismatch fails closed without reading the value. |
| **Rotation** | `PUT …/credentials` adds a new version and points the connection at it. The previous version stays **enabled** until `test_connection` succeeds on the new one, then it is disabled. A failed test keeps it, so rotating back is possible. Rotating twice before a test disables the untested middle version and keeps the last confirmed one. Each step is audited (store, version numbers, `previous_version_disabled`), never the value. The view adds `credentials.store` and `credentials.rotation_pending_test`. |
| **Revocation** | Destroys **every** version of the connection's secret, then suspends the connection (T16). If Secret Manager is unreachable, the connection is still suspended and its references cleared, the audit records `versions_destroyed: false`, and the call returns an error asking to revoke again. A retry destroys the versions. |
| **Authentication** | Application Default Credentials from the VM's attached service account. `GOOGLE_APPLICATION_CREDENTIALS` (a key file) is refused at startup and by the client. |
| **Fail closed** | Any Secret Manager error (unreachable, timeout, denied, not found, label mismatch) is `SecretStoreUnavailable`, carrying the exception type only. Quoting → **PROVIDER_UNAVAILABLE** ("Provider credentials are unavailable: …"). Issuing → refused, the invoice stays a draft. Delivery → the row waits with `last_error`. There is never a fallback to Fernet. Credentials held in a store other than the configured one are unusable until re-entered ("re-enter them"). |
| **Store choice** | `TAX_PROVIDER_SECRET_STORE=gcp\|fernet`. At startup (`verify_secret_store_at_startup`, refusing with SystemExit): an unknown store; `TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED=true` without `gcp`; `gcp` without `TAX_SECRET_MANAGER_PROJECT` or with a key file; and in **production**, `fernet` while any PRODUCTION connection exists. Production credentials are accepted only with the flag **and** the gcp store. |
| **Keys by resource name** | `TAX_PROVIDER_PSEUDONYM_KEY_SECRET` and `TAX_PROVIDER_ENCRYPTION_KEY_SECRET` take a version resource name. The value is loaded through the same ADC client, cached in memory for `TAX_SECRET_CACHE_TTL_SECONDS` (300), and never logged. The encryption key is never loaded in production (the Fernet store isn't used there). An unloadable pseudonym key blocks provider quoting and issuing ("pseudonym key unavailable"). A value left as `<SET_IN_SECRET_MANAGER>` counts as unset. |
| **Redaction** | The conformance suite gains `check_secret_store_never_leaks`, run against both stores. The value comes out of `get()` only. Store failures, their causes, logs and the connection view never contain it, even when the GCP error message itself echoes it. |
| **Dependencies** | `google-cloud-secret-manager==2.20.2`, plus `pyasn1-modules==0.3.0`: newer versions need pyasn1 ≥ 0.6.1, which python-jose refuses. The full requirements resolve together. |
| **Migration** | `e5c1a7b3d9f4`: the four `credential_*` columns on `tax_provider_connections`; existing credentials are marked `fernet`. `CRITICAL_COLUMNS` updated. |

## How each key reaches each environment

| Key / setting | Local and CI | Staging | Production |
|---|---|---|---|
| `TAX_PROVIDER_SECRET_STORE` | `.env` (`fernet`). CI sets nothing. | Deploy-injected GitHub secret/variable (`fernet` or `gcp`) | `gcp`, in the VM's `backend/.env` set by the GCP admin. Not a secret; not in `deploy.yml`. |
| Provider credentials | Fernet store (`tax_provider_secrets`) | Fernet store, or `gcp` with a staging project | **Secret Manager only**, one secret per connection, created by the app |
| `TAX_PROVIDER_ENCRYPTION_KEY` | `.env`. Tests generate a per-session key. | Deploy-injected GitHub secret, or `TAX_PROVIDER_ENCRYPTION_KEY_SECRET` | **Not used** (never loaded) |
| `TAX_PROVIDER_PSEUDONYM_KEY` | `.env`. Tests use a per-session key. | Deploy-injected GitHub secret | **Secret Manager only**: `TAX_PROVIDER_PSEUDONYM_KEY_SECRET=projects/<p>/secrets/tax-provider-pseudonym-key/versions/<n>`. Pin the version number, not `latest`: a new version is a key change (remap required). |
| `TAX_SECRET_MANAGER_PROJECT`, `TAX_SECRET_MANAGER_REGION` | unset | Staging project, if `gcp` | VM `backend/.env`, set by the GCP admin |
| `TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED` | `false` | `false` | `true` only at the 4d go-live gate, with `gcp` |

We have no staging deploy workflow today. When one is added, these values
come from its GitHub environment secrets. **None of them are added to
`deploy.yml` for production.**

## What our GCP admin must provision (production)

1. **API.** `gcloud services enable secretmanager.googleapis.com --project=<PROJECT>`.
2. **Region and replication.** Pick the region where the billing VM runs
   (data residency), and set `TAX_SECRET_MANAGER_REGION` to it. The app
   creates connection secrets with user-managed replication in that single
   region. If the organisation uses the `gcp.resourceLocations` policy,
   allow that region.
3. **Pseudonym key secret.** Create `tax-provider-pseudonym-key` once, with
   user-managed replication in the same region. Generate the value with
   `python -c "import secrets; print(secrets.token_urlsafe(48))"` and pipe
   it to `gcloud secrets create … --data-file=-` and
   `gcloud secrets versions add … --data-file=-`, never on the command line
   or in shell history. Give the app the version resource name. **Set it
   once:** changing it later blocks provider issuing until each tenant
   remaps and acknowledges it.
4. **Service account.**
   - Use a dedicated service account for the billing VM (for example
     `zoiko-billing-backend@<PROJECT>.iam.gserviceaccount.com`).
   - Attach it to the VM, with an access scope that includes
     `cloud-platform`.
   - Create **no keys** for it. Enforce this with
     `iam.disableServiceAccountKeyCreation` where possible.
   - The app refuses `GOOGLE_APPLICATION_CREDENTIALS`.
5. **IAM, scoped by name prefix.**
   - Create a custom role, `taxProviderSecrets`, with:
     `secretmanager.secrets.create`, `secretmanager.secrets.get`,
     `secretmanager.versions.add`, `secretmanager.versions.access`,
     `secretmanager.versions.disable`, `secretmanager.versions.destroy`,
     `secretmanager.versions.list`.
   - Grant it to the service account on the project, with this IAM
     condition:
     ```
     resource.name.startsWith("projects/<PROJECT_NUMBER>/secrets/tax-provider-")
     ```
     Secret Manager resource names in conditions use the project **number**.
     This keeps the app away from every other secret in the project. Do not
     grant `roles/secretmanager.admin` or an unconditioned accessor role.
   - **Verify** after granting:
     - creating `tax-provider-sandbox-org0-conn0` succeeds;
     - creating or reading any other name is denied.
   - If your organisation's policy evaluates `secrets.create` against the
     project rather than the new secret's name, grant `secrets.create` alone
     without the condition, and keep everything else conditioned.
6. **Audit logging.**
   - Admin Activity logs are always on.
   - Enable Data Access audit logs (`DATA_READ`, `DATA_WRITE`, `ADMIN_READ`)
     for `secretmanager.googleapis.com`, so every access, add, disable and
     destroy is logged with the principal.
   - Route them to the security log sink, with the retention the DPO sets.
   - Alert on access by any principal other than the billing service
     account.
7. **VM settings** (in `backend/.env` on the VM, by the admin):
   ```
   TAX_PROVIDER_SECRET_STORE=gcp
   TAX_SECRET_MANAGER_PROJECT=<PROJECT>
   TAX_SECRET_MANAGER_REGION=<REGION>
   TAX_PROVIDER_PSEUDONYM_KEY_SECRET=projects/<PROJECT>/secrets/tax-provider-pseudonym-key/versions/<N>
   ```
   Restart the service. Startup refuses an unsafe combination.

## Decisions to review

1. **Revocation suspends before destruction is confirmed.** If Secret
   Manager is down, the connection is still frozen and the call reports the
   failure; a retry destroys the versions. Freezing is the safe direction.
2. **The previous version is disabled, not destroyed**, after a successful
   test. That allows an audited re-enable during an incident. Revocation is
   what destroys.
3. **Credentials don't migrate between stores.** Switching
   `TAX_PROVIDER_SECRET_STORE` makes existing connections unusable until a
   billing admin re-enters their credentials. Re-entering removes the old
   store's copy, so there is never a silent copy or fallback.
4. **Production detection.** `ENVIRONMENT`/`APP_ENV`=production, or unset
   with `DEBUG` off, is treated as production (fail closed). Staging must
   set `ENVIRONMENT=staging`.

## Tests

| Test file | Covers |
|---|---|
| `tests/test_tax_phase4d0_secret_manager.py` (26) | Fake GCP client, no real GCP. One labelled, regional secret per connection, with only references in the DB. Quoting through it. **Org-label mismatch** on read and on a pre-existing secret name. **Rotation order**: the old version stays enabled through a failed test and is disabled after a good one; double rotation disables the untested version. **Revoke** destroys all versions and suspends, including when Secret Manager is unreachable (then retry). **Fail closed**: unavailable, denied and timeout give PROVIDER_UNAVAILABLE and never call Fernet; issuing refused after a good quote; other-store credentials unusable. Production credentials need the flag **and** gcp. **Startup refusals**: fernet in production with a PRODUCTION connection (allowed in staging or without one); the flag with fernet; unknown store; missing project; key file. Pseudonym key from Secret Manager, cached and never logged; unreachable key blocks; encryption key never loaded in production; placeholders count as unset. Redaction for both stores. |
| `tests/tax_provider_conformance/__init__.py` | `check_secret_store_never_leaks` |
| `tests/test_tax_phase4a2.py`, `tests/privacy/test_tax_phase4a2_api.py` | The credential view and rotation audit gained the additive store fields |

**CI result:** _see PR_.
