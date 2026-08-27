"""
tests/test_tax_summary.py
--------------------------
Regression coverage for TaxRepository.get_summary / TaxService.get_tax_summary
after the performance fix that replaced a full-table Python-side load+filter
with server-side SQL aggregation (see repositories/tax.py).

get_monthly_trend() is not covered here: it uses func.date_trunc(), a
Postgres-only function not available on the SQLite in-memory test database
used by this fixture set — consistent with the rest of this suite, which
likewise does not unit-test CollectionsCaseRepository.get_recovery_trend or
InvoiceRepository.get_invoice_trend for the same reason.
"""
from datetime import date, timedelta, datetime, timezone

from app.modules.billing.models import Tax, TaxType
from app.modules.billing.services.tax_service import TaxService
from tests.conftest import make_organization


def make_tax(db, organization_id, tax_amount, taxable_amount="1000.00", tax_type=TaxType.GST,
             created_at=None, is_active=True, jurisdiction="IN"):
    tax = Tax(
        organization_id=organization_id,
        taxable_amount=taxable_amount,
        tax_amount=tax_amount,
        tax_percentage="18.00",
        jurisdiction=jurisdiction,
        tax_type=tax_type,
        is_active=is_active,
    )
    db.add(tax)
    db.flush()
    if created_at is not None:
        tax.created_at = created_at
        db.flush()
    return tax


class TestTaxSummary:
    def test_empty_summary(self, db_session):
        org = make_organization(db_session, code="ORG-EMPTY")
        svc = TaxService(db_session)
        result = svc.get_tax_summary(org.id)
        assert result == {"total_tax": 0.0, "total_records": 0, "breakdown_by_type": {}}

    def test_totals_and_breakdown_by_type(self, db_session):
        org = make_organization(db_session, code="ORG-A")
        make_tax(db_session, org.id, "18.00", tax_type=TaxType.GST)
        make_tax(db_session, org.id, "12.00", tax_type=TaxType.GST)
        make_tax(db_session, org.id, "5.00", tax_type=TaxType.VAT)
        db_session.commit()

        svc = TaxService(db_session)
        result = svc.get_tax_summary(org.id)

        assert result["total_records"] == 3
        assert result["total_tax"] == 35.0
        assert result["breakdown_by_type"] == {"gst": 30.0, "vat": 5.0}

    def test_inactive_rows_excluded(self, db_session):
        org = make_organization(db_session, code="ORG-B")
        make_tax(db_session, org.id, "10.00", is_active=True)
        make_tax(db_session, org.id, "999.00", is_active=False)
        db_session.commit()

        svc = TaxService(db_session)
        result = svc.get_tax_summary(org.id)
        assert result["total_records"] == 1
        assert result["total_tax"] == 10.0

    def test_date_range_is_inclusive_on_both_ends(self, db_session):
        org = make_organization(db_session, code="ORG-C")
        today = date.today()
        make_tax(db_session, org.id, "10.00", created_at=datetime(today.year, today.month, today.day, 0, 0, tzinfo=timezone.utc))
        make_tax(db_session, org.id, "20.00", created_at=datetime.combine(today - timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc))
        make_tax(db_session, org.id, "30.00", created_at=datetime.combine(today + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc))
        db_session.commit()

        svc = TaxService(db_session)
        result = svc.get_tax_summary(org.id, date_from=str(today), date_to=str(today))
        assert result["total_records"] == 1
        assert result["total_tax"] == 10.0

        result_range = svc.get_tax_summary(org.id, date_from=str(today - timedelta(days=1)), date_to=str(today))
        assert result_range["total_records"] == 2
        assert result_range["total_tax"] == 30.0

    def test_tenant_isolation(self, db_session):
        org_a = make_organization(db_session, code="ORG-D1")
        org_b = make_organization(db_session, code="ORG-D2")
        make_tax(db_session, org_a.id, "10.00")
        make_tax(db_session, org_b.id, "500.00")
        db_session.commit()

        svc = TaxService(db_session)
        result_a = svc.get_tax_summary(org_a.id)
        result_b = svc.get_tax_summary(org_b.id)

        assert result_a["total_records"] == 1
        assert result_a["total_tax"] == 10.0
        assert result_b["total_records"] == 1
        assert result_b["total_tax"] == 500.0
