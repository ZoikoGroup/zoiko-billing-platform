"""
modules/super_admin/audit_service.py
-------------------------------------
Platform-plane audit writer (PHASE 11).

Mirrors the org-scoped BillingAuditService.log_no_commit pattern: the entry
is added and FLUSHED into the caller's transaction only — it is persisted
exclusively by the caller's single commit, and rolled back with it. A failed
mutation therefore leaves ZERO audit rows behind (all-or-nothing with the
change it describes).

The platform-plane audit is deliberately SEPARATE from the org-scoped
billing_audit_logs (BillingAuditLog): that table requires organization_id
NOT NULL and documents tenant-facing billing operations, so it can never
hold platform events like CommercialPlan mutations (org-agnostic).

Data classification: actor_id (Super Admin user id), entity_type/entity_id,
optional organization_id, and structured old/new/metadata state of auditable
fields. No passwords, tokens, JWTs, or payment credentials are ever stored.
"""

import hashlib
import json
import logging
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.modules.super_admin.models import (
    PlatformAuditAction,
    PlatformAuditLog,
)

logger = logging.getLogger("zoiko_billing.super_admin.audit")


def _json_safe(value: Any) -> Any:
    """Normalize a value to JSON-serializable primitives.

    Handles nested dict/list/tuple, Decimal (kept as string so currency
    amounts never lose precision), date/datetime (ISO-8601), and enums.
    """
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [_json_safe(v) for v in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    return value


def _canonical_audit_json(data: dict) -> str:
    """Deterministic, sorted-key JSON string for hash chain verification."""
    return json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)


class PlatformAuditService:
    def __init__(self, db: Session):
        self.db = db

    def log_no_commit(
        self,
        *,
        actor_id: Optional[int],
        action: PlatformAuditAction,
        entity_type: str,
        entity_id: Optional[int] = None,
        organization_id: Optional[int] = None,
        old_values: Optional[dict] = None,
        new_values: Optional[dict] = None,
        metadata: Optional[dict] = None,
        actor_role: Optional[str] = None,
        reason: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> PlatformAuditLog:
        """Append a platform-plane audit entry to the caller's transaction.

        Only flushes — the caller's commit persists it, so a later rollback
        discards both the mutation and its audit row together. Callers must
        invoke this ONLY after a mutation has succeeded, so a failed
        operation never produces an audit row.
        """
        entry = PlatformAuditLog(
            actor_id=actor_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            organization_id=organization_id,
            old_values=_json_safe(old_values),
            new_values=_json_safe(new_values),
            metadata_=_json_safe(metadata),
            actor_role=actor_role,
            reason=reason,
            correlation_id=correlation_id,
        )
        self.db.add(entry)
        self.db.flush()

        # Compute tamper-evident hash chain (AUD-01)
        # 1. Serialize writers on Postgres; skip on SQLite
        try:
            bind = self.db.get_bind() if hasattr(self.db, "get_bind") else getattr(self.db, "bind", None)
            dialect = bind.dialect.name if bind and hasattr(bind, "dialect") else "sqlite"
        except Exception:
            dialect = "sqlite"

        if dialect == "postgresql":
            self.db.execute(text("SELECT pg_advisory_xact_lock(849302751)"))

        # 2. Get last hashed row
        prev_row = (
            self.db.query(PlatformAuditLog.row_hash)
            .filter(
                PlatformAuditLog.id != entry.id,
                PlatformAuditLog.row_hash.isnot(None),
            )
            .order_by(PlatformAuditLog.created_at.desc(), PlatformAuditLog.id.desc())
            .first()
        )
        prev_hash = prev_row[0] if prev_row and prev_row[0] else "GENESIS"

        # 3. Canonical hash over non-nullable content fields.
        # DO NOT include actor_id or organization_id (ON DELETE SET NULL cascades).
        canonical = _canonical_audit_json({
            "id": entry.id,
            "action": entry.action.value if hasattr(entry.action, "value") else str(entry.action),
            "entity_type": entry.entity_type,
            "entity_id": entry.entity_id,
            "old_values": entry.old_values,
            "new_values": entry.new_values,
            "metadata": entry.metadata_,
            "reason": entry.reason,
            "correlation_id": entry.correlation_id,
            "created_at": entry.created_at.strftime("%Y-%m-%dT%H:%M:%S.%f") if entry.created_at else None,
        })
        entry.prev_hash = prev_hash
        entry.row_hash = hashlib.sha256((prev_hash + canonical).encode("utf-8")).hexdigest()
        self.db.flush()

        return entry

    @classmethod
    def verify_audit_chain(cls, db: Session, limit: Optional[int] = None) -> Optional[int]:
        """Verify the tamper-evident hash chain (AUD-01).
        Returns the first broken row id, or None if the chain is fully valid.
        """
        query = (
            db.query(PlatformAuditLog)
            .filter(PlatformAuditLog.row_hash.isnot(None))
            .order_by(PlatformAuditLog.created_at.asc(), PlatformAuditLog.id.asc())
        )
        if limit is not None:
            query = query.limit(limit)

        rows = query.all()
        if not rows:
            return None

        expected_prev_hash = "GENESIS"
        for row in rows:
            if row.prev_hash != expected_prev_hash:
                return row.id

            canonical = _canonical_audit_json({
                "id": row.id,
                "action": row.action.value if hasattr(row.action, "value") else str(row.action),
                "entity_type": row.entity_type,
                "entity_id": row.entity_id,
                "old_values": row.old_values,
                "new_values": row.new_values,
                "metadata": row.metadata_,
                "reason": row.reason,
                "correlation_id": row.correlation_id,
                "created_at": row.created_at.strftime("%Y-%m-%dT%H:%M:%S.%f") if row.created_at else None,
            })
            expected_row_hash = hashlib.sha256((expected_prev_hash + canonical).encode("utf-8")).hexdigest()
            if row.row_hash != expected_row_hash:
                return row.id

            expected_prev_hash = row.row_hash

        return None

    def verify_chain(self, limit: Optional[int] = None) -> Optional[int]:
        """Instance convenience helper for verify_audit_chain."""
        return self.verify_audit_chain(self.db, limit=limit)
