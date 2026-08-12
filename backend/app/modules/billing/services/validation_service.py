"""
modules/billing/services/validation_service.py
----------------------------------------------
Enterprise-grade validation service for BillingConfiguration.
Returns passed checks, warnings, errors, and a readiness score (0-100).
"""

import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.modules.billing.models import (
    BillingConfiguration,
    ExchangeRateProvider,
)
from app.modules.billing.repositories.settings import BillingConfigurationRepository
from app.modules.billing.utils.currency_utils import VALID_CURRENCY_CODES

logger = logging.getLogger("zoiko")


# ── Regex Patterns ───────────────────────────────────────────────────────────

GSTIN_PATTERN = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$")
PAN_PATTERN = re.compile(r"^[A-Z]{5}\d{4}[A-Z]{1}$")
EMAIL_PATTERN = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")
PHONE_PATTERN = re.compile(r"^[\+]?[\d\s\-\(\)]{7,20}$")
WEBSITE_PATTERN = re.compile(r"^https?://[\w\-]+(\.[\w\-]+)+(/[\w\-./?#&%=]*)?$")
FISCAL_MONTH_PATTERN = re.compile(r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")
INVOICE_PREFIX_PATTERN = re.compile(r"^[A-Za-z0-9\-_]{1,10}$")
POSTAL_CODE_PATTERN = re.compile(r"^[\w\s\-]{3,20}$")

VALID_TIMEZONES = [
    "UTC", "US/Eastern", "US/Central", "US/Pacific", "Europe/London",
    "Europe/Paris", "Europe/Berlin", "Asia/Kolkata", "Asia/Dubai",
    "Asia/Singapore", "Asia/Tokyo", "Asia/Shanghai", "Australia/Sydney",
    "Pacific/Auckland", "America/Sao_Paulo", "Africa/Cairo",
]
VALID_LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "ar", "hi", "nl", "ru", "pl", "tr"]
GST_STATE_CODES = [
    "01","02","03","04","05","06","07","08","09","10",
    "11","12","13","14","15","16","17","18","19","20",
    "21","22","23","24","25","26","27","28","29","30",
    "31","32","33","34","35","36","37","38",
]


class ValidationItem:
    """A single validation result item."""
    __slots__ = ("field", "message", "severity", "code")

    def __init__(self, field: str, message: str, severity: str, code: str = ""):
        self.field = field
        self.message = message
        self.severity = severity  # "error", "warning", "info", "passed"
        self.code = code

    def to_dict(self) -> Dict[str, str]:
        d = {"field": self.field, "message": self.message, "severity": self.severity}
        if self.code:
            d["code"] = self.code
        return d


class BillingValidationService:
    """
    Enterprise validation service for BillingConfiguration.
    Computes a readiness score (0-100) based on field completeness and validity.
    """

    # Weights for readiness score calculation (total = 100)
    SECTION_WEIGHTS = {
        "company_profile": 20,
        "currency": 15,
        "invoicing": 15,
        "tax": 15,
        "payment": 15,
        "exchange_rate": 10,
        "registration": 10,
    }

    def __init__(self, db: Session):
        self.db = db
        self.repo = BillingConfigurationRepository(db)

    def validate(
        self, organization_id: int, form_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Run full validation and return structured result.
        If form_data is provided, validate against it (pre-save).
        Otherwise validate against the persisted configuration.
        """
        config = self.repo.get_by_organization(organization_id)
        data = form_data if form_data is not None else self._config_to_dict(config)

        passed: List[ValidationItem] = []
        warnings: List[ValidationItem] = []
        errors: List[ValidationItem] = []
        section_scores: Dict[str, float] = {}

        # Run all validators
        all_validators = [
            self._validate_company_profile,
            self._validate_registration,
            self._validate_currency,
            self._validate_invoicing,
            self._validate_tax,
            self._validate_payment,
            self._validate_exchange_rate,
        ]

        for validator in all_validators:
            try:
                p, w, e, section_name, section_score = validator(data)
                passed.extend(p)
                warnings.extend(w)
                errors.extend(e)
                section_scores[section_name] = section_score
            except Exception as exc:
                logger.error("Validator %s failed: %s", validator.__name__, exc, exc_info=True)
                errors.append(ValidationItem(
                    field="system",
                    message=f"Validation check '{validator.__name__}' encountered an error.",
                    severity="error",
                    code="VALIDATOR_INTERNAL_ERROR",
                ))

        # Calculate overall readiness score
        readiness_score = self._calculate_score(section_scores, errors, warnings)

        result = {
            "valid": len(errors) == 0,
            "readiness_score": readiness_score,
            "passed": [item.to_dict() for item in passed],
            "warnings": [item.to_dict() for item in warnings],
            "errors": [item.to_dict() for item in errors],
            "passed_count": len(passed),
            "warning_count": len(warnings),
            "error_count": len(errors),
            "section_scores": section_scores,
            "field_count": len([k for k in data if data.get(k) is not None and data.get(k) != ""]),
            "validated_at": datetime.utcnow().isoformat() + "Z",
        }

        logger.info(
            "Validation complete for org %s: score=%d, errors=%d, warnings=%d, passed=%d",
            organization_id, readiness_score, len(errors), len(warnings), len(passed),
        )
        return result

    # ── Section Validators ───────────────────────────────────────────────

    def _validate_company_profile(
        self, data: Dict[str, Any],
    ) -> Tuple[List, List, List, str, float]:
        passed, warnings, errors = [], [], []

        # Company name
        company_name = (data.get("company_name") or "").strip()
        if company_name:
            if len(company_name) < 2:
                errors.append(ValidationItem("company_name", "Company name must be at least 2 characters.", "error", "NAME_TOO_SHORT"))
            elif len(company_name) > 200:
                errors.append(ValidationItem("company_name", "Company name must be 200 characters or fewer.", "error", "NAME_TOO_LONG"))
            else:
                passed.append(ValidationItem("company_name", "Company name is valid.", "passed"))
        else:
            warnings.append(ValidationItem("company_name", "Company name is not set.", "warning", "MISSING"))

        # Billing email
        billing_email = (data.get("billing_email") or "").strip()
        if billing_email:
            if not EMAIL_PATTERN.match(billing_email):
                errors.append(ValidationItem("billing_email", f"Invalid email format: {billing_email}", "error", "INVALID_EMAIL"))
            else:
                passed.append(ValidationItem("billing_email", "Billing email is valid.", "passed"))
        else:
            warnings.append(ValidationItem("billing_email", "Billing email is not set.", "warning", "MISSING"))

        # Billing phone
        billing_phone = (data.get("billing_phone") or "").strip()
        if billing_phone:
            cleaned = re.sub(r"[\s\-\(\)]", "", billing_phone)
            if not cleaned.isdigit() or len(cleaned) < 7 or len(cleaned) > 15:
                warnings.append(ValidationItem("billing_phone", "Phone number format may be invalid.", "warning", "INVALID_PHONE"))
            else:
                passed.append(ValidationItem("billing_phone", "Billing phone is valid.", "passed"))

        # Website
        website = (data.get("website") or "").strip()
        if website:
            if not WEBSITE_PATTERN.match(website):
                errors.append(ValidationItem("website", f"Invalid website URL: {website}", "error", "INVALID_WEBSITE"))
            else:
                passed.append(ValidationItem("website", "Website URL is valid.", "passed"))

        # Logo URL
        logo_url = (data.get("logo_url") or "").strip()
        if logo_url:
            if not logo_url.startswith(("http://", "https://")):
                warnings.append(ValidationItem("logo_url", "Logo URL should start with http:// or https://.", "warning", "INVALID_LOGO_URL"))
            else:
                passed.append(ValidationItem("logo_url", "Logo URL format is valid.", "passed"))

        # Address fields
        for field in ["address_line1", "city", "state", "postal_code"]:
            val = (data.get(field) or "").strip()
            if val:
                passed.append(ValidationItem(field, f"{field.replace('_', ' ').title()} is set.", "passed"))

        # Country
        country = (data.get("country") or "").strip()
        if country:
            passed.append(ValidationItem("country", f"Country is set: {country}.", "passed"))
        else:
            warnings.append(ValidationItem("country", "Country is not set. This affects tax rules and field visibility.", "warning", "MISSING_COUNTRY"))

        # Postal code format
        postal_code = (data.get("postal_code") or "").strip()
        if postal_code and not POSTAL_CODE_PATTERN.match(postal_code):
            warnings.append(ValidationItem("postal_code", "Postal code format looks unusual.", "warning", "UNUSUAL_POSTAL_CODE"))

        # Score: completeness of key fields
        key_fields = ["company_name", "billing_email", "country", "address_line1", "city"]
        filled = sum(1 for f in key_fields if (data.get(f) or "").strip())
        score = (filled / len(key_fields)) * 100

        return passed, warnings, errors, "company_profile", score

    def _validate_registration(
        self, data: Dict[str, Any],
    ) -> Tuple[List, List, List, str, float]:
        passed, warnings, errors = [], [], []
        country = (data.get("country") or "").strip()

        # GSTIN (India)
        gst_number = (data.get("gst_number") or "").strip().upper()
        if gst_number:
            if not GSTIN_PATTERN.match(gst_number):
                errors.append(ValidationItem("gst_number", f"Invalid GSTIN format: {gst_number}. Expected: 2 digits + 5 letters + 4 digits + 1 letter + Z + 1 alphanumeric.", "error", "INVALID_GSTIN"))
            else:
                state_code = gst_number[:2]
                if state_code not in GST_STATE_CODES:
                    errors.append(ValidationItem("gst_number", f"GSTIN state code '{state_code}' is not a valid Indian state/UT code.", "error", "INVALID_GST_STATE"))
                else:
                    # PAN portion validation (chars 3-12)
                    pan_in_gst = gst_number[2:12]
                    if not re.match(r"^[A-Z]{5}\d{4}[A-Z]$", pan_in_gst):
                        errors.append(ValidationItem("gst_number", "GSTIN contains invalid PAN portion.", "error", "INVALID_GSTIN_PAN"))
                    else:
                        passed.append(ValidationItem("gst_number", "GSTIN is valid.", "passed"))
        elif country == "India":
            warnings.append(ValidationItem("gst_number", "GSTIN is required for Indian businesses.", "warning", "MISSING_GSTIN"))

        # PAN (India)
        pan_number = (data.get("pan_number") or "").strip().upper()
        if pan_number:
            if not PAN_PATTERN.match(pan_number):
                errors.append(ValidationItem("pan_number", f"Invalid PAN format: {pan_number}. Expected: 5 letters + 4 digits + 1 letter.", "error", "INVALID_PAN"))
            else:
                # Entity type check (4th char)
                entity_char = pan_number[3]
                valid_entities = {"A", "B", "C", "F", "G", "H", "L", "J", "P", "T"}
                if entity_char not in valid_entities:
                    warnings.append(ValidationItem("pan_number", f"PAN entity type '{entity_char}' is unusual.", "warning", "UNUSUAL_PAN_ENTITY"))
                else:
                    passed.append(ValidationItem("pan_number", "PAN is valid.", "passed"))
        elif country == "India":
            warnings.append(ValidationItem("pan_number", "PAN is recommended for Indian businesses.", "warning", "MISSING_PAN"))

        # VAT Number
        vat_number = (data.get("vat_number") or "").strip()
        if vat_number:
            if len(vat_number) < 4 or len(vat_number) > 20:
                warnings.append(ValidationItem("vat_number", "VAT number length looks unusual (expected 4-20 characters).", "warning", "UNUSUAL_VAT"))
            else:
                passed.append(ValidationItem("vat_number", "VAT number is set.", "passed"))

        # Business Registration Number
        brn = (data.get("business_registration_number") or "").strip()
        if brn:
            passed.append(ValidationItem("business_registration_number", "Business registration number is set.", "passed"))

        # TIN
        tin = (data.get("tin_number") or "").strip()
        if tin:
            passed.append(ValidationItem("tin_number", "Tax ID / TIN is set.", "passed"))

        # Score
        if country == "India":
            key_fields = ["gst_number", "pan_number"]
            filled = sum(1 for f in key_fields if (data.get(f) or "").strip())
            score = (filled / len(key_fields)) * 100
        elif country in ("United States", "United Kingdom", "UAE", "Singapore", "Australia"):
            key_fields = ["business_registration_number"]
            filled = sum(1 for f in key_fields if (data.get(f) or "").strip())
            score = (filled / len(key_fields)) * 100
        else:
            score = 80  # Default for unspecified countries

        return passed, warnings, errors, "registration", score

    def _validate_currency(
        self, data: Dict[str, Any],
    ) -> Tuple[List, List, List, str, float]:
        passed, warnings, errors = [], [], []

        # Default currency
        default_currency = (data.get("default_currency") or "").strip().upper()
        if default_currency:
            if default_currency not in VALID_CURRENCY_CODES:
                errors.append(ValidationItem("default_currency", f"Invalid currency code: {default_currency}", "error", "INVALID_CURRENCY"))
            else:
                passed.append(ValidationItem("default_currency", f"Default currency is set to {default_currency}.", "passed"))
        else:
            errors.append(ValidationItem("default_currency", "Default currency is required.", "error", "MISSING_CURRENCY"))

        # Home currency
        home_currency = (data.get("home_currency") or "").strip().upper()
        if home_currency:
            if home_currency not in VALID_CURRENCY_CODES:
                errors.append(ValidationItem("home_currency", f"Invalid home currency code: {home_currency}", "error", "INVALID_HOME_CURRENCY"))
            else:
                passed.append(ValidationItem("home_currency", f"Home currency is set to {home_currency}.", "passed"))

        # Base currency
        base_currency = (data.get("base_currency") or "").strip().upper()
        if base_currency:
            if base_currency not in VALID_CURRENCY_CODES:
                errors.append(ValidationItem("base_currency", f"Invalid base currency code: {base_currency}", "error", "INVALID_BASE_CURRENCY"))
            else:
                passed.append(ValidationItem("base_currency", f"Base currency is set to {base_currency}.", "passed"))

        # Currency precision
        precision = data.get("currency_precision")
        if precision is not None:
            try:
                p = int(precision)
                if p < 0 or p > 10:
                    errors.append(ValidationItem("currency_precision", "Currency precision must be 0-10.", "error", "INVALID_PRECISION"))
                else:
                    passed.append(ValidationItem("currency_precision", f"Currency precision is set to {p}.", "passed"))
            except (TypeError, ValueError):
                errors.append(ValidationItem("currency_precision", "Currency precision must be a number.", "error", "NON_NUMERIC_PRECISION"))

        # Timezone
        tz = (data.get("timezone") or "").strip()
        if tz and tz not in VALID_TIMEZONES:
            warnings.append(ValidationItem("timezone", f"Timezone '{tz}' is not in the standard list.", "warning", "UNKNOWN_TIMEZONE"))
        elif tz:
            passed.append(ValidationItem("timezone", f"Timezone is set to {tz}.", "passed"))

        # Language
        lang = (data.get("language") or "").strip().lower()
        if lang and lang not in VALID_LANGUAGES:
            warnings.append(ValidationItem("language", f"Language '{lang}' may not be supported.", "warning", "UNKNOWN_LANGUAGE"))
        elif lang:
            passed.append(ValidationItem("language", f"Language is set to {lang}.", "passed"))

        # Score
        key_fields = ["default_currency", "home_currency", "base_currency", "timezone"]
        filled = sum(1 for f in key_fields if (data.get(f) or "").strip())
        score = (filled / len(key_fields)) * 100

        return passed, warnings, errors, "currency", score

    def _validate_invoicing(
        self, data: Dict[str, Any],
    ) -> Tuple[List, List, List, str, float]:
        passed, warnings, errors = [], [], []

        # Invoice prefix
        invoice_prefix = (data.get("invoice_prefix") or "").strip()
        if invoice_prefix:
            if not INVOICE_PREFIX_PATTERN.match(invoice_prefix):
                errors.append(ValidationItem("invoice_prefix", f"Invalid invoice prefix: '{invoice_prefix}'. Must be 1-10 alphanumeric/dash/underscore characters.", "error", "INVALID_INVOICE_PREFIX"))
            else:
                passed.append(ValidationItem("invoice_prefix", f"Invoice prefix is '{invoice_prefix}'.", "passed"))
        else:
            warnings.append(ValidationItem("invoice_prefix", "Invoice prefix is not set.", "warning", "MISSING"))

        # Quote prefix
        quote_prefix = (data.get("quote_prefix") or "").strip()
        if quote_prefix:
            if not INVOICE_PREFIX_PATTERN.match(quote_prefix):
                errors.append(ValidationItem("quote_prefix", f"Invalid quote prefix: '{quote_prefix}'.", "error", "INVALID_QUOTE_PREFIX"))
            elif quote_prefix == invoice_prefix and invoice_prefix:
                warnings.append(ValidationItem("quote_prefix", "Quote prefix is the same as invoice prefix.", "warning", "DUPLICATE_PREFIX"))
            else:
                passed.append(ValidationItem("quote_prefix", f"Quote prefix is '{quote_prefix}'.", "passed"))

        # Credit note prefix
        cn_prefix = (data.get("credit_note_prefix") or "").strip()
        if cn_prefix:
            if not INVOICE_PREFIX_PATTERN.match(cn_prefix):
                errors.append(ValidationItem("credit_note_prefix", f"Invalid credit note prefix: '{cn_prefix}'.", "error", "INVALID_CN_PREFIX"))
            elif cn_prefix == invoice_prefix and invoice_prefix:
                warnings.append(ValidationItem("credit_note_prefix", "Credit note prefix is the same as invoice prefix.", "warning", "DUPLICATE_PREFIX"))
            else:
                passed.append(ValidationItem("credit_note_prefix", f"Credit note prefix is '{cn_prefix}'.", "passed"))

        # Refund prefix
        rf_prefix = (data.get("refund_prefix") or "").strip()
        if rf_prefix:
            if not INVOICE_PREFIX_PATTERN.match(rf_prefix):
                errors.append(ValidationItem("refund_prefix", f"Invalid refund prefix: '{rf_prefix}'.", "error", "INVALID_RF_PREFIX"))
            elif rf_prefix == invoice_prefix and invoice_prefix:
                warnings.append(ValidationItem("refund_prefix", "Refund prefix is the same as invoice prefix.", "warning", "DUPLICATE_PREFIX"))
            else:
                passed.append(ValidationItem("refund_prefix", f"Refund prefix is '{rf_prefix}'.", "passed"))

        # Write-off prefix
        wo_prefix = (data.get("write_off_prefix") or "").strip()
        if wo_prefix:
            if not INVOICE_PREFIX_PATTERN.match(wo_prefix):
                errors.append(ValidationItem("write_off_prefix", f"Invalid write-off prefix: '{wo_prefix}'.", "error", "INVALID_WO_PREFIX"))
            elif wo_prefix == invoice_prefix and invoice_prefix:
                warnings.append(ValidationItem("write_off_prefix", "Write-off prefix is the same as invoice prefix.", "warning", "DUPLICATE_PREFIX"))
            else:
                passed.append(ValidationItem("write_off_prefix", f"Write-off prefix is '{wo_prefix}'.", "passed"))

        # Fiscal year
        for fy_field in ["fiscal_year_start", "fiscal_year_end"]:
            fy_val = (data.get(fy_field) or "").strip()
            if fy_val:
                if not FISCAL_MONTH_PATTERN.match(fy_val):
                    errors.append(ValidationItem(fy_field, f"Invalid fiscal year format: '{fy_val}'. Expected MM-DD.", "error", "INVALID_FY_FORMAT"))
                else:
                    passed.append(ValidationItem(fy_field, f"{fy_field.replace('_', ' ').title()} is {fy_val}.", "passed"))

        # Default due days
        due_days = data.get("default_due_days")
        if due_days is not None:
            try:
                d = int(due_days)
                if d < 0 or d > 365:
                    errors.append(ValidationItem("default_due_days", "Due days must be 0-365.", "error", "INVALID_DUE_DAYS"))
                else:
                    passed.append(ValidationItem("default_due_days", f"Default due days is {d}.", "passed"))
            except (TypeError, ValueError):
                errors.append(ValidationItem("default_due_days", "Due days must be a number.", "error", "NON_NUMERIC"))

        # Late fee
        late_pct = data.get("late_payment_fee_percentage")
        if late_pct is not None:
            try:
                p = float(late_pct)
                if p < 0 or p > 100:
                    errors.append(ValidationItem("late_payment_fee_percentage", "Late fee percentage must be 0-100.", "error", "INVALID_LATE_FEE"))
                elif p > 50:
                    warnings.append(ValidationItem("late_payment_fee_percentage", "Late fee percentage is unusually high.", "warning", "HIGH_LATE_FEE"))
                else:
                    passed.append(ValidationItem("late_payment_fee_percentage", f"Late fee is {p}%.", "passed"))
            except (TypeError, ValueError):
                errors.append(ValidationItem("late_payment_fee_percentage", "Late fee must be a number.", "error", "NON_NUMERIC"))

        # Score
        key_fields = ["invoice_prefix", "quote_prefix", "default_due_days", "fiscal_year_start"]
        filled = sum(1 for f in key_fields if ((data.get(f) or "").strip() if isinstance(data.get(f), str) else data.get(f) is not None))
        score = (filled / len(key_fields)) * 100

        return passed, warnings, errors, "invoicing", score

    def _validate_tax(
        self, data: Dict[str, Any],
    ) -> Tuple[List, List, List, str, float]:
        passed, warnings, errors = [], [], []

        # Tax calculation method
        tax_method = (data.get("tax_calculation_method") or "").strip().lower()
        if tax_method:
            valid_methods = {"exclusive", "inclusive"}
            if tax_method not in valid_methods:
                errors.append(ValidationItem("tax_calculation_method", f"Invalid tax method: '{tax_method}'. Must be 'exclusive' or 'inclusive'.", "error", "INVALID_TAX_METHOD"))
            else:
                passed.append(ValidationItem("tax_calculation_method", f"Tax method is {tax_method}.", "passed"))
        else:
            warnings.append(ValidationItem("tax_calculation_method", "Tax calculation method is not set.", "warning", "MISSING"))

        # Tax label
        tax_label = (data.get("tax_label") or "").strip()
        if tax_label:
            if len(tax_label) > 50:
                warnings.append(ValidationItem("tax_label", "Tax label is unusually long.", "warning", "LONG_LABEL"))
            else:
                passed.append(ValidationItem("tax_label", f"Tax label is '{tax_label}'.", "passed"))

        # Tax number
        tax_number = (data.get("tax_number") or "").strip()
        if tax_number:
            passed.append(ValidationItem("tax_number", "Tax registration number is set.", "passed"))

        # Tax rounding method
        tax_rounding = (data.get("tax_rounding_method") or "").strip().lower()
        if tax_rounding:
            valid_rounding = {"per_line", "per_invoice", "per_line_item"}
            if tax_rounding not in valid_rounding:
                warnings.append(ValidationItem("tax_rounding_method", f"Unknown tax rounding method: '{tax_rounding}'.", "warning", "UNKNOWN_TAX_ROUNDING"))
            else:
                passed.append(ValidationItem("tax_rounding_method", f"Tax rounding is {tax_rounding}.", "passed"))

        # Score
        score = 100 if tax_method else 50

        return passed, warnings, errors, "tax", score

    def _validate_payment(
        self, data: Dict[str, Any],
    ) -> Tuple[List, List, List, str, float]:
        passed, warnings, errors = [], [], []

        # Default payment terms
        payment_terms = (data.get("default_payment_terms") or "").strip().lower()
        if payment_terms:
            valid_terms = {"due_on_receipt", "net_7", "net_10", "net_15", "net_30", "net_45", "net_60", "net_90"}
            if payment_terms not in valid_terms:
                warnings.append(ValidationItem("default_payment_terms", f"Non-standard payment terms: '{payment_terms}'.", "warning", "NON_STANDARD_TERMS"))
            else:
                passed.append(ValidationItem("default_payment_terms", f"Payment terms: {payment_terms}.", "passed"))
        else:
            warnings.append(ValidationItem("default_payment_terms", "Payment terms are not set.", "warning", "MISSING"))

        # Rounding method
        rounding = (data.get("rounding_method") or "").strip().lower()
        if rounding:
            valid = {"none", "up", "down", "half_up", "half_down", "half_even"}
            if rounding not in valid:
                errors.append(ValidationItem("rounding_method", f"Invalid rounding method: '{rounding}'.", "error", "INVALID_ROUNDING"))
            else:
                passed.append(ValidationItem("rounding_method", f"Rounding method: {rounding}.", "passed"))

        # Rounding precision
        rp = data.get("rounding_precision")
        if rp is not None:
            try:
                r = int(rp)
                if r < 0 or r > 10:
                    errors.append(ValidationItem("rounding_precision", "Rounding precision must be 0-10.", "error", "INVALID_ROUNDING_PRECISION"))
                else:
                    passed.append(ValidationItem("rounding_precision", f"Rounding precision: {r}.", "passed"))
            except (TypeError, ValueError):
                errors.append(ValidationItem("rounding_precision", "Rounding precision must be a number.", "error", "NON_NUMERIC"))

        # Grace period
        grace = data.get("grace_period_days")
        if grace is not None:
            try:
                g = int(grace)
                if g < 0 or g > 365:
                    errors.append(ValidationItem("grace_period_days", "Grace period must be 0-365.", "error", "INVALID_GRACE"))
                else:
                    passed.append(ValidationItem("grace_period_days", f"Grace period: {g} days.", "passed"))
            except (TypeError, ValueError):
                errors.append(ValidationItem("grace_period_days", "Grace period must be a number.", "error", "NON_NUMERIC"))

        # Credit limit
        cl = data.get("credit_limit")
        if cl is not None:
            try:
                c = float(cl)
                if c < 0:
                    errors.append(ValidationItem("credit_limit", "Credit limit cannot be negative.", "error", "NEGATIVE_CREDIT"))
                else:
                    passed.append(ValidationItem("credit_limit", f"Credit limit: {c}.", "passed"))
            except (TypeError, ValueError):
                errors.append(ValidationItem("credit_limit", "Credit limit must be a number.", "error", "NON_NUMERIC"))

        # At least one payment gateway enabled
        gateway_fields = [
            "gateway_stripe_enabled", "gateway_razorpay_enabled", "gateway_paypal_enabled",
            "gateway_cash_enabled", "gateway_bank_transfer_enabled", "gateway_upi_enabled",
            "gateway_offline_enabled",
        ]
        any_gateway = any(data.get(f) for f in gateway_fields)
        if any_gateway:
            passed.append(ValidationItem("payment_gateways", "At least one payment gateway is enabled.", "passed"))
        else:
            warnings.append(ValidationItem("payment_gateways", "No payment gateways are enabled.", "warning", "NO_GATEWAYS"))

        # Score
        key_fields = ["default_payment_terms", "rounding_method", "rounding_precision"]
        filled = sum(1 for f in key_fields if ((data.get(f) or "").strip() if isinstance(data.get(f), str) else data.get(f) is not None))
        score = min(((filled / len(key_fields)) * 100), 100)
        if any_gateway:
            score = max(score, 60)

        return passed, warnings, errors, "payment", score

    def _validate_exchange_rate(
        self, data: Dict[str, Any],
    ) -> Tuple[List, List, List, str, float]:
        passed, warnings, errors = [], [], []

        # Provider
        provider = (data.get("exchange_rate_provider") or "").strip().lower()
        if provider:
            valid_providers = {p.value for p in ExchangeRateProvider}
            if provider not in valid_providers:
                errors.append(ValidationItem("exchange_rate_provider", f"Invalid exchange rate provider: '{provider}'.", "error", "INVALID_PROVIDER"))
            elif provider == "manual":
                warnings.append(ValidationItem("exchange_rate_provider", "Manual rates require periodic manual updates.", "warning", "MANUAL_RATES"))
            else:
                passed.append(ValidationItem("exchange_rate_provider", f"Exchange rate provider: {provider}.", "passed"))
        else:
            warnings.append(ValidationItem("exchange_rate_provider", "Exchange rate provider is not configured.", "warning", "MISSING_PROVIDER"))

        # Base currency
        base_ccy = (data.get("exchange_rate_base_currency") or "").strip().upper()
        if base_ccy:
            if base_ccy not in VALID_CURRENCY_CODES:
                errors.append(ValidationItem("exchange_rate_base_currency", f"Invalid base currency: {base_ccy}", "error", "INVALID_BASE_CCY"))
            else:
                passed.append(ValidationItem("exchange_rate_base_currency", f"Rate base currency: {base_ccy}.", "passed"))

        # Last refreshed
        last_refreshed = data.get("exchange_rate_last_refreshed")
        if last_refreshed:
            try:
                if isinstance(last_refreshed, str):
                    ts = datetime.fromisoformat(last_refreshed.replace("Z", "+00:00"))
                else:
                    ts = last_refreshed
                age_hours = (datetime.utcnow() - ts.replace(tzinfo=None)).total_seconds() / 3600
                if age_hours > 48:
                    warnings.append(ValidationItem("exchange_rate_last_refreshed", f"Rates last refreshed {int(age_hours)}h ago. Consider refreshing.", "warning", "STALE_RATES"))
                else:
                    passed.append(ValidationItem("exchange_rate_last_refreshed", f"Rates refreshed {int(age_hours)}h ago.", "passed"))
            except Exception:
                pass

        # Cached rates check
        cached_rates = data.get("exchange_rates")
        if cached_rates and isinstance(cached_rates, dict) and len(cached_rates) > 0:
            passed.append(ValidationItem("exchange_rates", f"{len(cached_rates)} currency rates are cached.", "passed"))
        elif provider and provider != "manual":
            warnings.append(ValidationItem("exchange_rates", "No cached exchange rates. Click 'Refresh Now' to fetch live rates.", "warning", "NO_CACHED_RATES"))

        # Score
        if provider and provider != "manual" and cached_rates and isinstance(cached_rates, dict) and len(cached_rates) > 0:
            score = 100
        elif provider and provider != "manual":
            score = 60
        elif provider == "manual":
            score = 50
        else:
            score = 20

        return passed, warnings, errors, "exchange_rate", score

    # ── Helpers ──────────────────────────────────────────────────────────

    def _calculate_score(
        self,
        section_scores: Dict[str, float],
        errors: List[ValidationItem],
        warnings: List[ValidationItem],
    ) -> int:
        """Calculate overall readiness score (0-100)."""
        # Weighted section average
        total_weight = 0
        weighted_sum = 0
        for section, weight in self.SECTION_WEIGHTS.items():
            if section in section_scores:
                weighted_sum += section_scores[section] * weight
                total_weight += weight

        if total_weight > 0:
            base_score = weighted_sum / total_weight
        else:
            base_score = 50  # Default

        # Penalty for errors (-5 per error, max -40)
        error_penalty = min(len(errors) * 5, 40)
        # Penalty for warnings (-1 per warning, max -15)
        warning_penalty = min(len(warnings) * 1, 15)

        score = max(0, min(100, int(base_score - error_penalty - warning_penalty)))
        return score

    def _config_to_dict(self, config: Optional[BillingConfiguration]) -> Dict[str, Any]:
        """Convert a BillingConfiguration model instance to a flat dict for validation."""
        if not config:
            return {}

        result = {}
        for column in BillingConfiguration.__table__.columns:
            val = getattr(config, column.name, None)
            if val is not None:
                # Convert enums to their string values
                if hasattr(val, "value"):
                    val = val.value
                result[column.name] = val
        return result
