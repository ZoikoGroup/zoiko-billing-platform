"""ZB-TAX-ARCH-001 Phase 4d-0: GCP Secret Manager references on provider
connections

tax_provider_connections gains credential_store ("fernet" | "gcp"),
credential_secret_name (the Secret Manager resource name),
credential_version and credential_previous_version (version numbers; the
previous one is disabled after a successful test). Never a secret value.
Existing credentials are marked as held by the fernet store.

Revision ID: e5c1a7b3d9f4
Revises: d2b8e4f6a1c3
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'e5c1a7b3d9f4'
down_revision: Union[str, Sequence[str], None] = 'd2b8e4f6a1c3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("credential_store", sa.String(20)),
    ("credential_secret_name", sa.String(255)),
    ("credential_version", sa.String(20)),
    ("credential_previous_version", sa.String(20)),
)


def _has_column(t: str, c: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return insp.has_table(t) and c in {x["name"] for x in insp.get_columns(t)}


def upgrade() -> None:
    for name, type_ in _COLUMNS:
        if not _has_column("tax_provider_connections", name):
            op.add_column("tax_provider_connections", sa.Column(name, type_, nullable=True))
    op.execute("UPDATE tax_provider_connections SET credential_store = 'fernet' "
               "WHERE credential_ref IS NOT NULL AND credential_store IS NULL")


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        if _has_column("tax_provider_connections", name):
            op.drop_column("tax_provider_connections", name)
