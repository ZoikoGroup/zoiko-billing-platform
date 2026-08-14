"""
Regression tests for finding 5.7: ProductImportService.export_catalog() called
self.repo.get_by_id_safe(), which does not exist on ProductRepository — an
export restricted to a selected id list (GET /products/export?ids=...) raised
AttributeError (500).

The export now resolves the requested ids through get_by_ids() and silently
skips ids that do not exist or belong to another organization, preserving the
intended forgiving semantics.

Uses the shared in-memory SQLite fixtures (tests/conftest.py) and exercises the
real ProductImportService path exactly as the router does.
"""
import csv
import io

import pytest

from app.modules.billing.models import Product
from app.modules.billing.services.product_import_service import ProductImportService
from tests.conftest import make_organization


def make_product(db, organization_id, name, code):
    product = Product(
        organization_id=organization_id,
        name=name,
        code=code,
        default_price="10.00",
        currency="USD",
    )
    db.add(product)
    db.flush()
    db.refresh(product)
    return product


def _csv_rows(payload):
    return list(csv.reader(io.StringIO(payload.decode("utf-8"))))


@pytest.fixture()
def org(db_session):
    return make_organization(db_session)


@pytest.fixture()
def service(db_session):
    return ProductImportService(db_session)


def test_export_with_selected_ids_includes_only_own_products(db_session, service, org):
    p1 = make_product(db_session, org.id, "Alpha", "ALPHA-1")
    p2 = make_product(db_session, org.id, "Beta", "BETA-1")

    other_org = make_organization(db_session, code="ORG2", name="Other Org")
    foreign = make_product(db_session, other_org.id, "Gamma", "GAMMA-1")

    payload, mime = service.export_catalog(
        organization_id=org.id,
        fmt="csv",
        ids=[p1.id, p2.id, foreign.id],
    )

    rows = _csv_rows(payload)
    assert mime == "text/csv"
    assert len(rows) == 3
    names = {row[0] for row in rows[1:]}
    assert names == {"Alpha", "Beta"}
    assert "Gamma" not in names


def test_export_with_unknown_ids_is_forgiving(db_session, service, org):
    p1 = make_product(db_session, org.id, "Alpha", "ALPHA-2")

    payload, mime = service.export_catalog(
        organization_id=org.id,
        fmt="csv",
        ids=[p1.id, 999999],
    )

    rows = _csv_rows(payload)
    assert len(rows) == 2
    assert rows[1][0] == "Alpha"


def test_export_with_empty_id_list_falls_back_to_full_catalog(db_session, service, org):
    """An empty ids list is falsy, so export_catalog exports the whole
    catalog (pre-existing behavior for GET /products/export without ids)."""
    make_product(db_session, org.id, "Alpha", "ALPHA-3")

    payload, mime = service.export_catalog(organization_id=org.id, fmt="csv", ids=[])

    rows = _csv_rows(payload)
    assert len(rows) == 2
    assert rows[1][0] == "Alpha"


def test_export_with_duplicate_ids_emits_each_product_once(db_session, service, org):
    p1 = make_product(db_session, org.id, "Alpha", "ALPHA-4")

    payload, mime = service.export_catalog(
        organization_id=org.id,
        fmt="csv",
        ids=[p1.id, p1.id, p1.id],
    )

    rows = _csv_rows(payload)
    assert len(rows) == 2
    assert rows[1][0] == "Alpha"
