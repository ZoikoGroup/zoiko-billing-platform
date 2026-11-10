"""ZB-TAX-ARCH-001 Phase 7 PR 4: targeted remediation (no silent historical mutation)."""
from decimal import Decimal

import pytest

from app.config import settings
from app.core.exceptions import BadRequestException, ForbiddenException
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import BillingAuditLog, CreditNote, CreditNoteStatus, InvoiceStatus, Tax
from app.modules.tax.evidence_bundle import verify
from app.modules.tax.remediation_models import TaxDuplicateRowArchive, TaxRemediationItem
from app.modules.tax.remediation_service import RemediationService, duplicates_preview, overcollection_preview
from tests.conftest import make_customer, make_invoice, make_organization
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user

T = "/api/v1/tax/remediation"


@pytest.fixture()
def t(db_session):
    db = db_session
    org = make_organization(db, code="P7R", name="Remediation Org")
    customer = make_customer(db, org.id, code="P7RC", email="r@buyer.example")
    invoices = []
    for n in range(3):
        inv = make_invoice(db, org.id, customer.id, status=InvoiceStatus.SENT, invoice_number=f"R-{n}")
        inv.discount_percentage, inv.tax_amount, inv.currency = Decimal("10"), Decimal("20.00"), "GBP"
        invoices.append(inv)
    first = invoices[0]
    for _ in range(2):                                                     # a true duplicate
        db.add(Tax(organization_id=org.id, invoice_id=first.id, taxable_amount=Decimal("100"), tax_amount=Decimal("20"),
                   tax_percentage=Decimal("20"), is_active=True))
    second = invoices[1]
    db.add(Tax(organization_id=org.id, invoice_id=second.id, taxable_amount=Decimal("100"), tax_amount=Decimal("20"),
               tax_percentage=Decimal("20"), is_active=True))
    db.add(Tax(organization_id=org.id, invoice_id=second.id, taxable_amount=Decimal("100"), tax_amount=Decimal("19"),
               tax_percentage=Decimal("20"), is_active=True))             # same key, different amount: not identical
    db.commit()
    return {"org": org, "invoices": invoices,
            "admin": _tenant_user(db, org, UserRole.ORG_ADMIN, "admin@p7r.example"),
            "admin2": _tenant_user(db, org, UserRole.ORG_ADMIN, "admin2@p7r.example"),
            "finance": _tenant_user(db, org, UserRole.FINANCE_APPROVER, "fin@p7r.example"),
            "billing": _tenant_user(db, org, UserRole.BILLING_ADMIN, "bill@p7r.example")}


@pytest.fixture()
def on(monkeypatch, t):
    monkeypatch.setattr(settings, "TAX_REMEDIATION_OVERCOLLECTION_ORGS", str(t["org"].id))
    monkeypatch.setattr(settings, "TAX_REMEDIATION_DUPLICATES_ORGS", f"999,{t['org'].id}")


def test_previews_change_nothing_and_execution_is_off_by_default(db_session, t):
    org = t["org"].id
    tax_rows = db_session.query(Tax).count()
    over = overcollection_preview(db_session, org)
    assert over["enabled"] is False and len(over["invoices"]) == 3
    assert over["invoices"][0]["credit_note_amount"] == Decimal("2.00")
    dup = duplicates_preview(db_session, org)
    assert dup["enabled"] is False
    first = next(i for i in dup["invoices"] if i["invoice_id"] == t["invoices"][0].id)
    assert len(first["rows_to_remove"]) == 1 and first["tax_rows_total_before"] == Decimal("40")
    assert first["tax_rows_total_after"] == Decimal("20") and first["invoice_totals_change"] is False
    second = next(i for i in dup["invoices"] if i["invoice_id"] == t["invoices"][1].id)
    assert second["rows_to_remove"] == [] and len(second["rows_flagged_not_identical"]) == 1
    assert db_session.query(Tax).count() == tax_rows and db_session.query(CreditNote).count() == 0
    with pytest.raises(ForbiddenException, match="turned off"):
        RemediationService(db_session).propose(org, t["admin"].id, "OVERCOLLECTION_CREDIT", [t["invoices"][0].id], "x")


def test_corrective_credit_notes_two_people_draft_never_twice_and_sealed(db_session, t, on):
    org, svc = t["org"].id, RemediationService(db_session)
    ids = [t["invoices"][0].id, t["invoices"][1].id]
    batch = svc.propose(org, t["admin"].id, "OVERCOLLECTION_CREDIT", ids, "refund over-collected tax")
    with pytest.raises(ForbiddenException, match="different finance approver"):
        svc.decide(org, t["admin"].id, batch.id, approve=True)
    svc.decide(org, t["finance"].id, batch.id, approve=True)
    notes = db_session.query(CreditNote).filter(CreditNote.invoice_id.in_(ids)).all()
    assert len(notes) == 2 and all(n.status == CreditNoteStatus.DRAFT for n in notes)
    assert all(n.tax_amount == Decimal("2.00") and n.total_amount == Decimal("2.00") for n in notes)
    for inv in t["invoices"][:2]:
        db_session.refresh(inv)
        assert inv.tax_amount == Decimal("20.00") and inv.status == InvoiceStatus.SENT     # invoice untouched
    assert batch.evidence_sha256 and len(batch.result["credit_notes"]) == 2
    with pytest.raises(BadRequestException, match="never twice"):
        svc.propose(org, t["admin"].id, "OVERCOLLECTION_CREDIT", [ids[0]], "again")
    events = {a.new_values.get("remediation") for a in db_session.query(BillingAuditLog).filter(
        BillingAuditLog.entity_type == "TaxRemediationBatch")}
    assert {"proposed", "executed"} <= events


def test_batches_are_capped_and_only_for_current_findings(db_session, t, on, monkeypatch):
    org, svc = t["org"].id, RemediationService(db_session)
    monkeypatch.setattr(settings, "TAX_REMEDIATION_MAX_BATCH", 1)
    with pytest.raises(BadRequestException, match="capped at 1"):
        svc.propose(org, t["admin"].id, "OVERCOLLECTION_CREDIT", [i.id for i in t["invoices"][:2]], "x")
    other = make_organization(db_session, code="P7RX", name="Other")
    stranger = make_invoice(db_session, other.id, make_customer(db_session, other.id, code="X", email="x@x.example").id,
                            status=InvoiceStatus.SENT, invoice_number="X-1")
    with pytest.raises(BadRequestException, match="not in this organization's current findings"):
        svc.propose(org, t["admin"].id, "OVERCOLLECTION_CREDIT", [stranger.id], "x")
    batch = svc.propose(org, t["admin"].id, "OVERCOLLECTION_CREDIT", [t["invoices"][2].id], "x")
    with pytest.raises(BadRequestException, match="already in a proposed batch"):
        svc.propose(org, t["admin2"].id, "OVERCOLLECTION_CREDIT", [t["invoices"][2].id], "x")
    with pytest.raises(BadRequestException, match="reason is required"):
        svc.decide(org, t["finance"].id, batch.id, approve=False)
    svc.decide(org, t["finance"].id, batch.id, approve=False, reason="not yet")
    assert db_session.query(CreditNote).count() == 0


def test_duplicates_removed_only_when_identical_archived_and_reversible(db_session, t, on):
    org, svc = t["org"].id, RemediationService(db_session)
    ids = [t["invoices"][0].id, t["invoices"][1].id]
    before = {r.id for r in db_session.query(Tax).filter(Tax.invoice_id.in_(ids))}
    batch = svc.propose(org, t["admin"].id, "DUPLICATE_ROWS", [ids[0]], "remove resend duplicates")
    svc.decide(org, t["finance"].id, batch.id, approve=True)
    assert len(batch.result["rows_removed"]) == 1
    remaining = {r.id for r in db_session.query(Tax).filter(Tax.invoice_id == ids[0])}
    assert len(remaining) == 1
    archived = db_session.query(TaxDuplicateRowArchive).filter(TaxDuplicateRowArchive.batch_id == batch.id).one()
    assert archived.row["tax_amount"] == "20.00" and archived.tax_row_id not in remaining
    db_session.refresh(t["invoices"][0])
    assert t["invoices"][0].tax_amount == Decimal("20.00")                        # totals unchanged
    assert db_session.query(TaxRemediationItem).filter(TaxRemediationItem.batch_id == batch.id).one().rows_removed == 1
    with pytest.raises(BadRequestException, match="reason"):
        svc.reverse(org, t["admin"].id, batch.id, "")
    svc.reverse(org, t["admin"].id, batch.id, "auditor asked for the rows back")
    assert {r.id for r in db_session.query(Tax).filter(Tax.invoice_id.in_(ids))} == before    # same ids back
    with pytest.raises(BadRequestException, match="executed"):
        svc.reverse(org, t["admin"].id, batch.id, "twice")
    with pytest.raises(BadRequestException, match="current findings"):                     # not-identical only
        svc.propose(org, t["admin"].id, "DUPLICATE_ROWS", [ids[1]], "x")


def test_every_remediation_has_an_evidence_bundle(db_session, client_for, t, on):
    org, svc = t["org"].id, RemediationService(db_session)
    batch = svc.propose(org, t["admin"].id, "OVERCOLLECTION_CREDIT", [t["invoices"][0].id], "refund")
    svc.decide(org, t["finance"].id, batch.id, approve=True)
    body = client_for(t["finance"]).get(f"/api/v1/tax/evidence-bundles/remediation_batch/{batch.id}").json()
    assert body["kind"] == "remediation_batch" and verify(body)
    assert body["evidence"][0]["credit_note_id"] and body["approvals"]["decided_by"]["user_id"] == t["finance"].id
    assert any((h["details"] or {}).get("remediation") == "executed" for h in body["history"])


def test_http_roles_and_tenancy(db_session, client_for, t, on):
    assert client_for(t["billing"]).get(f"{T}/overcollection/preview").status_code == 403
    assert client_for(t["finance"]).get(f"{T}/duplicates/preview").status_code == 200
    body = {"kind": "OVERCOLLECTION_CREDIT", "invoice_ids": [t["invoices"][0].id], "reason": "refund"}
    assert client_for(t["finance"]).post(f"{T}/batches", json=body).status_code == 403          # org admin proposes
    created = client_for(t["admin"]).post(f"{T}/batches", json=body)
    assert created.status_code == 201 and created.json()["state"] == "PROPOSED"
    bid = created.json()["id"]
    assert client_for(t["admin2"]).post(f"{T}/batches/{bid}/approve", json={}).status_code == 403   # finance decides
    done = client_for(t["finance"]).post(f"{T}/batches/{bid}/approve", json={})
    assert done.status_code == 200 and done.json()["state"] == "EXECUTED" and done.json()["evidence_sha256"]
    staff = client_for(make_super_admin(db_session, "tp@p7r.example", PlatformRole.TAX_PUBLISHER))
    assert staff.get(f"{T}/batches").status_code == 403                                          # T13
    other = make_organization(db_session, code="P7RY", name="Other")
    stranger = client_for(_tenant_user(db_session, other, UserRole.ORG_ADMIN, "a@p7ry.example"))
    assert stranger.post(f"{T}/batches/{bid}/withdraw").status_code == 404
