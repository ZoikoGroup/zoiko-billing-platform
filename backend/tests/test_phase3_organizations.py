"""
PHASE 3A/3C tests — Organizations workspace + governed lifecycle state machine.

Coverage:
   1-6    Directory read model: defaults + plane marker, search, status and
          lifecycle filters, per-org user counts, open incident counts,
          last-activity evidence.
   7      Registration stamps ONBOARDING lifecycle state.
   8-12   Evidence-based onboarding readiness checklist.
  13-17   Overview composed read model (identity, transitions map, readiness,
          administrators, user summary, audit history, privileged grants) +
          404 for missing orgs.
  18-30   TenantLifecycleService.transition(): valid paths, is_active
          lockstep, audit trail (action/reason/actor/correlation/metadata),
          invalid-transition rejection with NO audit row written, missing
          reason, same-state rejection, terminal DEACTIVATED, reactivation,
          deactivation abort, unknown target value, transition map shape.

Handlers/services are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL. conftest is untouched.
"""
import pytest

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.auth.models import User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import register_enterprise
from app.modules.billing.models import BillingConfiguration
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.organizations.models import Organization, TenantLifecycleState
from app.modules.super_admin.lifecycle_service import TenantLifecycleService
from app.modules.super_admin.models import (
    AttentionItem,
    AttentionSeverity,
    AttentionStatus,
    PlatformAuditAction,
    PlatformAuditLog,
)
from app.modules.super_admin.organization_service import OrganizationDirectoryService
from app.modules.super_admin.privileged_access_service import PrivilegedAccessService
from app.modules.super_admin.router import (
    get_super_admin_organization_overview,
    list_super_admin_organizations,
    transition_super_admin_organization_lifecycle,
)
from tests.conftest import make_organization


# ── helpers ─────────────────────────────────────────────────────────────────

class _TransitionSchema:
    def __init__(self, target: str, reason: str):
        self.target = target
        self.reason = reason


def _sa_user():
    return User(
        email="sa@p3.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="A",
        phone="",
        is_active=True,
        is_verified=True,
    )


def _sa_user_persisted(db):
    user = _sa_user()
    db.add(user)
    db.flush()
    return user


def _org(db, code="P3A", name=None):
    org = make_organization(db, code=code, name=name or f"Org {code}")
    db.commit()
    return org


def _org_user(db, org_id, email, role=UserRole.ORG_ADMIN, is_active=True, is_verified=True):
    user = User(
        email=email,
        hashed_password="x",
        role=role,
        organization_id=org_id,
        first_name="A",
        last_name="B",
        phone="",
        is_active=is_active,
        is_verified=is_verified,
    )
    db.add(user)
    db.flush()
    return user


def _transition(db, org_id, target, reason="Operational decision"):
    return transition_super_admin_organization_lifecycle(
        organization_id=org_id,
        data=_TransitionSchema(target=target, reason=reason),
        current_user=_sa_user(),
        db=db,
    )


def _list_directory(db, **kwargs):
    params = {
        "skip": 0,
        "limit": 50,
        "search": "",
        "status": None,
        "lifecycle_state": None,
        "country": None,
        "currency": None,
        "billing_classification": None,
        "billing_source": None,
    }
    params.update(kwargs)
    return list_super_admin_organizations(current_user=_sa_user(), db=db, **params)


def _incident(db, org_id, key, status=AttentionStatus.OPEN, title="Incident"):
    item = AttentionItem(
        source="manual",
        source_key=key,
        title=title,
        severity=AttentionSeverity.P2,
        status=status,
        organization_id=org_id,
        correlation_id=f"corr-{key}",
    )
    db.add(item)
    db.flush()
    return item


def _open_subscription(db, org_id, plan_code="P3PLAN"):
    account = CommercialAccountService(db).ensure_commercial_account(org_id)
    plan = CommercialPlanService(db).create_plan(plan_code=plan_code, plan_name=f"Plan {plan_code}")
    sub = CommercialSubscriptionService(db).create_subscription(
        organization_id=org_id,
        plan_id=plan.id,
        status=__import__(
            "app.modules.commercial.enums", fromlist=["CommercialSubscriptionStatus"]
        ).CommercialSubscriptionStatus.ACTIVE,
    )
    db.commit()
    return account, plan, sub


# ── 1-6 Directory read model ────────────────────────────────────────────────

def test_directory_lists_org_with_defaults_and_plane_marker(db_session):
    org = _org(db_session, "DIR1")
    result = _list_directory(db_session)

    assert result.total == 1
    item = result.organizations[0]
    assert item.id == org.id
    assert item.organization_code == "DIR1"
    assert item.lifecycle_state == TenantLifecycleState.ACTIVE.value
    assert item.is_active is True
    # No commercial account provisioned yet → honest empty values.
    # (can_charge reflects classification/source alignment — existing
    # Phase 6 semantics — not account existence.)
    assert item.commercial_account_status is None
    assert item.subscription_status is None
    assert item.plane == "TENANT"


def test_directory_search_matches_name_code_and_legal_name(db_session):
    _org(db_session, "SRCA", name="Alpha Logistics")
    match_legal = make_organization(db_session, code="SRCB", name="Unrelated")
    match_legal.legal_name = "Beta Industries LLC"
    db_session.commit()

    by_name = _list_directory(db_session, search="alpha")
    assert by_name.total == 1
    assert by_name.organizations[0].organization_code == "SRCA"

    by_code = _list_directory(db_session, search="srcb")
    assert by_code.total == 1

    by_legal = _list_directory(db_session, search="beta industries")
    assert by_legal.total == 1
    assert by_legal.organizations[0].id == match_legal.id


def test_directory_status_filter_and_validation(db_session):
    active = _org(db_session, "STA")
    suspended = _org(db_session, "STS")
    _transition(db_session, suspended.id, "suspended")

    only_active = _list_directory(db_session, status="active")
    assert {o.id for o in only_active.organizations} == {active.id}

    only_inactive = _list_directory(db_session, status="inactive")
    assert {o.id for o in only_inactive.organizations} == {suspended.id}

    with pytest.raises(BadRequestException):
        _list_directory(db_session, status="banana")


def test_directory_lifecycle_state_filter(db_session):
    keep = _org(db_session, "LFA")
    moved = _org(db_session, "LFB")
    # Only PROVISIONING may move to ONBOARDING — simulate a pre-provisioned
    # row created by an external provisioning flow.
    moved.lifecycle_state = TenantLifecycleState.PROVISIONING
    db_session.commit()
    _transition(db_session, moved.id, "onboarding")

    result = _list_directory(
        db_session, lifecycle_state=TenantLifecycleState.ONBOARDING
    )
    assert result.total == 1
    assert result.organizations[0].id == moved.id
    assert result.organizations[0].lifecycle_state == "onboarding"

    everything_else = _list_directory(
        db_session, lifecycle_state=TenantLifecycleState.ACTIVE
    )
    assert everything_else.organizations[0].id == keep.id


def test_directory_counts_users_org_admins_unverified_and_open_incidents(db_session):
    org = _org(db_session, "CNT")
    _org_user(db_session, org.id, "admin@cnt.example", UserRole.ORG_ADMIN)
    _org_user(
        db_session,
        org.id,
        "billing@cnt.example",
        UserRole.BILLING_ADMIN,
        is_verified=False,
    )
    _org_user(
        db_session, org.id, "gone@cnt.example", UserRole.AUDITOR, is_active=False
    )
    _incident(db_session, org.id, "inc-open", AttentionStatus.OPEN)
    _incident(db_session, org.id, "inc-resolved", AttentionStatus.RESOLVED)
    db_session.commit()

    item = _list_directory(db_session).organizations[0]
    assert item.total_users == 3
    assert item.active_users == 2
    assert item.org_admins == 1
    assert item.unverified_users == 1
    assert item.open_incident_count == 1


def test_directory_last_activity_uses_latest_audit_evidence(db_session):
    org = _org(db_session, "ACT")
    before = _list_directory(db_session).organizations[0]
    assert before.last_activity_at is not None  # row update timestamp exists

    _transition(db_session, org.id, "suspended")
    after = _list_directory(db_session).organizations[0]
    assert after.last_activity_at >= before.last_activity_at


def test_last_activity_handles_mixed_aware_and_naive_datetimes():
    """Regression: PlatformAuditLog.created_at is DateTime(timezone=True)
    (tz-aware on real Postgres) while Organization.updated_at/
    AttentionItem.last_seen_at are naive — max() over the mix used to raise
    'TypeError: can't compare offset-naive and offset-aware datetimes' in
    production (SQLite silently strips tzinfo on round-trip, so this never
    reproduced against the SQLite-backed test DB — construct the aware
    datetime directly in Python instead)."""
    from datetime import datetime, timezone

    naive_older = datetime(2026, 1, 1, 10, 0, 0)
    aware_newer = datetime(2026, 1, 2, 10, 0, 0, tzinfo=timezone.utc)

    result = OrganizationDirectoryService._max_activity_datetime((naive_older, aware_newer, None))
    assert result == datetime(2026, 1, 2, 10, 0, 0)
    assert result.tzinfo is None

    # Order-independence: the naive-vs-aware TypeError depends on which pair
    # max() compares first, so also check the reverse ordering.
    result2 = OrganizationDirectoryService._max_activity_datetime((aware_newer, naive_older))
    assert result2 == datetime(2026, 1, 2, 10, 0, 0)

    assert OrganizationDirectoryService._max_activity_datetime((None, None)) is None


# ── 7 Registration stamps ONBOARDING ────────────────────────────────────────

def _register(db, email, organization="Onboard Co"):
    return register_enterprise(
        db,
        RegisterRequest(
            organization=organization,
            name="Ada Admin",
            email=email,
            password="StrongPass123!",
            currency="USD",
            intended_plan="essentials",
        ),
    )


def test_registration_stamps_onboarding_not_active(db_session):
    _register(db_session, "founder@onboard.example")
    admin = db_session.query(User).filter_by(email="founder@onboard.example").first()
    org = (
        db_session.query(Organization)
        .filter_by(id=admin.organization_id)
        .first()
    )
    # New tenants are usable but flagged as still onboarding; activation to
    # ACTIVE is a governed Super Admin transition, not an automatic one.
    assert org.lifecycle_state == TenantLifecycleState.ONBOARDING
    assert org.is_active is True


# ── 8-12 Evidence-based onboarding readiness ────────────────────────────────

def test_readiness_after_registration_is_evidence_based(db_session):
    _register(db_session, "ready@check.example")
    admin = db_session.query(User).filter_by(email="ready@check.example").first()
    org = db_session.query(Organization).filter_by(id=admin.organization_id).first()

    service = OrganizationDirectoryService(db_session)
    overview = service.get_organization_overview(org.id)

    readiness = overview["onboarding_readiness"]
    # Administrator exists (registration creates the ORG_ADMIN).
    assert readiness["administrator"] == "ready"
    # Registration seeds BillingConfiguration — measured, not assumed.
    assert readiness["configuration"] == "ready"
    # No subscription assigned yet.
    assert readiness["billing"] == "pending"
    # No integration registry exists anywhere in this codebase → UNKNOWN,
    # never guessed green.
    assert readiness["integration"] == "unknown"

    assert overview["onboarding_blockers"] == [
        "No open commercial subscription",
        "Integration status unknown",
    ]


def test_readiness_configuration_requires_existing_row_not_lazy_seed(db_session):
    org = _org(db_session, "CFG")
    lifecycle = TenantLifecycleService(db_session)
    assert lifecycle.onboarding_readiness(org)["configuration"] == "pending"

    db_session.add(BillingConfiguration(organization_id=org.id))
    db_session.commit()
    assert lifecycle.onboarding_readiness(org)["configuration"] == "ready"
    # The probe must never create what it measures.
    count = (
        db_session.query(BillingConfiguration)
        .filter(BillingConfiguration.organization_id == org.id)
        .count()
    )
    assert count == 1


def test_readiness_billing_requires_open_subscription(db_session):
    org = _org(db_session, "BILL")
    lifecycle = TenantLifecycleService(db_session)
    assert lifecycle.onboarding_readiness(org)["billing"] == "pending"

    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    from app.modules.commercial.enums import (
        CommercialPlanStatus,
        CommercialSubscriptionStatus,
    )

    plan = CommercialPlanService(db_session).create_plan(
        plan_code="RDBILL", plan_name="Ready Billing"
    )
    plan.status = CommercialPlanStatus.ACTIVE
    db_session.commit()
    CommercialSubscriptionService(db_session).create_subscription(
        account.id,
        plan,
        status=CommercialSubscriptionStatus.ACTIVE,
    )
    db_session.commit()
    assert lifecycle.onboarding_readiness(org)["billing"] == "ready"


def test_readiness_administrator_requires_active_org_admin(db_session):
    org = _org(db_session, "ADM")
    lifecycle = TenantLifecycleService(db_session)
    assert lifecycle.onboarding_readiness(org)["administrator"] == "pending"

    _org_user(db_session, org.id, "boss@adm.example", UserRole.ORG_ADMIN)
    assert lifecycle.onboarding_readiness(org)["administrator"] == "ready"

    # A deactivated administrator no longer counts as ready evidence.
    admin = (
        db_session.query(User).filter_by(email="boss@adm.example").first()
    )
    admin.is_active = False
    db_session.commit()
    assert lifecycle.onboarding_readiness(org)["administrator"] == "pending"


def test_readiness_integration_is_always_unknown_today(db_session):
    org = _org(db_session, "INT")
    lifecycle = TenantLifecycleService(db_session)
    assert lifecycle.onboarding_readiness(org)["integration"] == "unknown"
    assert "Integration status unknown" in lifecycle.onboarding_blockers(org)


# ── 13-17 Overview composed read model ──────────────────────────────────────

def test_overview_composes_identity_lifecycle_and_transitions(db_session):
    org = _org(db_session, "OVR")
    _org_user(db_session, org.id, "chief@ovr.example", UserRole.ORG_ADMIN)

    response = get_super_admin_organization_overview(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )

    assert response.organization.id == org.id
    assert response.organization.organization_code == "OVR"
    assert response.lifecycle_state == "active"
    assert response.allowed_transitions == ["deactivating", "suspended"]
    assert response.access_blocked is False
    assert len(response.administrators) == 1
    assert response.administrators[0].email == "chief@ovr.example"
    assert response.user_summary.total_users == 1
    assert response.recent_audit_events == []
    assert response.recent_privileged_grants == []
    assert response.generated_at is not None
    assert response.plane == "TENANT"
    # Domain boundary: the overview carries zero monetary fields.
    assert not any(hasattr(response.organization, f) for f in ("amount", "mrr", "revenue"))


def test_overview_onboarding_org_shows_expected_transition_targets(db_session):
    org = _org(db_session, "OVRO")
    org.lifecycle_state = TenantLifecycleState.ONBOARDING
    db_session.commit()

    response = get_super_admin_organization_overview(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert response.allowed_transitions == ["active", "deactivating", "suspended"]


def test_overview_includes_audit_history_and_privileged_grants(db_session):
    org = _org(db_session, "OVRH")
    sa = _sa_user_persisted(db_session)

    _transition(db_session, org.id, "suspended")
    PrivilegedAccessService(db_session).request_access(
        actor=sa,
        organization_id=org.id,
        reason="Investigate billing discrepancy",
        ticket_reference="TCK-4242",
    )
    db_session.commit()

    response = get_super_admin_organization_overview(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    actions = [e.action for e in response.recent_audit_events]
    assert PlatformAuditAction.LIFECYCLE_TRANSITION.value in actions
    assert PlatformAuditAction.PRIVILEGED_ACCESS_REQUESTED.value in actions
    lifecycle_event = next(
        e
        for e in response.recent_audit_events
        if e.action == PlatformAuditAction.LIFECYCLE_TRANSITION.value
    )
    assert lifecycle_event.reason == "Operational decision"
    assert lifecycle_event.correlation_id.startswith("lc-")

    assert len(response.recent_privileged_grants) == 1
    grant = response.recent_privileged_grants[0]
    assert grant.ticket_reference == "TCK-4242"
    assert grant.scope == "read_only_financial_summary"


def test_overview_missing_org_raises_not_found(db_session):
    with pytest.raises(NotFoundException):
        get_super_admin_organization_overview(
            organization_id=99999, current_user=_sa_user(), db=db_session
        )


def test_overview_blocked_states_flag_access(db_session):
    org = _org(db_session, "OVRB")
    _transition(db_session, org.id, "deactivating")
    response = get_super_admin_organization_overview(
        organization_id=org.id, current_user=_sa_user(), db=db_session
    )
    assert response.access_blocked is True
    assert response.organization.is_active is False


# ── 18-30 Governed lifecycle transitions ────────────────────────────────────

def test_transition_suspend_sets_inactive_and_writes_full_audit_trail(db_session):
    org = _org(db_session, "TRN1")

    response = _transition(db_session, org.id, "suspended")

    assert response.previous_state == "active"
    assert response.current_state == "suspended"
    assert response.is_active is False
    assert response.correlation_id.startswith("lc-")

    db_session.refresh(org)
    assert str(org.lifecycle_state.value) == "suspended"
    assert org.is_active is False

    events = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.entity_type == "Organization")
        .all()
    )
    assert len(events) == 1
    event = events[0]
    assert event.action == PlatformAuditAction.LIFECYCLE_TRANSITION
    assert event.reason == "Operational decision"
    assert event.actor_role == "super_admin"
    assert event.correlation_id == response.correlation_id
    assert event.metadata_["transition"] == "active->suspended"
    assert event.old_values["lifecycle_state"] == "active"
    assert event.new_values["lifecycle_state"] == "suspended"


def test_transition_reactivates_suspended_org(db_session):
    org = _org(db_session, "TRN2")
    _transition(db_session, org.id, "suspended")

    response = _transition(db_session, org.id, "active")
    assert response.previous_state == "suspended"
    assert response.current_state == "active"
    db_session.refresh(org)
    assert org.is_active is True


def test_invalid_transition_rejected_without_audit_row(db_session):
    org = _org(db_session, "TRN3")

    with pytest.raises(BadRequestException):
        _transition(db_session, org.id, "deactivated")  # ACTIVE → DEACTIVATED skips wind-down

    db_session.refresh(org)
    assert org.lifecycle_state == TenantLifecycleState.ACTIVE
    assert org.is_active is True
    assert db_session.query(PlatformAuditLog).count() == 0


def test_transition_requires_documented_reason(db_session):
    org = _org(db_session, "TRN4")
    for blank in ("", "   "):
        with pytest.raises(BadRequestException):
            _transition(db_session, org.id, "suspended", reason=blank)


def test_same_state_transition_rejected(db_session):
    org = _org(db_session, "TRN5")
    with pytest.raises(BadRequestException):
        _transition(db_session, org.id, "active")


def test_deactivated_is_terminal(db_session):
    org = _org(db_session, "TRN6")
    final = _transition(db_session, org.id, "deactivating")
    assert final.allowed_transitions == ["active", "deactivated"]

    final = _transition(db_session, org.id, "deactivated")
    assert final.allowed_transitions == []
    assert final.is_active is False

    for target in ("active", "suspended", "deactivating"):
        with pytest.raises(BadRequestException):
            _transition(db_session, org.id, target)

    db_session.refresh(org)
    assert org.lifecycle_state == TenantLifecycleState.DEACTIVATED


def test_deactivation_can_be_aborted_back_to_active(db_session):
    org = _org(db_session, "TRN7")
    _transition(db_session, org.id, "deactivating")
    response = _transition(db_session, org.id, "active")
    assert response.previous_state == "deactivating"
    assert response.current_state == "active"
    db_session.refresh(org)
    assert org.is_active is True


def test_unknown_target_value_rejected_with_valid_options(db_session):
    org = _org(db_session, "TRN8")
    with pytest.raises(BadRequestException) as excinfo:
        _transition(db_session, org.id, "quantum")
    assert "quantum" in str(excinfo.value)


def test_transition_of_missing_org_raises_not_found(db_session):
    with pytest.raises(NotFoundException):
        _transition(db_session, 987654, "suspended")


def test_allowed_transition_map_shape(db_session):
    transitions = TenantLifecycleService.allowed_transitions
    assert transitions(TenantLifecycleState.PROVISIONING) == [
        TenantLifecycleState.ACTIVE,
        TenantLifecycleState.DEACTIVATING,
        TenantLifecycleState.ONBOARDING,
        TenantLifecycleState.SUSPENDED,
    ]
    assert transitions(TenantLifecycleState.ONBOARDING) == [
        TenantLifecycleState.ACTIVE,
        TenantLifecycleState.DEACTIVATING,
        TenantLifecycleState.SUSPENDED,
    ]
    assert transitions(TenantLifecycleState.ACTIVE) == [
        TenantLifecycleState.DEACTIVATING,
        TenantLifecycleState.SUSPENDED,
    ]
    assert transitions(TenantLifecycleState.SUSPENDED) == [
        TenantLifecycleState.ACTIVE,
        TenantLifecycleState.DEACTIVATING,
    ]
    assert set(transitions(TenantLifecycleState.DEACTIVATING)) == {
        TenantLifecycleState.ACTIVE,
        TenantLifecycleState.DEACTIVATED,
    }
    assert transitions(TenantLifecycleState.DEACTIVATED) == []


def test_multiple_transitions_write_one_audit_row_each(db_session):
    org = _org(db_session, "TRN9")
    _transition(db_session, org.id, "suspended", reason="Payment abuse hold")
    _transition(db_session, org.id, "active", reason="Resolved after review")
    _transition(db_session, org.id, "deactivating", reason="Contract ended")

    events = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.action == PlatformAuditAction.LIFECYCLE_TRANSITION)
        .order_by(PlatformAuditLog.id.asc())
        .all()
    )
    assert len(events) == 3
    reasons = [e.reason for e in events]
    assert reasons == ["Payment abuse hold", "Resolved after review", "Contract ended"]
    assert len({e.correlation_id for e in events}) == 3
