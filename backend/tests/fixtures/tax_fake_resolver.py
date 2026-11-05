"""
tests/fixtures/tax_fake_resolver.py
-----------------------------------
A fake AddressResolver for Phase 4c tests. It resolves by street line from a
fixed table: test values, not a geocoding dataset.
"""
from app.modules.tax.address_resolver import (
    ADDRESS_RESOLVERS,
    AddressResolver,
    Resolution,
    ResolutionPrecision,
    ResolutionStatus,
)


class FakeAddressResolver(AddressResolver):
    name = "fake-resolver"

    def __init__(self):
        self.table: dict = {}            # line1 -> Resolution
        self.calls: list = []

    def resolve(self, address: dict) -> Resolution:
        self.calls.append(dict(address))
        return self.table.get(address["line1"], Resolution(status=ResolutionStatus.NOT_FOUND, source="fake-2026.11"))

    def add(self, line1: str, codes: tuple, *, precision=ResolutionPrecision.ROOFTOP, candidates: int = 1):
        self.table[line1] = Resolution(status=ResolutionStatus.RESOLVED, precision=precision,
                                       jurisdiction_codes=codes, candidates=candidates, source="fake-2026.11")


def register_fake_resolver() -> FakeAddressResolver:
    resolver = FakeAddressResolver()
    ADDRESS_RESOLVERS.clear()
    ADDRESS_RESOLVERS[resolver.name] = resolver
    return resolver
