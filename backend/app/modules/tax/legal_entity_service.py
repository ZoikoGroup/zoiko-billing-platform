"""
app/modules/tax/legal_entity_service.py
---------------------------------------
Seller legal entity lifecycle (ZB-TAX-ARCH-001 §02, §07, §15).

Every organization has exactly one *default* entity, created lazily from the
organization profile the first time anything needs it (registration,
invoice creation, invoice finalization, or the Phase 0 migration backfill).
Additional entities are explicit.

Guardrails enforced here:
  * Entities are strictly tenant-scoped; every lookup filters by
    organization_id, and a foreign entity id behaves exactly like a missing
    one (NotFound, no existence leak).
  * An entity's home country cannot be changed once it has issued (non-draft)
    invoices — that would silently re-attribute historical tax obligations.
    Register a new entity instead.
  * The GOVERNED tax regime cannot be switched on by a settings toggle
    (§13 T12). It requires approved jurisdiction activation records, which
    arrive in Phase 2; until then the request is refused.
"""
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.exceptions import AlreadyExistsException, BadRequestException, NotFoundException
from app.modules.auth.country_currency import resolve_country_code
from app.modules.billing.models import BillingAuditAction, Invoice, InvoiceStatus
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.utils.country_tax_profiles import get_country_tax_profile
from app.modules.tax.enums import EntityTaxRegime
from app.modules.tax.models import SellerLegalEntity

logger = logging.getLogger("zoiko_billing")

DEFAULT_ENTITY_CODE = "PRIMARY"

ENTITY_WRITABLE_FIELDS = {
    "entity_code", "legal_name", "display_name",
    "country_code", "subdivision_code", "address_line1", "address_line2",
    "city", "postal_code", "timezone",
    "primary_tax_id", "primary_tax_id_type", "registration_number",
    "is_merchant_of_record", "tax_regime", "notes",
}

# Fields whose change re-attributes tax obligations of already-issued
# invoices. Locked once the entity has issued anything.
JURISDICTION_LOCKED_FIELDS = {"country_code", "subdivision_code"}


def _normalize(data: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: v for k, v in data.items() if k in ENTITY_WRITABLE_FIELDS}
    for key in ("entity_code", "legal_name", "display_name", "primary_tax_id", "registration_number"):
        if isinstance(out.get(key), str):
            out[key] = out[key].strip() or None
    if out.get("entity_code"):
        out["entity_code"] = out["entity_code"].upper()
    if "country_code" in out and out["country_code"] is not None:
        resolved = resolve_country_code(out["country_code"])
        if not resolved:
            raise BadRequestException(f"Unrecognized country: {out['country_code']!r}. Use an ISO 3166-1 alpha-2 code.")
        out["country_code"] = resolved
    if isinstance(out.get("subdivision_code"), str):
        out["subdivision_code"] = out["subdivision_code"].strip().upper() or None
    if isinstance(out.get("tax_regime"), str):
        try:
            out["tax_regime"] = EntityTaxRegime(out["tax_regime"].lower())
        except ValueError:
            raise BadRequestException(f"Unknown tax_regime {out['tax_regime']!r}.")
    return out


class LegalEntityService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = BillingAuditService(db)

    # ── Queries ──────────────────────────────────────────────────────────

    def _query(self, organization_id: int):
        return self.db.query(SellerLegalEntity).filter(SellerLegalEntity.organization_id == organization_id)

    def list_entities(self, organization_id: int, include_inactive: bool = False) -> List[SellerLegalEntity]:
        q = self._query(organization_id)
        if not include_inactive:
            q = q.filter(SellerLegalEntity.is_active.is_(True))
        return q.order_by(SellerLegalEntity.is_default.desc(), SellerLegalEntity.entity_code).all()

    def get_entity(self, entity_id: int, organization_id: int) -> SellerLegalEntity:
        entity = self._query(organization_id).filter(SellerLegalEntity.id == entity_id).first()
        if entity is None:
            raise NotFoundException("SellerLegalEntity", entity_id)
        return entity

    def get_default_entity(self, organization_id: int) -> Optional[SellerLegalEntity]:
        return self._query(organization_id).filter(SellerLegalEntity.is_default.is_(True)).first()

    def has_issued_invoices(self, entity_id: int, organization_id: int) -> bool:
        return self.db.query(Invoice.id).filter(
            Invoice.organization_id == organization_id,
            Invoice.seller_entity_id == entity_id,
            Invoice.status != InvoiceStatus.DRAFT,
        ).first() is not None

    # ── Default entity bootstrap ─────────────────────────────────────────

    @staticmethod
    def default_entity_values_from_org(org) -> Dict[str, Any]:
        """Map an Organization profile onto a default entity. Pure function
        so the Alembic backfill and the lazy bootstrap stay identical."""
        country_code = resolve_country_code(getattr(org, "country", None))
        profile = get_country_tax_profile(country_code) if country_code else None
        tax_id = (getattr(org, "tax_no", None) or "").strip() or None
        return {
            "entity_code": DEFAULT_ENTITY_CODE,
            "legal_name": (getattr(org, "legal_name", None) or getattr(org, "organization_name", None) or "Primary entity").strip(),
            "display_name": getattr(org, "display_name", None) or getattr(org, "organization_name", None),
            "country_code": country_code,
            "address_line1": getattr(org, "address", None),
            "city": getattr(org, "city", None),
            "postal_code": getattr(org, "postal_code", None),
            "timezone": getattr(org, "timezone", None),
            "primary_tax_id": tax_id,
            "primary_tax_id_type": (profile.tax_id_label if (profile and tax_id) else None),
            "registration_number": getattr(org, "registration_number", None),
        }

    def ensure_default_entity(self, organization_id: int, created_by: Optional[int] = None) -> SellerLegalEntity:
        """Return the org's default entity, creating it from the org profile
        if missing. Flush-only (never commits) so callers keep their own
        transaction boundary — registration stays all-or-nothing."""
        existing = self.get_default_entity(organization_id)
        if existing is not None:
            return existing

        from app.modules.organizations.models import Organization
        org = self.db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise NotFoundException("Organization", organization_id)

        values = self.default_entity_values_from_org(org)
        # If a non-default entity already took the PRIMARY code, pick a free one.
        code = values["entity_code"]
        suffix = 1
        while self._query(organization_id).filter(SellerLegalEntity.entity_code == code).first() is not None:
            suffix += 1
            code = f"{DEFAULT_ENTITY_CODE}{suffix}"
        values["entity_code"] = code

        entity = SellerLegalEntity(
            organization_id=organization_id, is_default=True, is_active=True,
            created_by=created_by, **values,
        )
        try:
            with self.db.begin_nested():
                self.db.add(entity)
                self.db.flush()
        except IntegrityError:
            # Lost a race with a concurrent bootstrap for the same org; the
            # partial unique index guarantees the winner is the only default.
            winner = self.get_default_entity(organization_id)
            if winner is None:
                raise
            return winner
        self.audit.log_no_commit(
            organization_id, created_by, BillingAuditAction.CREATE, "SellerLegalEntity", entity.id,
            new_values={"entity_code": entity.entity_code, "source": "organization_profile_bootstrap"},
        )
        return entity

    def resolve_issuing_entity(self, organization_id: int, entity_id: Optional[int] = None) -> SellerLegalEntity:
        """The entity an invoice is issued by: the explicit one (validated as
        this tenant's and active) or the org default."""
        if entity_id is None:
            return self.ensure_default_entity(organization_id)
        entity = self.get_entity(entity_id, organization_id)
        if not entity.is_active:
            raise BadRequestException("Seller legal entity is inactive and cannot issue invoices.")
        return entity

    # ── Mutations ────────────────────────────────────────────────────────

    def _guard_regime(self, data: Dict[str, Any]) -> None:
        if data.get("tax_regime") == EntityTaxRegime.GOVERNED:
            raise BadRequestException(
                "The governed tax regime cannot be enabled from settings. It requires an approved, "
                "effective jurisdiction activation backed by a published rule pack or approved tenant "
                "configuration (ZB-TAX-ARCH-001 §05, §13.2): request it with "
                "POST /api/v1/tax/legal-entities/{id}/regime after checking .../regime-eligibility."
            )

    def create_entity(self, organization_id: int, created_by: int, **data: Any) -> SellerLegalEntity:
        make_default = bool(data.pop("is_default", False))
        data = _normalize(data)
        self._guard_regime(data)
        if not data.get("entity_code") or not data.get("legal_name"):
            raise BadRequestException("entity_code and legal_name are required.")
        if self._query(organization_id).filter(SellerLegalEntity.entity_code == data["entity_code"]).first():
            raise AlreadyExistsException("SellerLegalEntity", "entity_code")

        # Guarantee the org has its bootstrap default before adding siblings.
        current_default = self.ensure_default_entity(organization_id, created_by)
        if make_default:
            current_default.is_default = False
            self.db.flush()
        entity = SellerLegalEntity(
            organization_id=organization_id, created_by=created_by,
            is_default=make_default, is_active=True, **data,
        )
        self.db.add(entity)
        self.db.flush()
        self.audit.log_no_commit(
            organization_id, created_by, BillingAuditAction.CREATE, "SellerLegalEntity", entity.id,
            new_values={k: (v.value if hasattr(v, "value") else v) for k, v in data.items()},
        )
        self.db.commit()
        self.db.refresh(entity)
        return entity

    def update_entity(
        self, entity_id: int, organization_id: int, updated_by: int,
        expected_version: Optional[int] = None, **data: Any,
    ) -> SellerLegalEntity:
        data.pop("is_default", None)  # default switching has its own endpoint
        data = _normalize(data)
        self._guard_regime(data)
        entity = self.get_entity(entity_id, organization_id)
        if expected_version is not None and entity.version != expected_version:
            raise BadRequestException("This legal entity was modified by someone else. Reload and try again.")

        changed = {k: v for k, v in data.items() if getattr(entity, k) != v}
        if not changed:
            return entity
        locked = JURISDICTION_LOCKED_FIELDS & changed.keys()
        if locked and self.has_issued_invoices(entity_id, organization_id):
            raise BadRequestException(
                f"Cannot change {', '.join(sorted(locked))} on an entity that has issued invoices; "
                "doing so would re-attribute historical tax obligations. Register a new legal entity instead."
            )
        if "entity_code" in changed and self._query(organization_id).filter(
            SellerLegalEntity.entity_code == changed["entity_code"], SellerLegalEntity.id != entity_id,
        ).first():
            raise AlreadyExistsException("SellerLegalEntity", "entity_code")

        old = {k: getattr(entity, k) for k in changed}
        for k, v in changed.items():
            setattr(entity, k, v)
        entity.updated_by = updated_by
        entity.version = (entity.version or 1) + 1
        self.audit.log_no_commit(
            organization_id, updated_by, BillingAuditAction.UPDATE, "SellerLegalEntity", entity_id,
            old_values={k: (v.value if hasattr(v, "value") else v) for k, v in old.items()},
            new_values={k: (v.value if hasattr(v, "value") else v) for k, v in changed.items()},
        )
        self.db.commit()
        self.db.refresh(entity)
        return entity

    def set_default(self, entity_id: int, organization_id: int, updated_by: int) -> SellerLegalEntity:
        entity = self.get_entity(entity_id, organization_id)
        if not entity.is_active:
            raise BadRequestException("An inactive entity cannot be the default.")
        if entity.is_default:
            return entity
        current = self.get_default_entity(organization_id)
        if current is not None:
            current.is_default = False
            self.db.flush()  # release the partial unique index first
        entity.is_default = True
        entity.updated_by = updated_by
        self.audit.log_no_commit(
            organization_id, updated_by, BillingAuditAction.UPDATE, "SellerLegalEntity", entity_id,
            new_values={"is_default": True, "previous_default_id": current.id if current else None},
        )
        self.db.commit()
        self.db.refresh(entity)
        return entity

    def deactivate(self, entity_id: int, organization_id: int, updated_by: int) -> SellerLegalEntity:
        entity = self.get_entity(entity_id, organization_id)
        if entity.is_default:
            raise BadRequestException("The default legal entity cannot be deactivated. Set another default first.")
        entity.is_active = False
        entity.updated_by = updated_by
        self.audit.log_no_commit(
            organization_id, updated_by, BillingAuditAction.DELETE, "SellerLegalEntity", entity_id,
        )
        self.db.commit()
        self.db.refresh(entity)
        return entity
