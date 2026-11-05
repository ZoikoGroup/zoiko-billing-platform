"""
Provider adapter conformance suite (ZB-TAX-ARCH-001 Phase 4a-1).

Every ProviderAdapter must pass these checks before it is registered in
app.modules.tax.engines.PROVIDERS. Today they run against the fake
(tests/test_tax_provider_conformance.py); in 4d the same checks run against
the chosen provider's sandbox through `run_all(make_adapter, ...)`.

`make_adapter(**faults)` returns a fresh adapter. Fault keywords are adapter
specific (sandboxes simulate faults differently); a check that needs a fault
the adapter cannot simulate is reported as skipped, never as passed.
"""
import logging
from datetime import date
from decimal import Decimal

from app.modules.tax.provider_contract import (
    ALLOWED_COMMIT_FIELDS,
    ALLOWED_LINE_FIELDS,
    ProviderAdapter,
    ProviderCapabilities,
    ProviderError,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderTransaction,
    RemoteTransactionState,
)


def sample_payload(key: str, tax: str = "12.34", net: str = "123.40", currency: str = "GBP",
                   tax_date: date = date(2026, 6, 1)) -> dict:
    """A minimal, allowed-fields-only commit payload."""
    return {
        "idempotency_key": key, "document_reference": key, "document_type": "invoice",
        "tax_date": tax_date.isoformat(), "currency": currency,
        "seller": {"country_code": "GB", "subdivision_code": None},
        "buyer": {"address": {"country_code": "GB", "subdivision_code": None, "postal_code": "SW1A 1AA",
                              "city": "London"}},
        "lines": [{"line_id": 1, "quantity": "1", "net_amount": net, "line_discount": "0", "document_discount": "0",
                   "tax_code": "SVC", "is_tax_inclusive": False,
                   "components": [{"component_code": "C1", "tax_amount": tax}]}],
        "totals": {"tax": tax, "total": str(Decimal(net) + Decimal(tax))},
    }


class Skip(Exception):
    pass


def check_contract_shape(make_adapter):
    adapter = make_adapter()
    assert isinstance(adapter, ProviderAdapter)
    assert adapter.name and adapter.rounding_mode is not None, "an adapter must declare its rounding mode"
    assert isinstance(adapter.capabilities(), ProviderCapabilities)


def check_idempotent_commit(make_adapter):
    adapter = make_adapter()
    first = adapter.commit(idempotency_key="conf-1", payload=sample_payload("conf-1"))
    second = adapter.commit(idempotency_key="conf-1", payload=sample_payload("conf-1"))
    assert first == second, "the same key must return the same transaction"
    other = adapter.commit(idempotency_key="conf-2", payload=sample_payload("conf-2"))
    assert other != first


def check_transaction_state_reports_totals(make_adapter):
    adapter = make_adapter()
    assert adapter.transaction_state(idempotency_key="conf-none").state == RemoteTransactionState.NOT_FOUND
    tid = adapter.commit(idempotency_key="conf-3", payload=sample_payload("conf-3", tax="12.34", net="123.40"))
    txn = adapter.transaction_state(idempotency_key="conf-3")
    assert isinstance(txn, ProviderTransaction) and txn.state == RemoteTransactionState.COMMITTED
    assert txn.transaction_id == tid
    assert (txn.currency, txn.tax_date) == ("GBP", date(2026, 6, 1))
    assert txn.total_tax == Decimal("12.34") and txn.total_amount == Decimal("135.74")
    assert txn.components == {"C1": Decimal("12.34")}, "per-component amounts are needed by the drift check"


def check_void_by_reference(make_adapter):
    adapter = make_adapter()
    tid = adapter.commit(idempotency_key="conf-4", payload=sample_payload("conf-4"))
    adapter.void(transaction_id=tid, idempotency_key="conf-4:void", reason="conformance")
    assert adapter.transaction_state(idempotency_key="conf-4").state == RemoteTransactionState.VOIDED


def check_timeout_is_never_success(make_adapter):
    try:
        adapter = make_adapter(fail="timeout_after_success")
    except TypeError:
        raise Skip("adapter cannot simulate a timeout")
    try:
        adapter.commit(idempotency_key="conf-5", payload=sample_payload("conf-5"))
    except ProviderTimeout:
        pass
    else:
        raise AssertionError("a timeout must surface as ProviderTimeout, never as success")
    # the outcome is then discoverable by key
    assert adapter.transaction_state(idempotency_key="conf-5").state == RemoteTransactionState.COMMITTED


def check_rate_limit_is_retryable(make_adapter):
    try:
        adapter = make_adapter(fail="rate_limited")
    except TypeError:
        raise Skip("adapter cannot simulate throttling")
    try:
        adapter.commit(idempotency_key="conf-6", payload=sample_payload("conf-6"))
    except ProviderRateLimited as exc:
        assert exc.retry_after_seconds > 0
    else:
        raise AssertionError("throttling must surface as ProviderRateLimited")
    assert adapter.transaction_state(idempotency_key="conf-6").state == RemoteTransactionState.NOT_FOUND


def check_money_is_decimal_exact_and_signed(make_adapter):
    adapter = make_adapter()
    adapter.commit(idempotency_key="conf-7", payload=sample_payload("conf-7", tax="-0.01", net="-0.10"))
    txn = adapter.transaction_state(idempotency_key="conf-7")
    assert txn.total_tax == Decimal("-0.01") and isinstance(txn.total_tax, Decimal)
    assert sum(txn.components.values(), Decimal("0")) == txn.total_tax


def check_payload_fields_are_minimal():
    payload = sample_payload("conf-8")
    assert set(payload) <= ALLOWED_COMMIT_FIELDS
    assert all(set(line) <= ALLOWED_LINE_FIELDS for line in payload["lines"])


def check_credentials_never_leak(make_adapter, secret: str, caplog):
    try:
        adapter = make_adapter(fail="commit_error")
    except TypeError:
        raise Skip("adapter cannot simulate a refusal")
    with caplog.at_level(logging.DEBUG):
        try:
            adapter.commit(idempotency_key="conf-9", payload=sample_payload("conf-9"))
        except ProviderError as exc:
            assert secret not in str(exc) and secret not in repr(exc)
    assert secret not in caplog.text


CHECKS = [check_contract_shape, check_idempotent_commit, check_transaction_state_reports_totals,
          check_void_by_reference, check_timeout_is_never_success, check_rate_limit_is_retryable,
          check_money_is_decimal_exact_and_signed]
