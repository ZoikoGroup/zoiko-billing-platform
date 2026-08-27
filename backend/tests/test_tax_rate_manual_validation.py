"""
tests/test_tax_rate_manual_validation.py
------------------------------------------
Regression coverage for two defects found in the Payments/Tax UI
production-readiness cycle:

DEF-03 (P2, fixed): the manual Add/Edit Tax Rate schemas (TaxRateCreate/
TaxRateUpdate) had no server-side validation for currency_code/country_code
-- invalid values like "ZZZ"/"ZZ" were silently accepted with 201/200,
unlike the bulk import path (TaxRateImportService), which already validated
both. Fixed by adding the same validate_currency_format (reused from
utils/validators.py, the same helper Payment/Refund/CreditNote/WriteOff
schemas already use) and a new validate_country_code_format (reusing
resolve_country_code, the same resolver the bulk importer and customer
import already use) as field_validators on both schemas.

DEF-06 (P3, fixed): InvoiceRepository.get_aging_buckets() used
`due_date <= today` while the newer list_effectively_overdue() (and the
scheduled overdue-invoice job it mirrors) uses `due_date < today` -- a
one-day boundary inconsistency between two independently-"overdue" read
paths. Fixed by aligning get_aging_buckets to the same `< today` boundary.
"""
from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.billing.repositories.invoice import InvoiceRepository
from app.modules.billing.schemas import TaxRateCreate, TaxRateUpdate

from tests.conftest import make_customer, make_invoice, make_organization


# ─── DEF-03: currency_code / country_code validation ───────────────────────

class TestTaxRateCreateValidation:
    def _base_kwargs(self, **overrides):
        kwargs = dict(name="Test Rate", code="TR1", jurisdiction="India", rate="18", tax_type="gst")
        kwargs.update(overrides)
        return kwargs

    def test_valid_currency_and_country_accepted(self):
        rate = TaxRateCreate(**self._base_kwargs(currency_code="inr", country_code="in"))
        assert rate.currency_code == "INR"  # normalized to uppercase
        assert rate.country_code == "IN"

    def test_country_name_resolved_to_iso_code(self):
        rate = TaxRateCreate(**self._base_kwargs(country_code="India"))
        assert rate.country_code == "IN"

    def test_invalid_currency_rejected(self):
        with pytest.raises(ValidationError, match="Unsupported currency code"):
            TaxRateCreate(**self._base_kwargs(currency_code="ZZZ"))

    def test_invalid_country_rejected(self):
        with pytest.raises(ValidationError, match="is not recognized"):
            TaxRateCreate(**self._base_kwargs(country_code="ZZ"))

    def test_blank_currency_and_country_pass_through_as_none(self):
        rate = TaxRateCreate(**self._base_kwargs(currency_code="", country_code=""))
        assert rate.currency_code is None
        assert rate.country_code is None

    def test_omitted_currency_and_country_default_to_none(self):
        rate = TaxRateCreate(**self._base_kwargs())
        assert rate.currency_code is None
        assert rate.country_code is None


class TestTaxRateUpdateValidation:
    def test_valid_currency_and_country_accepted(self):
        rate = TaxRateUpdate(currency_code="usd", country_code="us")
        assert rate.currency_code == "USD"
        assert rate.country_code == "US"

    def test_invalid_currency_rejected(self):
        with pytest.raises(ValidationError, match="Unsupported currency code"):
            TaxRateUpdate(currency_code="ZZZ")

    def test_invalid_country_rejected(self):
        with pytest.raises(ValidationError, match="is not recognized"):
            TaxRateUpdate(country_code="ZZ")

    def test_unset_fields_stay_unset(self):
        rate = TaxRateUpdate(rate="12")
        assert "currency_code" not in rate.model_fields_set
        assert "country_code" not in rate.model_fields_set


# ─── DEF-06: aging-bucket / effectively-overdue boundary consistency ───────

class TestAgingBucketBoundaryConsistency:
    def test_invoice_due_today_excluded_from_aging_buckets(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00")
        inv.due_date = date.today()
        db_session.commit()

        repo = InvoiceRepository(db_session)
        buckets = repo.get_aging_buckets(org.id)
        total_bucketed = sum(b["count"] for b in buckets["buckets"])
        assert total_bucketed == 0, "an invoice due today is not yet overdue"

    def test_invoice_due_today_also_excluded_from_effectively_overdue(self, db_session):
        """Same boundary as the aging-buckets check above -- the two read
        paths must agree (this is exactly what DEF-06 was about)."""
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00")
        inv.due_date = date.today()
        db_session.commit()

        repo = InvoiceRepository(db_session)
        found = repo.list_effectively_overdue(org.id)
        assert not any(f.id == inv.id for f in found)

    def test_invoice_due_yesterday_appears_in_both(self, db_session):
        org = make_organization(db_session)
        cust = make_customer(db_session, org.id)
        inv = make_invoice(db_session, org.id, cust.id, status=InvoiceStatus.SENT, total_amount="1000.00")
        inv.due_date = date.today() - timedelta(days=1)
        db_session.commit()

        repo = InvoiceRepository(db_session)
        buckets = repo.get_aging_buckets(org.id)
        total_bucketed = sum(b["count"] for b in buckets["buckets"])
        assert total_bucketed == 1

        found = repo.list_effectively_overdue(org.id)
        assert any(f.id == inv.id for f in found)
