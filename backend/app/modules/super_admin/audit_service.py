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

import logging
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Optional

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
        )
        self.db.add(entry)
        self.db.flush()
        return entry
