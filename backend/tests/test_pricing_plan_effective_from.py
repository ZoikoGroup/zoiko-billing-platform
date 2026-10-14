"""Pricing plans cannot start in the past (Effective From)."""
from datetime import date, timedelta

import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.services.pricing_service import PricingService

check = PricingService._reject_past_effective_from


def test_rejects_past_year():
    with pytest.raises(BadRequestException, match="cannot be in the past"):
        check(date(2014, 12, 12))


def test_rejects_two_days_ago():
    with pytest.raises(BadRequestException):
        check(date.today() - timedelta(days=2))


def test_allows_today_yesterday_grace_and_future():
    check(date.today())
    check(date.today() - timedelta(days=1))  # timezone grace
    check(date.today() + timedelta(days=30))
    check(None)
