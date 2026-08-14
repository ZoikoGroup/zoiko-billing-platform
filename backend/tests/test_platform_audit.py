"""
PHASE 11 tests — Platform audit trail (PlatformAuditLog + PlatformAuditService)
+ cross-organization Super Admin audit feed.

Mandated coverage (Step 18):
  1. create audit
  2. update audit
  3. activate audit
  4. deactivate audit
  5. set-default audit
  6. clear-default audit
  7. archive audit
  8. failed mutation => zero audit rows
  9. actor recorded
  10. old/new values recorded
  11. transaction rollback drops audit rows with the caller's transaction
  12. endpoint access (Super Admin can list)
  13. tenant denied (403 via get_current_super_admin)
  14. organization filter
  15. action filter
  16. entity filter
  17. pagination / created_at DESC order
  18. subscription audit unchanged (Phase 9 BillingAuditLog preserved separately)

Handlers/dependencies are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL.
"""
from datetime import date, timedelta

import pytest

from app.core.dependencies import get_current_super_admin
from app.core.exceptions import BadRequestException, ForbiddenException
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import BillingAuditLog
from app.modules.commercial.enums import CommercialPlanStatus, CommercialSubscriptionStatus
from app.modules.commercial.models import CommercialPlan
from app.modules.commercial.service import CommercialPlanService
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from app.modules.super_admin.router import (
    create_commercial_plan,
    create_commercial_subscription,
    list_platform_audit_logs,
    set_commercial_plan_default,
    set_commercial_plan_status,
    update_commercial_plan,
)
from tests.conftest import make_organization


class _PlanSchema:
    """Minimal stand-in for the Pydantic create schema (model_dump only)."""

    def __init__(self, **kwargs):
        self._data = kwargs

    def model_dump(self):
        return dict(self._data)


class _UpdateSchema:
    def __init__(self, **kwargs):
        self._data = kwargs

    def model_dump(self, exclude_unset=False):
        return dict(self._data)


class _StatusSchema:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def _sa(db):
    user = User(
        email="sa@audit11.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="Super",
        last_name="Admin",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def _create(db, code="STARTER", name="Starter", current_user=None, **kw):
    return create_commercial_plan(
        data=_PlanSchema(plan_code=code, plan_name=name, **kw),
        current_user=current_user or _sa(db),
        db=db,
    )


def _count(db):
    return db.query(PlatformAuditLog).count()


# ── 1-7: every plan mutation produces the right audit action ───────────────


def test_create_audit(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="AUD1", name="Create Me", current_user=sa)
    entries = db_session.query(PlatformAuditLog).order_by(PlatformAuditLog.id).all()
    assert len(entries) == 1
    entry = entries[0]
    assert entry.action == PlatformAuditAction.CREATE
    assert entry.entity_type == "CommercialPlan"
    assert entry.entity_id == plan.id
    assert entry.actor_id == sa.id
    assert entry.organization_id is None
    assert entry.old_values is None
    assert entry.new_values["plan_code"] == "AUD1"
    assert entry.new_values["status"] == "active"
    assert entry.new_values["is_default"] is False


def test_update_audit(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="AUD2", name="Before", current_user=sa)
    update_commercial_plan(
        plan_id=plan.id,
        data=_UpdateSchema(plan_name="After", max_users=10),
        current_user=sa,
        db=db_session,
    )
    entries = db_session.query(PlatformAuditLog).order_by(PlatformAuditLog.id).all()
    assert len(entries) == 2
    update = entries[-1]
    assert update.action == PlatformAuditAction.UPDATE
    assert update.entity_id == plan.id
    assert update.old_values["plan_name"] == "Before"
    assert update.new_values["plan_name"] == "After"
    assert update.old_values["max_users"] is None
    assert update.new_values["max_users"] == 10
    assert "plan_code" not in update.old_values  # immutable, not part of an edit


def test_update_noop_writes_no_audit(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="AUD3", name="Same", current_user=sa)
    before = _count(db_session)
    update_commercial_plan(
        plan_id=plan.id,
        data=_UpdateSchema(plan_name="Same"),
        current_user=sa,
        db=db_session,
    )
    assert _count(db_session) == before  # no change, no audit row


def test_activate_audit(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="AUD4", name="Activate", current_user=sa)
    set_commercial_plan_status(
        plan_id=plan.id,
        data=_StatusSchema(status=CommercialPlanStatus.INACTIVE),
        current_user=sa,
        db=db_session,
    )
    set_commercial_plan_status(
        plan_id=plan.id,
        data=_StatusSchema(status=CommercialPlanStatus.ACTIVE),
        current_user=sa,
        db=db_session,
    )
    entries = db_session.query(PlatformAuditLog).order_by(PlatformAuditLog.id).all()
    assert [e.action for e in entries] == [
        PlatformAuditAction.CREATE,
        PlatformAuditAction.DEACTIVATE,
        PlatformAuditAction.ACTIVATE,
    ]
    activate = entries[-1]
    assert activate.old_values["status"] == "inactive"
    assert activate.new_values["status"] == "active"
    assert activate.metadata_["transition"] == "inactive->active"


def test_deactivate_audit(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="AUD5", name="Deactivate", current_user=sa)
    set_commercial_plan_status(
        plan_id=plan.id,
        data=_StatusSchema(status=CommercialPlanStatus.INACTIVE),
        current_user=sa,
        db=db_session,
    )
    deactivate = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.action == PlatformAuditAction.DEACTIVATE)
        .one()
    )
    assert deactivate.entity_id == plan.id
    assert deactivate.old_values["status"] == "active"
    assert deactivate.new_values["status"] == "inactive"


def test_deactivate_clears_default_flag_and_audits_it(db_session):
    sa = _sa(db_session)
    plan = _create(
        db_session, code="AUD6", name="Default Toggle", current_user=sa, is_default=True
    )
    set_commercial_plan_status(
        plan_id=plan.id,
        data=_StatusSchema(status=CommercialPlanStatus.INACTIVE),
        current_user=sa,
        db=db_session,
    )
    deactivate = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.action == PlatformAuditAction.DEACTIVATE)
        .one()
    )
    assert deactivate.old_values["is_default"] is True
    assert deactivate.new_values["is_default"] is False


def test_set_default_audit(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="AUD7", name="Set Default", current_user=sa)
    set_commercial_plan_default(
        plan_id=plan.id,
        data=_StatusSchema(is_default=True),
        current_user=sa,
        db=db_session,
    )
    entry = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.action == PlatformAuditAction.SET_DEFAULT)
        .one()
    )
    assert entry.entity_id == plan.id
    assert entry.old_values["is_default"] is False
    assert entry.new_values["is_default"] is True


def test_clear_default_audit(db_session):
    sa = _sa(db_session)
    plan = _create(
        db_session, code="AUD8", name="Clear Default", current_user=sa, is_default=True
    )
    set_commercial_plan_default(
        plan_id=plan.id,
        data=_StatusSchema(is_default=False),
        current_user=sa,
        db=db_session,
    )
    entry = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.action == PlatformAuditAction.CLEAR_DEFAULT)
        .one()
    )
    assert entry.entity_id == plan.id
    assert entry.old_values["is_default"] is True
    assert entry.new_values["is_default"] is False


def test_set_default_noop_writes_no_audit(db_session):
    sa = _sa(db_session)
    plan = _create(
        db_session, code="AUD9", name="Noop Default", current_user=sa, is_default=True
    )
    before = _count(db_session)
    set_commercial_plan_default(
        plan_id=plan.id,
        data=_StatusSchema(is_default=True),
        current_user=sa,
        db=db_session,
    )
    assert _count(db_session) == before


def test_archive_audit(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="AUD10", name="Archive", current_user=sa)
    set_commercial_plan_status(
        plan_id=plan.id,
        data=_StatusSchema(status=CommercialPlanStatus.ARCHIVED),
        current_user=sa,
        db=db_session,
    )
    entry = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.action == PlatformAuditAction.ARCHIVE)
        .one()
    )
    assert entry.entity_id == plan.id
    assert entry.old_values["status"] == "active"
    assert entry.new_values["status"] == "archived"


# ── 8: failed mutations leave ZERO audit rows ──────────────────────────────


def test_failed_create_leaves_no_audit_row(db_session):
    sa = _sa(db_session)
    _create(db_session, code="DUP11", name="First", current_user=sa)
    before = _count(db_session)
    with pytest.raises(BadRequestException):
        _create(db_session, code="DUP11", name="Second", current_user=sa)
    assert _count(db_session) == before
    assert db_session.query(CommercialPlan).count() == 1


def test_failed_status_transition_leaves_no_audit_row(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="ARCH11", name="Terminal", current_user=sa)
    set_commercial_plan_status(
        plan_id=plan.id,
        data=_StatusSchema(status=CommercialPlanStatus.ARCHIVED),
        current_user=sa,
        db=db_session,
    )
    before = _count(db_session)  # CREATE + ARCHIVE
    with pytest.raises(BadRequestException):
        set_commercial_plan_status(
            plan_id=plan.id,
            data=_StatusSchema(status=CommercialPlanStatus.ACTIVE),
            current_user=sa,
            db=db_session,
        )
    assert _count(db_session) == before


def test_failed_default_selection_leaves_no_audit_row(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="INAC11", name="Inactive", current_user=sa)
    set_commercial_plan_status(
        plan_id=plan.id,
        data=_StatusSchema(status=CommercialPlanStatus.INACTIVE),
        current_user=sa,
        db=db_session,
    )
    before = _count(db_session)  # CREATE + DEACTIVATE
    with pytest.raises(BadRequestException):
        set_commercial_plan_default(
            plan_id=plan.id,
            data=_StatusSchema(is_default=True),
            current_user=sa,
            db=db_session,
        )
    assert _count(db_session) == before


# ── 9-10: actor + old/new values are recorded ──────────────────────────────


def test_actor_recorded(db_session):
    sa = _sa(db_session)
    _create(db_session, code="ACT11", name="Actor", current_user=sa)
    entry = db_session.query(PlatformAuditLog).one()
    assert entry.actor_id == sa.id


# ── 11: transaction rollback drops audit rows with the caller's transaction ─


def test_rollback_drops_audit_rows_with_caller_transaction(db_session):
    sa = _sa(db_session)
    svc = CommercialPlanService(db_session)
    svc.create_plan(plan_code="RB11", plan_name="Rollback", actor_id=sa.id)
    # Flushed into the caller's transaction — visible in-session but NOT committed.
    assert _count(db_session) == 1
    assert db_session.query(CommercialPlan).count() == 1
    db_session.rollback()
    assert _count(db_session) == 0
    assert db_session.query(CommercialPlan).count() == 0


# ── 12-13: endpoint access + tenant isolation ──────────────────────────────


def test_super_admin_can_list_audit_logs(db_session):
    sa = _sa(db_session)
    _create(db_session, code="FEED11", name="Feed", current_user=sa)
    result = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert result.total == 1
    assert result.logs[0].actor_email == sa.email
    assert result.logs[0].action == "create"


def test_tenant_denied(db_session):
    tenant = User(
        email="org@audit11.example",
        hashed_password="x",
        role=UserRole.ORG_ADMIN,
        organization_id=1,
        first_name="T",
        last_name="U",
        phone="",
        is_active=True,
        is_verified=True,
    )
    with pytest.raises(ForbiddenException):
        get_current_super_admin(current_user=tenant)


# ── 14-16: feed filters ────────────────────────────────────────────────────


def test_organization_filter(db_session):
    sa = _sa(db_session)
    org = make_organization(db_session, code="AUDORG", name="Audit Org")
    db_session.flush()
    # Simulate an org-attached platform event (future org-scoped platform
    # action) to prove the organization_id filter works end to end.
    PlatformAuditService(db_session).log_no_commit(
        actor_id=sa.id,
        action=PlatformAuditAction.UPDATE,
        entity_type="Organization",
        entity_id=org.id,
        organization_id=org.id,
        new_values={"is_active": True},
    )
    db_session.commit()

    only_org = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="",
        actor_id=None, organization_id=org.id, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert only_org.total == 1
    assert only_org.logs[0].organization_id == org.id

    none_match = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="",
        actor_id=None, organization_id=999999, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert none_match.total == 0


def test_action_filter(db_session):
    sa = _sa(db_session)
    plan = _create(db_session, code="FILT11", name="Filter", current_user=sa)
    set_commercial_plan_status(
        plan_id=plan.id,
        data=_StatusSchema(status=CommercialPlanStatus.INACTIVE),
        current_user=sa,
        db=db_session,
    )
    creates = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="create",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert creates.total == 1
    assert creates.logs[0].action == "create"
    deactivates = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="deactivate",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert deactivates.total == 1
    assert deactivates.logs[0].action == "deactivate"


def test_entity_type_and_search_filter(db_session):
    sa = _sa(db_session)
    _create(db_session, code="ENT11", name="Entity", current_user=sa)
    by_entity = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="CommercialPlan", action="",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert by_entity.total == 1

    by_search = list_platform_audit_logs(
        skip=0, limit=50, search="mercialplan", entity_type="", action="",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert by_search.total == 1

    no_match = list_platform_audit_logs(
        skip=0, limit=50, search="zzz-nothing", entity_type="", action="",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert no_match.total == 0


def test_actor_and_date_filter(db_session):
    sa = _sa(db_session)
    _create(db_session, code="DAT11", name="Date Filter", current_user=sa)
    by_actor = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="",
        actor_id=sa.id, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert by_actor.total == 1
    assert by_actor.logs[0].actor_id == sa.id

    # Today's row must fall inside generous day bounds.
    wide = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="",
        actor_id=None, organization_id=None,
        date_from=date.today() - timedelta(days=1),
        date_to=date.today() + timedelta(days=1),
        current_user=sa, db=db_session,
    )
    assert wide.total == 1

    none_in_range = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="",
        actor_id=None, organization_id=None,
        date_from=date.today() + timedelta(days=30),
        date_to=date.today() + timedelta(days=31),
        current_user=sa, db=db_session,
    )
    assert none_in_range.total == 0


# ── 17: pagination + created_at DESC order ─────────────────────────────────


def test_pagination_and_ordering(db_session):
    sa = _sa(db_session)
    created_ids = []
    for i in range(5):
        plan = _create(db_session, code=f"PAG11{i}", name=f"Plan {i}", current_user=sa)
        created_ids.append(plan.id)

    result = list_platform_audit_logs(
        skip=0, limit=2, search="", entity_type="", action="",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert result.total == 5
    assert len(result.logs) == 2
    returned_ids = [log.entity_id for log in result.logs]
    assert returned_ids == sorted(created_ids, reverse=True)[:2]

    page2 = list_platform_audit_logs(
        skip=2, limit=2, search="", entity_type="", action="",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert len(page2.logs) == 2
    assert [log.entity_id for log in page2.logs] == sorted(created_ids, reverse=True)[2:4]


# ── 18: Phase 9 subscription audit (BillingAuditLog) preserved separately ──


def test_subscription_audit_unchanged_and_separate(db_session):
    sa = _sa(db_session)
    org = make_organization(db_session, code="SUBAUD", name="Sub Audit")
    db_session.commit()

    plan = CommercialPlanService(db_session).create_plan(
        plan_code="SUBPLAN", plan_name="Sub Plan", actor_id=sa.id
    )
    db_session.commit()
    platform_rows_after_plan = _count(db_session)
    assert platform_rows_after_plan == 1  # only the plan CREATE

    create_commercial_subscription(
        data=_StatusSchema(
            organization_id=org.id,
            plan_id=plan.id,
            status=CommercialSubscriptionStatus.PENDING,
        ),
        current_user=sa,
        db=db_session,
    )

    # Phase 9 audit still records the subscription in the org-scoped trail.
    billing_entries = db_session.query(BillingAuditLog).all()
    assert len(billing_entries) == 1
    assert billing_entries[0].organization_id == org.id
    assert billing_entries[0].entity_type == "CommercialSubscription"

    # ...and the subscription mutation is NOT duplicated into the platform trail.
    assert _count(db_session) == platform_rows_after_plan

    feed = list_platform_audit_logs(
        skip=0, limit=50, search="", entity_type="", action="",
        actor_id=None, organization_id=None, date_from=None, date_to=None,
        current_user=sa, db=db_session,
    )
    assert feed.total == platform_rows_after_plan
    assert all(log.entity_type == "CommercialPlan" for log in feed.logs)
