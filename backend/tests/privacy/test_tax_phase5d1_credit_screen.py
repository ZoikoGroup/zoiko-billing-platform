"""ZB-TAX-ARCH-001 Phase 5d PR 1: what the governed credit-note screen needs.
The creditable view, a preview that writes nothing and equals the created
credit note to the cent (full and partial), provider ADJUST state, and the
existing permissions (billing admin; other org 404; platform 403)."""
from decimal import Decimal

import pytest

from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import CreditNote
from app.modules.tax.enums import OutboxState
from app.modules.tax.provider_issuance import ProviderIssuanceService
from app.modules.tax.quote_models import CreditNoteTaxLine
from tests.conftest import make_organization
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase3a_governed import buyer, build_world, draft, finalize, quote
from tests.test_tax_phase4a2 import _issued

T = "/api/v1/tax/invoices"


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P5D1")
    inv = draft(w, [(w["svc_product"], "33.33", 3, False), (w["svc_product"], "50", 1, False)],
                customer=buyer(w, verified=False, code="P5D1B"), discount_pct="10")
    quote(w, inv)
    finalize(w, inv)
    w["inv"] = inv
    return w


def _lines(inv, fractions):
    return [{"invoice_item_id": i.id, "fraction": str(f)} for i, f in zip(inv.items, fractions) if f]


def _created_view(db, note_id):
    rows = db.query(CreditNoteTaxLine).filter(CreditNoteTaxLine.credit_note_id == note_id).all()
    return sorted(str(r.credited_tax) for r in rows)


def test_creditable_lists_snapshot_lines_with_nothing_credited(client_for, w):
    body = client_for(w["maker"]).get(f"{T}/{w['inv'].id}/credit-notes/creditable").json()
    assert body["invoice_number"] == w["inv"].invoice_number and body["provider_committed"] is False
    assert len(body["lines"]) == 2 and body["credit_notes"] == []
    first = body["lines"][0]
    assert Decimal(first["remaining_fraction"]) == 1 and Decimal(first["credited_fraction"]) == 0
    assert first["components"] and first["components"][0]["component_code"] and first["outcome"]


@pytest.mark.parametrize("fractions", [(1, 1), ("0.3333333333", 0), (0, "0.5")])
def test_preview_equals_the_created_credit_note_to_the_cent_and_writes_nothing(db_session, client_for, w, fractions):
    inv, client = w["inv"], client_for(w["maker"])
    lines = _lines(inv, fractions)
    before = db_session.query(CreditNote).count()
    preview = client.post(f"{T}/{inv.id}/credit-notes/preview", json={"lines": lines})
    assert preview.status_code == 200, preview.text
    assert db_session.query(CreditNote).count() == before                          # nothing written
    p = preview.json()
    created = client.post(f"{T}/{inv.id}/credit-notes", json={"lines": lines, "reason": "returned"}).json()
    assert Decimal(p["subtotal"]) == Decimal(created["subtotal"])
    assert Decimal(p["tax_amount"]) == Decimal(created["tax_amount"])
    assert Decimal(p["total_amount"]) == Decimal(created["total_amount"])
    previewed_tax = sorted(str(-Decimal(c["credited_tax"])) for l in p["lines"] for c in l["components"])
    assert [Decimal(x) for x in previewed_tax] == [Decimal(x) for x in _created_view(db_session, created["credit_note_id"])]
    assert all(l["outcome"] and "components" in l for l in p["lines"])


def test_partial_then_remaining_reconciles_and_creditable_tracks_it(db_session, client_for, w):
    inv, client = w["inv"], client_for(w["maker"])
    client.post(f"{T}/{inv.id}/credit-notes", json={"lines": _lines(inv, ("0.3333333333", 0)), "reason": "1 of 3"})
    body = client.get(f"{T}/{inv.id}/credit-notes/creditable").json()
    first = body["lines"][0]
    assert Decimal("0.33") < Decimal(first["credited_fraction"]) < Decimal("0.34")
    rest = [{"invoice_item_id": l["invoice_item_id"], "fraction": l["remaining_fraction"]} for l in body["lines"]]
    client.post(f"{T}/{inv.id}/credit-notes", json={"lines": rest, "reason": "the rest"})
    rows = db_session.query(CreditNoteTaxLine).filter(CreditNoteTaxLine.invoice_id == inv.id).all()
    assert -sum(r.credited_tax for r in rows) == inv.tax_amount                    # to the cent
    after = client.get(f"{T}/{inv.id}/credit-notes/creditable").json()
    assert all(Decimal(l["remaining_fraction"]) == 0 for l in after["lines"]) and len(after["credit_notes"]) == 2
    over = client.post(f"{T}/{inv.id}/credit-notes/preview", json={"lines": _lines(inv, ("0.01", 0))})
    assert over.status_code == 400 and "beyond 100%" in over.text


def test_same_permissions_as_the_credit_note_flow(db_session, client_for, w):
    inv = w["inv"]
    urls = [("get", f"{T}/{inv.id}/credit-notes/creditable", None),
            ("post", f"{T}/{inv.id}/credit-notes/preview", {"lines": _lines(inv, (1, 0))})]
    auditor = client_for(_tenant_user(db_session, w["org"], UserRole.AUDITOR, "aud@p5d1.example"))
    for method, url, body in urls:
        assert getattr(auditor, method)(url, **({"json": body} if body else {})).status_code == 403
        assert getattr(client_for(w["checker"]), method)(url, **({"json": body} if body else {})).status_code == 403
    other = make_organization(db_session, code="P5D1X", name="Other")
    stranger = client_for(_tenant_user(db_session, other, UserRole.BILLING_ADMIN, "b@p5d1x.example"))
    assert stranger.get(urls[0][1]).status_code == 404
    staff = client_for(make_super_admin(db_session, "tp@p5d1.example", PlatformRole.TAX_PUBLISHER))
    assert staff.get(urls[0][1]).status_code == 403                                 # T13


def test_a_legacy_invoice_is_sent_to_the_standard_flow(client_for, w):
    legacy = draft(w, [(w["svc_product"], "10", 1, False)])                         # never quoted or issued governed
    response = client_for(w["maker"]).get(f"{T}/{legacy.id}/credit-notes/creditable")
    assert response.status_code == 400


def test_provider_committed_credit_shows_the_adjust_state(db_session, client_for, w):
    inv, _q = _issued(w)
    client = client_for(w["maker"])
    body = client.get(f"{T}/{inv.id}/credit-notes/creditable").json()
    assert body["provider_committed"] is True
    preview = client.post(f"{T}/{inv.id}/credit-notes/preview", json={"lines": _lines(inv, (1,))}).json()
    assert preview["provider_committed"] is True
    client.post(f"{T}/{inv.id}/credit-notes", json={"lines": _lines(inv, (1,)), "reason": "cancelled order"})
    pending = client.get(f"{T}/{inv.id}/credit-notes/creditable").json()["credit_notes"][0]["adjust"]
    assert pending["state"] in ("PENDING", "UNCERTAIN") and pending["transaction_id"]
    ProviderIssuanceService(db_session, provider_lookup=lambda name: w["provider"]).reconcile()
    done = client.get(f"{T}/{inv.id}/credit-notes/creditable").json()["credit_notes"][0]["adjust"]
    assert done["state"] == OutboxState.DONE.name
