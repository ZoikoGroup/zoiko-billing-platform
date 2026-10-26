"""
tests/test_organization_account_status.py
-----------------------------------------
The Super Admin directory reports one account_status per organization
(trial / active / past_due / suspended / deactivated / no_plan) instead of
lifecycle bookkeeping states such as ONBOARDING. The per-row value
(account_status_for) and the SQL used for filtering and fleet counts
(_account_status_case) must agree.
"""

from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialPlanService,
    CommercialSubscriptionService,
)
from app.modules.organizations.models import TenantLifecycleState
from app.modules.super_admin.organization_service import OrganizationDirectoryService
from tests.conftest import make_organization


def _org(db, code, *, lifecycle=TenantLifecycleState.ACTIVE, sub_status=None, plan=None):
    org = make_organization(db, code=code, name=f"Org {code}")
    org.lifecycle_state = lifecycle
    if lifecycle in (TenantLifecycleState.SUSPENDED, TenantLifecycleState.DEACTIVATING, TenantLifecycleState.DEACTIVATED):
        org.is_active = False
    if sub_status is not None:
        account = CommercialAccountService(db).ensure_commercial_account(org.id)
        db.flush()
        sub = CommercialSubscriptionService(db).create_subscription(account.id, plan)
        sub.status = sub_status
    db.commit()
    return org


def _fleet(db):
    plan = CommercialPlanService(db).create_plan(plan_code="ACCTPLAN", plan_name="Acct Plan")
    db.flush()
    return {
        "trial": _org(db, "AS-TRIAL", lifecycle=TenantLifecycleState.ONBOARDING, sub_status=CommercialSubscriptionStatus.TRIALING, plan=plan),
        "recovery": _org(db, "AS-RECOV", sub_status=CommercialSubscriptionStatus.TRIAL_RECOVERY, plan=plan),
        "active": _org(db, "AS-ACTIVE", sub_status=CommercialSubscriptionStatus.ACTIVE, plan=plan),
        "past_due": _org(db, "AS-PASTDUE", sub_status=CommercialSubscriptionStatus.PAST_DUE, plan=plan),
        "suspended": _org(db, "AS-SUSP", lifecycle=TenantLifecycleState.SUSPENDED, sub_status=CommercialSubscriptionStatus.ACTIVE, plan=plan),
        "deactivated": _org(db, "AS-DEACT", lifecycle=TenantLifecycleState.DEACTIVATED, sub_status=CommercialSubscriptionStatus.TRIALING, plan=plan),
        "no_plan": _org(db, "AS-NOPLAN", lifecycle=TenantLifecycleState.ONBOARDING),
    }


EXPECTED = {
    "AS-TRIAL": "trial",  # onboarding lifecycle, but the account is on trial
    "AS-RECOV": "trial",
    "AS-ACTIVE": "active",
    "AS-PASTDUE": "past_due",
    "AS-SUSP": "suspended",  # lifecycle wins over the active subscription
    "AS-DEACT": "deactivated",
    "AS-NOPLAN": "no_plan",
}


def test_rows_report_account_status(db_session):
    _fleet(db_session)
    result = OrganizationDirectoryService(db_session).list_organizations(limit=50)
    by_code = {o["organization_code"]: o["account_status"] for o in result["organizations"]}
    assert {code: by_code[code] for code in EXPECTED} == EXPECTED


def test_status_counts_match_rows(db_session):
    _fleet(db_session)
    counts = OrganizationDirectoryService(db_session).list_organizations(limit=50)["status_counts"]
    assert counts["trial"] >= 2 and counts["active"] >= 1 and counts["past_due"] >= 1
    assert counts["suspended"] >= 1 and counts["deactivated"] >= 1 and counts["no_plan"] >= 1
    rows = OrganizationDirectoryService(db_session).list_organizations(limit=200)["organizations"]
    from collections import Counter
    assert dict(Counter(o["account_status"] for o in rows)) == {k: v for k, v in counts.items() if v}


def test_filter_by_account_status_uses_the_same_rule(db_session):
    _fleet(db_session)
    svc = OrganizationDirectoryService(db_session)
    for status in ("trial", "active", "past_due", "suspended", "deactivated", "no_plan"):
        result = svc.list_organizations(limit=200, account_status=status)
        assert result["total"] == len(result["organizations"])
        assert {o["account_status"] for o in result["organizations"]} <= {status}
    trial_codes = {o["organization_code"] for o in svc.list_organizations(limit=200, account_status="trial")["organizations"]}
    assert {"AS-TRIAL", "AS-RECOV"} <= trial_codes


def test_unknown_account_status_is_rejected(db_session):
    import pytest
    from app.core.exceptions import BadRequestException

    with pytest.raises(BadRequestException):
        OrganizationDirectoryService(db_session).list_organizations(account_status="onboarding")
