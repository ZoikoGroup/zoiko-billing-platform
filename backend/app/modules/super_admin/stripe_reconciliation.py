"""
modules/super_admin/stripe_reconciliation.py
---------------------------------------------
ISS-017 — true ledger-vs-Stripe processor comparison for Plane 2 payments.

Scope (deliberately minimal, per the "do not invent unsupported mappings"
rule): this module compares Billing `Payment` rows against Stripe
`PaymentIntent` objects. This is the ONE mapping that is populated by every
real Stripe payment path in this codebase (`Payment.stripe_payment_intent_id`,
set by `StripeService._record_cleared_payment` / the `payment_intent.succeeded`
webhook handler — see `app/modules/billing/services/stripe_service.py`).
Invoice<->Stripe-Invoice and Refund<->Stripe-Refund mappings also exist in
the schema (`Invoice.stripe_invoice_id`, `Refund.gateway_refund_id`) but are
NOT implemented here — see the ISS-017 doc's "Known Limitations" section.

FINANCIAL SAFETY: this module is READ + COMPARE + CLASSIFY only. It never
writes to Payment/Invoice/Refund/PaymentAllocation — only to
ReconciliationRun/ReconciliationException (the existing audit-trail tables).

TENANT ISOLATION: every Stripe API call is scoped with
`stripe_account=<the organization's own connected_account_id>` (Stripe
Connect), and every ledger query is scoped with
`Payment.organization_id == organization_id`. One organization's
reconciliation pass never sees another organization's Stripe or ledger data.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.billing.models import Payment, PaymentStatus
from app.modules.billing.services.stripe_connect_service import (
    _resolve_environment,
    get_connected_account_row,
)
from app.modules.billing.models import IntegrationConnectionStatus, StripeConnectedAccount

logger = logging.getLogger("zoiko_billing.super_admin.reconciliation.stripe")

# ── Bounds (Step 8/15/20 — never unbounded Stripe traffic) ──────────────────
MAX_RANGE_DAYS = 92  # one calendar quarter
PAGE_SIZE = 100
MAX_RECORDS_PER_ORGANIZATION = 500

# Discrepancy kinds (Step 5). Reuses the existing ReconciliationException
# model (kind: str, entity_type: str, detail: JSON) — no new table/enum.
KIND_MISSING_IN_STRIPE = "stripe_missing_in_stripe"
KIND_MISSING_IN_LEDGER = "stripe_missing_in_ledger"
KIND_AMOUNT_MISMATCH = "stripe_amount_mismatch"
KIND_CURRENCY_MISMATCH = "stripe_currency_mismatch"
KIND_STATUS_MISMATCH = "stripe_status_mismatch"
KIND_DUPLICATE_PROCESSOR_RECORD = "stripe_duplicate_processor_record"
KIND_DUPLICATE_LEDGER_RECORD = "stripe_duplicate_ledger_record"
KIND_IDENTIFIER_MISMATCH = "stripe_identifier_mismatch"
KIND_UNSUPPORTED_MAPPING = "stripe_unsupported_mapping"

# Stripe PaymentIntent.status -> internal PaymentStatus (Step 7). Any Stripe
# status NOT in this map is treated as unmapped/unknown and flagged as a
# status mismatch for human review rather than silently ignored (Step 7 asks
# us not to flag a *known, differently-labeled* processor state as a
# discrepancy -- an entirely *unrecognized* status string is a different,
# safer-to-flag case).
_PI_STATUS_TO_INTERNAL: dict[str, PaymentStatus] = {
    "succeeded": PaymentStatus.CLEARED,
    "processing": PaymentStatus.PROCESSING,
    "requires_payment_method": PaymentStatus.PENDING,
    "requires_confirmation": PaymentStatus.PENDING,
    "requires_action": PaymentStatus.PENDING,
    "requires_capture": PaymentStatus.PENDING,
    "canceled": PaymentStatus.CANCELLED,
}


def _stripe_module():
    """Lazy import, mirroring `stripe_service._stripe_module()` — the app
    must still boot without the `stripe` package installed."""
    try:
        import stripe  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError(
            "The 'stripe' package is not installed."
        ) from e
    if not settings.STRIPE_SECRET_KEY:
        raise RuntimeError("Stripe is not configured (STRIPE_SECRET_KEY is blank).")
    stripe.api_key = settings.STRIPE_SECRET_KEY
    return stripe


def _cents_to_decimal(cents: Any) -> Decimal:
    return (Decimal(str(cents)) / Decimal("100")).quantize(Decimal("0.01"))


def _day_range_to_unix(range_start: date, range_end: date) -> dict:
    start_dt = datetime.combine(range_start, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(range_end, time.max, tzinfo=timezone.utc)
    return {"gte": int(start_dt.timestamp()), "lte": int(end_dt.timestamp())}


def classify_stripe_error(stripe_module, exc: Exception) -> dict:
    """Map a raised Stripe SDK exception to a safe, secret-free diagnostic.

    Never includes the API key, request headers, or raw exception repr —
    only `type(exc).__name__`-derived category and Stripe's own
    user-facing message (Step 14/22)."""
    if isinstance(exc, stripe_module.AuthenticationError):
        category = "authentication_failure"
    elif isinstance(exc, stripe_module.RateLimitError):
        category = "rate_limit"
    elif isinstance(exc, stripe_module.APIConnectionError):
        # The stripe-python SDK does not distinguish a bare network failure
        # from a request timeout — both raise APIConnectionError.
        category = "network_or_timeout"
    elif isinstance(exc, stripe_module.InvalidRequestError):
        category = "invalid_request"
    elif isinstance(exc, stripe_module.PermissionError):
        category = "authentication_failure"
    elif isinstance(exc, stripe_module.StripeError):
        category = "processor_api_error"
    else:
        category = "unexpected_error"
    message = getattr(exc, "user_message", None) or str(exc) or "Stripe request failed"
    return {"category": category, "message": message}


@dataclass
class OrgReconciliationResult:
    organization_id: int
    compared: bool  # True only if at least one real Stripe API call succeeded
    records_inspected: int = 0
    records_matched: int = 0
    exceptions: list[dict] = field(default_factory=list)
    error: Optional[dict] = None  # {"category": ..., "message": ...} if the org's comparison could not fully complete
    truncated: bool = False
    skip_reason: Optional[str] = None  # set when the org has no active Stripe connection (not an error)


def _list_stripe_payment_intents(
    stripe_module, connected_account_id: str, range_start: date, range_end: date,
) -> tuple[dict[str, Any], list[str], bool, Optional[dict]]:
    """Bounded, paginated retrieval of one org's PaymentIntents.

    Returns (records_by_id, duplicate_ids, truncated, error). `error` is set
    (and retrieval stops) on the first processor failure; whatever was
    already fetched is still returned so the caller can report partial
    scope rather than discarding it silently.
    """
    records: dict[str, Any] = {}
    duplicates: list[str] = []
    starting_after = None
    fetched = 0
    created_filter = _day_range_to_unix(range_start, range_end)

    while fetched < MAX_RECORDS_PER_ORGANIZATION:
        limit = min(PAGE_SIZE, MAX_RECORDS_PER_ORGANIZATION - fetched)
        try:
            page = stripe_module.PaymentIntent.list(
                stripe_account=connected_account_id,
                created=created_filter,
                limit=limit,
                starting_after=starting_after,
            )
        except Exception as e:  # noqa: BLE001 - classified immediately below
            return records, duplicates, fetched >= MAX_RECORDS_PER_ORGANIZATION, classify_stripe_error(stripe_module, e)

        page_data = list(getattr(page, "data", None) or [])
        if not page_data:
            break
        for obj in page_data:
            pid = getattr(obj, "id", None)
            if not pid:
                continue
            if pid in records:
                duplicates.append(pid)
            else:
                records[pid] = obj
            fetched += 1
        has_more = bool(getattr(page, "has_more", False))
        if not has_more:
            break
        starting_after = getattr(page_data[-1], "id", None)
        if starting_after is None:
            break

    truncated = fetched >= MAX_RECORDS_PER_ORGANIZATION
    return records, duplicates, truncated, None


def _status_compatible(internal_status: PaymentStatus, stripe_status: str) -> bool:
    # A Stripe PaymentIntent stays "succeeded" forever even after the
    # underlying charge is later refunded — Stripe tracks refunds on the
    # Charge/Refund objects, not on PaymentIntent.status. Our ledger
    # correctly moves the Payment to REFUNDED; that is not a discrepancy.
    if internal_status == PaymentStatus.REFUNDED and stripe_status == "succeeded":
        return True
    expected = _PI_STATUS_TO_INTERNAL.get(stripe_status)
    if expected is None:
        return False
    return expected == internal_status


def reconcile_organization_payments(
    db: Session, organization_id: int, range_start: date, range_end: date,
) -> OrgReconciliationResult:
    """Compare one organization's ledger Payments against its own Stripe
    PaymentIntents, scoped entirely to that organization's connected
    account (tenant isolation) and to the given bounded date range."""
    result = OrgReconciliationResult(organization_id=organization_id, compared=False)

    environment = _resolve_environment()
    account_row = get_connected_account_row(db, organization_id, env=environment)
    if account_row is None or account_row.status != IntegrationConnectionStatus.ACTIVE:
        result.skip_reason = "no_active_stripe_connection"
        return result

    # ── Ledger side (scoped strictly to this organization) ──────────────
    ledger_rows = (
        db.query(Payment)
        .filter(
            Payment.organization_id == organization_id,
            Payment.stripe_payment_intent_id.isnot(None),
            Payment.payment_date >= range_start,
            Payment.payment_date <= range_end,
        )
        .all()
    )
    ledger_by_pi: dict[str, list[Payment]] = {}
    for p in ledger_rows:
        ledger_by_pi.setdefault(p.stripe_payment_intent_id, []).append(p)

    for pi_id, payments in ledger_by_pi.items():
        if len(payments) > 1:
            result.exceptions.append({
                "kind": KIND_DUPLICATE_LEDGER_RECORD,
                "entity_type": "payment",
                "entity_id": payments[0].id,
                "detail": {
                    "stripe_payment_intent_id": pi_id,
                    "conflicting_payment_ids": [p.id for p in payments],
                },
            })
        if not pi_id.startswith("pi_"):
            result.exceptions.append({
                "kind": KIND_IDENTIFIER_MISMATCH,
                "entity_type": "payment",
                "entity_id": payments[0].id,
                "detail": {
                    "reason": "stripe_payment_intent_id does not match Stripe's PaymentIntent id format",
                    "stored_value": pi_id,
                },
            })

    # Ledger rows that only ever reached "checkout session created" (no
    # PaymentIntent id known yet) cannot be safely compared as if they were
    # a PaymentIntent — flag as unsupported mapping rather than a false
    # MISSING_IN_STRIPE.
    checkout_only = (
        db.query(Payment)
        .filter(
            Payment.organization_id == organization_id,
            Payment.stripe_payment_intent_id.is_(None),
            Payment.stripe_checkout_session_id.isnot(None),
            Payment.payment_date >= range_start,
            Payment.payment_date <= range_end,
        )
        .all()
    )
    for p in checkout_only:
        result.exceptions.append({
            "kind": KIND_UNSUPPORTED_MAPPING,
            "entity_type": "payment",
            "entity_id": p.id,
            "detail": {
                "reason": "payment has a Stripe checkout session id but no PaymentIntent id yet; not comparable",
                "stripe_checkout_session_id": p.stripe_checkout_session_id,
            },
        })

    # ── Processor side ────────────────────────────────────────────────────
    stripe_module = _stripe_module()
    stripe_records, dup_ids, truncated, error = _list_stripe_payment_intents(
        stripe_module, account_row.connected_account_id, range_start, range_end,
    )
    result.truncated = truncated
    if error is not None:
        result.error = error
        # Whatever was retrieved before the failure is still compared below
        # (partial scope), but `result.compared` stays False so the caller
        # never treats this organization as fully verified.
    else:
        result.compared = True

    for pid in dup_ids:
        result.exceptions.append({
            "kind": KIND_DUPLICATE_PROCESSOR_RECORD,
            "entity_type": "payment",
            "entity_id": None,
            "detail": {"stripe_payment_intent_id": pid},
        })

    matched_ids = set(ledger_by_pi.keys()) & set(stripe_records.keys())
    missing_in_stripe = set(ledger_by_pi.keys()) - set(stripe_records.keys())
    missing_in_ledger = set(stripe_records.keys()) - set(ledger_by_pi.keys())

    # If retrieval failed/truncated, we cannot be sure an id "missing in
    # Stripe" is a real discrepancy vs. simply not-yet-fetched — do not
    # accuse the ledger falsely; only report matches/mismatches we could
    # actually verify, and let `result.error`/`truncated` keep the run from
    # claiming VERIFIED.
    if error is None and not truncated:
        for pi_id in missing_in_stripe:
            result.exceptions.append({
                "kind": KIND_MISSING_IN_STRIPE,
                "entity_type": "payment",
                "entity_id": ledger_by_pi[pi_id][0].id,
                "detail": {"stripe_payment_intent_id": pi_id},
            })
        for pi_id in missing_in_ledger:
            result.exceptions.append({
                "kind": KIND_MISSING_IN_LEDGER,
                "entity_type": "payment",
                "entity_id": None,
                "detail": {"stripe_payment_intent_id": pi_id},
            })

    for pi_id in matched_ids:
        payment = ledger_by_pi[pi_id][0]  # duplicates already flagged above
        stripe_obj = stripe_records[pi_id]
        stripe_currency = (getattr(stripe_obj, "currency", "") or "").upper()
        internal_currency = (payment.currency or "").upper()
        if stripe_currency != internal_currency:
            result.exceptions.append({
                "kind": KIND_CURRENCY_MISMATCH,
                "entity_type": "payment",
                "entity_id": payment.id,
                "detail": {
                    "stripe_payment_intent_id": pi_id,
                    "ledger_currency": internal_currency,
                    "stripe_currency": stripe_currency,
                },
            })
        else:
            stripe_amount_cents = getattr(stripe_obj, "amount_received", None)
            if stripe_amount_cents is None:
                stripe_amount_cents = getattr(stripe_obj, "amount", 0)
            stripe_amount = _cents_to_decimal(stripe_amount_cents)
            ledger_amount = Decimal(str(payment.amount or 0))
            if abs(ledger_amount - stripe_amount) > Decimal("0.01"):
                result.exceptions.append({
                    "kind": KIND_AMOUNT_MISMATCH,
                    "entity_type": "payment",
                    "entity_id": payment.id,
                    "detail": {
                        "stripe_payment_intent_id": pi_id,
                        "ledger_amount": str(ledger_amount),
                        "stripe_amount": str(stripe_amount),
                        "currency": internal_currency,
                    },
                })

        stripe_status = getattr(stripe_obj, "status", None)
        if stripe_status and not _status_compatible(payment.status, stripe_status):
            result.exceptions.append({
                "kind": KIND_STATUS_MISMATCH,
                "entity_type": "payment",
                "entity_id": payment.id,
                "detail": {
                    "stripe_payment_intent_id": pi_id,
                    "ledger_status": payment.status.value if hasattr(payment.status, "value") else str(payment.status),
                    "stripe_status": stripe_status,
                },
            })

        result.records_matched += 1

    result.records_inspected = len(ledger_by_pi) + len(missing_in_ledger)
    return result


def reconcile_processor_payments(
    db: Session, range_start: date, range_end: date,
) -> dict:
    """Top-level orchestrator: iterate every organization with an ACTIVE
    Stripe connection in the current environment, reconcile each one
    independently (tenant-isolated), and aggregate the results.

    Returns a dict shaped for storage in `ReconciliationRun.processor_stats`
    plus a flat list of exception dicts ready to become
    `ReconciliationException` rows.
    """
    environment = _resolve_environment()
    connected_org_ids = [
        row.organization_id
        for row in (
            db.query(StripeConnectedAccount)
            .filter(
                StripeConnectedAccount.environment == environment,
                StripeConnectedAccount.status == IntegrationConnectionStatus.ACTIVE,
            )
            .all()
        )
    ]

    all_exceptions: list[dict] = []
    organizations_compared: list[int] = []
    processor_errors: list[dict] = []
    records_inspected = 0
    records_matched = 0
    any_truncated = False

    for org_id in connected_org_ids:
        org_result = reconcile_organization_payments(db, org_id, range_start, range_end)
        for exc in org_result.exceptions:
            exc = dict(exc)
            exc["organization_id"] = org_id
            all_exceptions.append(exc)
        records_inspected += org_result.records_inspected
        records_matched += org_result.records_matched
        if org_result.truncated:
            any_truncated = True
            processor_errors.append({
                "organization_id": org_id,
                "category": "range_truncated",
                "message": (
                    f"Reached the {MAX_RECORDS_PER_ORGANIZATION}-record bound before "
                    "exhausting Stripe's result set for this range; comparison scope "
                    "for this organization is incomplete."
                ),
            })
        if org_result.error is not None:
            processor_errors.append({"organization_id": org_id, **org_result.error})
        if org_result.compared:
            organizations_compared.append(org_id)

    fully_verified = (
        bool(organizations_compared)
        and not processor_errors
        and not any_truncated
        and not all_exceptions
    )

    return {
        "environment": environment.value if hasattr(environment, "value") else str(environment),
        "range_start": range_start.isoformat(),
        "range_end": range_end.isoformat(),
        "organizations_with_active_connection": connected_org_ids,
        "organizations_compared": organizations_compared,
        "records_inspected": records_inspected,
        "records_matched": records_matched,
        "processor_errors": processor_errors,
        "exceptions": all_exceptions,
        "any_comparison_performed": bool(organizations_compared),
        "fully_verified": fully_verified,
    }
