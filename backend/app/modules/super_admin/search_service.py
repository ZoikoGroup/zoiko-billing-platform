"""
modules/super_admin/search_service.py
----------------------------------------
ZB-SA-CMD-003 §13/§14 — identity-first, domain-labeled, permission-aware
global search + command palette backing.

Every result carries an explicit domain label per the spec's vocabulary
lock (§4.2) and only ever exposes identity-level fields in the search
result itself — no financial amounts, no tenant customer/invoice content.
Sensitive Domain B detail is never returned from search; a result merely
points at the correctly-authorized page (e.g. an Organization result
routes to Support Access to request a grant, not to a Domain B page
directly). Only super_admin can call this today (see router.py), matching
every other endpoint in this module — there is no anonymous or
cross-role search path.
"""

from typing import Any

from sqlalchemy.orm import Session

from app.modules.organizations.models import Organization
from app.modules.super_admin.models import AttentionItem, PlatformAuditLog, PrivilegedTenantAccessGrant

MAX_RESULTS_PER_TYPE = 5


class GlobalSearchService:
    def __init__(self, db: Session):
        self.db = db

    def search(self, query: str) -> list[dict[str, Any]]:
        query = (query or "").strip()
        if not query:
            return []

        results: list[dict[str, Any]] = []
        results.extend(self._search_organizations(query))
        results.extend(self._search_attention(query))
        results.extend(self._search_correlation_id(query))
        results.extend(self._search_audit(query))
        return results

    def _search_organizations(self, query: str) -> list[dict[str, Any]]:
        like = f"%{query}%"
        rows = (
            self.db.query(Organization)
            .filter((Organization.organization_name.ilike(like)) | (Organization.organization_code.ilike(like)))
            .limit(MAX_RESULTS_PER_TYPE)
            .all()
        )
        return [
            {
                "domain": "platform",
                "entity_type": "Organization",
                "id": org.id,
                "label": f"{org.organization_name} ({org.organization_code})",
                "route": "/super-admin/support-access",
                "requires_access": True,
            }
            for org in rows
        ]

    def _search_attention(self, query: str) -> list[dict[str, Any]]:
        like = f"%{query}%"
        rows = (
            self.db.query(AttentionItem)
            .filter((AttentionItem.title.ilike(like)) | (AttentionItem.source_key.ilike(like)))
            .order_by(AttentionItem.opened_at.desc())
            .limit(MAX_RESULTS_PER_TYPE)
            .all()
        )
        return [
            {
                "domain": "governance",
                "entity_type": "Attention Item",
                "id": item.id,
                "label": f"{item.title} [{item.severity.value.upper()}]",
                "route": "/super-admin/governance",
                "requires_access": False,
            }
            for item in rows
        ]

    def _search_correlation_id(self, query: str) -> list[dict[str, Any]]:
        """Exact-match only — a correlation ID is an opaque identifier, not
        free text (ZB-SA-CMD-003 §13.1)."""
        results: list[dict[str, Any]] = []
        audit_hit = (
            self.db.query(PlatformAuditLog)
            .filter(PlatformAuditLog.correlation_id == query)
            .order_by(PlatformAuditLog.created_at.desc())
            .first()
        )
        if audit_hit:
            results.append({
                "domain": "governance",
                "entity_type": "Correlation ID",
                "id": audit_hit.id,
                "label": f"Correlation {query} — {audit_hit.action.value if hasattr(audit_hit.action, 'value') else audit_hit.action}",
                "route": "/super-admin/audit-logs",
                "requires_access": False,
            })
        grant_hit = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(PrivilegedTenantAccessGrant.correlation_id == query)
            .first()
        )
        if grant_hit:
            results.append({
                "domain": "governance",
                "entity_type": "Correlation ID",
                "id": grant_hit.id,
                "label": f"Correlation {query} — privileged access grant",
                "route": "/super-admin/support-access",
                "requires_access": False,
            })
        return results

    def _search_audit(self, query: str) -> list[dict[str, Any]]:
        like = f"%{query}%"
        rows = (
            self.db.query(PlatformAuditLog)
            .filter(PlatformAuditLog.entity_type.ilike(like))
            .order_by(PlatformAuditLog.created_at.desc())
            .limit(MAX_RESULTS_PER_TYPE)
            .all()
        )
        return [
            {
                "domain": "governance",
                "entity_type": "Audit Event",
                "id": row.id,
                "label": f"{row.entity_type} #{row.entity_id} — {row.action.value if hasattr(row.action, 'value') else row.action}",
                "route": "/super-admin/audit-logs",
                "requires_access": False,
            }
            for row in rows
        ]
