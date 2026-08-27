"""
tests/test_tax_rate_import.py
-------------------------------
Regression coverage for the bulk Tax Rate import feature
(TaxRateImportService) and the is_default-per-currency uniqueness fix in
TaxService.create_tax_rate/update_tax_rate that the importer relies on.

Mirrors the existing service-level test style in this repo (calls services
directly against the db_session fixture -- there is no FastAPI TestClient
fixture in use elsewhere in this suite).
"""
from datetime import date

import pytest

from app.modules.billing.models import TaxRate
from app.modules.billing.services.tax_rate_import_service import TaxRateImportService
from app.modules.billing.services.tax_service import TaxService

from tests.conftest import make_organization, make_tax_rate

USER_ID = 1


def _csv_bytes(rows, headers=None):
    headers = headers or [
        "name", "code", "tax_type", "rate", "jurisdiction",
        "country_code", "currency_code", "is_default",
    ]
    lines = [",".join(headers)]
    for row in rows:
        lines.append(",".join(str(v) for v in row))
    return ("\n".join(lines)).encode("utf-8")


# ─── TaxService.create_tax_rate / update_tax_rate: is_default uniqueness ────

class TestDefaultUniqueness:
    def test_second_default_unsets_first(self, db_session):
        org = make_organization(db_session)
        svc = TaxService(db_session)
        r1 = svc.create_tax_rate(
            organization_id=org.id, created_by=USER_ID,
            name="Rate A", code="A1", jurisdiction="India", rate=5,
            tax_type="gst", currency_code="INR", is_default=True, effective_from=date.today(),
        )
        r2 = svc.create_tax_rate(
            organization_id=org.id, created_by=USER_ID,
            name="Rate B", code="B1", jurisdiction="India", rate=18,
            tax_type="gst", currency_code="INR", is_default=True, effective_from=date.today(),
        )
        db_session.refresh(r1)
        assert r1.is_default is False
        assert r2.is_default is True

    def test_update_to_default_unsets_previous(self, db_session):
        org = make_organization(db_session)
        svc = TaxService(db_session)
        r1 = svc.create_tax_rate(
            organization_id=org.id, created_by=USER_ID,
            name="Rate A", code="A1", jurisdiction="India", rate=5,
            tax_type="gst", currency_code="INR", is_default=True, effective_from=date.today(),
        )
        r2 = svc.create_tax_rate(
            organization_id=org.id, created_by=USER_ID,
            name="Rate B", code="B1", jurisdiction="India", rate=18,
            tax_type="gst", currency_code="INR", is_default=False, effective_from=date.today(),
        )
        svc.update_tax_rate(rate_id=r2.id, organization_id=org.id, updated_by=USER_ID, is_default=True)
        db_session.refresh(r1)
        db_session.refresh(r2)
        assert r1.is_default is False
        assert r2.is_default is True

    def test_different_currencies_each_keep_their_own_default(self, db_session):
        org = make_organization(db_session)
        svc = TaxService(db_session)
        inr = svc.create_tax_rate(
            organization_id=org.id, created_by=USER_ID,
            name="INR Rate", code="INR1", jurisdiction="India", rate=18,
            tax_type="gst", currency_code="INR", is_default=True, effective_from=date.today(),
        )
        usd = svc.create_tax_rate(
            organization_id=org.id, created_by=USER_ID,
            name="USD Rate", code="USD1", jurisdiction="US", rate=7,
            tax_type="sales_tax", currency_code="USD", is_default=True, effective_from=date.today(),
        )
        db_session.refresh(inr)
        db_session.refresh(usd)
        assert inr.is_default is True
        assert usd.is_default is True


# ─── Preview: validation ─────────────────────────────────────────────────

class TestPreviewValidation:
    def test_valid_single_row(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["India GST 18%", "IN-GST-18", "gst", "18", "India", "IN", "INR", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["total"] == 1
        assert result["valid"] == 1
        assert result["invalid"] == 0

    def test_valid_multi_row_gst_slabs(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        rows = [
            ["GST 5%", "IN-GST-5", "gst", "5", "India", "IN", "INR", "false"],
            ["GST 12%", "IN-GST-12", "gst", "12", "India", "IN", "INR", "false"],
            ["GST 18%", "IN-GST-18", "gst", "18", "India", "IN", "INR", "true"],
            ["GST 28%", "IN-GST-28", "gst", "28", "India", "IN", "INR", "false"],
        ]
        result = svc.preview_import(_csv_bytes(rows), "rates.csv", {}, org.id)
        assert result["total"] == 4
        assert result["valid"] == 4

    def test_invalid_rate_out_of_range(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Bad Rate", "BAD1", "gst", "150", "India", "IN", "INR", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["invalid"] == 1
        assert "Rate must be between 0 and 100" in result["rows"][0]["errors"][0]

    def test_invalid_rate_non_numeric(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Bad Rate", "BAD1", "gst", "abc", "India", "IN", "INR", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["invalid"] == 1

    def test_missing_required_field(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["", "NOCODE", "gst", "18", "India", "IN", "INR", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["invalid"] == 1
        assert any("Name" in e for e in result["rows"][0]["errors"])

    def test_invalid_currency(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Bad Currency", "BADCUR", "gst", "18", "India", "IN", "ZZZ", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["invalid"] == 1

    def test_invalid_country(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Bad Country", "BADCTY", "gst", "18", "India", "ZZ", "INR", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["invalid"] == 1

    def test_invalid_tax_type(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Bad Type", "BADTYPE", "not_a_type", "18", "India", "IN", "INR", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["invalid"] == 1

    def test_duplicate_code_within_file(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        rows = [
            ["First", "DUPE1", "gst", "18", "India", "IN", "INR", "false"],
            ["Second", "DUPE1", "gst", "12", "India", "IN", "INR", "false"],
        ]
        result = svc.preview_import(_csv_bytes(rows), "rates.csv", {}, org.id)
        assert result["duplicate"] == 1
        assert result["valid"] == 1

    def test_duplicate_against_existing_org_rate(self, db_session):
        org = make_organization(db_session)
        make_tax_rate(db_session, org.id, code="EXIST1", currency_code="INR")
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Existing", "EXIST1", "gst", "18", "India", "IN", "INR", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["duplicate"] == 1
        assert result["rows"][0]["matched_existing_code"] == "EXIST1"

    def test_mixed_valid_and_invalid_file(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        rows = [
            ["Good", "GOOD1", "gst", "18", "India", "IN", "INR", "false"],
            ["Bad", "BAD1", "gst", "999", "India", "IN", "INR", "false"],
        ]
        result = svc.preview_import(_csv_bytes(rows), "rates.csv", {}, org.id)
        assert result["valid"] == 1
        assert result["invalid"] == 1

    def test_empty_file(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        result = svc.preview_import(_csv_bytes([]), "rates.csv", {}, org.id)
        assert result["total"] == 0

    def test_unsupported_file_format(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        with pytest.raises(ValueError):
            svc.preview_import(b"not a real file", "rates.pdf", {}, org.id)

    def test_blank_currency_defaults_to_org_currency(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["No Currency", "NOCUR1", "gst", "18", "India", "IN", "", "false"]])
        result = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        assert result["valid"] == 1
        assert result["rows"][0]["mapped_data"]["currency_code"] == "USD"  # no BillingConfiguration seeded -> fallback


# ─── Confirm: actually writes rows, respects strategies, isolates tenants ──

class TestConfirmImport:
    def test_confirm_creates_rows(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        rows = [
            ["GST 5%", "IN-GST-5", "gst", "5", "India", "IN", "INR", "false"],
            ["GST 18%", "IN-GST-18", "gst", "18", "India", "IN", "INR", "false"],
        ]
        preview = svc.preview_import(_csv_bytes(rows), "rates.csv", {}, org.id)
        summary = svc.confirm_import(preview["session_id"], org.id, USER_ID)
        assert summary["imported"] == 2
        assert summary["failed"] == 0
        created = db_session.query(TaxRate).filter(TaxRate.organization_id == org.id).all()
        assert {r.code for r in created} == {"IN-GST-5", "IN-GST-18"}

    def test_confirm_only_one_default_survives_multi_row_import(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        rows = [
            ["GST 5%", "IN-GST-5", "gst", "5", "India", "IN", "INR", "true"],
            ["GST 12%", "IN-GST-12", "gst", "12", "India", "IN", "INR", "true"],
            ["GST 18%", "IN-GST-18", "gst", "18", "India", "IN", "INR", "true"],
        ]
        preview = svc.preview_import(_csv_bytes(rows), "rates.csv", {}, org.id)
        svc.confirm_import(preview["session_id"], org.id, USER_ID)
        created = db_session.query(TaxRate).filter(TaxRate.organization_id == org.id).all()
        defaults = [r for r in created if r.is_default]
        assert len(defaults) == 1
        assert defaults[0].code == "IN-GST-18"  # last row processed wins

    def test_confirm_supersedes_preexisting_manual_default(self, db_session):
        org = make_organization(db_session)
        existing = make_tax_rate(db_session, org.id, code="OLD-DEFAULT", currency_code="INR", is_default=True)
        db_session.commit()
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["New Default", "NEW-DEFAULT", "gst", "18", "India", "IN", "INR", "true"]])
        preview = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        svc.confirm_import(preview["session_id"], org.id, USER_ID)
        db_session.refresh(existing)
        assert existing.is_default is False

    def test_confirm_skip_duplicate_strategy(self, db_session):
        org = make_organization(db_session)
        make_tax_rate(db_session, org.id, code="EXIST1", currency_code="INR")
        db_session.commit()
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Existing", "EXIST1", "gst", "18", "India", "IN", "INR", "false"]])
        preview = svc.preview_import(file_bytes, "rates.csv", {}, org.id, duplicate_strategy="skip")
        summary = svc.confirm_import(preview["session_id"], org.id, USER_ID, duplicate_strategy="skip")
        assert summary["skipped"] == 1
        assert summary["imported"] == 0

    def test_confirm_overwrite_duplicate_strategy(self, db_session):
        org = make_organization(db_session)
        existing = make_tax_rate(db_session, org.id, code="EXIST1", currency_code="INR", rate="10.00")
        db_session.commit()
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Updated", "EXIST1", "gst", "25", "India", "IN", "INR", "false"]])
        preview = svc.preview_import(file_bytes, "rates.csv", {}, org.id, duplicate_strategy="overwrite")
        summary = svc.confirm_import(preview["session_id"], org.id, USER_ID, duplicate_strategy="overwrite")
        assert summary["imported"] == 1
        db_session.refresh(existing)
        assert float(existing.rate) == 25.0

    def test_confirm_create_copy_duplicate_strategy(self, db_session):
        org = make_organization(db_session)
        make_tax_rate(db_session, org.id, code="EXIST1", currency_code="INR")
        db_session.commit()
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Copy Me", "EXIST1", "gst", "18", "India", "IN", "INR", "false"]])
        preview = svc.preview_import(file_bytes, "rates.csv", {}, org.id, duplicate_strategy="create_copy")
        summary = svc.confirm_import(preview["session_id"], org.id, USER_ID, duplicate_strategy="create_copy")
        assert summary["imported"] == 1
        codes = {r.code for r in db_session.query(TaxRate).filter(TaxRate.organization_id == org.id).all()}
        assert "EXIST1-COPY" in codes

    def test_invalid_rows_never_written(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Bad", "BAD1", "gst", "999", "India", "IN", "INR", "false"]])
        preview = svc.preview_import(file_bytes, "rates.csv", {}, org.id)
        summary = svc.confirm_import(preview["session_id"], org.id, USER_ID)
        assert summary["failed"] == 1
        assert db_session.query(TaxRate).filter(TaxRate.organization_id == org.id).count() == 0

    def test_cross_tenant_confirm_rejected(self, db_session):
        org_a = make_organization(db_session, code="ORGA")
        org_b = make_organization(db_session, code="ORGB")
        svc = TaxRateImportService(db_session)
        file_bytes = _csv_bytes([["Rate", "R1", "gst", "18", "India", "IN", "INR", "false"]])
        preview = svc.preview_import(file_bytes, "rates.csv", {}, org_a.id)
        with pytest.raises((ValueError, PermissionError)):
            svc.confirm_import(preview["session_id"], org_b.id, USER_ID)
        assert db_session.query(TaxRate).filter(TaxRate.organization_id == org_b.id).count() == 0

    def test_expired_or_unknown_session_raises(self, db_session):
        org = make_organization(db_session)
        svc = TaxRateImportService(db_session)
        with pytest.raises(ValueError):
            svc.confirm_import("not-a-real-session", org.id, USER_ID)


# ─── Template ────────────────────────────────────────────────────────────

class TestTemplate:
    def test_csv_template_contains_required_headers(self, db_session):
        svc = TaxRateImportService(db_session)
        content, mimetype = svc.generate_template("csv")
        text = content.decode("utf-8")
        assert "Name *" in text
        assert "Code *" in text
        assert "Rate (%) *" in text
        assert mimetype == "text/csv"

    def test_xlsx_template_generates(self, db_session):
        svc = TaxRateImportService(db_session)
        content, mimetype = svc.generate_template("xlsx")
        assert content[:2] == b"PK"  # xlsx is a zip archive
        assert "spreadsheetml" in mimetype
