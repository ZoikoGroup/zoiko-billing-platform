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
