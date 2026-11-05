"""Tax Control Center backend gaps B1 and B3.

B1: the platform approvals inbox lists every tax change awaiting approval
(staged rates, tax-code sets, rule packs, market availability) with
can_approve / reason_if_not reflecting maker-checker. Tax roles only, no
tenant data.

B3: additive cursor pagination. Old clients (no limit/cursor) get the same
fields as before, plus next_cursor; endpoints that already had a limit keep
their defaults.
"""
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.modules.auth.models import PlatformRole, UserRole
from app.modules.super_admin.models import ApprovalRequest
from app.modules.tax.enums import (
    PlatformVersionStatus,
    RateKind,
    StagedRateStatus,
    StagingOrigin,
    TaxOperatingMode,
    TransactionClass,
)
from app.modules.tax.pagination import encode_cursor
from app.modules.tax.policy_models import TaxRulePackVersion
from app.modules.tax.policy_service import MarketAvailabilityService, TaxCodeSetService
from app.modules.tax.registry_models import TaxChangeApproval, TaxRateStaging
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase3a_governed import GATES, build_world, draft

INBOX = "/api/v1/super-admin/tax-registry/approvals-inbox"
NOW = datetime.now(timezone.utc)
ITEM_FIELDS = {"kind", "id", "title", "submitted_by", "submitted_at", "can_approve", "reason_if_not"}


@pytest.fixture()
def world(db_session):
    w = build_world(db_session, org_code="TCCAPI")
    w["inv"] = draft(w, [(w["svc_product"], 100, 1, False)], number="INV-TCC-SECRET")
    db = db_session
    maker = w["reviewer"]

    avail = MarketAvailabilityService(db)
    row = avail.draft(actor_id=maker.id, jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                      transaction_class=TransactionClass.B2C_GOODS, mode=TaxOperatingMode.REFERENCE_ONLY, gates=GATES)
    avail.validate(actor_id=maker.id, version_id=row.id)
    avail.submit(actor_id=maker.id, version_id=row.id, reason="inbox")
    w["availability"] = row

    codes = TaxCodeSetService(db)
    cs = codes.draft(actor_id=maker.id)
    codes.validate(actor_id=maker.id, version_id=cs.id)
    codes.submit(actor_id=maker.id, version_id=cs.id, reason="inbox")
    w["code_set"] = cs

    w["pack"] = TaxRulePackVersion(code="GB-VAT-DOMESTIC-SERVICES", version="9", markets=[], rounding_rule="PER_LINE",
                                   rounding_mode="HALF_UP", status=PlatformVersionStatus.IN_APPROVAL,
                                   created_by_user_id=maker.id, maker_user_id=maker.id, created_at=NOW,
                                   submitted_at=NOW)
    db.add(w["pack"])

    # A staged rate prepared by the publisher: they cannot approve their own change.
    staged = TaxRateStaging(origin=StagingOrigin.MANUAL, component_id=w["component"].id, tax_code="STANDARD",
                            product_scope="GENERAL", rate_kind=RateKind.STANDARD, rate_percent=Decimal("21"),
                            observed_at=NOW, created_at=NOW, status=StagedRateStatus.IN_APPROVAL,
                            created_by_user_id=w["publisher"].id)
    request = ApprovalRequest(request_type="tax_rate_publish", requested_at=datetime.utcnow())
    db.add_all([staged, request])
    db.flush()
    change = TaxChangeApproval(approval_request_id=request.id, staged_rate_id=staged.id, change_kind="NEW",
                               detector=StagingOrigin.MANUAL, submitted_at=NOW, maker_user_id=w["publisher"].id)
    db.add(change)
    db.flush()
    staged.change_approval_id = change.id
    db.commit()
    w["staged"] = staged
    return w


def _by_kind(items):
    return {i["kind"]: i for i in items}


def test_inbox_reflects_maker_checker_per_item(db_session, client_for, world):
    publisher = client_for(world["publisher"])
    body = publisher.get(INBOX).json()
    items = _by_kind(body["items"])
    assert set(items) == {"staged_rate", "tax_code_set", "rule_pack", "market_availability"}
    assert all(set(i) == ITEM_FIELDS for i in body["items"]) and body["next_cursor"] is None
    for kind in ("tax_code_set", "rule_pack", "market_availability"):
        assert items[kind]["can_approve"] is True and items[kind]["reason_if_not"] is None
        assert items[kind]["submitted_by"] == world["reviewer"].id and items[kind]["submitted_at"]
    assert items["staged_rate"]["can_approve"] is False                  # the publisher prepared it
    assert "different person" in items["staged_rate"]["reason_if_not"]
    assert "GB-VAT STANDARD/GENERAL 21%" in items["staged_rate"]["title"]
    assert items["market_availability"]["title"] == "GB VAT B2C_GOODS -> REFERENCE_ONLY"


def test_reviewers_see_the_inbox_but_cannot_approve(db_session, client_for, world):
    body = client_for(world["reviewer"]).get(INBOX).json()
    assert body["items"] and all(i["can_approve"] is False for i in body["items"])
    assert all("TAX_PUBLISHER" in i["reason_if_not"] for i in body["items"])


def test_inbox_is_platform_data_only(db_session, client_for, world):
    text = client_for(world["publisher"]).get(INBOX).text
    for secret in ("INV-TCC-SECRET", world["org"].organization_name, world["customer"].email,
                   "organization_id", "invoice", "customer"):
        assert secret not in text, secret


@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.RELIABILITY_OPERATOR,
                                  PlatformRole.AUDITOR])
def test_inbox_is_for_tax_roles_only(db_session, client_for, world, role):
    client = client_for(make_super_admin(db_session, f"{role.value}@tcc.example", role))
    assert client.get(INBOX).status_code == 403


def test_tenant_users_cannot_reach_the_inbox(db_session, client_for, world):
    assert client_for(world["maker"]).get(INBOX).status_code == 403


def test_inbox_pagination_and_kind_filter(db_session, client_for, world):
    client = client_for(world["publisher"])
    first = client.get(INBOX, params={"limit": 3}).json()
    assert len(first["items"]) == 3 and first["next_cursor"]
    second = client.get(INBOX, params={"limit": 3, "cursor": first["next_cursor"]}).json()
    assert len(second["items"]) == 1 and second["next_cursor"] is None
    seen = [(i["kind"], i["id"]) for i in first["items"] + second["items"]]
    assert len(set(seen)) == 4
    only = client.get(INBOX, params={"kind": "rule_pack"}).json()["items"]
    assert [i["kind"] for i in only] == ["rule_pack"]
    assert client.get(INBOX, params={"cursor": "not-a-cursor"}).status_code == 400
    assert client.get(INBOX, params={"limit": 201}).status_code == 422


# ── B3: backward-compatible pagination ──────────────────────────────────

PLATFORM_LISTS = ["/api/v1/super-admin/tax-registry/source-revisions",
                  "/api/v1/super-admin/tax-registry/market-availability",
                  "/api/v1/super-admin/tax-registry/tax-code-sets",
                  "/api/v1/super-admin/tax-registry/rule-packs"]


@pytest.mark.parametrize("url", PLATFORM_LISTS)
def test_old_clients_get_the_same_fields_plus_next_cursor(db_session, client_for, world, url):
    body = client_for(world["publisher"]).get(url).json()
    assert set(body) == {"items", "next_cursor"} and body["next_cursor"] is None
    assert body["items"]                                               # all rows, under the default page size


def test_platform_list_pages_through_every_row(db_session, client_for, world):
    client = client_for(world["publisher"])
    url = "/api/v1/super-admin/tax-registry/market-availability"
    everything = client.get(url).json()["items"]
    collected, cursor = [], None
    while True:
        page = client.get(url, params={"limit": 2, **({"cursor": cursor} if cursor else {})}).json()
        collected += page["items"]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert [r["id"] for r in collected] == [r["id"] for r in everything]


def test_staged_rates_keep_skip_and_limit_and_add_a_cursor(db_session, client_for, world):
    client = client_for(world["publisher"])
    url = "/api/v1/super-admin/tax-registry/staged-rates"
    body = client.get(url).json()
    assert set(body) == {"items", "total", "next_cursor"} and body["total"] == len(body["items"])
    assert client.get(url, params={"skip": 0, "limit": 500}).status_code == 200      # old maximum still valid
    paged = client.get(url, params={"limit": 1}).json()
    assert len(paged["items"]) == 1 and (paged["next_cursor"] is not None) == (body["total"] > 1)


def test_reference_jurisdictions_paginate(db_session, client_for, world):
    client = client_for(world["maker"])
    body = client.get("/api/v1/tax/jurisdictions").json()
    assert set(body) == {"items", "next_cursor"} and body["next_cursor"] is None


TENANT_LISTS = ["/api/v1/tax/legal-entities", "/api/v1/tax/registrations", "/api/v1/tax/legal-bases",
                "/api/v1/tax/activations", "/api/v1/tax/product-classifications", "/api/v1/tax/review-items"]


@pytest.mark.parametrize("url", TENANT_LISTS)
def test_tenant_lists_keep_their_fields_and_add_next_cursor(db_session, client_for, world, url):
    body = client_for(world["maker"]).get(url).json()
    assert set(body) == {"items", "next_cursor"} and body["next_cursor"] is None


def test_tenant_activations_page(db_session, client_for, world):
    client = client_for(world["maker"])
    everything = client.get("/api/v1/tax/activations").json()["items"]
    assert len(everything) == 4
    first = client.get("/api/v1/tax/activations", params={"limit": 3}).json()
    rest = client.get("/api/v1/tax/activations", params={"limit": 3, "cursor": first["next_cursor"]}).json()
    assert [a["id"] for a in first["items"] + rest["items"]] == [a["id"] for a in everything]
    assert rest["next_cursor"] is None


def test_exceptions_keep_their_limit_and_add_a_cursor(db_session, client_for, world):
    client = client_for(world["maker"])
    for n in range(2):
        draft(world, [(world["svc_product"], 100 + n, 1, False)])
    body = client.get("/api/v1/tax/exceptions").json()
    assert {"items", "count", "checked", "next_cursor"} <= set(body) and body["next_cursor"] is None
    page = client.get("/api/v1/tax/exceptions", params={"limit": 2}).json()
    assert page["checked"] == 2 and page["next_cursor"]
    rest = client.get("/api/v1/tax/exceptions", params={"limit": 2, "cursor": page["next_cursor"]}).json()
    assert rest["checked"] == 1 and rest["next_cursor"] is None
    ids = [i["invoice_id"] for i in page["items"] + rest["items"]]
    assert ids == [i["invoice_id"] for i in body["items"]]


def test_cursor_is_opaque_and_validated():
    assert encode_cursor(5) != "5"
