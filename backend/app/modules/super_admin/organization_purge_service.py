"""
modules/super_admin/organization_purge_service.py
-------------------------------------------------
Permanent (hard) deletion of an Organization and every row that belongs to it.

This is the ONLY code path that physically removes a tenant. The documented
default offboarding path remains the governed, non-destructive
``TenantLifecycleService`` transition (SUSPENDED -> DEACTIVATING ->
DEACTIVATED), which preserves billing history. A purge is reserved for
demo/test cleanup and right-to-erasure requests, and is gated at the router by
an exact ``organization_code`` confirmation plus a mandatory reason.

Why this is metadata-driven instead of a hand-written table list:
  * 86 tables carry ``organization_id`` and most FKs are ``ON DELETE RESTRICT``
    — a naïve ``DELETE FROM organizations`` fails, and a hand-maintained
    ordering drifts the moment a new table is added.
  * Some tables belong to the tenant transitively via FK (AI conversation
    trees, commercial/platform rows) without their own ``organization_id``.

Algorithm:
  1. Seed every table that has an ``organization_id`` column with the rows
     whose value equals the target org, plus the ``organizations`` row itself.
  2. Breadth-first follow every FOREIGN KEY edge from the rows already
     selected to collect the rest of the tenant graph (this catches the
     transitive children).
  3. Delete the collected rows child-before-parent. A table may only be
     deleted once no *remaining* table holds a RESTRICT / NO ACTION FK into
     it; SET NULL and CASCADE children never block.
  4. Record the purge on the platform audit trail (organization_id left NULL,
     because the row it referred to no longer exists).

Everything runs inside the caller's transaction: a single ``commit`` makes the
purge durable, a rollback removes all of it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, Iterable, Set, Tuple

from sqlalchemy import delete as sa_delete
from sqlalchemy import select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import Base
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction

logger = logging.getLogger("zoiko_billing.super_admin.purge")

# FK delete actions that do NOT require the referenced row to be removed first.
_NON_BLOCKING_FK_ACTIONS = {"CASCADE", "SET NULL", "SET DEFAULT"}

# The canonical tenant key. ``tenant_id`` (used by the AI context tables) is
# reached through its FK edge, so it does not need seeding here.
_ORG_COLUMN = "organization_id"

_Pk = Tuple[int, ...]


class PurgeDependencyError(RuntimeError):
    """Raised when the FK graph cannot be unwound (unexpected RESTRICT cycle)."""


@dataclass
class PurgeResult:
    organization_id: int
    organization_code: str
    organization_name: str
    tables_deleted: int
    rows_deleted: int
    per_table: Dict[str, int] = field(default_factory=dict)


def _pk_columns(table):
    return list(table.primary_key.columns)


def _pk_predicate(table, rows: Iterable[_Pk]):
    rows = list(rows)
    cols = _pk_columns(table)
    if len(cols) == 1:
        return cols[0].in_([r[0] for r in rows])
    return tuple_(*cols).in_(rows)


class OrganizationPurgeService:
    def __init__(self, db: Session):
        self.db = db

    # ── public API ──────────────────────────────────────────────────────────

    def purge(self, organization, *, actor, reason: str) -> PurgeResult:
        """Permanently delete *organization* and all of its tenant data.

        Does NOT commit — the caller owns the transaction boundary.
        """
        org_id = int(organization.id)
        org_code = organization.organization_code
        org_name = organization.organization_name
        # Snapshot the fields the audit row needs before the row disappears.
        old_values = {
            "organization_name": org_name,
            "organization_code": org_code,
            "is_active": bool(organization.is_active),
            "lifecycle_state": getattr(
                getattr(organization, "lifecycle_state", None), "value", None
            ),
            "created_at": organization.created_at,
        }

        pending = self._collect(org_id)
        per_table = self._delete_all(pending)
        rows_deleted = sum(per_table.values())

        # organization_id is deliberately NULL: the FK it would point at is
        # gone, and the surrogate entity_id below still identifies the tenant.
        PlatformAuditService(self.db).log_no_commit(
            actor_id=getattr(actor, "id", None),
            actor_role="super_admin",
            action=PlatformAuditAction.DELETE,
            entity_type="Organization",
            entity_id=org_id,
            organization_id=None,
            old_values=old_values,
            reason=reason,
            metadata={
                "purge": True,
                "organization_code": org_code,
                "tables_deleted": len(per_table),
                "rows_deleted": rows_deleted,
            },
        )

        logger.warning(
            "HARD PURGE of organization %s (%s) by actor %s: %d rows across %d tables — %s",
            org_code,
            org_id,
            getattr(actor, "email", getattr(actor, "id", None)),
            rows_deleted,
            len(per_table),
            reason,
        )
        return PurgeResult(
            organization_id=org_id,
            organization_code=org_code,
            organization_name=org_name,
            tables_deleted=len(per_table),
            rows_deleted=rows_deleted,
            per_table=per_table,
        )

    # ── collection ──────────────────────────────────────────────────────────

    def _collect(self, org_id: int) -> Dict[str, Set[_Pk]]:
        """Return ``{table_name: {primary-key tuples}}`` for the whole tenant."""
        metadata = Base.metadata
        tables = metadata.tables

        # parent table -> [(child table, child fk column, parent referenced column, ondelete)]
        children: Dict[str, list] = {}
        for child_name, child in tables.items():
            for fk in child.foreign_keys:
                parent_name = fk.column.table.name
                children.setdefault(parent_name, []).append(
                    (child_name, fk.parent.name, fk.column.name, fk.ondelete)
                )

        pending: Dict[str, Set[_Pk]] = {}
        queue = []

        def add(table_name: str, pks: Set[_Pk]) -> None:
            if not pks:
                return
            bucket = pending.setdefault(table_name, set())
            fresh = pks - bucket
            if fresh:
                bucket.update(fresh)
                queue.append((table_name, fresh))

        # Seed 1: the organization row itself.
        add("organizations", {(org_id,)})

        # Seed 2: every table that keys directly on the org.
        for table_name, table in tables.items():
            if _ORG_COLUMN not in table.columns:
                continue
            cols = _pk_columns(table)
            if not cols:
                continue
            rows = self.db.execute(
                select(*cols).where(table.columns[_ORG_COLUMN] == org_id)
            ).all()
            add(table_name, {tuple(r) for r in rows})

        # BFS across FK edges to pick up transitive (non-org-column) children.
        while queue:
            parent_name, parent_pks = queue.pop(0)
            parent = tables[parent_name]
            parent_predicate = _pk_predicate(parent, parent_pks)
            for child_name, child_col, parent_col, _ondelete in children.get(parent_name, []):
                child = tables[child_name]
                cols = _pk_columns(child)
                if not cols:
                    continue
                referenced = select(parent.columns[parent_col]).where(parent_predicate)
                rows = self.db.execute(
                    select(*cols).where(child.columns[child_col].in_(referenced))
                ).all()
                add(child_name, {tuple(r) for r in rows})

        return pending

    # ── deletion ────────────────────────────────────────────────────────────

    def _blocking_parents(self, pending: Dict[str, Set[_Pk]]) -> Dict[str, Set[str]]:
        """parent table -> child tables holding a RESTRICT/NO ACTION FK into it."""
        metadata = Base.metadata
        pending_names = set(pending)
        blocking: Dict[str, Set[str]] = {}
        for child_name in pending_names:
            child = metadata.tables[child_name]
            for fk in child.foreign_keys:
                action = (fk.ondelete or "NO ACTION").upper()
                if action in _NON_BLOCKING_FK_ACTIONS:
                    continue
                parent_name = fk.column.table.name
                if parent_name == child_name:
                    continue  # self-reference handled by the retry below
                blocking.setdefault(parent_name, set()).add(child_name)
        return blocking

    def _delete_all(self, pending: Dict[str, Set[_Pk]]) -> Dict[str, int]:
        metadata = Base.metadata
        remaining: Dict[str, Set[_Pk]] = {k: set(v) for k, v in pending.items() if v}
        blocking = self._blocking_parents(remaining)
        per_table: Dict[str, int] = {}

        while remaining:
            progressed = False
            for table_name in list(remaining):
                blockers = {b for b in blocking.get(table_name, set()) if b != table_name}
                if blockers & set(remaining):
                    continue
                table = metadata.tables[table_name]
                rows = remaining.pop(table_name)
                try:
                    # SAVEPOINT per table: on Postgres a failed statement
                    # poisons the whole transaction, so a retry on the next
                    # pass is only possible after rolling back to here.
                    with self.db.begin_nested():
                        self.db.execute(
                            sa_delete(table).where(_pk_predicate(table, rows))
                        )
                except IntegrityError:
                    # Either an unexpected non-collected referencing row, or a
                    # self-referential RESTRICT edge — put it back and retry on
                    # the next pass once other tables have been cleared.
                    remaining[table_name] = rows
                    continue
                per_table[table_name] = per_table.get(table_name, 0) + len(rows)
                progressed = True
            if not progressed:
                stuck = ", ".join(sorted(remaining))
                raise PurgeDependencyError(
                    "Could not resolve the tenant's foreign-key order; still "
                    f"holding rows in: {stuck}. No data was committed."
                )

        return per_table
