"""
CRIT-Q17b remediation — optimistic-lock `version` on PriceList.

PriceList.version was previously a dead column (`default=1` but never
incremented by any write path), the same class of bug as CRIT-Q17. After the
fix, `version` is bumped EXPLICITLY at the repository/service layer (repo
`_apply`/`save`, overrides for update/bulk_update/soft_delete/restore, plus
parent bump on item add/update/remove) — never by an ORM `onupdate` hook.

These exercise the real repositories/services against the shared in-memory
SQLite fixtures, mirroring test_resource_version_column.py.
"""
import pytest

from datetime import date

from app.modules.billing.models import (
    PriceList,
    PriceListItem,
    Product,
)
from app.modules.billing.repositories.catalog import PriceListRepository
from app.modules.billing.services.pricing_service import PriceListService
from tests.conftest import make_organization


def _fresh_price_list(db):
    org = make_organization(db, code="PLORG1", name="PriceList Org")
    db.commit()
    pl = PriceList(
        organization_id=org.id,
        name="Standard",
        code="PL-STD",
        currency="USD",
        effective_from=date(2026, 1, 1),
    )
    db.add(pl)
    db.commit()
    db.refresh(pl)
    return org, pl


def _product(db, org, code="PROD1"):
    p = Product(
        organization_id=org.id,
        name="Widget",
        code=code,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def test_create_starts_at_version_one(db_session):
    _, pl = _fresh_price_list(db_session)
    assert pl.version == 1
    db_session.refresh(pl)
    assert pl.version == 1


def test_update_bumps_version(db_session):
    _, pl = _fresh_price_list(db_session)
    svc = PriceListService(db_session)
    updated = svc.update(pl.id, pl.organization_id, updated_by=1, description="v2")
    assert updated.version == 2


def test_deactivate_bumps_version(db_session):
    _, pl = _fresh_price_list(db_session)
    svc = PriceListService(db_session)
    updated = svc.deactivate(pl.id, pl.organization_id, updated_by=1)
    assert updated.is_active is False
    assert updated.version == 2


def test_same_value_update_still_bumps(db_session):
    """Consistent with CRIT-Q17: any repo.write bumps version regardless of
    whether the value changed — err toward extra invalidation."""
    _, pl = _fresh_price_list(db_session)
    repo = PriceListRepository(db_session)
    updated = repo.update(pl.id, pl.organization_id, name="Standard")
    assert updated.version == 2


def test_bulk_update_bumps_each(db_session):
    _, pl = _fresh_price_list(db_session)
    repo = PriceListRepository(db_session)
    updated = repo.bulk_update([{"id": pl.id, "description": "bulk"}], pl.organization_id)
    assert len(updated) == 1
    assert updated[0].version == 2


def test_soft_delete_and_restore_bump(db_session):
    _, pl = _fresh_price_list(db_session)
    repo = PriceListRepository(db_session)
    deleted = repo.soft_delete(pl.id, pl.organization_id)
    assert deleted.version == 2
    restored = repo.restore(pl.id, pl.organization_id)
    assert restored.version == 3


def test_add_item_bumps_parent(db_session):
    org, pl = _fresh_price_list(db_session)
    prod = _product(db_session, org)
    svc = PriceListService(db_session)
    svc.add_item(
        pl.organization_id, pl.id, created_by=1,
        product_id=prod.id, unit_price="10.0000",
    )
    db_session.refresh(pl)
    assert pl.version == 2


def test_update_item_bumps_parent(db_session):
    org, pl = _fresh_price_list(db_session)
    prod = _product(db_session, org)
    svc = PriceListService(db_session)
    item = svc.add_item(
        pl.organization_id, pl.id, created_by=1,
        product_id=prod.id, unit_price="10.0000",
    )
    db_session.refresh(pl)
    assert pl.version == 2

    svc.update_item(pl.id, item.id, pl.organization_id, updated_by=1, unit_price="12.0000")
    db_session.refresh(pl)
    assert pl.version == 3


def test_remove_item_bumps_parent(db_session):
    org, pl = _fresh_price_list(db_session)
    prod = _product(db_session, org)
    svc = PriceListService(db_session)
    item = svc.add_item(
        pl.organization_id, pl.id, created_by=1,
        product_id=prod.id, unit_price="10.0000",
    )
    db_session.refresh(pl)
    assert pl.version == 2

    svc.remove_item(pl.id, item.id, pl.organization_id, updated_by=1)
    db_session.refresh(pl)
    assert pl.version == 3
    assert db_session.query(PriceListItem).count() == 0
