from types import SimpleNamespace
from typing import Any, Dict, Optional

from app.modules.billing.models import BillingConfiguration
from app.modules.billing.repositories.base import BaseRepository


# Columns required by the READ-ONLY currency/FX resolution path. These are
# selected explicitly (never SELECT *) so unrelated configuration columns —
# e.g. a drifted/missing column — cannot abort the transaction and take down
# every currency-labelled answer.
_CURRENCY_VIEW_COLUMNS = (
    "base_currency",
    "default_currency",
    "exchange_rates",
    "exchange_rate_last_refreshed",
    "exchange_rate_base_currency",
    "exchange_rate_usd",
    "exchange_rate_inr",
    "exchange_rate_gbp",
    "exchange_rate_eur",
    "exchange_rate_aed",
)


class BillingConfigurationRepository(BaseRepository[BillingConfiguration]):
    def __init__(self, db):
        super().__init__(db, BillingConfiguration)

    def get_by_organization(self, organization_id: int) -> Optional[BillingConfiguration]:
        return self.db.query(BillingConfiguration).filter(
            BillingConfiguration.organization_id == organization_id,
        ).first()

    def get_currency_view(self, organization_id: int) -> Optional[SimpleNamespace]:
        """Load only the currency/FX columns for the org's billing configuration.

        The currency-resolution path (base currency, cached FX rates, rate
        staleness) must not depend on the rest of the BillingConfiguration
        schema. Loading the full ORM entity couples it to every column, so a
        single drifted column aborts the transaction and fails every
        currency-labelled answer. This projected read touches only the columns
        the path actually uses and returns a lightweight namespace (or None
        when no configuration row exists)."""
        row = (
            self.db.query(*[getattr(BillingConfiguration, c) for c in _CURRENCY_VIEW_COLUMNS])
            .filter(BillingConfiguration.organization_id == organization_id)
            .first()
        )
        if row is None:
            return None
        return SimpleNamespace(
            organization_id=organization_id,
            **dict(zip(_CURRENCY_VIEW_COLUMNS, row)),
        )

    def _apply(self, obj: BillingConfiguration, **data: Any) -> BillingConfiguration:
        """Set fields AND bump the optimistic-lock version in the same
        transaction. Explicit, not an ORM `onupdate` hook — so a future bulk
        `Query.update()` or raw-SQL path can never silently skip the bump.
        `version` itself is never settable through this helper."""
        for field, value in data.items():
            if hasattr(obj, field) and field != "version":
                setattr(obj, field, value)
        obj.version = (obj.version or 0) + 1
        return obj

    def upsert(self, organization_id: int, updated_by: Optional[int] = None, **data: Any) -> BillingConfiguration:
        existing = self.get_by_organization(organization_id)
        if existing:
            self._apply(existing, **data)
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
