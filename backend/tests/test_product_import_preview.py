"""
Regression tests for the product import preview file-type handling.

Previously, any file with a `.xls` extension (legacy Excel OLE2/CFB, which
openpyxl cannot read) — or any ZIP-prefixed file that is not a valid .xlsx
workbook — was fed to openpyxl and blew up with the cryptic
`BadZipFile: File is not a zip file`. The preview route then translated that
into a generic 500 ("Import preview failed"), so the user could not import.

File dispatch is now content-based (`_detect_and_parse`): a legacy `.xls`
raises a clear, actionable ValueError (422), a corrupt `.xlsx` raises a clear
ValueError, and plain-text/CSV still parses — regardless of extension.

Uses the shared in-memory SQLite fixtures (tests/conftest.py).
"""
import csv
import io

import pytest

from app.modules.billing.services.product_import_service import (
    ProductImportService,
)
from tests.conftest import make_organization

CSV_BYTES = "Name *,SKU / Code *,Type *\nSvc,SVC-1,service\n".encode("utf-8")

LEGACY_XLS_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # OLE2/CFB header


@pytest.fixture()
def org(db_session):
    return make_organization(db_session)


@pytest.fixture()
def service(db_session):
    return ProductImportService(db_session)


def _preview(service, org, data, filename):
    return service.preview_import(
        file_bytes=data,
        filename=filename,
        column_map={},
        organization_id=org.id,
    )


def test_valid_csv_preview_and_confirm(db_session, service, org):
    res = _preview(service, org, CSV_BYTES, "products.csv")
    assert res["total"] == 1
    assert res["valid"] == 1
    assert res["invalid"] == 0

    conf = service.confirm_import(
        session_id=res["session_id"],
        organization_id=org.id,
        user_id=1,
        duplicate_strategy="skip",
    )
    assert conf["imported"] == 1
    assert conf["failed"] == 0


def test_legacy_xls_gives_clear_error_not_badzip(service, org):
    # A real legacy .xls (or any file carrying the OLE2 magic header) must
    # raise a readable ValueError, not a cryptic BadZipFile/500.
    with pytest.raises(ValueError) as exc:
        _preview(service, org, LEGACY_XLS_MAGIC + b"fake-xls-bytes", "old.xls")
    assert "xls" in str(exc.value).lower()
    assert "xlsx" in str(exc.value).lower()


def test_corrupt_xlsx_gives_clear_error(service, org):
    # A file that starts with a ZIP header but is not a real workbook would
    # previously surface openpyxl's BadZipFile as a 500.
    with pytest.raises(ValueError) as exc:
        _preview(service, org, b"PK\x03\x04garbage-not-a-workbook", "bad.xlsx")
    assert "xlsx" in str(exc.value).lower()


def test_xls_ext_but_csv_content_is_parsed(service, org):
    # Plain-text CSV content should be parsed as CSV even if named .xls,
    # rather than routed to openpyxl and crashing.
    res = _preview(service, org, CSV_BYTES, "mislabeled.xls")
    assert res["total"] == 1
    assert res["valid"] == 1


def test_reimport_restores_soft_deleted_product(db_session, service, org):
    """Re-importing a code that belongs to a soft-deleted product must RESTORE
    that product instead of failing with 409 'code already exists'. The
    archived row still holds the (org, code) unique constraint, so a naive
    insert collides; the service must revive it."""
    from app.modules.billing.models import Product
    from datetime import datetime, timezone

    archived = Product(
        organization_id=org.id,
        name="Website Development",
        code="SVC-WEB-001",
        default_price="10.00",
        currency="USD",
        deleted_at=datetime.now(timezone.utc),
        is_active=False,
    )
    db_session.add(archived)
    db_session.flush()
    db_session.refresh(archived)
    archived_id = archived.id

    reimport_csv = (
        "Name *,SKU / Code *,Type *\n"
        "Website Development,SVC-WEB-001,service\n"
    ).encode("utf-8")

    # Preview sees no live duplicate (deleted row excluded) -> valid.
    res = _preview(service, org, reimport_csv, "products.csv")
    assert res["valid"] == 1

    conf = service.confirm_import(
        session_id=res["session_id"],
        organization_id=org.id,
        user_id=1,
        duplicate_strategy="skip",
    )
    assert conf["imported"] == 1
    assert conf["failed"] == 0

    db_session.expire_all()
    revived = db_session.get(Product, archived_id)
    assert revived.deleted_at is None
    assert revived.is_active is True
    assert revived.code == "SVC-WEB-001"
