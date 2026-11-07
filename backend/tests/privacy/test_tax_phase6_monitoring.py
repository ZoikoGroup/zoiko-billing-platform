"""ZB-TAX-ARCH-001 Phase 6 PR 2: tax monitoring and alerts.

Each alert fires at its configurable threshold and clears when the
condition clears, through the platform's Attention Engine; metrics and
alert texts are aggregate only (no tenant identifiers, T13)."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.config import settings
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.super_admin.models import AttentionItem, AttentionStatus
from app.modules.tax import monitoring
from app.modules.tax.enums import CircuitState, OutboxOperation, OutboxState, RemoteCommitState, TaxQuoteStatus
from app.modules.tax.provider_issuance import RECONCILIATION_JOB, ProviderHealth, ProviderIssuanceService
from app.modules.tax.provider_models import TaxJobHeartbeat, TaxProviderOutbox
from app.modules.tax.quote_models import TaxQuote
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase3a_governed import build_world
from tests.test_tax_phase4a2 import issue_via_connection, provider_invoice

URL = "/api/v1/super-admin/tax-registry/monitoring"
SECRET_ORG = "Monitoring Secret Holdings"


def now():
    return datetime.now(timezone.utc)


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P6M")
    w["org"].organization_name = SECRET_ORG
    db_session.commit()
    return w


def heartbeat(db, ok=True, age_minutes=0):
    hb = db.get(TaxJobHeartbeat, RECONCILIATION_JOB) or TaxJobHeartbeat(job_name=RECONCILIATION_JOB)
    hb.last_finished_at = now() - timedelta(minutes=age_minutes)
    hb.last_ok = ok
    db.add(hb)
    db.commit()


def quote(db, w, status, country="GB", refusal_reason=None, minutes_ago=1):
    db.add(TaxQuote(organization_id=w["org"].id, document_type="invoice", document_id=1, status=status,
                    context_fingerprint="x" * 64, document_hash="y" * 64, request_hash="z" * 64,
                    remote_commit_state=RemoteCommitState.NOT_APPLICABLE if hasattr(RemoteCommitState, "NOT_APPLICABLE")
                    else list(RemoteCommitState)[0],
                    supply_address={"country_code": country}, refusal_reason=refusal_reason,
                    created_at=now() - timedelta(minutes=minutes_ago)))
    db.commit()


def firing(db, key):
    return db.query(AttentionItem).filter(AttentionItem.source_key == f"tax:{key}",
                                          AttentionItem.status.in_([AttentionStatus.OPEN, AttentionStatus.ACKNOWLEDGED])).first()


def run(db, clock=now):
    return monitoring.publish(db, monitoring.evaluate(monitoring.collect(db, now=clock)))


def test_oldest_unresolved_outbox_row_fires_then_clears(db_session, w):
    heartbeat(db_session)
    inv, q = provider_invoice(w)
    row = ProviderIssuanceService(db_session).begin(inv, q, w["maker"].id)
    db_session.commit()
    assert "tax.outbox_oldest_unresolved" not in run(db_session)["fired"]
    later = lambda: now() + timedelta(minutes=45)                      # noqa: E731
    assert "tax.outbox_oldest_unresolved" in run(db_session, later)["fired"]
    item = firing(db_session, "tax.outbox_oldest_unresolved")
    assert item.source == "tax_monitoring" and item.severity.name == "P1"
    ProviderIssuanceService(db_session).reconcile()                      # resolves the row
    db_session.refresh(row)
    assert row.state == OutboxState.DONE
    assert "tax.outbox_oldest_unresolved" in run(db_session, later)["cleared"]


def test_stale_never_run_or_failed_heartbeat_fires(db_session, w, monkeypatch):
    db_session.query(TaxJobHeartbeat).delete()
    db_session.commit()
    assert "tax.reconciliation_heartbeat" in run(db_session)["fired"]            # never recorded
    heartbeat(db_session)
    assert "tax.reconciliation_heartbeat" in run(db_session)["cleared"]
    heartbeat(db_session, age_minutes=20)
    assert "tax.reconciliation_heartbeat" in run(db_session)["fired"]
    heartbeat(db_session, ok=False)
    assert "tax.reconciliation_heartbeat" in run(db_session)["fired"]
    monkeypatch.setattr(settings, "TAX_ALERT_HEARTBEAT_STALE_MINUTES", 30)        # configurable
    monkeypatch.setattr(settings, "TAX_PROVIDER_RECONCILIATION_ENABLED", False)
    heartbeat(db_session, age_minutes=20)
    assert "tax.reconciliation_heartbeat" not in run(db_session)["fired"]


def test_circuit_breaker_opening_fires_per_provider(db_session, w):
    heartbeat(db_session)
    health = ProviderHealth(db_session)
    health.circuit("fake-provider").state = CircuitState.OPEN
    db_session.commit()
    assert "tax.circuit_open:fake-provider" in run(db_session)["fired"]
    health.circuit("fake-provider").state = CircuitState.CLOSED
    db_session.commit()
    assert "tax.circuit_open:fake-provider" in run(db_session)["cleared"]


def test_provider_unavailable_and_not_determined_rates_by_market(db_session, w, monkeypatch):
    heartbeat(db_session)
    monkeypatch.setattr(settings, "TAX_ALERT_RATE_MIN_QUOTES", 4)
    for _ in range(2):
        quote(db_session, w, TaxQuoteStatus.PROVIDER_UNAVAILABLE, "US")
    for _ in range(2):
        quote(db_session, w, TaxQuoteStatus.QUOTED, "US")
    for _ in range(3):
        quote(db_session, w, TaxQuoteStatus.NEEDS_EVIDENCE, "GB")
    quote(db_session, w, TaxQuoteStatus.QUOTED, "GB")
    quote(db_session, w, TaxQuoteStatus.PROVIDER_UNAVAILABLE, "AU")                # below the minimum count
    quote(db_session, w, TaxQuoteStatus.PROVIDER_UNAVAILABLE, "US", minutes_ago=120)  # outside the window
    metrics = monitoring.collect(db_session)
    assert metrics["by_market"]["US"]["provider_unavailable_rate"] == 0.5
    assert metrics["by_market"]["GB"]["not_determined_rate"] == 0.75
    fired = run(db_session)["fired"]
    assert "tax.provider_unavailable:US" in fired and "tax.not_determined:GB" in fired
    assert "tax.provider_unavailable:AU" not in fired and "tax.not_determined:US" not in fired
    monkeypatch.setattr(settings, "TAX_ALERT_PROVIDER_UNAVAILABLE_RATE", 0.6)      # configurable
    assert "tax.provider_unavailable:US" in run(db_session)["cleared"]


def test_review_required_backlog(db_session, w, monkeypatch):
    heartbeat(db_session)
    monkeypatch.setattr(settings, "TAX_ALERT_REVIEW_BACKLOG", 1)
    inv, _q = provider_invoice(w)
    w["provider"].remote_tax_delta = Decimal("0.01")                             # drift -> REVIEW_REQUIRED
    issue_via_connection(w, inv)
    assert db_session.query(TaxProviderOutbox).filter(TaxProviderOutbox.state == OutboxState.REVIEW_REQUIRED,
                                                      TaxProviderOutbox.operation == OutboxOperation.COMMIT).count() == 1
    assert "tax.review_backlog" in run(db_session)["fired"]
    monkeypatch.setattr(settings, "TAX_ALERT_REVIEW_BACKLOG", 2)
    assert "tax.review_backlog" in run(db_session)["cleared"]


def test_secret_store_failures(db_session, w):
    heartbeat(db_session)
    quote(db_session, w, TaxQuoteStatus.PROVIDER_UNAVAILABLE, "GB",
          refusal_reason="Provider credentials are unavailable: Secret Manager unreachable")
    assert monitoring.collect(db_session)["secret_store_failures"] == 1
    assert "tax.secret_store_failures" in run(db_session)["fired"]
    item = firing(db_session, "tax.secret_store_failures")
    assert item.severity.name == "P1"


def test_alerts_and_metrics_never_carry_tenant_identifiers(db_session, w, monkeypatch):
    monkeypatch.setattr(settings, "TAX_ALERT_RATE_MIN_QUOTES", 1)
    monkeypatch.setattr(settings, "TAX_ALERT_REVIEW_BACKLOG", 0)
    quote(db_session, w, TaxQuoteStatus.PROVIDER_UNAVAILABLE, "GB",
          refusal_reason="Provider credentials are unavailable: x")
    run(db_session, lambda: now() + timedelta(hours=2))
    items = db_session.query(AttentionItem).filter(AttentionItem.source == "tax_monitoring").all()
    assert items
    for item in items:
        text = f"{item.title} {item.description}"
        assert SECRET_ORG not in text and w["org"].organization_code not in text
        assert item.organization_id is None
    metrics = str(monitoring.collect(db_session))
    assert SECRET_ORG not in metrics and "organization_id" not in metrics and "invoice_id" not in metrics


def test_the_endpoint_is_platform_ops_only_and_aggregate(db_session, client_for, w):
    tax = client_for(make_super_admin(db_session, "tr@p6m.example", PlatformRole.TAX_REVIEWER))
    body = tax.get(URL)
    assert body.status_code == 200 and {"outbox", "reconciliation", "by_market", "alerts", "thresholds"} <= set(body.json())
    assert SECRET_ORG not in body.text
    tenant = client_for(_tenant_user(db_session, w["org"], UserRole.ORG_ADMIN, "admin@p6m.example"))
    assert tenant.get(URL).status_code == 403
    reliability = client_for(make_super_admin(db_session, "ro@p6m.example", PlatformRole.RELIABILITY_OPERATOR))
    assert reliability.get(URL).status_code == 200                                # same roles as provider health
    # Platform administrators hold reliability.read implicitly (as for provider health); the data is
    # aggregate, so that is fine. Tenant users are refused (T13).
    admin = client_for(make_super_admin(db_session, "pa@p6m.example", PlatformRole.PLATFORM_ADMINISTRATOR))
    seen = admin.get(URL)
    assert seen.status_code == 200 and SECRET_ORG not in seen.text


def test_the_job_is_scheduled_and_the_metrics_are_in_the_dictionary():
    from app.core.scheduler import get_job_definitions
    from app.modules.super_admin.metric_dictionary import get_metric

    jobs = {d[2]: d for d in get_job_definitions()}
    assert jobs["tax_monitoring_job"][0] == "app.modules.tax.monitoring:run_tax_monitoring_job"
    for metric in ("outbox_oldest_unresolved_age_seconds", "reconciliation_heartbeat_age_seconds", "circuits_open",
                   "provider_unavailable_rate", "not_determined_rate", "review_required_backlog",
                   "secret_store_failures"):
        assert get_metric(f"zb.tax.{metric}.v1") is not None, metric


def test_monitoring_can_be_switched_off(monkeypatch):
    monkeypatch.setattr(settings, "TAX_MONITORING_ENABLED", False)
    assert monitoring.run_tax_monitoring_job() == {"skipped": "TAX_MONITORING_ENABLED is off"}
