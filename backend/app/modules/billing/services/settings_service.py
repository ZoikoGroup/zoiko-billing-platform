import logging
import re
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.billing.models import (
    BillingAuditAction, BillingConfiguration, CurrencyCode,
    CurrencySymbolPosition, DateFormat, DraftBehaviour,
    ExchangeRateProvider, InvoiceTemplate, NumberFormat, PaymentTerm,
    RecognizedRevenueMethod, RevenueRecognitionMethod, RoundingMethod,
    SequenceReset, TaxCalculationMethod, TaxRoundingMethod,
)
from app.modules.billing.repositories.settings import BillingConfigurationRepository
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.utils.currency_utils import get_currency_symbol, validate_currency_code, validate_language_code

logger = logging.getLogger("zoiko_billing")


def validate_email(email: Optional[str]) -> Optional[str]:
    if not email:
        return None
    pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
    if not re.match(pattern, email):
        return "Invalid email format"
    return None


def validate_phone(phone: Optional[str]) -> Optional[str]:
    if not phone:
        return None
    cleaned = re.sub(r"[\s\-\+\(\)]", "", phone)
    if not cleaned.isdigit() or len(cleaned) < 7 or len(cleaned) > 15:
        return "Invalid phone number format"
    return None


def validate_website(website: Optional[str]) -> Optional[str]:
    if not website:
        return None
    pattern = r"^https?:\/\/([\w\-]+\.)+[\w\-]+(\/[\w\-\.~:/?#\[\]@!$&'\(\)\*\+,;=]*)?$"
    if not re.match(pattern, website):
        return "Invalid website URL format"
    return None


def validate_gst(gst: Optional[str]) -> Optional[str]:
    if not gst:
        return None
    pattern = r"^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$"
    if not re.match(pattern, gst):
        return "Invalid GST number format"
    return None


def validate_vat(vat: Optional[str]) -> Optional[str]:
    if not vat:
        return None
    if len(vat) < 4 or len(vat) > 20:
        return "Invalid VAT number format"
    return None


def validate_fiscal_year(fy: Optional[str]) -> Optional[str]:
    if not fy:
        return None
    pattern = r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"
    if not re.match(pattern, fy):
        return "Fiscal year must be in MM-DD format"
    return None


def validate_invoice_prefix(prefix: Optional[str]) -> Optional[str]:
    if not prefix:
        return None
    if len(prefix) > 10:
        return "Invoice prefix must be 10 characters or less"
    if not re.match(r"^[A-Za-z0-9\-_]+$", prefix):
        return "Invoice prefix must contain only letters, numbers, hyphens, and underscores"
    return None


CONFIGURATION_DEFAULTS = {
    "default_currency": CurrencyCode.USD,
    "home_currency": CurrencyCode.USD,
    "base_currency": CurrencyCode.USD,
    "supported_currencies": ["USD"],
    "date_format": DateFormat.DD_MM_YYYY,
    "timezone": "UTC",
    "language": "en",
    "fiscal_year_start": "01-01",
    "fiscal_year_end": "12-31",
    "currency_precision": 2,
    "currency_symbol_position": CurrencySymbolPosition.BEFORE,
    "invoice_prefix": "INV-",
    "invoice_number_format": NumberFormat.PREFIX_YYYY_SEQ,
    "invoice_sequence_reset": SequenceReset.ANNUALLY,
    "quote_prefix": "QTE-",
    "quote_number_format": NumberFormat.PREFIX_YYYY_SEQ,
    "quote_sequence_reset": SequenceReset.ANNUALLY,
    "credit_note_prefix": "CN-",
    "credit_note_number_format": NumberFormat.PREFIX_YYYY_SEQ,
    "credit_note_sequence_reset": SequenceReset.ANNUALLY,
    "refund_prefix": "RF-",
    "refund_number_format": NumberFormat.PREFIX_YYYY_SEQ,
    "refund_sequence_reset": SequenceReset.ANNUALLY,
    "write_off_prefix": "WO-",
    "write_off_number_format": NumberFormat.PREFIX_YYYY_SEQ,
    "write_off_sequence_reset": SequenceReset.ANNUALLY,
    "auto_generate_invoice_number": True,
    "invoice_template": InvoiceTemplate.STANDARD,
    "invoice_pdf_template": "standard",
    "draft_behaviour": DraftBehaviour.SAVE_AS_DRAFT,
    "show_tax_breakdown": True,
    "show_discount": True,
    "show_shipping": False,
    "default_due_days": 30,
    "payment_reminder_days_before": 3,
    "late_payment_fee_percentage": 0,
    "late_payment_fee_flat": 0,
    "default_payment_terms": PaymentTerm.NET_30,
    "payment_term_options": ["net_30", "net_15", "net_7", "due_on_receipt"],
    "supported_payment_methods": ["credit_card", "bank_transfer", "paypal"],
    "auto_send_receipts": True,
    "exchange_rate_provider": ExchangeRateProvider.OPEN_ER_API,
    "exchange_rate_auto_update": False,
    "exchange_rate_usd": Decimal("1.000000"),
    "exchange_rate_inr": Decimal("83.000000"),
    "exchange_rate_gbp": Decimal("0.790000"),
    "exchange_rate_eur": Decimal("0.920000"),
    "exchange_rate_aed": Decimal("3.670000"),
    "exchange_rates": None,
    "exchange_rate_base_currency": "USD",
    "exchange_rate_last_refreshed": None,
    "exchange_rate_auto_refresh": False,
    "rounding_method": RoundingMethod.HALF_UP,
    "rounding_precision": 2,
    "gateway_stripe_enabled": False,
    "gateway_razorpay_enabled": False,
    "gateway_paypal_enabled": True,
    "gateway_cash_enabled": True,
    "gateway_bank_transfer_enabled": True,
    "gateway_upi_enabled": False,
    "gateway_offline_enabled": True,
    "auto_capture_enabled": True,
    "grace_period_days": 0,
    "credit_limit": 0,
    "tax_calculation_method": TaxCalculationMethod.EXCLUSIVE,
    "tax_label": "VAT",
    "is_tax_inclusive_default": False,
    "show_tax_on_invoice": True,
    "enable_auto_tax_calculation": False,
    "gst_enabled": False,
    "sales_tax_enabled": False,
    "service_tax_enabled": False,
    "withholding_tax_enabled": False,
    "reverse_charge_enabled": False,
    "compound_tax_enabled": False,
    "tax_rounding_method": TaxRoundingMethod.PER_LINE,
    "auto_dunning": False,
    "dunning_level_count": 4,
    "dunning_wait_days": 3,
    "dunning_action_types": ["email_reminder"],
    "enable_escalation_to_collections": False,
    "collections_wait_days": 30,
    "reminder_sms_enabled": False,
    "reminder_whatsapp_enabled": False,
    "auto_suspend_enabled": False,
    "grace_days": 0,
    "enable_revenue_recognition": False,
    "revenue_recognition_method": RevenueRecognitionMethod.IMMEDIATE,
    "revenue_recognition_deferral_days": 0,
    "recognized_revenue_method": RecognizedRevenueMethod.ACCRUAL,
    "recognition_frequency": "monthly",
    "enable_multi_currency": False,
    "enable_approval_workflow": False,
    "enable_credit_notes": True,
    "enable_discounts": True,
    "enable_retainers": False,
    "enable_schedule_invoicing": False,
    "enable_partial_payments": True,
    "enable_auto_apply_credits": True,
    "enable_quotes": True,
    "enable_contracts": True,
    "enable_usage_billing": False,
    "enable_refunds": True,
    "enable_auto_taxes": False,
    "enable_audit_logs": True,
    "notify_invoice_created": True,
    "notify_invoice_sent": True,
    "notify_invoice_paid": True,
    "notify_invoice_overdue": True,
    "notify_subscription_renewed": True,
    "notify_subscription_cancelled": True,
    "notify_payment_failed": True,
    "notify_payment_success": True,
    "notify_customer_created": False,
    "tax_profiles": [],
    "tax_regions": [],
    "tax_categories": [],
    "hsn_sac_codes": [],
    "email_templates": {},
    "sms_templates": {},
    "notification_preferences": {},
    "security_settings": {},
    "retry_rules": {"max_retries": 3, "retry_interval_hours": 24},
    "refund_settings": {"auto_approve": False, "refund_window_days": 30, "require_reason": True},
    "reminder_schedule": {"before_due": [3, 1], "after_due": [0, 3, 7, 14, 30]},
    "penalty_settings": {"type": "percentage", "value": 0, "max_cap": None},
    "interest_settings": {"annual_rate": 0, "compounding": "simple", "waive_first_x_days": 0},
    "gst_settings": {},
    "vat_settings": {},
    "sales_tax_settings": {},
    "service_tax_settings": {},
    "withholding_tax_settings": {},
    "reverse_charge_settings": {},
    "compound_tax_settings": {},
    "revenue_accounts": {"deferred_revenue": None, "recognized_revenue": None, "contract_asset": None},
    "recognition_schedule": [],
    "product_numbering_prefix": "PROD-",
    "product_numbering_format": "{PREFIX}{NUMBER}",
    "default_product_currency": "USD",
    "default_category_id": None,
    "default_tax_rate": None,
    "max_discount_percentage": None,
    "usage_billing_unit": "unit",
    "usage_billing_rounding": "nearest",
    "auto_archive_days": None,
    "product_visibility": "visible",
    "require_sku": "no",
}


class BillingConfigurationService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = BillingConfigurationRepository(db)
        self.audit = BillingAuditService(db)

    def get_configuration(self, organization_id: int) -> BillingConfiguration:
        logger.info("Getting billing configuration for organization_id=%s", organization_id)
        config = self.repo.get_by_organization(organization_id)
        if not config:
            logger.info("No configuration found for organization_id=%s, seeding from organization", organization_id)
            config = self.seed_billing_configuration(organization_id)
            # Persist now: the API layer's get_db() never commits on its own, so
            # the lazily-created config must be committed here (same behavior as
            # the previous repo.create() path, which also committed internally).
            self.db.commit()
            logger.info("Seeded configuration for organization_id=%s, config_id=%s", organization_id, config.id)
        return config

    def seed_billing_configuration(self, organization_id: int) -> BillingConfiguration:
        """Idempotently initialize a BillingConfiguration from the Organization's
        identity fields (PHASE 4). Never overwrites an existing configuration —
        existing tenants are returned untouched. Operational fields that the
        Organization does not own come from CONFIGURATION_DEFAULTS.

        Does NOT commit: the caller owns the transaction. During registration the
        config is flushed inside the same transaction as org + user (all-or-
        nothing); get_configuration() commits explicitly for the lazy backstop.
        """
        existing = self.repo.get_by_organization(organization_id)
        if existing:
            logger.info("BillingConfiguration already exists for organization_id=%s, leaving unchanged", organization_id)
            return existing

        from app.modules.organizations.models import Organization

        org = self.db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise NotFoundException("Organization", "id")

        data = dict(CONFIGURATION_DEFAULTS)
        data["company_name"] = org.organization_name
        data["billing_email"] = org.email
        data["billing_phone"] = self._clamp(org.phone, 30, "billing_phone")
        data["website"] = org.website
        data["address_line1"] = self._clamp(org.address, 255, "address_line1")
        data["city"] = org.city
        data["state"] = org.state
        data["country"] = org.country
        data["postal_code"] = org.postal_code
        data["timezone"] = org.timezone or "UTC"
        data["fiscal_year_start"] = org.fiscal_year_start or "01-01"
        data["fiscal_year_end"] = org.fiscal_year_end or "12-31"

        # Country-appropriate date format (e.g. US -> MM-DD-YYYY) instead of
        # always leaving CONFIGURATION_DEFAULTS' DD-MM-YYYY, which is only
        # correct for most-but-not-all registration countries.
        from app.modules.auth.country_currency import get_default_date_format_for_country
        date_format_str = get_default_date_format_for_country(org.country)
        if date_format_str:
            try:
                data["date_format"] = DateFormat(date_format_str)
            except ValueError:
                pass
        # Generic tax number -> generic tax_number field. Organization.tax_no is
        # a single field covering GST/PAN/VAT/TIN with no type semantics, so it
        # must NOT be copied into gst_number/vat_number/pan_number/tin_number.
        data["tax_number"] = org.tax_no
        data["business_registration_number"] = org.registration_number

        if org.currency:
            currency_str = org.currency.strip().upper()
            try:
                currency = CurrencyCode(currency_str)
            except ValueError:
                currency = None
                logger.warning(
                    "Organization %s currency %r is not supported by CurrencyCode; "
                    "keeping CONFIGURATION_DEFAULTS currency (USD)",
                    organization_id, org.currency,
                )
            if currency is not None:
                # get_default_currency() prefers base_currency over default_currency,
                # so all three are kept in sync or the seeded currency would be ignored.
                data["default_currency"] = currency
                data["home_currency"] = currency
                data["base_currency"] = currency
                # Mirror organizations/router.py's currency-update path: the org's
                # own currency must always be a supported currency, or a fresh
                # non-USD org seeds with its base currency missing from
                # supported_currencies (CONFIGURATION_DEFAULTS is USD-only).
                supported = list(data.get("supported_currencies") or [])
                if currency_str not in supported:
                    supported.append(currency_str)
                    data["supported_currencies"] = supported

                # Derive tax_label/tax_id_label from the registration
                # country's tax profile (country_tax_profiles.py) when this
                # country is covered -- this is the precise, country-aware
                # source ("GST"/"VAT"/"Sales Tax"/"Consumption Tax" plus the
                # actual tax-identifier name like "GSTIN"), and correctly
                # distinguishes countries that share a currency (France vs.
                # Germany, both EUR). Falls back to deriving tax_label from
                # the starter tax catalogue by currency alone (the older,
                # coarser behavior) when the country isn't covered yet, and
                # to CONFIGURATION_DEFAULTS' generic "VAT" when neither is.
                from app.modules.billing.utils.country_tax_profiles import get_country_tax_profile
                tax_profile = get_country_tax_profile(org.country)
                if tax_profile is not None:
                    data["tax_label"] = tax_profile.tax_system
                    data["tax_id_label"] = tax_profile.tax_id_label
                else:
                    from app.modules.billing.utils.tax_catalogue import get_catalogue_entries_for_currency
                    catalogue_entries = get_catalogue_entries_for_currency(currency_str)
                    if catalogue_entries:
                        data["tax_label"] = catalogue_entries[0].tax_type.value.upper()

        config = BillingConfiguration(organization_id=organization_id, **data)
        self.db.add(config)
        self.db.flush()
        logger.info("Seeded billing configuration for organization_id=%s (config_id=%s)", organization_id, config.id)
        return config

    @staticmethod
    def _clamp(value, limit: int, field_name: str):
        """Defensive truncation to a column's max length so an over-long
        Organization value cannot fail the seed (and with it registration)."""
        if value is None or len(value) <= limit:
            return value
        logger.warning(
            "Truncating Organization value for %s to %s characters during billing configuration seed",
            field_name, limit,
        )
        return value[:limit]

    def _validate_config_data(self, data: Dict[str, Any]) -> List[str]:
        errors = []
        validators = {
            "billing_email": validate_email,
            "billing_phone": validate_phone,
            "website": validate_website,
            "gst_number": validate_gst,
            "vat_number": validate_vat,
            "fiscal_year_start": validate_fiscal_year,
            "fiscal_year_end": validate_fiscal_year,
            "invoice_prefix": validate_invoice_prefix,
            "quote_prefix": validate_invoice_prefix,
            "credit_note_prefix": validate_invoice_prefix,
            "refund_prefix": validate_invoice_prefix,
            "write_off_prefix": validate_invoice_prefix,
        }
        for field, validator in validators.items():
            if field in data:
                error = validator(data[field])
                if error:
                    errors.append(f"{field}: {error}")

        if data.get("default_due_days") is not None and (data["default_due_days"] < 0 or data["default_due_days"] > 365):
            errors.append("default_due_days must be between 0 and 365")

        if data.get("currency_precision") is not None and (data["currency_precision"] < 0 or data["currency_precision"] > 10):
            errors.append("currency_precision must be between 0 and 10")

        if data.get("rounding_precision") is not None and (data["rounding_precision"] < 0 or data["rounding_precision"] > 10):
            errors.append("rounding_precision must be between 0 and 10")

        if data.get("dunning_level_count") is not None and (data["dunning_level_count"] < 1 or data["dunning_level_count"] > 10):
            errors.append("dunning_level_count must be between 1 and 10")

        if data.get("late_payment_fee_percentage") is not None and (data["late_payment_fee_percentage"] < 0 or data["late_payment_fee_percentage"] > 100):
            errors.append("late_payment_fee_percentage must be between 0 and 100")

        if data.get("default_currency") is not None and not validate_currency_code(data["default_currency"]):
            errors.append(f"default_currency: invalid currency code '{data['default_currency']}'")

        if data.get("home_currency") is not None and not validate_currency_code(data["home_currency"]):
            errors.append(f"home_currency: invalid currency code '{data['home_currency']}'")

        if data.get("base_currency") is not None and not validate_currency_code(data["base_currency"]):
            errors.append(f"base_currency: invalid currency code '{data['base_currency']}'")

        if data.get("language") is not None and not validate_language_code(data["language"]):
            errors.append(f"language: invalid language code '{data['language']}'")

        return errors

    def update_configuration(
        self, organization_id: int, updated_by: int, **data: Any,
    ) -> BillingConfiguration:
        logger.info("Updating billing configuration for organization_id=%s by user_id=%s, fields=%s", organization_id, updated_by, list(data.keys()))
        errors = self._validate_config_data(data)
        if errors:
            logger.warning("Validation failed for organization_id=%s: %s", organization_id, errors)
            raise BadRequestException("Validation failed: " + "; ".join(errors))

        # ── Merge tax_preferences into tax_profiles JSON (Q1 resolution) ──────
        # tax_preferences carries frontend-only toggles (auto_calculation, filing_frequency,
        # requires_tax_id, etc.) that have no dedicated column.  We store them as a typed
        # entry inside the existing tax_profiles JSON list so no migration is needed.
        tax_preferences = data.pop("tax_preferences", None)
        if tax_preferences is not None:
            # Load current tax_profiles from the DB so we can do a safe merge.
            try:
                existing_config = self.repo.get_by_organization(organization_id)
                current_profiles: list = list(existing_config.tax_profiles or []) if existing_config else []
            except Exception:
                current_profiles = []

            # Merge: replace the "preferences" typed entry if it exists, else append.
            merged = [p for p in current_profiles if not (isinstance(p, dict) and p.get("type") == "preferences")]
            merged.append({"type": "preferences", "data": tax_preferences})
            data["tax_profiles"] = merged
            logger.info("Merged tax_preferences into tax_profiles for organization_id=%s", organization_id)

        # ── Merge raw tax_profiles writes by "type" instead of full-replace ────
        # Callers other than the tax_preferences path above (e.g. Tax Configuration's
        # jurisdictions/exemptions save) send tax_profiles directly. Writing that
        # straight through would silently wipe out any other typed entry already
        # stored in the same JSON column (e.g. the "preferences" entry above).
        # Merge by each incoming entry's "type" instead, same as the block above.
        elif isinstance(data.get("tax_profiles"), list):
            incoming_profiles = data["tax_profiles"]
            incoming_types = {p.get("type") for p in incoming_profiles if isinstance(p, dict) and p.get("type")}
            try:
                existing_config = self.repo.get_by_organization(organization_id)
                current_profiles = list(existing_config.tax_profiles or []) if existing_config else []
            except Exception:
                current_profiles = []
            preserved = [p for p in current_profiles if not (isinstance(p, dict) and p.get("type") in incoming_types)]
            data["tax_profiles"] = preserved + incoming_profiles
            logger.info("Merged incoming tax_profiles entries by type for organization_id=%s", organization_id)

        try:
            config = self.repo.upsert(organization_id, updated_by=updated_by, **data)
            self.audit.log(
                organization_id, updated_by, BillingAuditAction.UPDATE,
                "BillingConfiguration", config.id, new_values=data,
            )
            logger.info("Billing configuration updated successfully for organization_id=%s", organization_id)
            return config
        except Exception as e:
            logger.error("Failed to update billing configuration for organization_id=%s: %s", organization_id, str(e), exc_info=True)
            raise

    def reset_configuration(self, organization_id: int, updated_by: int) -> BillingConfiguration:
        logger.info("Resetting billing configuration for organization_id=%s by user_id=%s", organization_id, updated_by)
        try:
            config = self.repo.reset_to_defaults(
                organization_id, updated_by=updated_by, **CONFIGURATION_DEFAULTS,
            )
            self.audit.log(
                organization_id, updated_by, BillingAuditAction.UPDATE,
                "BillingConfiguration", config.id, new_values={"reset": True},
            )
            logger.info("Billing configuration reset successfully for organization_id=%s, config_id=%s", organization_id, config.id)
            return config
        except Exception as e:
            logger.error("Failed to reset billing configuration for organization_id=%s: %s", organization_id, str(e), exc_info=True)
            raise

    def validate_configuration(self, organization_id: int) -> Dict[str, Any]:
        logger.info("Validating billing configuration for organization_id=%s", organization_id)
        config = self.get_configuration(organization_id)
        errors = []

        field_validators = {
            "billing_email": (config.billing_email, validate_email),
            "billing_phone": (config.billing_phone, validate_phone),
            "website": (config.website, validate_website),
            "gst_number": (config.gst_number, validate_gst),
            "vat_number": (config.vat_number, validate_vat),
            "fiscal_year_start": (config.fiscal_year_start, validate_fiscal_year),
            "fiscal_year_end": (config.fiscal_year_end, validate_fiscal_year),
            "invoice_prefix": (config.invoice_prefix, validate_invoice_prefix),
            "quote_prefix": (config.quote_prefix, validate_invoice_prefix),
            "credit_note_prefix": (config.credit_note_prefix, validate_invoice_prefix),
            "refund_prefix": (config.refund_prefix, validate_invoice_prefix),
            "write_off_prefix": (config.write_off_prefix, validate_invoice_prefix),
        }

        for field, (value, validator) in field_validators.items():
            error = validator(value)
            if error:
                errors.append(f"{field}: {error}")

        if not config.default_currency:
            errors.append("default_currency is required")
        elif not validate_currency_code(config.default_currency.value if hasattr(config.default_currency, 'value') else config.default_currency):
            errors.append("default_currency: invalid currency code")

        if not config.language:
            errors.append("language is required")
        elif not validate_language_code(config.language):
            errors.append("language: invalid language code, falling back to English")

        if config.default_due_days is None or config.default_due_days < 0 or config.default_due_days > 365:
            errors.append("default_due_days must be between 0 and 365")

        result = {
            "valid": len(errors) == 0,
            "errors": errors,
            "field_count": len([c for c in BillingConfiguration.__table__.columns if hasattr(config, c.name)]),
        }
        logger.info("Validation result for organization_id=%s: valid=%s, errors=%d", organization_id, result["valid"], len(errors))
        return result

    def get_invoice_prefix(self, organization_id: int) -> str:
        config = self.get_configuration(organization_id)
        return config.invoice_prefix or "INV-"

    def get_quote_prefix(self, organization_id: int) -> str:
        config = self.get_configuration(organization_id)
        return config.quote_prefix or "QTE-"

    def get_default_currency(self, organization_id: int) -> str:
        config = self.get_configuration(organization_id)
        # Prefer base_currency over default_currency as the authoritative org currency
        if hasattr(config, "base_currency") and config.base_currency:
            val = config.base_currency.value if hasattr(config.base_currency, 'value') else config.base_currency
            if val:
                return str(val)
        if hasattr(config, "default_currency") and config.default_currency:
            val = config.default_currency.value if hasattr(config.default_currency, 'value') else config.default_currency
            if val:
                return str(val)
        return "USD"

    def get_currency_symbol(self, organization_id: int) -> str:
        currency_code = self.get_default_currency(organization_id)
        return get_currency_symbol(currency_code)

    def get_payment_terms(self, organization_id: int) -> str:
        config = self.get_configuration(organization_id)
        return config.default_payment_terms.value if hasattr(config.default_payment_terms, 'value') else (config.default_payment_terms or "net_30")

    def get_exchange_rate_for_pair(
        self, organization_id: int, from_currency: str, to_currency: str,
    ) -> Dict[str, Any]:
        """Get exchange rate for a specific currency pair using ExchangeRateService."""
        from app.modules.billing.services.exchange_rate_service import ExchangeRateService
        svc = ExchangeRateService(self.db)
        rate, source, timestamp = svc.get_rate(organization_id, from_currency, to_currency)
        return {
            "from_currency": from_currency,
            "to_currency": to_currency,
            "rate": float(rate),
            "source": source,
            "timestamp": timestamp.isoformat() if timestamp else None,
        }

    def refresh_exchange_rates(
        self, organization_id: int, base_currency: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Refresh exchange rates from the live API."""
        from app.modules.billing.services.exchange_rate_service import ExchangeRateService
        svc = ExchangeRateService(self.db)
        return svc.refresh_rates(organization_id, base_currency)

    def get_cached_exchange_rates(self, organization_id: int) -> Dict[str, Any]:
        """Get all cached exchange rates for an organization."""
        from app.modules.billing.services.exchange_rate_service import ExchangeRateService
        svc = ExchangeRateService(self.db)
        return svc.get_cached_rates(organization_id)

    def get_supported_currencies(self) -> List[str]:
        """Get list of currencies supported by the exchange rate API."""
        from app.modules.billing.services.exchange_rate_service import ExchangeRateService
        return ExchangeRateService.get_supported_currencies(None)


# NOTE (Phase 2): BillingSettingsService (and its backing BillingSettingRepository)
# was removed here — dead code confirmed via repo-wide search: nothing in the
# codebase ever instantiated it (no router, service, or task). This class
# wrapped the legacy `billing_settings` table, which is a separate, narrower
# configuration model than BillingConfiguration below. BillingConfigurationService
# is the sole live configuration layer for the whole billing module — every
# router and service already goes through it exclusively. The `billing_settings`
# table and its BillingSetting model are left untouched (schema preserved).
