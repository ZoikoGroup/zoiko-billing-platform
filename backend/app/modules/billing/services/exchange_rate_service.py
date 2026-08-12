"""
modules/billing/services/exchange_rate_service.py
-------------------------------------------------
Live exchange rate service using ExchangeRate-API (open.er-api.com).
Provider-agnostic architecture with fallback chain:
  1. Live API → 2. Billing Configuration cached rates → 3. Block invoice with error
"""

import logging
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException
from app.modules.billing.models import BillingConfiguration, ExchangeRateProvider
from app.modules.billing.repositories.settings import BillingConfigurationRepository

logger = logging.getLogger("zoiko")

OPEN_ER_API_BASE = "https://open.er-api.com/v6/latest"
REQUEST_TIMEOUT = 10

# Exchange rate freshness: rates older than this trigger a live refresh attempt
EXCHANGE_RATE_MAX_AGE_HOURS = 24  # 24 hours


class ExchangeRateService:
    """
    Fetches live exchange rates and caches them in BillingConfiguration.
    Falls back to stored rates if the live API is unreachable.
    """

    def __init__(self, db: Session):
        self.db = db
        self.repo = BillingConfigurationRepository(db)

    def is_rate_stale(self, organization_id: int) -> bool:
        """Check if cached exchange rates are older than the freshness threshold."""
        config = self.repo.get_by_organization(organization_id)
        if not config or not config.exchange_rate_last_refreshed:
            return True
        last_refreshed = config.exchange_rate_last_refreshed
        if last_refreshed.tzinfo is None:
            last_refreshed = last_refreshed.replace(tzinfo=timezone.utc)
        age = datetime.now(timezone.utc) - last_refreshed
        return age.total_seconds() > EXCHANGE_RATE_MAX_AGE_HOURS * 3600

    # ── Public API ────────────────────────────────────────────────────────

    def get_rate(
        self,
        organization_id: int,
        from_currency: str,
        to_currency: str,
    ) -> Tuple[Decimal, str, datetime]:
        """
        Get exchange rate from one currency to another.
        Returns (rate, source, timestamp).

        Source will be one of: "live_api", "cached", "manual".
        Raises BadRequestException if no rate is available.
        """
        from_currency = (from_currency or "").upper().strip()
        to_currency = (to_currency or "").upper().strip()

        if from_currency == to_currency:
            return Decimal("1"), "self", datetime.now(timezone.utc)

        config = self.repo.get_by_organization(organization_id)
        if not config:
            raise BadRequestException(
                "No billing configuration found. Please configure billing settings first."
            )

        # If cached rates are fresh, use them directly — skip the live API call
        if not self.is_rate_stale(organization_id):
            rate, source, ts = self._get_cached_rate(config, from_currency, to_currency)
            if rate is not None:
                return rate, source, ts

        # Fallback: try live API (cached stale or missing)
        rate, source, ts = self._fetch_live_rate(config, from_currency, to_currency)
        if rate is not None:
            return rate, source, ts

        # Fallback: use cached rates from BillingConfiguration
        rate, source, ts = self._get_cached_rate(config, from_currency, to_currency)
        if rate is not None:
            return rate, source, ts

        # Fallback: legacy hardcoded fields
        rate, source, ts = self._get_legacy_rate(config, from_currency, to_currency)
        if rate is not None:
            return rate, source, ts

        raise BadRequestException(
            f"Exchange rate not available for {from_currency} → {to_currency}. "
            "Please refresh exchange rates in Billing Settings or configure manual rates."
        )

    def refresh_rates(self, organization_id: int, base_currency: Optional[str] = None) -> Dict[str, Any]:
        """
        Fetch latest rates from the live API and cache them.
        Returns dict with the fetched rates and metadata.
        """
        config = self.repo.get_by_organization(organization_id)
        if not config:
            raise BadRequestException("No billing configuration found.")

        base = (base_currency or config.base_currency or "USD").upper()
        rates, metadata = self._fetch_all_rates(base)

        if not rates:
            raise BadRequestException(
                "Unable to fetch live exchange rates. "
                "Please check your network connection and try again."
            )

        # Cache rates in BillingConfiguration
        cached_rates = dict(config.exchange_rates) if config.exchange_rates else {}
        cached_rates.update(rates)
        config.exchange_rates = cached_rates
        config.exchange_rate_last_refreshed = datetime.now(timezone.utc)
        if base_currency:
            config.exchange_rate_base_currency = base
        self.db.commit()
        self.db.refresh(config)

        # Also update legacy fields for backward compatibility
        self._update_legacy_fields(config, rates)

        return {
            "base_currency": base,
            "rates": rates,
            "count": len(rates),
            "timestamp": config.exchange_rate_last_refreshed.isoformat(),
            "source": "live_api",
        }

    def get_cached_rates(self, organization_id: int) -> Dict[str, Any]:
        """Return all cached exchange rates for an organization."""
        config = self.repo.get_by_organization(organization_id)
        if not config:
            return {"rates": {}, "base_currency": "USD", "last_refreshed": None}

        rates = dict(config.exchange_rates) if config.exchange_rates else {}

        # Merge legacy fields if no cached rates
        if not rates:
            legacy = self._extract_legacy_rates(config)
            if legacy:
                rates = legacy

        if config.exchange_rate_last_refreshed:
            last = config.exchange_rate_last_refreshed
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            staleness_hours = (datetime.now(timezone.utc) - last).total_seconds() / 3600
            is_stale = staleness_hours > EXCHANGE_RATE_MAX_AGE_HOURS
        else:
            staleness_hours = None
            is_stale = True

        return {
            "base_currency": config.exchange_rate_base_currency or (
                config.base_currency.value if hasattr(config.base_currency, 'value')
                else str(config.base_currency or "USD")
            ),
            "rates": rates,
            "last_refreshed": (
                config.exchange_rate_last_refreshed.isoformat()
                if config.exchange_rate_last_refreshed else None
            ),
            "auto_refresh": bool(config.exchange_rate_auto_refresh),
            "staleness_hours": staleness_hours,
            "is_stale": is_stale,
        }

    def get_supported_currencies(self) -> List[str]:
        """Return list of currencies supported by the API."""
        return [
            "AED", "ARS", "AUD", "BRL", "CAD", "CHF", "CLP", "CNY",
            "COP", "CZK", "DKK", "EGP", "EUR", "GBP", "HKD", "HUF",
            "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "KWD", "MYR",
            "MXN", "NGN", "NOK", "NZD", "PHP", "PKR", "PLN", "QAR",
            "RON", "RUB", "SAR", "SEK", "SGD", "THB", "TRY", "TWD",
            "USD", "VND", "ZAR",
        ]

    def get_rate_for_new_transaction(
        self, organization_id: int, from_currency: str, to_currency: str,
    ) -> Tuple[Decimal, str, datetime]:
        """
        Get exchange rate for a NEW transaction.
        If cached rates are stale, attempts a live refresh first.
        Falls back to cached rates if refresh fails.
        """
        if self.is_rate_stale(organization_id):
            logger.info("Exchange rates stale for org %d, attempting refresh", organization_id)
            try:
                self.refresh_rates(organization_id)
            except Exception as e:
                logger.warning("Auto-refresh failed for org %d: %s", organization_id, e)
        return self.get_rate(organization_id, from_currency, to_currency)

    # ── Private Helpers ───────────────────────────────────────────────────

    def _fetch_live_rate(
        self,
        config: BillingConfiguration,
        from_currency: str,
        to_currency: str,
    ) -> Tuple[Optional[Decimal], Optional[str], Optional[datetime]]:
        """Attempt to fetch a live rate from the API."""
        provider = config.exchange_rate_provider
        if isinstance(provider, ExchangeRateProvider):
            provider = provider.value

        if provider and provider != ExchangeRateProvider.OPEN_ER_API.value:
            logger.debug("Provider %s does not support live fetch, skipping", provider)
            return None, None, None

        try:
            base = (config.exchange_rate_base_currency or "USD").upper()
            url = f"{OPEN_ER_API_BASE}/{base}"
            with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
                resp = client.get(url)
                resp.raise_for_status()
                data = resp.json()

            if data.get("result") != "success":
                logger.warning("open.er-api.com returned result=%s", data.get("result"))
                return None, None, None

            api_rates = data.get("rates", {})
            now = datetime.now(timezone.utc)

            # Build rate from base → from_currency and base → to_currency
            from_rate_raw = api_rates.get(from_currency)
            to_rate_raw = api_rates.get(to_currency)

            if from_rate_raw is None or to_rate_raw is None:
                return None, None, None

            from_rate = Decimal(str(from_rate_raw))
            to_rate = Decimal(str(to_rate_raw))

            if from_rate == 0:
                return None, None, None

            rate = (to_rate / from_rate).quantize(Decimal("0.000001"))

            # Cache all rates for future lookups (store as float for JSON serialization)
            cached_rates = dict(config.exchange_rates) if config.exchange_rates else {}
            for code, val in api_rates.items():
                try:
                    cached_rates[code] = float(Decimal(str(val)))
                except (InvalidOperation, TypeError, ValueError):
                    pass
            config.exchange_rates = cached_rates
            config.exchange_rate_last_refreshed = now
            config.exchange_rate_base_currency = base
            self.db.commit()

            # Update legacy fields
            self._update_legacy_fields(config, api_rates)

            logger.info(
                "Live rate fetched: %s→%s = %s (base=%s)",
                from_currency, to_currency, rate, base,
            )
            return rate, "live_api", now

        except httpx.HTTPError as e:
            logger.warning("HTTP error fetching live rate: %s", e)
            return None, None, None
        except Exception as e:
            logger.warning("Unexpected error fetching live rate: %s", e)
            return None, None, None

    def _get_cached_rate(
        self,
        config: BillingConfiguration,
        from_currency: str,
        to_currency: str,
    ) -> Tuple[Optional[Decimal], Optional[str], Optional[datetime]]:
        """Get rate from cached exchange_rates JSON field."""
        cached = config.exchange_rates
        if not cached or not isinstance(cached, dict):
            return None, None, None

        from_rate = cached.get(from_currency)
        to_rate = cached.get(to_currency)

        if from_rate is None or to_rate is None:
            return None, None, None

        try:
            from_rate = Decimal(str(from_rate))
            to_rate = Decimal(str(to_rate))
        except (InvalidOperation, TypeError):
            return None, None, None

        if from_rate == 0:
            return None, None, None

        rate = (to_rate / from_rate).quantize(Decimal("0.000001"))
        ts = config.exchange_rate_last_refreshed or datetime.now(timezone.utc)

        # Log staleness warning for monitoring
        if config.exchange_rate_last_refreshed:
            last = config.exchange_rate_last_refreshed
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            age_hours = (datetime.now(timezone.utc) - last).total_seconds() / 3600
            if age_hours > EXCHANGE_RATE_MAX_AGE_HOURS:
                logger.warning(
                    "Exchange rates for org %d are stale (%.1f hours old, max %d). "
                    "Consider refreshing via Billing Settings.",
                    getattr(config, 'organization_id', 0), age_hours, EXCHANGE_RATE_MAX_AGE_HOURS
                )

        return rate, "cached", ts

    def _get_legacy_rate(
        self,
        config: BillingConfiguration,
        from_currency: str,
        to_currency: str,
    ) -> Tuple[Optional[Decimal], Optional[str], Optional[datetime]]:
        """Get rate from legacy hardcoded fields on BillingConfiguration."""
        rate_map = {
            "USD": config.exchange_rate_usd,
            "INR": config.exchange_rate_inr,
            "GBP": config.exchange_rate_gbp,
            "EUR": config.exchange_rate_eur,
            "AED": config.exchange_rate_aed,
        }

        from_rate = rate_map.get(from_currency)
        to_rate = rate_map.get(to_currency)

        if from_rate is None or to_rate is None:
            return None, None, None

        try:
            from_rate = Decimal(str(from_rate))
            to_rate = Decimal(str(to_rate))
        except (InvalidOperation, TypeError):
            return None, None, None

        if from_rate == 0:
            return None, None, None

        rate = (to_rate / from_rate).quantize(Decimal("0.000001"))
        ts = config.exchange_rate_updated_at or datetime.now(timezone.utc)
        return rate, "manual", ts

    def _fetch_all_rates(self, base_currency: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """Fetch all rates from the API for a given base currency."""
        try:
            url = f"{OPEN_ER_API_BASE}/{base_currency}"
            with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
                resp = client.get(url)
                resp.raise_for_status()
                data = resp.json()

            if data.get("result") != "success":
                return {}, {"error": data.get("error-type", "unknown")}

            return data.get("rates", {}), {
                "base": data.get("base_code"),
                "time_last_update_utc": data.get("time_last_update_utc"),
            }
        except httpx.HTTPError as e:
            logger.error("HTTP error fetching all rates: %s", e)
            return {}, {"error": str(e)}
        except Exception as e:
            logger.error("Unexpected error fetching all rates: %s", e)
            return {}, {"error": str(e)}

    def _update_legacy_fields(self, config: BillingConfiguration, rates: Dict[str, Any]) -> None:
        """Update legacy exchange_rate_* fields for backward compatibility."""
        legacy_map = {
            "USD": "exchange_rate_usd",
            "INR": "exchange_rate_inr",
            "GBP": "exchange_rate_gbp",
            "EUR": "exchange_rate_eur",
            "AED": "exchange_rate_aed",
        }
        updated = False
        for code, field in legacy_map.items():
            val = rates.get(code)
            if val is not None:
                try:
                    decimal_val = Decimal(str(val))
                    if getattr(config, field, None) != decimal_val:
                        setattr(config, field, decimal_val)
                        updated = True
                except (InvalidOperation, TypeError):
                    pass
        if updated:
            config.exchange_rate_updated_at = datetime.now(timezone.utc)
            self.db.commit()

    def _extract_legacy_rates(self, config: BillingConfiguration) -> Dict[str, Decimal]:
        """Extract rates from legacy fields into a dict."""
        rates = {}
        for code, field in [
            ("USD", "exchange_rate_usd"),
            ("INR", "exchange_rate_inr"),
            ("GBP", "exchange_rate_gbp"),
            ("EUR", "exchange_rate_eur"),
            ("AED", "exchange_rate_aed"),
        ]:
            val = getattr(config, field, None)
            if val is not None:
                try:
                    rates[code] = Decimal(str(val))
                except (InvalidOperation, TypeError):
                    pass
        return rates
