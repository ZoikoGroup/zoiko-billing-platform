"""
PHASE 8 tests — Commercial Entitlement foundation (Step 13 §ENTITLEMENTS).

  28. plan feature lookup
  29. plan limit lookup
  30. missing entitlement handled safely

Also covers the double-charge readiness helper (Step 10) which the mandated
list does not name but Phase 8 Step 10 requires verifying: billing_source
decides whether the standalone platform may charge.

Handlers/dependencies/services invoked directly (no HTTP layer) on the
isolated in-memory SQLite fixture — never BILLING_DATABASE_URL.
"""
import pytest

from app.modules.commercial.enums import (
    BillingSource,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialEntitlementService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.organizations.models import Organization
from tests.conftest import make_organization


def _plan(db, code, *, features=None, max_users=None, max_storage_gb=None):
    plan = CommercialPlanService(db).create_plan(
        plan_code=code,
        plan_name=code.title(),
        features=features,
        max_users=max_users,
        max_storage_gb=max_storage_gb,
    )
    plan.status = CommercialPlanStatus.ACTIVE
    db.commit()
    return plan


def _org_with_active_subscription(db, code, plan):
    org = make_organization(db, code=code, name=f"Ent {code}")
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    db.commit()
    sub = CommercialSubscriptionService(db).create_subscription(account.id, plan)
    CommercialSubscriptionService(db).transition(sub, CommercialSubscriptionStatus.ACTIVE)
    db.commit()
    return org, account, sub


def test_plan_feature_lookup(db_session):
    org, _, _ = _org_with_active_subscription(
        db_session,
        "FEAT8",
        _plan(db_session, "FEAT8P", features={"export": True, "api": False}),
    )
    svc = CommercialEntitlementService(db_session)
    assert svc.is_entitled(org.id, "export") is True
    assert svc.is_entitled(org.id, "api") is False


def test_plan_limit_lookup(db_session):
    org, _, _ = _org_with_active_subscription(
        db_session,
        "LIM8",
        _plan(db_session, "LIM8P", max_users=25, max_storage_gb=50),
    )
    svc = CommercialEntitlementService(db_session)
    assert svc.get_limit(org.id, "max_users") == 25
    assert svc.get_limit(org.id, "max_storage_gb") == 50
    # Custom named limit resolved from the features dict.
    _plan(db_session, "LIM8C", features={"seats": 40})
    org2 = make_organization(db_session, code="LIM8B", name="Ent LIM8B")
    CommercialAccountService(db_session).ensure_commercial_account(org2.id)
    db_session.commit()
    assert svc.get_limit(org2.id, "seats") is None  # no subscription yet


def test_missing_entitlement_handled_safely(db_session):
    org = make_organization(db_session, code="NONE8", name="No Ent")
    db_session.commit()
    svc = CommercialEntitlementService(db_session)

    # No account at all -> safe empty answers, no exceptions.
    assert svc.is_entitled(org.id, "export") is False
    assert svc.get_limit(org.id, "max_users") is None
    assert svc.get_organization_entitlements(org.id) == {
        "plan": None,
        "limits": {},
        "features": {},
    }

    # Account but no subscription -> same safe answers.
    CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    assert svc.is_entitled(org.id, "export") is False
    assert svc.get_limit(org.id, "max_users") is None
    assert svc.get_organization_entitlements(org.id) == {
        "plan": None,
        "limits": {},
        "features": {},
    }

    # Subscription on a plan with NO entitlement data -> false / None.
    org2, _, _ = _org_with_active_subscription(
        db_session, "NONE9", _plan(db_session, "NONE9P")
    )
    assert svc.is_entitled(org2.id, "export") is False
    assert svc.get_limit(org2.id, "max_users") is None
    assert svc.is_entitled(org2.id, "") is False
    assert svc.get_limit(org2.id, "") is None


def test_entitlement_resolves_through_open_subscription_only(db_session):
    plan = _plan(db_session, "OPEN8P", features={"audit": True})
    org, account, sub = _org_with_active_subscription(db_session, "OPEN8", plan)
    svc = CommercialEntitlementService(db_session)
    assert svc.is_entitled(org.id, "audit") is True

    # Terminate the subscription -> entitlement disappears (history kept).
    CommercialSubscriptionService(db_session).transition(
        sub, CommercialSubscriptionStatus.CANCELLED
    )
    db_session.commit()
    assert svc.is_entitled(org.id, "audit") is False
    assert db_session.query(CommercialSubscription).count() == 1


def test_double_charge_readiness(db_session):
    """Step 10: billing_source drives whether the standalone platform may
    independently charge. Preserved on the Organization (server-stamped)."""
    svc = CommercialAccountService(db_session)

    standalone = make_organization(db_session, code="CHG8A", name="Chg A")
    standalone.billing_source = BillingSource.REGISTERED_VIA_STANDALONE
    db_session.commit()
    assert svc.can_charge(standalone) is True

    zoiko_one = make_organization(db_session, code="CHG8B", name="Chg B")
    zoiko_one.billing_source = BillingSource.REGISTERED_VIA_ZOIKO_ONE
    db_session.commit()
    assert svc.can_charge(zoiko_one) is False

    # The account does NOT duplicate the source — it is read off the org.
    account_a = svc.ensure_commercial_account(standalone.id)
    account_b = svc.ensure_commercial_account(zoiko_one.id)
    db_session.commit()
    assert account_a is not None and account_b is not None
    assert hasattr(account_a, "billing_source") is False
    assert svc.determine_billing_source(standalone) == BillingSource.REGISTERED_VIA_STANDALONE
    assert svc.determine_billing_source(zoiko_one) == BillingSource.REGISTERED_VIA_ZOIKO_ONE


# ═══════════════════════════════════════════════════════════════════════════
# ZB-COM-ENT-001 Part 1 — Entitlement catalog structures (§12–§13)
# Data-level wiring tests: typed definition registry, per-version
# PlanEntitlement bindings, evaluation-program caps + granted plan, and the
# subscription trial/recovery-snapshot columns. Direct-model tests on the
# isolated in-memory SQLite fixture (no HTTP layer), matching this file's style.
# ═══════════════════════════════════════════════════════════════════════════
from datetime import datetime, timedelta

from app.modules.commercial.enums import (
    CommercialPlanVersionStatus,
    EntitlementEnforcementType,
    EntitlementRiskClassification,
    EntitlementValueType,
)
from app.modules.commercial.models import (
    CommercialEvaluationProgram,
    CommercialEvaluationProgramCap,
    EntitlementDefinition,
    PlanEntitlement,
)
from app.modules.commercial.service import CommercialPlanVersionService


def _definition(db, key="billing.invoice.create", value_type=EntitlementValueType.BOOLEAN):
    definition = EntitlementDefinition(
        key=key,
        value_type=value_type,
        risk_classification=EntitlementRiskClassification.STANDARD,
        enforcement_type=EntitlementEnforcementType.HARD,
        description=f"Test definition for {key}",
    )
    db.add(definition)
    db.flush()
    return definition


def _published_version(db, plan):
    version = CommercialPlanVersionService(db).create_draft(
        plan, plan_name=plan.plan_name, actor_id=None
    )
    version.status = CommercialPlanVersionStatus.PUBLISHED
    db.flush()
    return version


def test_entitlement_definition_is_unique_by_key(db_session):
    first = _definition(db_session)
    db_session.commit()
    duplicate = EntitlementDefinition(key=first.key, value_type=EntitlementValueType.INTEGER)
    db_session.add(duplicate)
    with pytest.raises(Exception):
        db_session.flush()
    db_session.rollback()
    assert db_session.query(EntitlementDefinition).count() == 1


def test_entitlement_definition_typed_fields(db_session):
    definition = _definition(
        db_session,
        "security.sso",
        EntitlementValueType.BOOLEAN,
    )
    definition.risk_classification = EntitlementRiskClassification.HIGH_RISK
    db_session.commit()
    fresh = (
        db_session.query(EntitlementDefinition)
        .filter(EntitlementDefinition.key == "security.sso")
        .first()
    )
    assert fresh.value_type == EntitlementValueType.BOOLEAN
    assert fresh.risk_classification == EntitlementRiskClassification.HIGH_RISK
    assert fresh.enforcement_type == EntitlementEnforcementType.HARD


def test_plan_entitlement_binds_definition_to_version(db_session):
    plan = _plan(db_session, "ENTPKG")
    version = _published_version(db_session, plan)
    definition = _definition(db_session, "billing.invoice.monthly_limit", EntitlementValueType.INTEGER)
    db_session.add(
        PlanEntitlement(
            plan_version_id=version.id,
            entitlement_definition_id=definition.id,
            value=50,
            is_contracted=False,
        )
    )
    db_session.commit()

    rows = (
        db_session.query(PlanEntitlement, EntitlementDefinition)
        .join(EntitlementDefinition, EntitlementDefinition.id == PlanEntitlement.entitlement_definition_id)
        .filter(PlanEntitlement.plan_version_id == version.id)
        .all()
    )
    assert len(rows) == 1
    entitlement, bound_definition = rows[0]
    assert entitlement.value == 50 and entitlement.is_contracted is False
    assert bound_definition.key == "billing.invoice.monthly_limit"


def test_plan_entitlement_unique_per_version_and_definition(db_session):
    plan = _plan(db_session, "ENTUQ")
    version = _published_version(db_session, plan)
    definition = _definition(db_session)
    db_session.add(
        PlanEntitlement(plan_version_id=version.id, entitlement_definition_id=definition.id, value=True)
    )
    db_session.flush()
    db_session.add(
        PlanEntitlement(plan_version_id=version.id, entitlement_definition_id=definition.id, value=False)
    )
    with pytest.raises(Exception):
        db_session.flush()
    db_session.rollback()


def test_enterprise_contracted_entitlement_has_null_value(db_session):
    plan = _plan(db_session, "ENTENT")
    version = _published_version(db_session, plan)
    definition = _definition(db_session, "api.write", EntitlementValueType.BOOLEAN)
    db_session.add(
        PlanEntitlement(
            plan_version_id=version.id,
            entitlement_definition_id=definition.id,
            value=None,
            is_contracted=True,
        )
    )
    db_session.commit()
    entitlement = (
        db_session.query(PlanEntitlement)
        .filter(PlanEntitlement.plan_version_id == version.id)
        .first()
    )
    assert entitlement.is_contracted is True
    assert entitlement.value is None


def test_evaluation_program_cap_with_granted_plan(db_session):
    plan = _plan(db_session, "EVALPKG")
    granted = _plan(db_session, "GRANTPKG")
    program = CommercialEvaluationProgram(
        plan_id=plan.id,
        duration_days=30,
        granted_plan_id=granted.id,
    )
    db_session.add(program)
    db_session.flush()
    definition = _definition(db_session, "billing.invoice.monthly_limit", EntitlementValueType.INTEGER)
    db_session.add(
        CommercialEvaluationProgramCap(
            evaluation_program_id=program.id,
            entitlement_definition_id=definition.id,
            cap_value=10,
        )
    )
    db_session.commit()

    assert program.granted_plan_id == granted.id
    assert len(program.caps) == 1
    cap = program.caps[0]
    assert cap.cap_value == 10
    assert cap.entitlement_definition.key == "billing.invoice.monthly_limit"


def test_subscription_carries_trial_and_recovery_snapshot_columns(db_session):
    plan = _plan(db_session, "TRIALPKG")
    org, account, sub = _org_with_active_subscription(db_session, "TRIALC", plan)
    sub.trial_ends_at = datetime.utcnow() + timedelta(days=7)
    sub.recovery_ends_at = sub.trial_ends_at + timedelta(days=14)
    sub.trial_granted_entitlements = {"billing.invoice.create": True, "storage.gb": 50}
    db_session.commit()

    fresh = db_session.query(CommercialSubscription).get(sub.id)
    assert fresh.recovery_ends_at is not None
    assert fresh.trial_ends_at is not None
    assert fresh.trial_granted_entitlements == {
        "billing.invoice.create": True,
        "storage.gb": 50,
    }


# ═══════════════════════════════════════════════════════════════════════════
# ZB-COM-ENT-001 Part 2 — resolver / snapshot / override / enforcement
# (service-level, no HTTP layer — matches this file's convention: this repo
# has no TestClient precedent anywhere in tests/).
# ═══════════════════════════════════════════════════════════════════════════
from app.modules.commercial.entitlement_enforcement import (
    EntitlementBlockedException,
    EntitlementEnforcementService,
)
from app.modules.commercial.entitlement_override_service import CommercialOverrideService
from app.modules.commercial.entitlement_resolver import resolve_entitlement
from app.modules.commercial.entitlement_snapshot_service import EntitlementSnapshotService
from app.modules.commercial.enums import CommercialOverrideStatus
from app.modules.commercial.models import CommercialOverride, EntitlementSnapshot
from app.modules.commercial.usage_metering_service import UsageMeteringService
from app.modules.super_admin.approval_service import SelfApprovalError


def _catalog_definition(db, key, value_type=EntitlementValueType.BOOLEAN):
    """Distinct from _definition (Part 1 helper) only in name, to keep Part 2
    tests self-documenting about which key they're exercising."""
    return _definition(db, key, value_type)


def _plan_with_entitlement(db, plan_code, key, value, value_type=EntitlementValueType.BOOLEAN):
    plan = _plan(db, plan_code)
    version = _published_version(db, plan)
    definition = _catalog_definition(db, key, value_type)
    db.add(PlanEntitlement(plan_version_id=version.id, entitlement_definition_id=definition.id, value=value))
    db.flush()
    return plan, definition


# ── Precedence chain (§12.1) — one test per level, plus the two explicit
#    precedence assertions the spec calls for directly. ─────────────────────


def test_resolver_L1_global_legal_block_beats_everything(db_session):
    plan, definition = _plan_with_entitlement(db_session, "L1PKG", "p2.l1.key", True)
    org, account, sub = _org_with_active_subscription(db_session, "L1ORG", plan)
    db_session.commit()
    # Even with an approved, unexpired override granting True, a legal block
    # must still deny.
    override = CommercialOverride(
        organization_id=org.id, entitlement_definition_id=definition.id,
        value=True, reason="test", status=CommercialOverrideStatus.APPROVED,
    )
    db_session.add(override)
    definition.is_globally_disabled = True
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.l1.key")
    assert resolved.source_level == 1
    assert resolved.value is False


def test_resolver_L2_kill_switch_pause_allows_everything(db_session):
    from app.modules.super_admin.kill_switch_service import (
        ENTITLEMENT_ENFORCEMENT,
        BillingKillSwitchService,
    )

    definition = _catalog_definition(db_session, "p2.l2.key", EntitlementValueType.BOOLEAN)
    org = make_organization(db_session, code="L2ORG", name="L2 Org")
    db_session.commit()
    # No account/subscription at all -> would default-deny (L7) if
    # enforcement weren't paused.
    BillingKillSwitchService(db_session).set_enabled(
        ENTITLEMENT_ENFORCEMENT, False, reason="test pause", actor_id=None,
    )
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.l2.key")
    assert resolved.source_level == 2
    assert resolved.value is True


def test_resolver_L3_override_beats_plan_entitlement(db_session):
    """The precedence-order guardrail: an override must win over a plan
    entitlement even when both exist for the same org+key."""
    plan, definition = _plan_with_entitlement(db_session, "L3PKG", "p2.l3.key", False)
    org, account, sub = _org_with_active_subscription(db_session, "L3ORG", plan)
    db_session.commit()

    # Sanity: without an override, the plan entitlement (False) resolves.
    baseline = resolve_entitlement(db_session, org.id, "p2.l3.key")
    assert baseline.value is False
    assert baseline.source_level in (5, 6)  # snapshot or live plan entitlement

    override = CommercialOverride(
        organization_id=org.id, entitlement_definition_id=definition.id,
        value=True, reason="test", status=CommercialOverrideStatus.APPROVED,
    )
    db_session.add(override)
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.l3.key")
    assert resolved.source_level == 3
    assert resolved.value is True


def test_resolver_L4_trial_grant_beats_plan_entitlement_for_granted_key(db_session):
    plan, definition = _plan_with_entitlement(db_session, "L4PKG", "p2.l4.key", False)
    org, account, sub = _org_with_active_subscription(db_session, "L4ORG", plan)
    sub.status = CommercialSubscriptionStatus.TRIALING
    sub.trial_granted_entitlements = [{"key": "p2.l4.key", "value": True, "value_type": "boolean"}]
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.l4.key")
    assert resolved.source_level == 4
    assert resolved.value is True


def test_resolver_L4_falls_through_when_trial_grant_omits_key(db_session):
    """A trial that didn't specifically grant a key falls back to the org's
    underlying plan entitlement, not to default-deny."""
    plan, definition = _plan_with_entitlement(db_session, "L4BPKG", "p2.l4b.key", True)
    org, account, sub = _org_with_active_subscription(db_session, "L4BORG", plan)
    sub.status = CommercialSubscriptionStatus.TRIALING
    sub.trial_granted_entitlements = [{"key": "some.other.key", "value": True, "value_type": "boolean"}]
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.l4b.key")
    assert resolved.source_level in (5, 6)
    assert resolved.value is True


def test_resolver_L5_snapshot_wins_over_stale_live_plan_entitlement(db_session):
    plan, definition = _plan_with_entitlement(db_session, "L5PKG", "p2.l5.key", True)
    org, account, sub = _org_with_active_subscription(db_session, "L5ORG", plan)
    db_session.commit()
    # create_subscription/transition already triggered a recompute -> the
    # snapshot holds value=True.
    snapshot = EntitlementSnapshotService(db_session).get_snapshot(org.id)
    assert snapshot is not None
    assert snapshot.values["p2.l5.key"]["value"] is True

    # Mutate the LIVE PlanEntitlement without recomputing -> simulates a
    # stale snapshot scenario. The snapshot must still win.
    live_row = (
        db_session.query(PlanEntitlement)
        .filter(PlanEntitlement.entitlement_definition_id == definition.id)
        .first()
    )
    live_row.value = False
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.l5.key")
    assert resolved.source_level == 5
    assert resolved.value is True  # from the snapshot, not the mutated live row


def test_resolver_L6_live_plan_entitlement_when_snapshot_missing(db_session):
    plan, definition = _plan_with_entitlement(db_session, "L6PKG", "p2.l6.key", True)
    org, account, sub = _org_with_active_subscription(db_session, "L6ORG", plan)
    db_session.commit()
    # Simulate a missing snapshot (recompute never ran / row deleted).
    db_session.query(EntitlementSnapshot).filter(EntitlementSnapshot.organization_id == org.id).delete()
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.l6.key")
    assert resolved.source_level == 6
    assert resolved.value is True


def test_resolver_L7_default_deny_when_nothing_resolves(db_session):
    definition = _catalog_definition(db_session, "p2.l7.key", EntitlementValueType.BOOLEAN)
    org = make_organization(db_session, code="L7ORG", name="L7 Org")
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.l7.key")
    assert resolved.source_level == 7
    assert resolved.value is False


def test_resolver_plan_entitlement_beats_default_deny(db_session):
    """The second explicit precedence assertion the spec calls for."""
    plan, definition = _plan_with_entitlement(db_session, "PEDPKG", "p2.ped.key", True)
    org, account, sub = _org_with_active_subscription(db_session, "PEDORG", plan)
    db_session.commit()

    resolved = resolve_entitlement(db_session, org.id, "p2.ped.key")
    assert resolved.value is True
    assert resolved.source_level in (5, 6)  # a real value, not L7's default False


# ── EntitlementSnapshot recompute — the 3 real trigger points ──────────────


def test_snapshot_recomputes_on_create_subscription(db_session):
    plan, definition = _plan_with_entitlement(db_session, "SNAPC", "p2.snapc.key", True)
    org, account, sub = _org_with_active_subscription(db_session, "SNAPCO", plan)
    db_session.commit()
    snapshot = EntitlementSnapshotService(db_session).get_snapshot(org.id)
    assert snapshot is not None
    assert snapshot.values["p2.snapc.key"]["value"] is True
    assert snapshot.computed_reason in ("subscription_created", "subscription_transition:active")


def test_snapshot_recomputes_on_transition(db_session):
    plan, definition = _plan_with_entitlement(db_session, "SNAPT", "p2.snapt.key", True)
    org, account, sub = _org_with_active_subscription(db_session, "SNAPTO", plan)
    db_session.commit()

    CommercialSubscriptionService(db_session).transition(sub, CommercialSubscriptionStatus.CANCELLED)
    db_session.commit()

    snapshot = EntitlementSnapshotService(db_session).get_snapshot(org.id)
    assert snapshot.computed_reason == "subscription_transition:cancelled"
    assert snapshot.values == {}  # no open subscription anymore


def test_snapshot_recomputes_on_provisioning_with_trial(db_session):
    plan = _plan(db_session, "SNAPPPLAN")
    granted = _plan(db_session, "SNAPPGRANT")
    granted_version = _published_version(db_session, granted)
    definition = _catalog_definition(db_session, "p2.snapp.key", EntitlementValueType.BOOLEAN)
    db_session.add(
        PlanEntitlement(plan_version_id=granted_version.id, entitlement_definition_id=definition.id, value=True)
    )
    program = CommercialEvaluationProgram(
        plan_id=plan.id, duration_days=14, granted_plan_id=granted.id, is_active=True,
    )
    db_session.add(program)
    db_session.commit()

    org = make_organization(db_session, code="SNAPPORG", name="Snap Provision Org")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    sub = CommercialSubscriptionService(db_session).provision_default_subscription(account.id, plan.plan_code)
    db_session.commit()

    assert sub.status == CommercialSubscriptionStatus.TRIALING
    snapshot = EntitlementSnapshotService(db_session).get_snapshot(org.id)
    assert snapshot.computed_reason == "provisioning"
    assert snapshot.values["p2.snapp.key"]["value"] is True
    assert snapshot.values["p2.snapp.key"]["source"] == "trial_grant"


# ── CommercialOverride lifecycle, incl. dual-approval and AC-10 ────────────


def test_override_full_lifecycle_and_self_approval_rejected(db_session):
    plan, definition = _plan_with_entitlement(db_session, "OVRPKG", "p2.ovr.key", False)
    org, account, sub = _org_with_active_subscription(db_session, "OVRORG", plan)
    db_session.commit()

    svc = CommercialOverrideService(db_session)
    override = svc.create_draft(
        organization_id=org.id, entitlement_definition_id=definition.id,
        value=True, reason="Enterprise negotiated grant", requested_by_user_id=101,
    )
    db_session.commit()
    assert override.status == CommercialOverrideStatus.DRAFT

    override, request = svc.submit_for_approval(override, requested_by_user_id=101, reason="please approve")
    db_session.commit()
    assert override.status == CommercialOverrideStatus.PENDING_APPROVAL

    # Same user cannot approve their own submission.
    with pytest.raises(SelfApprovalError):
        svc.approve_and_activate(override, approver_user_id=101)
    db_session.rollback()
    override = svc.get_override(override.id)
    assert override.status == CommercialOverrideStatus.PENDING_APPROVAL

    # A different user can.
    override = svc.approve_and_activate(override, approver_user_id=102)
    db_session.commit()
    assert override.status == CommercialOverrideStatus.APPROVED
    assert override.approved_by_user_id == 102

    resolved = resolve_entitlement(db_session, org.id, "p2.ovr.key")
    assert resolved.source_level == 3
    assert resolved.value is True

    # Revoke -> resolver falls back to the plan entitlement.
    svc.revoke(override, actor_id=102, reason="no longer needed")
    db_session.commit()
    resolved_after_revoke = resolve_entitlement(db_session, org.id, "p2.ovr.key")
    assert resolved_after_revoke.source_level != 3
    assert resolved_after_revoke.value is False


def test_override_reject_path(db_session):
    plan, definition = _plan_with_entitlement(db_session, "OVRRPKG", "p2.ovrr.key", False)
    org, account, sub = _org_with_active_subscription(db_session, "OVRRORG", plan)
    db_session.commit()

    svc = CommercialOverrideService(db_session)
    override = svc.create_draft(
        organization_id=org.id, entitlement_definition_id=definition.id,
        value=True, reason="test", requested_by_user_id=101,
    )
    override, _request = svc.submit_for_approval(override, requested_by_user_id=101, reason="please")
    db_session.commit()

    override = svc.reject(override, approver_user_id=102, rejection_reason="not approved")
    db_session.commit()
    assert override.status == CommercialOverrideStatus.REJECTED


def test_expired_override_has_zero_effect_with_no_cleanup_job(db_session):
    """AC-10: an override past expires_at is excluded automatically — no
    manual cleanup step required."""
    plan, definition = _plan_with_entitlement(db_session, "EXPPKG", "p2.exp.key", False)
    org, account, sub = _org_with_active_subscription(db_session, "EXPORG", plan)
    db_session.commit()

    expired_override = CommercialOverride(
        organization_id=org.id, entitlement_definition_id=definition.id,
        value=True, reason="test", status=CommercialOverrideStatus.APPROVED,
        expires_at=datetime.utcnow() - timedelta(days=1),
    )
    db_session.add(expired_override)
    db_session.commit()

    # No cleanup job run — the resolver alone excludes it.
    resolved = resolve_entitlement(db_session, org.id, "p2.exp.key")
    assert resolved.source_level != 3
    assert resolved.value is False


# ── UsageMeteringService idempotency ────────────────────────────────────────


def test_usage_metering_increment_is_idempotent(db_session):
    definition = _catalog_definition(db_session, "p2.usage.key", EntitlementValueType.INTEGER)
    org = make_organization(db_session, code="USGORG", name="Usage Org")
    db_session.commit()

    svc = UsageMeteringService(db_session)
    svc.increment(org.id, definition.id, idempotency_key="invoice:1")
    db_session.commit()
    svc.increment(org.id, definition.id, idempotency_key="invoice:1")  # retried request
    db_session.commit()

    assert svc.get_count(org.id, definition.id) == 1

    svc.increment(org.id, definition.id, idempotency_key="invoice:2")
    db_session.commit()
    assert svc.get_count(org.id, definition.id) == 2


# ── Fail-open (reads) vs fail-closed (writes), §14 ──────────────────────────


def test_is_entitled_fails_open_on_resolver_error(db_session, monkeypatch):
    definition = _catalog_definition(db_session, "billing.usage_metering", EntitlementValueType.BOOLEAN)
    org = make_organization(db_session, code="FOOPEN", name="Fail Open Org")
    db_session.commit()

    def _boom(db, organization_id, key):
        raise RuntimeError("resolver exploded")

    monkeypatch.setattr("app.modules.commercial.entitlement_resolver.resolve_entitlement", _boom)

    svc = CommercialEntitlementService(db_session)
    # Fails open: True (safe-allowed default), never raises.
    assert svc.is_entitled(org.id, "billing.usage_metering") is True
    assert svc.get_limit(org.id, "billing.invoice.monthly_limit") is None


def test_enforcement_fails_closed_on_resolver_error(db_session, monkeypatch):
    org = make_organization(db_session, code="FCLOSED", name="Fail Closed Org")
    db_session.commit()

    def _boom(db, organization_id, key):
        raise RuntimeError("resolver exploded")

    monkeypatch.setattr("app.modules.commercial.entitlement_enforcement.resolve_entitlement", _boom)

    svc = EntitlementEnforcementService(db_session)
    with pytest.raises(RuntimeError):
        svc.assert_boolean(organization_id=org.id, key="billing.usage_metering")


def test_enforcement_blocks_denied_boolean_entitlement(db_session):
    plan, definition = _plan_with_entitlement(db_session, "ENFBPKG", "collections.dunning", False)
    org, account, sub = _org_with_active_subscription(db_session, "ENFBORG", plan)
    db_session.commit()

    svc = EntitlementEnforcementService(db_session)
    with pytest.raises(EntitlementBlockedException):
        svc.assert_boolean(organization_id=org.id, key="collections.dunning")


def test_enforcement_allows_within_limit_and_blocks_over_limit(db_session):
    plan, definition = _plan_with_entitlement(
        db_session, "ENFLPKG", "org.entity.max", 2, EntitlementValueType.INTEGER,
    )
    org, account, sub = _org_with_active_subscription(db_session, "ENFLORG", plan)
    db_session.commit()

    svc = EntitlementEnforcementService(db_session)
    svc.assert_within_limit(organization_id=org.id, key="org.entity.max", current_count=1)  # 1+1=2, at limit, OK
    with pytest.raises(EntitlementBlockedException):
        svc.assert_within_limit(organization_id=org.id, key="org.entity.max", current_count=2)  # 2+1=3, over


def test_enforcement_noop_for_super_admin_caller(db_session):
    """A None organization_id (only possible for a super_admin caller) is
    not gated — the entitlement system governs tenant plan-driven
    capabilities, and a super_admin isn't tied to one."""
    svc = EntitlementEnforcementService(db_session)
    svc.assert_boolean(organization_id=None, key="collections.dunning")  # must not raise
    svc.assert_within_limit(organization_id=None, key="org.entity.max", current_count=999999)  # must not raise
