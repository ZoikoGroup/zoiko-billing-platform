from decimal import Decimal, ROUND_HALF_UP

from app.modules.billing.models import CurrencyCode

# Codes here are the display-symbol map, not the source of truth for "is this a
# valid currency code" — see validate_currency_code(), which checks against the
# CurrencyCode enum (models.py) instead, so there is exactly one canonical list
# of valid currency codes rather than two independently-maintained ones that
# happen to currently agree. This map still needs its own per-code symbol data.
CURRENCY_SYMBOL_MAP = {
    "USD": "$",
    "EUR": "\u20AC",
    "GBP": "\u00A3",
    "INR": "\u20B9",
    "JPY": "\u00A5",
    "CNY": "\u00A5",
    "AED": "\u062F.\u0625",
    "SAR": "\u0631.\u0633",
    "QAR": "\u0631.\u0642",
    "KWD": "\u062F.\u0643",
    "AUD": "A$",
    "CAD": "C$",
    "CHF": "CHF",
    "SGD": "S$",
    "NZD": "NZ$",
    "MYR": "RM",
    "THB": "\u0E3F",
    "HKD": "HK$",
    "KRW": "\u20A9",
    "MXN": "MX$",
    "ZAR": "R",
    "BRL": "R$",
    "SEK": "kr",
    "NOK": "kr",
    "DKK": "kr",
    "NGN": "\u20A6",
    "PKR": "\u20A8",
    "BDT": "\u09F3",
    "LKR": "\u20A8",
    "NPR": "\u20A8",
    "BHD": "\u062F.\u0628",
    "OMR": "\u0631.\u0639",
}

CURRENCY_DECIMAL_MAP = {
    "JPY": 0,
    "KRW": 0,
    "KWD": 3,
    "BHD": 3,
    "OMR": 3,
}


def get_currency_symbol(currency_code: str) -> str:
    return CURRENCY_SYMBOL_MAP.get(currency_code, currency_code)


def get_currency_decimal_digits(currency_code: str) -> int:
    return CURRENCY_DECIMAL_MAP.get(currency_code, 2)


# Single source of truth for the billing module's rounding policy: ROUND_HALF_UP
# (standard commercial rounding — 0.005 -> 0.01), applied at the currency's display
# precision (2dp for most currencies, 0 for JPY/KRW, 3 for KWD/BHD/OMR per
# CURRENCY_DECIMAL_MAP above). Every place that rounds a final money amount for
# storage or display should call this instead of an ad hoc round()/quantize()/`.2f`,
# so the rounding mode and precision can never silently diverge between call sites.
def round_money(amount, currency_code: str = None) -> Decimal:
    digits = get_currency_decimal_digits(currency_code) if currency_code else 2
    quantum = Decimal(1).scaleb(-digits)
    return Decimal(str(amount)).quantize(quantum, rounding=ROUND_HALF_UP)


def percentage_of(amount, percentage) -> Decimal:
    """Returns `percentage`% of `amount` (e.g. percentage_of(200, 10) -> 20).
    Centralizes the `amount * percentage / 100` pattern used for discounts,
    taxes, and fees across the billing module — one formula, one place.
    Intentionally unrounded (same contract as the rest of the calculation
    pipeline): round only at the point a value is stored or displayed, via
    round_money(), not here, so precision isn't lost before a document's
    final totals are computed.
    """
    return Decimal(str(amount)) * Decimal(str(percentage)) / Decimal("100")


def convert_amount(amount, exchange_rate, currency_code: str = None) -> Decimal:
    """Converts `amount` to another currency using `exchange_rate` and rounds
    the result per the billing rounding policy (round_money). Centralizes the
    `amount * rate` (+ round) pattern used wherever a document-level amount is
    converted and persisted (invoice/quote line items, subscription MRR
    rollups). NOT for use inside CalculationService.calculate_line_item's
    intermediate `converted_*` fields — those are deliberately left unrounded
    so a document's final totals aren't distorted by rounding each line twice.
    """
    return round_money(Decimal(str(amount)) * Decimal(str(exchange_rate)), currency_code)


def format_currency_display(amount, currency_code: str, position: str = "before") -> str:
    symbol = get_currency_symbol(currency_code)
    decimals = get_currency_decimal_digits(currency_code)
    try:
        formatted = f"{round_money(amount, currency_code):.{decimals}f}"
    except (ValueError, TypeError, ArithmeticError):
        formatted = str(amount)
    if position == "after":
        return f"{formatted}{symbol}"
    return f"{symbol}{formatted}"


# The canonical set of currency codes accepted wherever a field is validated
# against the CurrencyCode enum (models.py) — previously recomputed
# independently as `{c.value for c in CurrencyCode}` in admin_service.py,
# payment_service.py, and validation_service.py.
VALID_CURRENCY_CODES = {c.value for c in CurrencyCode}


def validate_currency_code(code: str) -> bool:
    return code in VALID_CURRENCY_CODES


def validate_language_code(code: str) -> bool:
    valid_codes = {
        "en", "hi", "te", "ta", "kn", "ml", "mr", "bn", "gu", "pa",
        "ur", "ar", "fr", "de", "es", "pt", "nl", "zh", "ja", "ko",
        "ru", "it", "tr",
    }
    return code in valid_codes
