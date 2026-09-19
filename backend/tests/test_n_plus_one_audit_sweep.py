"""tests/test_n_plus_one_audit_sweep.py
-----------------------------------------
Task 5 (complete the N+1 audit): proof for the remaining list/index
endpoints across billing/routers, commercial, and super_admin that weren't
covered by test_credit_note_relations_query_count.py.

Finding: unlike Invoice/CreditNote (which have relationship-backed hybrid
properties — customer_name etc. — and needed joinedload(...customer), every
other list endpoint audited here (billing catalog routers, commercial
module, super_admin/router.py) either has no relationship-derived response
fields at all, or already builds its query as a single SQL JOIN / with_entities
projection plus a page-bounded batched dict lookup (the same pattern as
organization_service.list_organizations' _commercial_map) — never per-row
ORM relationship traversal. These tests prove that boundedness for a
representative endpoint of each pattern, rather than adding no-op
eager-loads to already-safe queries.
"""
from app.modules.auth.models import User, UserRole
from app.modules.commercial.models import CommercialSubscription
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.super_admin.financial_operations_detail_service import (
    FinancialOperationsDetailService,
)
from app.modules.super_admin.router import (
    list_commercial_subscriptions,
    list_platform_users,
)
from tests.conftest import count_queries, make_organization
from tests.test_commercial_subscription_management import _org_with_plan, _sa_user
from tests.test_credit_note_relations_query_count import _make_customer, _make_org
from app.modules.billing.models import CreditNote, CreditNoteStatus, CreditNoteType
from datetime import date


def _bounded_across_growth(seed_more, call_fn, db_session):
    """Seed `first`, measure, seed more (cumulative total `second`), measure
    again — assert the query count didn't grow. Each seed call must add
    *new*, non-colliding rows (unique numbers/codes) since this measures
    growth on one continuously-growing dataset, not two independent ones."""
    seed_more(5)
    with count_queries(db_session) as counter:
        call_fn()
    n_small = counter["n"]

    seed_more(25)  # cumulative total now 30
    with count_queries(db_session) as counter2:
        call_fn()
    n_large = counter2["n"]

    assert n_small == n_large, f"query count scaled with rows: {n_small} -> {n_large}"


def test_commercial_subscriptions_list_query_count_is_bounded(db_session):
    """list_commercial_subscriptions (super_admin/router.py) joins
    CommercialSubscription+Organization+CommercialPlan in one query — proof
    it doesn't regress into per-row plan/org lookups."""
    counter_box = {"n": 0}

    def _seed(count):
        for _ in range(count):
            i = counter_box["n"]
            counter_box["n"] += 1
            org, plan, account = _org_with_plan(db_session, f"NP1O{i}", f"NP1P{i}")
            db_session.add(CommercialSubscription(
                commercial_account_id=account.id,
                commercial_plan_id=plan.id,
                status=CommercialSubscriptionStatus.ACTIVE,
            ))
        db_session.commit()

    def _call():
        return list_commercial_subscriptions(
            skip=0, limit=50, search="", status=None,
            current_user=_sa_user(), db=db_session,
        )

    _bounded_across_growth(_seed, _call, db_session)


def test_platform_users_list_query_count_is_bounded(db_session):
    """list_platform_users batches its MFA-flag and per-org commercial-plan
    lookups (reuses organization_service._commercial_map) — proof it stays
    flat as the page fills up."""
    counter_box = {"n": 0}

    def _seed(count):
        for _ in range(count):
            i = counter_box["n"]
            counter_box["n"] += 1
            org = make_organization(db_session, code=f"NP2O{i}", name=f"Org {i}")
            db_session.add(User(
                email=f"user{i}@np2.example", hashed_password="x",
                role=UserRole.ORG_ADMIN, organization_id=org.id,
                first_name="U", last_name=str(i), is_active=True, is_verified=True,
            ))
        db_session.commit()

    def _call():
        return list_platform_users(
            skip=0, limit=50, search="", role="", organization_id=None,
            is_active=None, current_user=_sa_user(), db=db_session,
        )

    _bounded_across_growth(_seed, _call, db_session)


def test_financial_operations_credit_notes_query_count_is_bounded(db_session):
    """FinancialOperationsDetailService.list_credit_notes (backs
    /financial-operations/credit-notes) projects columns via with_entities
    joined to Organization in one query — never touches CreditNote.customer
    or its hybrid properties at all, so it can't regress into the same N+1
    that CreditNoteRepository.list_paginated was fixed for."""
    org = _make_org(db_session)
    customers = [_make_customer(db_session, org.id, code=f"NP3C{i}") for i in range(6)]
    cids = [c.id for c in customers]
    counter_box = {"n": 0}

    def _seed(count):
        for _ in range(count):
            i = counter_box["n"]
            counter_box["n"] += 1
            db_session.add(CreditNote(
                organization_id=org.id,
                customer_id=cids[i % len(cids)],
                credit_note_number=f"NP3-{i}",
                credit_note_type=CreditNoteType.PARTIAL_CREDIT,
                status=CreditNoteStatus.ISSUED,
                total_amount="10.00",
                remaining_amount="10.00",
                reason=f"reason {i}",
                issue_date=date.today(),
            ))
        db_session.commit()

    svc = FinancialOperationsDetailService(db_session)

    def _call():
        return svc.list_credit_notes(limit=50)

    _bounded_across_growth(_seed, _call, db_session)
