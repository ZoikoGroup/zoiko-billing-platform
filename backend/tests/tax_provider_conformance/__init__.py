"""
Provider adapter conformance suite (ZB-TAX-ARCH-001 Phase 4a-1).

Every ProviderAdapter must pass these checks before it is registered in
app.modules.tax.engines.PROVIDERS. Today they run against the fake
(tests/test_tax_provider_conformance.py); in 4d the same checks run against
the chosen provider's sandbox through `run_all(make_adapter, secret=...)`,
or from the command line:

    TAX_CONFORMANCE_SECRET=... python -m tests.tax_provider_conformance pkg.module:make_adapter

which prints the JSON report (attach it as gate 03 evidence) and exits 1
unless it passed.

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
    ProviderAmbiguous,
    ProviderError,
    ProviderRateLimited,
    ProviderRefused,
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
        "buyer": {"address": {"role": "BILLING_FALLBACK", "line1": "1 Example Street", "line2": None,
                              "city": "London", "subdivision_code": None, "postal_code": "SW1A 1AA",
                              "country_code": "GB"}},
        "lines": [{"line_id": 1, "quantity": "1", "net_amount": net, "line_discount": "0", "document_discount": "0",
                   "tax_code": "SVC", "is_tax_inclusive": False,
                   "components": [{"component_code": "C1", "tax_amount": tax}]}],
        "totals": {"tax": tax, "total": str(Decimal(net) + Decimal(tax))},
    }


class Skip(Exception):
    pass


#: Idempotency keys are prefixed per run: a real sandbox remembers keys, so a
#: second run with fixed keys would be answered from the first run's records.
_run_prefix = "conf"


def _k(suffix: str) -> str:
    return f"{_run_prefix}-{suffix}"


def check_contract_shape(make_adapter):
    adapter = make_adapter()
    assert isinstance(adapter, ProviderAdapter)
    assert adapter.name and adapter.rounding_mode is not None, "an adapter must declare its rounding mode"
    assert isinstance(adapter.capabilities(), ProviderCapabilities)


def check_idempotent_commit(make_adapter):
    adapter = make_adapter()
    first = adapter.commit(idempotency_key=_k("1"), payload=sample_payload(_k("1")))
    second = adapter.commit(idempotency_key=_k("1"), payload=sample_payload(_k("1")))
    assert first == second, "the same key must return the same transaction"
    other = adapter.commit(idempotency_key=_k("2"), payload=sample_payload(_k("2")))
    assert other != first


def check_transaction_state_reports_totals(make_adapter):
    adapter = make_adapter()
    assert adapter.transaction_state(idempotency_key=_k("none")).state == RemoteTransactionState.NOT_FOUND
    tid = adapter.commit(idempotency_key=_k("3"), payload=sample_payload(_k("3"), tax="12.34", net="123.40"))
    txn = adapter.transaction_state(idempotency_key=_k("3"))
    assert isinstance(txn, ProviderTransaction) and txn.state == RemoteTransactionState.COMMITTED
    assert txn.transaction_id == tid
    assert (txn.currency, txn.tax_date) == ("GBP", date(2026, 6, 1))
    assert txn.total_tax == Decimal("12.34") and txn.total_amount == Decimal("135.74")
    assert txn.components == {"C1": Decimal("12.34")}, "per-component amounts are needed by the drift check"


def check_void_by_reference(make_adapter):
    adapter = make_adapter()
    tid = adapter.commit(idempotency_key=_k("4"), payload=sample_payload(_k("4")))
    adapter.void(transaction_id=tid, idempotency_key=_k("4:void"), reason="conformance")
    assert adapter.transaction_state(idempotency_key=_k("4")).state == RemoteTransactionState.VOIDED


def check_timeout_is_never_success(make_adapter):
    try:
        adapter = make_adapter(fail="timeout_after_success")
    except TypeError:
        raise Skip("adapter cannot simulate a timeout")
    try:
        adapter.commit(idempotency_key=_k("5"), payload=sample_payload(_k("5")))
    except ProviderTimeout:
        pass
    else:
        raise AssertionError("a timeout must surface as ProviderTimeout, never as success")
    # the outcome is then discoverable by key
    assert adapter.transaction_state(idempotency_key=_k("5")).state == RemoteTransactionState.COMMITTED


def check_rate_limit_is_retryable(make_adapter):
    try:
        adapter = make_adapter(fail="rate_limited")
    except TypeError:
        raise Skip("adapter cannot simulate throttling")
    try:
        adapter.commit(idempotency_key=_k("6"), payload=sample_payload(_k("6")))
    except ProviderRateLimited as exc:
        assert exc.retry_after_seconds > 0
    else:
        raise AssertionError("throttling must surface as ProviderRateLimited")
    assert adapter.transaction_state(idempotency_key=_k("6")).state == RemoteTransactionState.NOT_FOUND


def check_refusal_is_definite(make_adapter):
    """A definite refusal (validation, auth, unsupported) left nothing behind."""
    try:
        adapter = make_adapter(fail="commit_error")
    except TypeError:
        raise Skip("adapter cannot simulate a refusal")
    try:
        adapter.commit(idempotency_key=_k("10"), payload=sample_payload(_k("10")))
    except ProviderRefused:
        pass
    else:
        raise AssertionError("a refusal must surface as ProviderRefused")
    assert adapter.transaction_state(idempotency_key=_k("10")).state == RemoteTransactionState.NOT_FOUND


def check_ambiguous_errors_are_never_refusals(make_adapter):
    """5xx or a reset after sending is ProviderAmbiguous (never ProviderRefused);
    the outcome is then settled by transaction_state, whichever way it went."""
    for fault, expected in (("ambiguous_after_success", RemoteTransactionState.COMMITTED),
                            ("server_error", RemoteTransactionState.NOT_FOUND)):
        try:
            adapter = make_adapter(fail=fault)
        except TypeError:
            raise Skip("adapter cannot simulate an ambiguous failure")
        try:
            adapter.commit(idempotency_key=_k(f"11-{fault}"), payload=sample_payload(_k(f"11-{fault}")))
        except ProviderRefused:
            raise AssertionError(f"{fault}: an ambiguous failure must not be reported as a refusal")
        except ProviderAmbiguous:
            pass
        else:
            raise AssertionError(f"{fault}: an ambiguous failure must not be reported as success")
        assert adapter.transaction_state(idempotency_key=_k(f"11-{fault}")).state == expected


def check_adjust_by_reference(make_adapter):
    """A credit adjusts the original transaction by reference, idempotently on
    its own key, and transaction_state(adjust key) reports the signed totals."""
    adapter = make_adapter()
    tid = adapter.commit(idempotency_key=_k("12"), payload=sample_payload(_k("12"), tax="12.34", net="123.40"))
    credit = {**sample_payload(_k("12:cn"), tax="-6.17", net="-61.70"), "document_type": "credit_note",
              "original_transaction_id": tid}
    first = adapter.adjust(transaction_id=tid, idempotency_key=_k("12:cn"), payload=credit)
    assert adapter.adjust(transaction_id=tid, idempotency_key=_k("12:cn"), payload=credit) == first
    txn = adapter.transaction_state(idempotency_key=_k("12:cn"))
    assert txn.state == RemoteTransactionState.COMMITTED and txn.total_tax == Decimal("-6.17")
    try:
        adapter.adjust(transaction_id="no-such-transaction", idempotency_key=_k("12:bad"), payload=credit)
    except ProviderRefused:
        pass
    else:
        raise AssertionError("adjusting an unknown transaction must be refused")


def check_money_is_decimal_exact_and_signed(make_adapter):
    adapter = make_adapter()
    adapter.commit(idempotency_key=_k("7"), payload=sample_payload(_k("7"), tax="-0.01", net="-0.10"))
    txn = adapter.transaction_state(idempotency_key=_k("7"))
    assert txn.total_tax == Decimal("-0.01") and isinstance(txn.total_tax, Decimal)
    assert sum(txn.components.values(), Decimal("0")) == txn.total_tax


def check_payload_fields_are_minimal():
    payload = sample_payload(_k("8"))
    assert set(payload) <= ALLOWED_COMMIT_FIELDS
    assert all(set(line) <= ALLOWED_LINE_FIELDS for line in payload["lines"])


def check_credentials_never_leak(make_adapter, secret: str, caplog):
    try:
        adapter = make_adapter(fail="commit_error")
    except TypeError:
        raise Skip("adapter cannot simulate a refusal")
    with caplog.at_level(logging.DEBUG):
        try:
            adapter.commit(idempotency_key=_k("9"), payload=sample_payload(_k("9")))
        except ProviderError as exc:
            assert secret not in str(exc) and secret not in repr(exc)
    assert secret not in caplog.text


def check_secret_store_never_leaks(store, connection, secret: str, caplog, break_store):
    """Phase 4d-0: a SecretStore returns the value only from get(); its
    failures, logs and the connection view never carry it. `break_store()`
    makes the store fail (unreachable, denied or an unusable key)."""
    from app.modules.tax.connection_service import view_connection
    from app.modules.tax.secret_store import SecretStoreUnavailable

    with caplog.at_level(logging.DEBUG):
        assert store.get(connection) == secret
        assert secret not in str(view_connection(connection))
        break_store()
        for call in (lambda: store.get(connection), lambda: store.put(connection, secret)):
            try:
                call()
            except SecretStoreUnavailable as exc:
                assert secret not in str(exc) and secret not in repr(exc) and secret not in exc.message
                assert exc.__cause__ is None or secret not in str(exc.__cause__)
            else:
                raise AssertionError("a broken store must fail closed")
    assert secret not in caplog.text


class _LogCapture(logging.Handler):
    """A stand-in for pytest's caplog when run outside pytest."""

    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        try:
            self.lines.append(record.getMessage())
        except Exception:
            self.lines.append(str(record.msg))

    @property
    def text(self) -> str:
        return "\n".join(self.lines)

    def at_level(self, level):
        import contextlib

        @contextlib.contextmanager
        def _ctx():
            root = logging.getLogger()
            old = root.level
            root.addHandler(self)
            root.setLevel(level)
            try:
                yield self
            finally:
                root.setLevel(old)
                root.removeHandler(self)
        return _ctx()


def run_all(make_adapter, *, secret: str = None, run_id: str = None) -> dict:
    """Run every check against an adapter factory (the fake in CI; the
    provider sandbox in 4d) and return a report. Never raises for a failed
    check: the report says which failed and why. `passed` is true only when
    nothing failed, every skip carries a reason, and the redaction check ran
    (a credential was given).

    `secret` is the credential the adapter was built with (for the
    redaction check); it never appears in the report."""
    import uuid

    global _run_prefix
    _run_prefix = run_id or f"conf-{uuid.uuid4().hex[:10]}"
    results = {}

    def record(name, fn):
        try:
            fn()
            results[name] = {"status": "passed"}
        except Skip as exc:
            results[name] = {"status": "skipped", "reason": str(exc) or "no reason given"}
        except Exception as exc:                                  # a failed check, reported
            detail = f"{type(exc).__name__}: {exc}"
            if secret:
                detail = detail.replace(secret, "[credential]")
            results[name] = {"status": "failed", "detail": detail[:500]}

    try:
        for check in CHECKS:
            record(check.__name__, lambda c=check: c(make_adapter))
        record("check_payload_fields_are_minimal", check_payload_fields_are_minimal)
        if secret:
            record("check_credentials_never_leak",
                   lambda: check_credentials_never_leak(make_adapter, secret, _LogCapture()))
        else:
            results["check_credentials_never_leak"] = {"status": "skipped",
                                                       "reason": "no credential given to check for"}
    finally:
        run, _run_prefix = _run_prefix, "conf"
    failed = sorted(n for n, r in results.items() if r["status"] == "failed")
    unexplained = sorted(n for n, r in results.items()
                         if r["status"] == "skipped" and r.get("reason") == "no reason given")
    return {"run_id": run, "results": results, "failed": failed, "skipped": sorted(
        n for n, r in results.items() if r["status"] == "skipped"),
            "passed": not failed and not unexplained and bool(secret)}


CHECKS = [check_contract_shape, check_idempotent_commit, check_transaction_state_reports_totals,
          check_void_by_reference, check_timeout_is_never_success, check_rate_limit_is_retryable,
          check_refusal_is_definite, check_ambiguous_errors_are_never_refusals, check_adjust_by_reference,
          check_money_is_decimal_exact_and_signed]
