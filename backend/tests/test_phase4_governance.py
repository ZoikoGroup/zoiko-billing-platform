"""
tests/test_phase4_governance.py
--------------------------------
Phase 4 backend regression tests (Super Admin Control Plane hardening).

Coverage:
  G-01  Multi-currency financial integrity — monetary amounts are NEVER
        summed across currencies; single-currency convenience scalars are
        exposed only when every invoice shares one currency; an empty
        platform reports UNKNOWN, never zero. Counts stay totalable.
  G-02  Settings mutations are capability-gated, actor-stamped, and audited
        transactionally; sensitive values never enter audit payloads;
        no-op updates write no false audit evidence.
  G-03  Configuration governance inventory is composed from the three real
        sources (DB platform settings / code thresholds imported LIVE from
        their owning modules so it cannot drift from enforcement /
        environment presence-only status), masks sensitive values, and is
        itself capability-gated.

Handlers are invoked directly (no HTTP layer) on the isolated in-memory
SQLite fixture — the repo-wide convention (see test_platform_audit.py).
Capability enforcement is tested through has_capability / the
require_capability dependency itself (test_capabilities.py convention).
"""
import json
from decimal import Decimal
from uuid import uuid4

import pytest

from app.core import api_metrics
from app.core.capabilities import has_capability, require_capability
from app.core.exceptions import ForbiddenException
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.billing.models import InvoiceStatus
from app.modules.commercial.models import CommercialSubscription
from app.modules.organizations.models import Organization  # noqa: F401 (search target model)
from app.modules.super_admin import attention_service, kill_switch_service
from app.modules.super_admin.configuration_service import ConfigurationGovernanceService
from app.modules.super_admin.financial_consistency_service import FinancialConsistencyService
from app.modules.super_admin.models import (
    AttentionItem,
    AttentionSeverity,
    PlatformAuditAction,
    PlatformAuditLog,
    PlatformSetting,
)
from app.modules.super_admin.router import (
    create_commercial_subscription,
    create_setting,
    list_settings,
    update_setting,
)
from app.modules.super_admin.saas_reporting_service import SaasReportingService
from app.modules.super_admin.search_service import GlobalSearchService
from app.modules.super_admin.schemas import MASKED_VALUE_PLACEHOLDER
from tests.conftest import make_customer, make_invoice, make_organization


# ── helpers ──────────────────────────────────────────────────────────────────

class _SettingCreate:
    """Minimal stand-in for SettingCreate (attributes + model_dump)."""

    def __init__(self, key, value=None, description=None, category="general", is_public=False):
        self.key = key
        self.value = value
        self.description = description
        self.category = category
        self.is_public = is_public
        self._data = {
            "key": key, "value": value, "description": description,
            "category": category, "is_public": is_public,
        }

    def model_dump(self):
        return dict(self._data)


class _SettingUpdate:
    """Minimal stand-in for SettingUpdate (attribute access)."""

    def __init__(self, value=None, description=None, category=None, is_public=None):
        self.value = value
        self.description = description
        self.category = category
        self.is_public = is_public


def _user(email, platform_role=None):
    return User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="Op", last_name="Erate", phone="", is_active=True, is_verified=True,
        platform_role=platform_role,
    )


def _operator(db, email, platform_role):
    user = _user(email, platform_role)
    db.add(user)
    db.flush()
    return user


def _setting_audit_rows(db):
    return (
        db.query(PlatformAuditLog)
        .filter(PlatformAuditLog.entity_type == "PlatformSetting")
        .order_by(PlatformAuditLog.id)
        .all()
    )


# ── G-01: multi-currency financial integrity ────────────────────────────────

def test_g01_empty_db_reports_unknown_currency_state(db_session):
    result = FinancialConsistencyService(db_session).get_financial_operations_summary()
    billings = result["billings"]

    assert billings["total_invoices"] == 0
    assert billings["currency_state"] == "unknown"
    assert billings["currencies"] == []
    assert billings["overdue_count"] == 0
    # An empty platform must NOT fabricate zero amounts.
    assert "invoiced_amount" not in billings
    assert "collected_amount" not in billings
    assert "overdue_amount" not in billings


def test_g01_single_currency_exposes_convenience_scalars(db_session):
    org = make_organization(db_session)
    cust = make_customer(db_session, org.id)

    make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.PAID,
                 total_amount="100.00", paid_amount="100.00")
    make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.OVERDUE,
                 total_amount="50.00")

    billings = FinancialConsistencyService(db_session).get_financial_operations_summary()["billings"]

    assert billings["currency_state"] == "single_currency"
    assert billings["total_invoices"] == 2
    assert billings["invoiced_amount"] == "150.00"
    assert billings["collected_amount"] == "100.00"
    assert billings["overdue_count"] == 1
    assert billings["overdue_amount"] == "50.00"

    assert len(billings["currencies"]) == 1
    bucket = billings["currencies"][0]
    assert bucket["currency"] == "USD"
    assert bucket["invoice_count"] == 2


def test_g01_multi_currency_is_never_summed_across_currencies(db_session):
    org = make_organization(db_session)
    usd_cust = make_customer(db_session, org.id, code="CUST-USD", currency="USD")
    eur_cust = make_customer(db_session, org.id, code="CUST-EUR", currency="EUR")

    make_invoice(db_session, org.id, usd_cust.id, status=InvoiceStatus.PAID,
                 total_amount="100.00", paid_amount="100.00", currency="USD")
    make_invoice(db_session, org.id, eur_cust.id, status=InvoiceStatus.OVERDUE,
                 total_amount="250.00", currency="EUR")

    billings = FinancialConsistencyService(db_session).get_financial_operations_summary()["billings"]

    assert billings["currency_state"] == "multi_currency"
    # No combined monetary figure may exist across currencies…
    assert "invoiced_amount" not in billings
    assert "collected_amount" not in billings
    assert "overdue_amount" not in billings
    # …but per-currency buckets carry each side honestly.
    buckets = {c["currency"]: c for c in billings["currencies"]}
    assert set(buckets) == {"USD", "EUR"}
    assert buckets["USD"]["invoiced_amount"] == "100.00"
    assert buckets["USD"]["collected_amount"] == "100.00"
    assert buckets["EUR"]["invoiced_amount"] == "250.00"
    assert buckets["EUR"]["overdue_amount"] == "250.00"
    # Counts are currency-safe and still total.
    assert billings["total_invoices"] == 2
    assert billings["overdue_count"] == 1


# ── G-02: capability-gated, audited settings mutations ──────────────────────

def test_g02_platform_config_capability_boundaries():
    roles_with_read_only = (
        PlatformRole.SUPPORT_OPERATOR,
        PlatformRole.RELIABILITY_OPERATOR,
        PlatformRole.AUDITOR,
    )
    for role in roles_with_read_only:
        user = _user(f"{role.value}@g02.example", platform_role=role)
        assert has_capability(user, "platform_config.read"), role
        assert not has_capability(user, "platform_config.manage"), role

    security = _user("security@g02.example", platform_role=PlatformRole.SECURITY_OPERATOR)
    assert has_capability(security, "platform_config.read")
    assert has_capability(security, "platform_config.manage")

    # Legacy NULL platform_role keeps full access (backward compatibility).
    legacy = _user("legacy@g02.example", platform_role=None)
    assert has_capability(legacy, "platform_config.manage")


def test_g02_require_capability_dependency_refuses_missing_manage():
    dependency = require_capability("platform_config.manage")
    auditor = _user("auditor-dep@g02.example", platform_role=PlatformRole.AUDITOR)
    with pytest.raises(ForbiddenException):
        dependency(current_user=auditor)


def test_g02_create_setting_stamps_actor_and_audits_transactionally(db_session):
    actor = _operator(db_session, "sec-create@g02.example", PlatformRole.SECURITY_OPERATOR)

    response = create_setting(
        data=_SettingCreate(key="support.portal_url", value="https://help.example"),
        current_user=actor,
        db=db_session,
    )

    assert response.updated_by_email == actor.email
    rows = _setting_audit_rows(db_session)
    assert len(rows) == 1
    row = rows[0]
    assert row.action == PlatformAuditAction.CREATE
    assert row.actor_id == actor.id
    assert row.entity_id == response.id
    assert row.correlation_id.startswith("cfg-")
    assert row.new_values["key"] == "support.portal_url"
    assert row.new_values["value"] == "https://help.example"


def test_g02_sensitive_setting_value_never_reaches_response_or_audit(db_session):
    actor = _operator(db_session, "sec-secret@g02.example", PlatformRole.SECURITY_OPERATOR)

    response = create_setting(
        data=_SettingCreate(key="smtp.password.override", value="s3cret-value"),
        current_user=actor,
        db=db_session,
    )

    assert response.is_sensitive is True
    assert response.value == MASKED_VALUE_PLACEHOLDER

    row = _setting_audit_rows(db_session)[0]
    assert row.new_values.get("value_changed") is True
    assert "value" not in row.new_values
    assert "s3cret-value" not in json.dumps(row.new_values or {})
    assert "s3cret-value" not in json.dumps(row.old_values or {})


def test_g02_update_setting_records_old_new_and_restamps_actor(db_session):
    creator = _operator(db_session, "sec-one@g02.example", PlatformRole.SECURITY_OPERATOR)
    updater = _operator(db_session, "sec-two@g02.example", PlatformRole.SECURITY_OPERATOR)

    create_setting(
        data=_SettingCreate(key="theme.color", value="blue", description="UI accent"),
        current_user=creator,
        db=db_session,
    )
    response = update_setting(
        "theme.color", _SettingUpdate(value="red"), current_user=updater, db=db_session
    )

    assert response.updated_by_email == updater.email
    rows = _setting_audit_rows(db_session)
    assert [r.action for r in rows] == [PlatformAuditAction.CREATE, PlatformAuditAction.UPDATE]
    update_row = rows[-1]
    assert update_row.old_values["value"] == "blue"
    assert update_row.new_values["value"] == "red"
    assert update_row.actor_id == updater.id
    assert update_row.correlation_id.startswith("cfg-")


def test_g02_noop_update_writes_no_audit_evidence(db_session):
    actor = _operator(db_session, "sec-noop@g02.example", PlatformRole.SECURITY_OPERATOR)
    create_setting(
        data=_SettingCreate(key="noop.key", value="v", description="d"),
        current_user=actor,
        db=db_session,
    )
    before = len(_setting_audit_rows(db_session))

    update_setting(
        "noop.key",
        _SettingUpdate(value="v", description="d", category="general", is_public=False),
        current_user=actor,
        db=db_session,
    )

    assert len(_setting_audit_rows(db_session)) == before


def test_g02_list_settings_distinguishes_evidence_from_unknown(db_session):
    # A pre-Phase-4 row: last change predates audit coverage.
    db_session.add(PlatformSetting(key="legacy.flag", value="1"))
    db_session.flush()

    actor = _operator(db_session, "sec-list@g02.example", PlatformRole.SECURITY_OPERATOR)
    update_setting("legacy.flag", _SettingUpdate(value="2"), current_user=actor, db=db_session)

    db_session.add(PlatformSetting(key="untouched.flag", value="1"))
    db_session.commit()

    responses = {r.key: r for r in list_settings(current_user=actor, db=db_session)}
    assert responses["legacy.flag"].updated_by_email == actor.email
    # No recorded actor must render as None (UNKNOWN) — never fabricated.
    assert responses["untouched.flag"].updated_by_email is None


# ── G-03: configuration governance inventory ────────────────────────────────

def _inventory_entries(db):
    inventory = ConfigurationGovernanceService(db).get_inventory()
    return inventory, {e["name"]: e for e in inventory["entries"]}


def test_g03_threshold_entries_match_live_enforcement_values(db_session):
    _, entries = _inventory_entries(db_session)

    expected_ack = {sev.value: mins for sev, mins in attention_service._ACK_TARGET_MINUTES.items()}
    ack = entries["attention.sla_ack_target_minutes"]
    assert ack["value"] == expected_ack
    assert ack["source"].startswith("code:")
    assert ack["mutable"] is False
    assert ack["effective_from"] is None
    assert ack["updated_by"] is None
    assert ack["audit_status"] == "READ_ONLY_CODE_BASELINE"

    breaker = entries["circuit_breaker.default_auto_expire_minutes"]
    assert breaker["value"] == kill_switch_service.DEFAULT_AUTO_EXPIRE_MINUTES

    budget = entries["api.p95_latency_budget_ms"]
    assert budget["value"] == api_metrics.P95_BUDGET_MS


def test_g03_environment_capabilities_report_status_never_value(db_session):
    inventory, entries = _inventory_entries(db_session)

    cap_names = [
        name for name, e in entries.items() if e["category"] == "environment_capability"
    ]
    assert {"stripe.gateway", "smtp.provider", "mfa.encryption_key"} <= set(cap_names)
    for name in cap_names:
        entry = entries[name]
        assert entry["value"] in {"CONFIGURED", "NOT_CONFIGURED"}, name
        assert entry["source"] == "environment"
        assert entry["value_kind"] == "status"


def test_g03_platform_setting_entries_mask_sensitive_keys(db_session):
    db_session.add(PlatformSetting(key="vendor.api_key", value="raw-secret-material"))
    db_session.add(PlatformSetting(key="theme.color", value="dark"))
    db_session.commit()

    _, entries = _inventory_entries(db_session)

    secret = entries["vendor.api_key"]
    assert secret["value_kind"] == "masked"
    assert secret["value"] == MASKED_VALUE_PLACEHOLDER
    assert secret["is_sensitive"] is True
    assert secret["mutable"] is True

    plain = entries["theme.color"]
    assert plain["value"] == "dark"
    assert plain["is_sensitive"] is False


def test_g03_pre_phase4_rows_honestly_report_unaudited_history(db_session):
    db_session.add(PlatformSetting(key="legacy.setting", value="1"))
    db_session.commit()

    _, entries = _inventory_entries(db_session)
    entry = entries["legacy.setting"]
    assert entry["updated_by"] is None
    assert entry["audit_status"] == "PRE_PHASE_4_LAST_CHANGE_UNAUDITED"


def test_g03_inventory_summary_and_honesty_notes_are_consistent(db_session):
    inventory, entries = _inventory_entries(db_session)

    assert inventory["summary"] == {
        category: sum(1 for e in inventory["entries"] if e["category"] == category)
        for category in inventory["summary"]
    }
    assert sum(inventory["summary"].values()) == len(entries)
    assert inventory["honesty_notes"], "honesty notes must be present"
    assert inventory["generated_at"] is not None

# ── G-04: per-plan price-book coverage explanation ──────────────────────────

def _make_sub(db, org, plan):
    from tests.test_commercial_subscription_management import (
        _CreateSchema,
        _sa_user,
    )

    return create_commercial_subscription(
        data=_CreateSchema(organization_id=org.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db,
    )


def _coverage_entry(db, plan_id):
    report = SaasReportingService(db).get_reporting()
    for entry in report["subscriptions"]["coverage_by_plan"]:
        if entry["plan_id"] == plan_id:
            return entry
    return None


def test_g04_empty_platform_has_no_coverage_entries(db_session):
    report = SaasReportingService(db_session).get_reporting()
    assert report["subscriptions"]["coverage_by_plan"] == []


def test_g04_unpriced_plan_is_explained_per_plan(db_session):
    from tests.test_commercial_subscription_management import _org_with_plan
    from tests.test_phase3f_saas_plane1 import _publish_version

    org, plan, _ = _org_with_plan(db_session, "P4G04A", "P4G04APLAN")
    sub = _make_sub(db_session, org, plan)

    # Sub points at an unpriced PUBLISHED version -> contributes nothing.
    unpriced = _publish_version(db_session, plan, amount=None)
    row = db_session.query(CommercialSubscription).get(sub.id)
    row.catalog_version_id = unpriced.id
    db_session.flush()

    entry = _coverage_entry(db_session, plan.id)
    assert entry is not None
    assert entry["open_subscriptions_total"] == 1
    assert entry["open_subscriptions_priced"] == 0
    assert entry["unpriced_open_subscriptions"] == 1
    assert entry["has_published_price_book"] is False
    assert entry["priced_state"] == "unpriced"

    # Publishing a priced version and re-pointing flips the state honestly.
    priced = _publish_version(db_session, plan, amount=Decimal("50.00"))
    row.catalog_version_id = priced.id
    db_session.flush()

    entry = _coverage_entry(db_session, plan.id)
    assert entry["open_subscriptions_priced"] == 1
    assert entry["unpriced_open_subscriptions"] == 0
    assert entry["has_published_price_book"] is True
    assert entry["priced_state"] == "fully_priced"


def test_g04_partially_priced_state_identifies_the_gap(db_session):
    from app.modules.commercial.service import CommercialAccountService
    from tests.test_commercial_subscription_management import (
        _CreateSchema,
        _org_with_plan,
        _sa_user,
    )
    from tests.test_phase3f_saas_plane1 import _publish_version

    org_a, plan, _ = _org_with_plan(db_session, "P4G04B1", "P4G04BPLAN")
    priced_sub = _make_sub(db_session, org_a, plan)

    # Second tenant on the SAME plan (accounts cap at one open subscription,
    # but a plan serves many tenants).
    org_b = make_organization(db_session, code="P4G04B2", name="Org P4G04B2")
    CommercialAccountService(db_session).ensure_commercial_account(org_b.id)
    unpriced_sub = create_commercial_subscription(
        data=_CreateSchema(organization_id=org_b.id, plan_id=plan.id),
        current_user=_sa_user(),
        db=db_session,
    )

    priced = _publish_version(db_session, plan, amount=Decimal("30.00"))
    unpriced = _publish_version(db_session, plan, amount=None)
    db_session.query(CommercialSubscription).get(priced_sub.id).catalog_version_id = priced.id
    db_session.query(CommercialSubscription).get(unpriced_sub.id).catalog_version_id = unpriced.id
    db_session.flush()

    entry = _coverage_entry(db_session, plan.id)
    assert entry["open_subscriptions_total"] == 2
    assert entry["open_subscriptions_priced"] == 1
    assert entry["unpriced_open_subscriptions"] == 1
    assert entry["priced_state"] == "partially_priced"


# ── G-05: API error-rate observability ──────────────────────────────────────

def _clear_metrics_window():
    with api_metrics._LOCK:
        api_metrics._WINDOW.clear()


def test_g05_error_rates_are_measured_over_same_window():
    _clear_metrics_window()
    api_metrics.record(100.0, 200)
    api_metrics.record(200.0, 200)
    api_metrics.record(300.0, 503)
    api_metrics.record(150.0, 404)
    api_metrics.record(120.0)  # legacy sample without a status

    stats = api_metrics.snapshot()
    assert stats["sample_count"] == 5
    assert stats["error_count"] == 1          # only the 5xx counts as an error
    assert stats["client_error_count"] == 1   # the 4xx tracked separately
    assert stats["status_unknown_count"] == 1
    # Rates exclude status-less samples rather than guessing them healthy.
    assert stats["error_rate"] == round(1 / 4, 4)
    assert stats["client_error_rate"] == round(1 / 4, 4)


def test_g05_empty_window_reports_none_rates_never_zero():
    _clear_metrics_window()
    stats = api_metrics.snapshot()
    assert stats["sample_count"] == 0
    assert stats["error_count"] == 0
    assert stats["error_rate"] is None
    assert stats["client_error_rate"] is None


def test_g05_statusless_samples_still_produce_percentiles():
    _clear_metrics_window()
    api_metrics.record(100.0)
    api_metrics.record(500.0)
    stats = api_metrics.snapshot()
    assert stats["p95_ms"] == 500.0
    assert stats["status_unknown_count"] == 2
    assert stats["error_rate"] is None


# ── G-06: search results carry status/plane enrichment ──────────────────────

def test_g06_organization_results_carry_lifecycle_and_plane(db_session):
    org = make_organization(db_session, code="P4G06", name="Search Target Org")
    db_session.flush()

    results = GlobalSearchService(db_session).search("P4G06")
    hits = [r for r in results if r["entity_type"] == "Organization"]
    assert len(hits) == 1
    hit = hits[0]
    assert hit["plane"] == "TENANT"
    assert hit["status"] == org.lifecycle_state.value


def test_g06_attention_results_carry_status_severity_and_plane(db_session):
    item = AttentionItem(
        source="manual",
        source_key="phase4-g06-key",
        title="Phase 4 search enrichment probe",
        severity=AttentionSeverity.P1,
        correlation_id=f"p4g06-{uuid4().hex[:8]}",
    )
    db_session.add(item)
    db_session.commit()

    results = GlobalSearchService(db_session).search("enrichment probe")
    hits = [r for r in results if r["entity_type"] == "Attention Item"]
    assert len(hits) == 1
    hit = hits[0]
    assert hit["status"] == "open"
    assert hit["severity"] == "p1"
    assert hit["plane"] == "PLATFORM"
