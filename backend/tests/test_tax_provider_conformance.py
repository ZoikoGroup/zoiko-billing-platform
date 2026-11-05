"""
ZB-TAX-ARCH-001 Phase 4a-1: the provider conformance suite, run against the
fake. In 4d the same checks run against a real provider's sandbox.
"""
import pytest

from tests.fixtures.tax_fake_provider import FAKE_SECRET, FakeTaxProvider
from tests.tax_provider_conformance import (
    CHECKS,
    Skip,
    check_credentials_never_leak,
    check_payload_fields_are_minimal,
)


def make_fake(fail: str = ""):
    return FakeTaxProvider(fail_mode=fail)


@pytest.mark.parametrize("check", CHECKS, ids=lambda c: c.__name__)
def test_fake_provider_conforms(check):
    try:
        check(make_fake)
    except Skip as exc:
        pytest.skip(str(exc))


def test_payload_fields_are_minimal():
    check_payload_fields_are_minimal()


def test_fake_provider_never_leaks_credentials(caplog):
    check_credentials_never_leak(make_fake, FAKE_SECRET, caplog)


def test_fake_determine_error_does_not_leak_the_credential():
    from app.modules.tax.provider_contract import ProviderError

    provider = FakeTaxProvider(fail_mode="determine_error")
    with pytest.raises(ProviderError) as exc:
        provider.determine(type("R", (), {"activations": [], "tax_date": None, "currency": "GBP"})())
    assert FAKE_SECRET not in str(exc.value)


# ── run_all: the runner used against a provider sandbox in 4d ───────────

def test_run_all_passes_the_fake_and_reports_every_check():
    from tests.tax_provider_conformance import run_all

    report = run_all(make_fake, secret=FAKE_SECRET)
    assert report["passed"] is True and report["failed"] == [] and report["skipped"] == []
    assert set(report["results"]) == {c.__name__ for c in CHECKS} | {
        "check_payload_fields_are_minimal", "check_credentials_never_leak"}
    assert FAKE_SECRET not in str(report)


def test_run_all_uses_fresh_keys_per_run_so_a_sandbox_can_be_rerun():
    from tests.tax_provider_conformance import run_all

    shared = FakeTaxProvider()                                  # a sandbox keeps its ledger between runs

    def sandbox(fail: str = ""):
        return FakeTaxProvider(fail_mode=fail) if fail else shared

    first = run_all(sandbox, secret=FAKE_SECRET)
    keys_after_first = set(shared.ledger)
    second = run_all(sandbox, secret=FAKE_SECRET)
    assert first["passed"] and second["passed"] and first["run_id"] != second["run_id"]
    assert keys_after_first and all(k.startswith(first["run_id"]) for k in keys_after_first)
    assert all(k.startswith(second["run_id"]) for k in set(shared.ledger) - keys_after_first)
    assert len(shared.ledger) == 2 * len(keys_after_first)


def test_run_all_reports_failures_without_the_credential():
    from app.modules.tax.provider_contract import ProviderRefused
    from tests.tax_provider_conformance import run_all

    class Broken(FakeTaxProvider):
        def commit(self, *, idempotency_key, payload, **kw):
            raise ProviderRefused(f"rejected credential {FAKE_SECRET}")

    report = run_all(lambda fail="": Broken(fail_mode=fail), secret=FAKE_SECRET)
    assert report["passed"] is False and "check_idempotent_commit" in report["failed"]
    assert FAKE_SECRET not in str(report) and "[credential]" in str(report)


def test_run_all_without_a_credential_does_not_pass():
    from tests.tax_provider_conformance import run_all

    report = run_all(make_fake)
    assert report["failed"] == [] and report["passed"] is False
    assert report["results"]["check_credentials_never_leak"]["status"] == "skipped"


def test_run_all_command_line(monkeypatch, capsys):
    import json

    from tests.tax_provider_conformance.__main__ import main

    monkeypatch.setenv("TAX_CONFORMANCE_SECRET", FAKE_SECRET)
    assert main(["tests.test_tax_provider_conformance:make_fake"]) == 0
    out = capsys.readouterr().out
    assert json.loads(out)["passed"] is True and FAKE_SECRET not in out
    assert main(["no-colon"]) == 2
