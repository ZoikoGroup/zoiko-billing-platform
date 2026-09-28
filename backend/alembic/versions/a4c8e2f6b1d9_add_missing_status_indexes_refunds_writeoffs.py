"""add missing status indexes on refunds and write_offs

The super-admin Financial Operations hub's Credits/Refunds/Write-offs tab
groups refunds and write-offs by status on every load
(list_refunds/list_write_offs -> base.with_entities(Model.status,
func.count(...)).group_by(Model.status)) across every tenant. Payment,
CreditNote and DunningCase already had an index on their equivalent status
column; refunds.status and write_offs.status did not, so those two grouped
counts ran as a full table scan while their siblings didn't.

Revision ID: a4c8e2f6b1d9
Revises: 73e2ebbe6aad
Create Date: 2026-09-28

"""
from typing import Sequence, Union

from alembic import op


revision: str = "a4c8e2f6b1d9"
down_revision: Union[str, Sequence[str], None] = "73e2ebbe6aad"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_refunds_status", "refunds", ["status"], unique=False)
    op.create_index("ix_write_offs_status", "write_offs", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_write_offs_status", table_name="write_offs")
    op.drop_index("ix_refunds_status", table_name="refunds")
