"""
tests/test_tax_phase4d0_secret_manager.py
-----------------------------------------
ZB-TAX-ARCH-001 Phase 4d-0: provider credentials in GCP Secret Manager.

The GCP client is a fake (tests/fixtures/fake_secret_manager.py); no real
GCP is called in CI. Covered: one labelled secret per connection with only
its name and version in the database, the org-label check on every read,
rotation order (the old version is disabled only after a successful test),
revocation destroying every version, the unreachable / denied fail-closed
path (PROVIDER_UNAVAILABLE, never Fernet), the startup refusals, keys loaded
by resource name, and no secret value in logs, exceptions or responses.
"""
import logging

import pytest
from google.api_core import exceptions as gexc

from app.config import settings
from app.modules.billing.models import BillingAuditLog
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.tax import secret_store
from app.modules.tax.connection_service import ProviderConnectionService, view_connection
from app.modules.tax.determination_service import TaxDeterminationService
from app.modules.tax.enums import ConnectionStatus, ProviderEnvironment, TaxQuoteStatus
from app.modules.tax.issuance_gate import GovernedIssuanceGate
from app.modules.tax.provider_contract import ProviderMode
from app.modules.tax.provider_models import TaxProviderSecret
from app.modules.tax.secret_store import (
    FernetSecretStore,
    GcpSecretManagerStore,
    SecretStoreUnavailable,
    verify_secret_store_at_startup,
)
from tests.fixtures.fake_secret_manager import FakeSecretManager
from tests.tax_provider_conformance import check_secret_store_never_leaks
from tests.test_tax_phase3a_governed import build_world, draft

PROJECT = "zoiko-tax-test"
CREDENTIAL = "gcp-sandbox-credential-SECRET-5678"


def _enable_gcp(monkeypatch) -> FakeSecretManager:
    fake = FakeSecretManager()
    monkeypatch.setattr(settings, "TAX_PROVIDER_SECRET_STORE", "gcp")
    monkeypatch.setattr(settings, "TAX_SECRET_MANAGER_PROJECT", PROJECT)
    monkeypatch.setattr(settings, "TAX_SECRET_MANAGER_REGION", "europe-west2")
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    secret_store.set_gcp_client_for_tests(fake)
    return fake


@pytest.fixture()
def gcp(monkeypatch):
    yield _enable_gcp(monkeypatch)
    secret_store.set_gcp_client_for_tests(None)


@pytest.fixture()
def w(db_session, monkeypatch):
    world = build_world(db_session, org_code="P4D0")              # credentials start in the fernet store
    world["gcp"] = _enable_gcp(monkeypatch)
    svc = ProviderConnectionService(db_session)
    svc.set_credentials(world["org"].id, world["maker"].id, world["connection"].id, CREDENTIAL)
    world["secret_name"] = (f"projects/{PROJECT}/secrets/tax-provider-sandbox-org{world['org'].id}"
                            f"-conn{world['connection'].id}")
    yield world
    secret_store.set_gcp_client_for_tests(None)


def quote(w):
    inv = draft(w, [(w["dig_product"], 100, 1, False)])
    return inv, TaxDeterminationService(w["db"]).create_quote(w["org"].id, w["maker"].id, "invoice", inv.id)


def svc(w):
    return ProviderConnectionService(w["db"])


# ── one labelled secret per connection; only references in the DB ──────

def test_one_labelled_secret_per_connection_and_only_references_in_the_db(w):
    c, fake = w["connection"], w["gcp"]
    secret = fake.secrets[w["secret_name"]]
    assert secret["labels"] == {"purpose": "tax-provider", "org_id": str(w["org"].id),
                                "connection_id": str(c.id), "environment": "sandbox"}
    assert secret["replication"] == {"user_managed": {"replicas": [{"location": "europe-west2"}]}}
    assert (c.credential_store, c.credential_secret_name, c.credential_version) == ("gcp", w["secret_name"], "1")
    assert c.credential_ref is None and w["db"].query(TaxProviderSecret).count() == 0   # fernet copy removed
    stored = [getattr(c, col.name) for col in c.__table__.columns]
    assert all(CREDENTIAL not in str(v) for v in stored)
    _, q = quote(w)
    assert q.status == TaxQuoteStatus.QUOTED and w["provider"].credentials == CREDENTIAL


def test_reads_check_the_org_label(w):
    w["gcp"].secrets[w["secret_name"]]["labels"]["org_id"] = "999999"     # someone else's secret
    with pytest.raises(SecretStoreUnavailable, match="does not belong"):
        GcpSecretManagerStore(w["db"]).get(w["connection"])
    _, q = quote(w)
    assert q.status == TaxQuoteStatus.PROVIDER_UNAVAILABLE and q.tax_amount is None
    assert "access" not in w["gcp"].calls[-1:]                            # no value was fetched


def test_an_existing_secret_with_other_labels_is_never_reused(w):
    conn = svc(w).propose(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id, provider_name="fake-provider",
                          environment=ProviderEnvironment.SANDBOX, mode=ProviderMode.ESTIMATE_ONLY)
    name = f"projects/{PROJECT}/secrets/tax-provider-sandbox-org{w['org'].id}-conn{conn.id}"
    w["gcp"].secrets[name] = {"labels": {"org_id": "424242", "connection_id": str(conn.id)},  # another org's
                              "replication": {"automatic": {}}, "versions": {}}
    with pytest.raises(SecretStoreUnavailable, match="does not belong"):
        svc(w).set_credentials(w["org"].id, w["maker"].id, conn.id, CREDENTIAL)
    assert w["gcp"].secrets[name]["versions"] == {}


# ── rotation: the old version is disabled only after a successful test ──

def test_rotation_adds_a_version_and_disables_the_old_one_only_after_a_good_test(w):
    c, fake = w["connection"], w["gcp"]
    svc(w).set_credentials(w["org"].id, w["maker"].id, c.id, "gcp-rotated-credential-0002")
    assert (c.credential_version, c.credential_previous_version) == ("2", "1")
    assert fake.states(w["secret_name"]) == {"1": "ENABLED", "2": "ENABLED"}
    assert view_connection(c)["credentials"]["rotation_pending_test"] is True

    w["provider"].credentials_ok = False                                  # the new credential is rejected
    svc(w).test_connection(w["org"].id, w["maker"].id, c.id)
    assert fake.states(w["secret_name"]) == {"1": "ENABLED", "2": "ENABLED"} and c.credential_previous_version == "1"

    w["provider"].credentials_ok = True
    svc(w).test_connection(w["org"].id, w["maker"].id, c.id)
    assert fake.states(w["secret_name"]) == {"1": "DISABLED", "2": "ENABLED"} and c.credential_previous_version is None
    logs = w["db"].query(BillingAuditLog).filter(BillingAuditLog.entity_type == "TaxProviderConnection",
                                                 BillingAuditLog.entity_id == c.id).all()
    assert any((l.new_values or {}).get("previous_version_disabled") == "1" for l in logs)
    assert any((l.new_values or {}).get("credentials") == "rotated" for l in logs)
    assert all(CREDENTIAL not in str(l.new_values) for l in logs)


def test_rotating_again_before_a_test_disables_the_untested_version(w):
    c, fake = w["connection"], w["gcp"]
    svc(w).set_credentials(w["org"].id, w["maker"].id, c.id, "gcp-rotated-credential-0002")
    svc(w).set_credentials(w["org"].id, w["maker"].id, c.id, "gcp-rotated-credential-0003")
    assert (c.credential_version, c.credential_previous_version) == ("3", "1")      # 1 = last confirmed
    assert fake.states(w["secret_name"]) == {"1": "ENABLED", "2": "DISABLED", "3": "ENABLED"}


# ── revocation destroys every version ───────────────────────────────────

def test_revocation_destroys_every_version_and_freezes(w):
    c, fake = w["connection"], w["gcp"]
    svc(w).set_credentials(w["org"].id, w["maker"].id, c.id, "gcp-rotated-credential-0002")
    svc(w).revoke_credentials(w["org"].id, w["maker"].id, c.id, "contract ended")
    assert fake.states(w["secret_name"]) == {"1": "DESTROYED", "2": "DESTROYED"}
    assert c.status == ConnectionStatus.SUSPENDED and c.credential_version is None
    log = w["db"].query(BillingAuditLog).filter(BillingAuditLog.entity_type == "TaxProviderConnection",
                                                BillingAuditLog.entity_id == c.id).order_by(BillingAuditLog.id.desc()).first()
    assert log.new_values["credentials"] == "revoked" and log.new_values["versions_destroyed"] is True


def test_revocation_freezes_even_when_secret_manager_is_unreachable(w):
    c, fake = w["connection"], w["gcp"]
    fake.fail["list"] = gexc.ServiceUnavailable("down")
    with pytest.raises(SecretStoreUnavailable, match="suspended"):
        svc(w).revoke_credentials(w["org"].id, w["maker"].id, c.id, "leaked")
    w["db"].refresh(c)
    assert c.status == ConnectionStatus.SUSPENDED and c.credential_version is None
    del fake.fail["list"]
    svc(w).revoke_credentials(w["org"].id, w["maker"].id, c.id, "retry")      # retry destroys the versions
    assert set(fake.states(w["secret_name"]).values()) == {"DESTROYED"}


# ── fail closed: unreachable or denied, never Fernet ────────────────────

@pytest.mark.parametrize("error", [gexc.ServiceUnavailable("down"), gexc.PermissionDenied("denied"),
                                   gexc.DeadlineExceeded("slow")])
def test_unreachable_or_denied_is_provider_unavailable_and_never_fernet(w, monkeypatch, error):
    def no_fernet(*a, **k):
        raise AssertionError("fell back to the Fernet store")

    monkeypatch.setattr(FernetSecretStore, "get", no_fernet)
    w["gcp"].fail["access"] = error
    inv, q = quote(w)
    assert q.status == TaxQuoteStatus.PROVIDER_UNAVAILABLE and q.tax_amount is None
    assert "Provider credentials are unavailable" in q.refusal_reason and type(error).__name__ in q.refusal_reason


def test_issuing_is_refused_when_secret_manager_fails_after_quoting(w):
    inv, q = quote(w)
    assert q.status == TaxQuoteStatus.QUOTED
    w["gcp"].fail["access"] = gexc.ServiceUnavailable("down")
    service = InvoiceService(w["db"])
    service.governed_gate = GovernedIssuanceGate(w["db"])
    with pytest.raises(Exception, match="credentials are unavailable"):
        service.finalize_invoice(inv.id, w["org"].id, w["maker"].id)
    assert w["provider"].payloads == []


def test_credentials_in_the_other_store_are_unusable_until_re_entered(db_session, monkeypatch):
    world = build_world(db_session, org_code="P4D0F")                      # fernet credentials
    monkeypatch.setattr(settings, "TAX_PROVIDER_SECRET_STORE", "gcp")
    monkeypatch.setattr(settings, "TAX_SECRET_MANAGER_PROJECT", PROJECT)
    secret_store.set_gcp_client_for_tests(FakeSecretManager())
    try:
        problem = ProviderConnectionService(db_session).usable_problem(world["connection"])
        assert "fernet store, not the configured gcp store" in problem
        _, q = quote(world)
        assert q.status != TaxQuoteStatus.QUOTED and q.tax_amount is None
    finally:
        secret_store.set_gcp_client_for_tests(None)


# ── production credentials need the gcp store ───────────────────────────

def _production_connection(w):
    connections = svc(w)
    conn = connections.propose(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id,
                               provider_name="fake-provider", environment=ProviderEnvironment.PRODUCTION,
                               mode=ProviderMode.COMMIT)
    return conn


def test_production_credentials_need_the_flag_and_the_gcp_store(w, monkeypatch):
    from app.core.exceptions import BadRequestException

    conn = _production_connection(w)
    with pytest.raises(BadRequestException, match="managed secret store"):
        svc(w).set_credentials(w["org"].id, w["maker"].id, conn.id, CREDENTIAL)
    monkeypatch.setattr(settings, "TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED", True)
    svc(w).set_credentials(w["org"].id, w["maker"].id, conn.id, CREDENTIAL)
    assert conn.credential_store == "gcp" and conn.credential_secret_name.endswith(f"-conn{conn.id}")
    assert "tax-provider-production-org" in conn.credential_secret_name
    monkeypatch.setattr(settings, "TAX_PROVIDER_SECRET_STORE", "fernet")
    with pytest.raises(BadRequestException, match="managed secret store"):
        svc(w).set_credentials(w["org"].id, w["maker"].id, conn.id, CREDENTIAL)


# ── startup refusals ────────────────────────────────────────────────────

class _Session:
    def __init__(self, db):
        self.db = db

    def query(self, *a, **k):
        return self.db.query(*a, **k)

    def close(self):
        pass


def test_startup_refuses_fernet_in_production_with_a_production_connection(w, monkeypatch):
    _production_connection(w)
    monkeypatch.setattr(settings, "TAX_PROVIDER_SECRET_STORE", "fernet")
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(SystemExit, match="refused in production"):
        verify_secret_store_at_startup(lambda: _Session(w["db"]))
    monkeypatch.setenv("ENVIRONMENT", "staging")                      # outside production it is allowed
    verify_secret_store_at_startup(lambda: _Session(w["db"]))


def test_startup_allows_fernet_in_production_without_production_connections(db_session, monkeypatch):
    monkeypatch.setattr(settings, "TAX_PROVIDER_SECRET_STORE", "fernet")
    monkeypatch.setenv("ENVIRONMENT", "production")
    verify_secret_store_at_startup(lambda: _Session(db_session))


@pytest.mark.parametrize("change, message", [
    ({"TAX_PROVIDER_SECRET_STORE": "fernet", "TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED": True}, "requires"),
    ({"TAX_PROVIDER_SECRET_STORE": "vault"}, "must be one of"),
    ({"TAX_SECRET_MANAGER_PROJECT": ""}, "TAX_SECRET_MANAGER_PROJECT"),
])
def test_startup_refuses_unsafe_store_settings(gcp, monkeypatch, change, message):
    for key, value in change.items():
        monkeypatch.setattr(settings, key, value)
    with pytest.raises(SystemExit, match=message):
        verify_secret_store_at_startup(lambda: None)


def test_startup_refuses_a_service_account_key_file(gcp, monkeypatch):
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/etc/key.json")
    with pytest.raises(SystemExit, match="key file"):
        verify_secret_store_at_startup(lambda: None)


def test_startup_accepts_the_gcp_store(gcp):
    verify_secret_store_at_startup(lambda: None)


# ── tax keys loaded by resource name ────────────────────────────────────

def test_pseudonym_key_loads_from_secret_manager_cached_and_never_logged(gcp, monkeypatch, caplog):
    from app.modules.tax.pseudonym import customer_pseudonym, key_fingerprint

    resource = gcp.add_key(PROJECT, "tax-provider-pseudonym-key", "sm-pseudonym-key-VALUE-77")
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "")
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_SECRET", resource)
    with caplog.at_level(logging.DEBUG):
        first = key_fingerprint()
        ref = customer_pseudonym(1, 2)
        assert key_fingerprint() == first and ref and ref.startswith("zc_")
    assert gcp.calls.count("access") == 1                                  # cached within the TTL
    assert "sm-pseudonym-key-VALUE-77" not in caplog.text
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "sm-pseudonym-key-VALUE-77")
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_SECRET", "")
    assert key_fingerprint() == first                                      # same key, same fingerprint


def test_an_unreachable_pseudonym_key_blocks_provider_quoting(w, monkeypatch):
    resource = w["gcp"].add_key(PROJECT, "tax-provider-pseudonym-key", "sm-pseudonym-key-VALUE-88")
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_SECRET", resource)
    w["gcp"].fail["access"] = gexc.PermissionDenied("denied")
    _, q = quote(w)
    assert q.status == TaxQuoteStatus.PROVIDER_UNAVAILABLE and q.tax_amount is None


def test_the_encryption_key_is_never_loaded_in_production(gcp, monkeypatch):
    resource = gcp.add_key(PROJECT, "tax-provider-encryption-key", "not-used")
    monkeypatch.setattr(settings, "TAX_PROVIDER_ENCRYPTION_KEY_SECRET", resource)
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(SecretStoreUnavailable, match="not used in production"):
        secret_store.config_secret("TAX_PROVIDER_ENCRYPTION_KEY")
    assert gcp.calls == []


# ── redaction (conformance) ─────────────────────────────────────────────

def test_the_gcp_store_never_leaks_a_secret(w, caplog):
    check_secret_store_never_leaks(GcpSecretManagerStore(w["db"]), w["connection"], CREDENTIAL, caplog,
                                   break_store=lambda: w["gcp"].fail.update({"*": gexc.ServiceUnavailable(
                                       f"echo {CREDENTIAL}")}))


def test_the_fernet_store_never_leaks_a_secret(db_session, caplog, monkeypatch):
    world = build_world(db_session, org_code="P4D0R")
    check_secret_store_never_leaks(FernetSecretStore(db_session), world["connection"],
                                   "fake-sandbox-credential-1234", caplog,
                                   break_store=lambda: monkeypatch.setattr(settings, "TAX_PROVIDER_ENCRYPTION_KEY",
                                                                           "broken"))


def test_an_unfilled_placeholder_is_never_used_as_a_key(monkeypatch):
    from app.modules.tax.pseudonym import key_fingerprint

    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "<SET_IN_SECRET_MANAGER>")
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_SECRET", "<SET_IN_SECRET_MANAGER>")
    assert key_fingerprint() is None


# ── review additions: destroy retry, disabled-version retention, pinned key ──

def _destroy_items(w):
    from app.modules.tax.enums import ReviewItemKind
    from app.modules.tax.models import TaxReviewItem

    return w["db"].query(TaxReviewItem).filter(
        TaxReviewItem.kind == ReviewItemKind.CREDENTIAL_VERSIONS_NOT_DESTROYED,
        TaxReviewItem.subject_id == w["connection"].id).all()


def test_a_failed_destroy_raises_a_review_item_and_reconciliation_retries_until_it_succeeds(w):
    from app.modules.tax.provider_issuance import ProviderIssuanceService
    from app.modules.tax.review_service import view_review_item

    c, fake = w["connection"], w["gcp"]
    svc(w).set_credentials(w["org"].id, w["maker"].id, c.id, "gcp-rotated-credential-0002")
    fake.fail["list"] = gexc.ServiceUnavailable("down")
    with pytest.raises(SecretStoreUnavailable):
        svc(w).revoke_credentials(w["org"].id, w["maker"].id, c.id, "leaked")
    (item,) = _destroy_items(w)
    view = view_review_item(item)
    assert view["status"] == "OPEN" and view["owner_role"] == "BILLING_ADMIN" and view["age_days"] == 0
    assert "not destroyed" in view["detail"] and c.credential_destroy_through == "2"

    stats = ProviderIssuanceService(w["db"]).reconcile()                 # still down: stays open
    assert stats["secret_failures"] == 1 and _destroy_items(w)[0].status.name == "OPEN"
    assert fake.states(w["secret_name"]) == {"1": "ENABLED", "2": "ENABLED"}

    del fake.fail["list"]
    stats = ProviderIssuanceService(w["db"]).reconcile()
    assert stats["destroy_retried"] == 1
    assert fake.states(w["secret_name"]) == {"1": "DESTROYED", "2": "DESTROYED"}
    w["db"].refresh(c)
    assert c.credential_destroy_through is None and _destroy_items(w)[0].status.name == "RESOLVED"
    log = w["db"].query(BillingAuditLog).filter(BillingAuditLog.entity_type == "TaxProviderConnection",
                                                BillingAuditLog.entity_id == c.id).order_by(BillingAuditLog.id.desc()).first()
    assert log.new_values["credentials"] == "revoked versions destroyed (retry)"


def test_a_destroy_retry_never_touches_credentials_set_after_the_revocation(w):
    from app.modules.tax.provider_issuance import ProviderIssuanceService

    c, fake = w["connection"], w["gcp"]
    fake.fail["list"] = gexc.ServiceUnavailable("down")
    with pytest.raises(SecretStoreUnavailable):
        svc(w).revoke_credentials(w["org"].id, w["maker"].id, c.id, "leaked")
    del fake.fail["list"]
    svc(w).set_credentials(w["org"].id, w["maker"].id, c.id, "gcp-new-credential-after-revoke")   # version 2
    ProviderIssuanceService(w["db"]).reconcile()
    assert fake.states(w["secret_name"]) == {"1": "DESTROYED", "2": "ENABLED"}
    w["db"].refresh(c)
    assert c.credential_version == "2"


def _rotate_and_confirm(w):
    c = w["connection"]
    svc(w).set_credentials(w["org"].id, w["maker"].id, c.id, "gcp-rotated-credential-0002")
    svc(w).test_connection(w["org"].id, w["maker"].id, c.id)                # disables version 1
    assert list((c.credential_disabled_versions or {}).keys()) == ["1"]


def test_disabled_versions_are_destroyed_after_the_retention_window(w):
    from datetime import datetime, timedelta, timezone

    from app.modules.tax.connection_service import sweep_secret_versions

    _rotate_and_confirm(w)
    now = datetime.now(timezone.utc)
    assert sweep_secret_versions(w["db"], now + timedelta(days=29))["disabled_destroyed"] == 0
    assert w["gcp"].states(w["secret_name"]) == {"1": "DISABLED", "2": "ENABLED"}
    assert sweep_secret_versions(w["db"], now + timedelta(days=31))["disabled_destroyed"] == 1
    assert w["gcp"].states(w["secret_name"]) == {"1": "DESTROYED", "2": "ENABLED"}
    w["db"].refresh(w["connection"])
    assert w["connection"].credential_disabled_versions is None
    log = w["db"].query(BillingAuditLog).filter(BillingAuditLog.entity_type == "TaxProviderConnection",
                                                BillingAuditLog.entity_id == w["connection"].id) \
        .order_by(BillingAuditLog.id.desc()).first()
    assert log.new_values == {"credentials": "disabled versions destroyed", "versions": ["1"]}


def test_a_version_re_enabled_within_the_window_is_kept(w):
    from datetime import datetime, timedelta, timezone

    from app.modules.tax.connection_service import sweep_secret_versions

    _rotate_and_confirm(w)
    w["gcp"].secrets[w["secret_name"]]["versions"]["1"]["state"] = "ENABLED"     # an admin re-enabled it
    sweep_secret_versions(w["db"], datetime.now(timezone.utc) + timedelta(days=31))
    assert w["gcp"].states(w["secret_name"])["1"] == "ENABLED"


def test_the_retention_window_is_configurable(w, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from app.modules.tax.connection_service import sweep_secret_versions

    monkeypatch.setattr(settings, "TAX_SECRET_DISABLED_VERSION_RETENTION_DAYS", 7)
    _rotate_and_confirm(w)
    assert sweep_secret_versions(w["db"], datetime.now(timezone.utc) + timedelta(days=8))["disabled_destroyed"] == 1


@pytest.mark.parametrize("resource", [
    f"projects/{PROJECT}/secrets/tax-provider-pseudonym-key/versions/latest",
    f"projects/{PROJECT}/secrets/tax-provider-pseudonym-key/versions/current",
    f"projects/{PROJECT}/secrets/tax-provider-pseudonym-key",
])
def test_the_pseudonym_key_must_name_a_numbered_version(gcp, monkeypatch, resource):
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_SECRET", resource)
    with pytest.raises(SecretStoreUnavailable, match="numbered version"):
        secret_store.config_secret("TAX_PROVIDER_PSEUDONYM_KEY")
    with pytest.raises(SystemExit, match="numbered version"):
        verify_secret_store_at_startup(lambda: None)
    assert gcp.calls == []
