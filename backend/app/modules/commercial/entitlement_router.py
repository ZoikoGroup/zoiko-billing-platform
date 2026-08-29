"""
modules/commercial/entitlement_router.py
--------------------------------------------
ZB-COM-ENT-001 Part 2, §11 — the "internal endpoint" background jobs/
schedulers can call to evaluate entitlements the same way interactive
requests do (bypassing route dependencies is not bypassing the resolver).
Gated by the existing commercial_financial.read capability rather than
inventing a new one — this is exactly the kind of cross-org financial/
governance read that capability already governs. There is no separate
machine-to-machine auth layer anywhere in this codebase to mirror (every
cross-module call happens via direct Python import, as
EntitlementEnforcementService/resolve_entitlement already are) — "internal"
here means capability-gated within the platform, consistent with every
other cross-module call site.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.capabilities import require_capability
from app.database import get_db
from app.modules.commercial.entitlement_catalog_spec import ENTITLEMENT_CATALOG_SPEC
from app.modules.commercial.entitlement_resolver import resolve_entitlement

logger = logging.getLogger("zoiko_billing.commercial.entitlement_router")

router = APIRouter(prefix="/commercial/entitlements", tags=["🔐 Entitlements"])


@router.get(
    "/{organization_id}",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
    summary="Resolve every catalog entitlement for an organization",
)
def get_resolved_entitlements(organization_id: int, db: Session = Depends(get_db)):
    """Per-key error isolation: one bad key surfaces as an error row, not a
    500 for the whole response — this endpoint is itself a fail-open read
    (§14), same guarantee as CommercialEntitlementService.is_entitled/get_limit."""
    results = []
    for spec in ENTITLEMENT_CATALOG_SPEC:
        key = spec["key"]
        try:
            resolved = resolve_entitlement(db, organization_id, key)
            results.append({
                "key": key,
                "value": resolved.value,
                "value_type": resolved.value_type.value if hasattr(resolved.value_type, "value") else resolved.value_type,
                "source_level": resolved.source_level,
                "error": None,
            })
        except Exception as exc:  # noqa: BLE001 - per-key isolation, not a page-level 500
            logger.exception("Failed to resolve entitlement %r for org %s", key, organization_id)
            results.append({
                "key": key, "value": None, "value_type": spec["value_type"].value,
                "source_level": None, "error": str(exc),
            })
    return {"organization_id": organization_id, "entitlements": results}
