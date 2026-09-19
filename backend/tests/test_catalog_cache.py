"""
Regression tests for the commercial catalog cache (modules/commercial/cache.py).

Covers:
  - the "latest PUBLISHED version" scan being collapsed into one cached helper
  - the invalidation contract: publish / archive (the only two mutations that
    change what "latest PUBLISHED" means) must make the next read fresh
  - wiring through the real CommercialPlanVersionService paths (archive and the
    full draft -> submit -> approve -> publish flow) so the hooks actually fire
  - caching a None ("no published version") result so a later publish can't
    be obscured by a stale miss

All tests run on the isolated in-memory SQLite fixture from conftest.py; the
module-level cache is wiped by the autouse conftest fixture.
"""
from decimal import Decimal

from app.modules.commercial.cache import get_latest_published_version_id
from app.modules.commercial.enums import (
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialPlanVersionStatus,
)
from app.modules.commercial.models import (
    CommercialPlan,
    CommercialPlanVersion,
)
from app.modules.commercial.service import (
    CommercialPlanService,
    CommercialPlanVersionService,
)


def _make_plan(db, code="CACHE_PLAN"):
    plan = CommercialPlan(plan_code=code, plan_name=f"{code} plan", status=CommercialPlanStatus.ACTIVE)
    db.add(plan)
    db.flush()
    return plan


def _make_version(db, plan, number=1, status=CommercialPlanVersionStatus.PUBLISHED, price=None):
    version = CommercialPlanVersion(
        plan_id=plan.id,
        version_number=number,
        status=status,
        plan_name=plan.plan_name,
        billing_interval=CommercialBillingInterval.MONTHLY,
        currency="USD",
        price_amount=price,
    )
    db.add(version)
    db.flush()
    return version


def test_returns_highest_published_version(db_session):
    plan = _make_plan(db_session)
    _make_version(db_session, plan, number=1)
    v2 = _make_version(db_session, plan, number=2, price=Decimal("10"))
    db_session.commit()

    assert get_latest_published_version_id(db_session, plan.id) == v2.id


def test_no_published_version_returns_none(db_session):
    plan = _make_plan(db_session)
    _make_version(db_session, plan, status=CommercialPlanVersionStatus.DRAFT)
    db_session.commit()

    assert get_latest_published_version_id(db_session, plan.id) is None


def test_archive_service_invalidates_and_reveals_older_published(db_session):
    plan = _make_plan(db_session)
    v1 = _make_version(db_session, plan, number=1)
    v2 = _make_version(db_session, plan, number=2)
    db_session.commit()
    assert get_latest_published_version_id(db_session, plan.id) == v2.id

    CommercialPlanVersionService(db_session).archive(v2, actor_id=1)
    db_session.commit()

    assert get_latest_published_version_id(db_session, plan.id) == v1.id


def test_archive_last_published_version_invalidates_to_none(db_session):
    plan = _make_plan(db_session)
    v1 = _make_version(db_session, plan, number=1)
    db_session.commit()
    assert get_latest_published_version_id(db_session, plan.id) == v1.id

    CommercialPlanVersionService(db_session).archive(v1, actor_id=1)
    db_session.commit()

    assert get_latest_published_version_id(db_session, plan.id) is None


def test_publish_flow_invalidates_cached_none(db_session):
    """Cache a None (plan has no published version), then publish a draft
    through the real service flow — the next read must return the new version,
    not the stale miss."""
    plan = _make_plan(db_session)
    draft = _make_version(db_session, plan, status=CommercialPlanVersionStatus.DRAFT, price=Decimal("25"))
    db_session.commit()
    assert get_latest_published_version_id(db_session, plan.id) is None

    version_service = CommercialPlanVersionService(db_session)
    submitted, _request = version_service.submit_for_approval(
        draft, requested_by_user_id=42, reason="cache invalidation probe"
    )
    version_service.approve_and_publish(submitted, approver_user_id=7)
    db_session.commit()

    assert get_latest_published_version_id(db_session, plan.id) == submitted.id


def test_create_plan_service_uses_cache_consistently(db_session):
    """The service-level create_plan path keeps its own cache namespace apart
    from the version cache — creating a plan must not collide with the
    version-by-plan cache used by subscription creation."""
    plan = CommercialPlanService(db_session).create_plan(
        plan_code="CACHE_PLAN2", plan_name="Cache plan 2"
    )
    db_session.commit()
    assert get_latest_published_version_id(db_session, plan.id) is None