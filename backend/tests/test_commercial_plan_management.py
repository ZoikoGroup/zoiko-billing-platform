"""
PHASE 8 tests — Commercial Plan management (Super Admin) + default-plan logic.

Mandated PLAN coverage (Step 13 §PLAN):
  1. list plans
  2. get plan
  3. create plan
  4. duplicate plan rejected
  5. inactive plan
  6. archived plan
  7. referenced plan cannot be deleted
  8. default plan selection
  9. multiple defaults prevented

Handlers/dependencies are invoked directly (no HTTP layer) on the isolated
in-memory SQLite fixture — never BILLING_DATABASE_URL.
"""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.dependencies import get_current_super_admin
from app.core.exceptions import ForbiddenException
from app.modules.auth.models import User, UserRole
from app.modules.commercial.enums import (
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.models import CommercialPlan, CommercialSubscription
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.super_admin.router import (
    create_commercial_plan,
    get_commercial_plan,
    list_commercial_plans,
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


def _sa_user():
    return User(
        email="sa@plan8.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="A",
        phone="",
        is_active=True,
        is_verified=True,
    )


def _create(db, code="STARTER", name="Starter", **kw):
    return create_commercial_plan(
        data=_PlanSchema(plan_code=code, plan_name=name, **kw),
        current_user=_sa_user(),
        db=db,
    )


def test_list_plans(db_session):
    _create(db_session, code="A1", name="Plan A")
    _create(db_session, code="B1", name="Plan B")
    result = list_commercial_plans(skip=0, limit=50, current_user=_sa_user(), db=db_session)
    assert result.total == 2
    assert {p.plan_code for p in result.plans} == {"A1", "B1"}


def test_get_plan(db_session):
    created = _create(db_session, code="GET1", name="Get Me")
    fetched = get_commercial_plan(plan_id=created.id, current_user=_sa_user(), db=db_session)
    assert fetched.plan_code == "GET1"
    assert fetched.plan_name == "Get Me"


def test_create_plan(db_session):
    created = _create(db_session, code="NEW1", name="New Plan")
    db_session.commit()
    assert created.id is not None
    assert created.status == CommercialPlanStatus.ACTIVE
    assert created.is_default is False
    # No invented pricing — structure stays null.
    assert created.price_amount is None
    assert created.currency is None
    assert created.max_users is None


def test_duplicate_plan_rejected(db_session):
    _create(db_session, code="DUP1", name="First")
    db_session.commit()
    from app.core.exceptions import BadRequestException

    with pytest.raises(BadRequestException):
        _create(db_session, code="DUP1", name="Second")
    assert db_session.query(CommercialPlan).count() == 1


def test_inactive_plan(db_session):
    created = _create(db_session, code="INAC1", name="Going Inactive")
    db_session.commit()
    set_commercial_plan_status(
        plan_id=created.id,
        data=_StatusSchema(status=CommercialPlanStatus.INACTIVE),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(created)
    assert created.status == CommercialPlanStatus.INACTIVE
    # INACTIVE cannot be the approved default.
    from app.core.exceptions import BadRequestException

    with pytest.raises(BadRequestException):
        set_commercial_plan_default(
            plan_id=created.id,
            data=_StatusSchema(is_default=True),
            current_user=_sa_user(),
            db=db_session,
        )
    # But a plan can be reactivated.
    set_commercial_plan_status(
        plan_id=created.id,
        data=_StatusSchema(status=CommercialPlanStatus.ACTIVE),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(created)
    assert created.status == CommercialPlanStatus.ACTIVE


def test_archived_plan(db_session):
    created = _create(db_session, code="ARCH1", name="To Archive")
    db_session.commit()
    set_commercial_plan_status(
        plan_id=created.id,
        data=_StatusSchema(status=CommercialPlanStatus.ARCHIVED),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(created)
    assert created.status == CommercialPlanStatus.ARCHIVED
    # ARCHIVED is terminal — cannot be un-archived.
    from app.core.exceptions import BadRequestException

    with pytest.raises(BadRequestException):
        set_commercial_plan_status(
            plan_id=created.id,
            data=_StatusSchema(status=CommercialPlanStatus.ACTIVE),
            current_user=_sa_user(),
            db=db_session,
        )


def test_referenced_plan_cannot_be_deleted(db_session):
    """The retirement path is ARCHIVE, never hard-delete. Direct SQL delete of a
    referenced plan is additionally blocked by the ON DELETE RESTRICT FK."""
    org = make_organization(db_session, code="DEL8A", name="Del Ref")
    db_session.commit()
    plan = CommercialPlanService(db_session).create_plan(plan_code="DELREF1", plan_name="Del Ref")
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    CommercialSubscriptionService(db_session).create_subscription(account.id, plan)
    db_session.commit()

    # No delete endpoint exists (audit surface), so attempt a raw delete with
    # FK enforcement on: the RESTRICT FK must block it.
    db_session.execute(text("PRAGMA foreign_keys=ON"))
    with pytest.raises(IntegrityError):
        db_session.delete(plan)
        db_session.flush()
    db_session.rollback()

    # Plan + history still intact.
    assert db_session.query(CommercialPlan).count() == 1
    assert db_session.query(CommercialSubscription).count() == 1


def test_default_plan_selection(db_session):
    a = _create(db_session, code="DEF8A", name="Default A")
    b = _create(db_session, code="DEF8B", name="Default B")
    db_session.commit()

    set_commercial_plan_default(
        plan_id=a.id,
        data=_StatusSchema(is_default=True),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(a)
    db_session.refresh(b)
    assert a.is_default is True
    assert b.is_default is False


def test_multiple_defaults_prevented(db_session):
    a = _create(db_session, code="MULT8A", name="Multi A")
    b = _create(db_session, code="MULT8B", name="Multi B")
    db_session.commit()

    set_commercial_plan_default(
        plan_id=a.id,
        data=_StatusSchema(is_default=True),
        current_user=_sa_user(),
        db=db_session,
    )
    set_commercial_plan_default(
        plan_id=b.id,
        data=_StatusSchema(is_default=True),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(a)
    db_session.refresh(b)
    assert a.is_default is False
    assert b.is_default is True
    defaults = (
        db_session.query(CommercialPlan)
        .filter(CommercialPlan.is_default.is_(True))
        .count()
    )
    assert defaults == 1

    # Selecting the same plan again is idempotent — still one default.
    set_commercial_plan_default(
        plan_id=b.id,
        data=_StatusSchema(is_default=True),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(b)
    assert b.is_default is True
    assert db_session.query(CommercialPlan).filter(CommercialPlan.is_default.is_(True)).count() == 1

    # Clearing leaves NO default.
    set_commercial_plan_default(
        plan_id=b.id,
        data=_StatusSchema(is_default=False),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(b)
    assert b.is_default is False
    assert db_session.query(CommercialPlan).filter(CommercialPlan.is_default.is_(True)).count() == 0


def test_non_super_admin_rejected(db_session):
    tenant = User(
        email="org@plan8.example",
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


def test_plan_update_preserves_history(db_session):
    org = make_organization(db_session, code="UP8A", name="Upd Org")
    db_session.commit()
    plan = CommercialPlanService(db_session).create_plan(
        plan_code="UP8B", plan_name="Before"
    )
    account = CommercialAccountService(db_session).ensure_commercial_account(org.id)
    db_session.commit()
    sub = CommercialSubscriptionService(db_session).create_subscription(account.id, plan)
    db_session.commit()

    update_commercial_plan(
        plan_id=plan.id,
        data=_UpdateSchema(plan_name="After", max_users=10),
        current_user=_sa_user(),
        db=db_session,
    )
    db_session.refresh(plan)
    db_session.refresh(sub)
    assert plan.plan_name == "After"
    assert plan.max_users == 10
    # History untouched: same plan reference, same status, same period fields.
    assert sub.commercial_plan_id == plan.id
    assert sub.status == CommercialSubscriptionStatus.PENDING
