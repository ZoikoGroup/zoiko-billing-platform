"""ZB-TAX-ARCH-001 Phase 4d-0 review: secret version housekeeping

tax_provider_connections gains credential_disabled_versions (disabled
versions awaiting destruction after the retention window) and
credential_destroy_through (a failed revocation's versions, retried by
reconciliation). tax_review_items gains owner_role.

Revision ID: f7a2c4e6b8d1
Revises: e5c1a7b3d9f4
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'f7a2c4e6b8d1'
down_revision: Union[str, Sequence[str], None] = 'e5c1a7b3d9f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("tax_provider_connections", "credential_disabled_versions", sa.JSON()),
    ("tax_provider_connections", "credential_destroy_through", sa.String(20)),
    ("tax_review_items", "owner_role", sa.String(50)),
)


def _has_column(t: str, c: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return insp.has_table(t) and c in {x["name"] for x in insp.get_columns(t)}


def upgrade() -> None:
    for table, name, type_ in _COLUMNS:
        if not _has_column(table, name):
            op.add_column(table, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for table, name, _ in reversed(_COLUMNS):
        if _has_column(table, name):
            op.drop_column(table, name)
