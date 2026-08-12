from typing import Any, Dict, Optional

from app.modules.billing.models import BillingConfiguration
from app.modules.billing.repositories.base import BaseRepository


class BillingConfigurationRepository(BaseRepository[BillingConfiguration]):
    def __init__(self, db):
        super().__init__(db, BillingConfiguration)

    def get_by_organization(self, organization_id: int) -> Optional[BillingConfiguration]:
        return self.db.query(BillingConfiguration).filter(
            BillingConfiguration.organization_id == organization_id,
        ).first()

    def upsert(self, organization_id: int, updated_by: Optional[int] = None, **data: Any) -> BillingConfiguration:
        existing = self.get_by_organization(organization_id)
        if existing:
            for field, value in data.items():
                if hasattr(existing, field):
                    setattr(existing, field, value)
            if updated_by is not None:
                existing.updated_by = updated_by
            self.db.commit()
            self.db.refresh(existing)
            return existing
        config = self.create(
            organization_id,
            created_by=updated_by,
            updated_by=updated_by,
            **data,
        )
        return config

    def reset_to_defaults(self, organization_id: int, updated_by: Optional[int] = None, **defaults: Any) -> BillingConfiguration:
        existing = self.get_by_organization(organization_id)
        if existing:
            self.db.delete(existing)
            self.db.flush()
        data = dict(defaults)
        if updated_by is not None:
            data["updated_by"] = updated_by
        config = self.create(organization_id, **data)
        return config

    # NOTE: validate() was removed here (Phase 2, dead code) — it had zero
    # callers. BillingConfigurationService.validate_configuration() is the
    # live validation path used by the API (settings_router.py) and has its
    # own, more complete field validation; this repository-level duplicate
    # was never wired to it.

    # NOTE: BillingSettingRepository (and the BillingSetting model/table it
    # wrapped) was removed here (Phase 2, dead code) — BillingSettingsService,
    # its only caller, was never instantiated anywhere in the codebase (no
    # router, service, or task constructed it). BillingConfigurationService
    # is the sole live configuration layer; the billing_settings table and
    # BillingSetting model are left untouched (schema preserved) in case of
    # any external/manual dependency on the table itself.
