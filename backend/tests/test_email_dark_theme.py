"""
tests/test_email_dark_theme.py
-------------------------------
Unit & integration tests for Dark Theme Design System (Prompt 2 of 5)
of the Zoiko Billing Email System.
"""

import pytest
from app.services.email_foundation.enums import TemplateTier
from app.services.email_foundation.renderer import (
    render_dark_email,
    calculate_contrast_ratio,
    COLOR_BG_DARK,
    COLOR_TEXT_PRIMARY,
    COLOR_TEXT_SECONDARY,
    COLOR_ACCENT_BLUE,
    COLOR_SUCCESS,
    COLOR_ERROR,
    COLOR_WARNING,
)
from app.services.email_foundation.contract import TierEnforcementError


def test_contrast_ratios_pass_wcag_aaa():
    """Verification #3: Prove contrast ratios pass accessibility standards (>7:1 for AAA)."""
    # 1. White Primary Text against Dark Background (#0B1220)
    contrast_primary = calculate_contrast_ratio(COLOR_TEXT_PRIMARY, COLOR_BG_DARK)
    assert contrast_primary >= 7.0, f"Primary text contrast ratio {contrast_primary:.2f} must be >= 7.0 (WCAG AAA)"

    # 2. Secondary Text (#B0C4DE) against Dark Background
    contrast_secondary = calculate_contrast_ratio(COLOR_TEXT_SECONDARY, COLOR_BG_DARK)
    assert contrast_secondary >= 7.0, f"Secondary text contrast ratio {contrast_secondary:.2f} must be >= 7.0 (WCAG AAA)"

    # 3. Accent Blue (#60A5FA) against Dark Background
    contrast_accent = calculate_contrast_ratio(COLOR_ACCENT_BLUE, COLOR_BG_DARK)
    assert contrast_accent >= 7.0, f"Accent blue contrast ratio {contrast_accent:.2f} must be >= 7.0 (WCAG AAA)"


def test_bgcolor_fallback_present_for_outlook():
    """Verification #2: Prove bgcolor attribute is present for Outlook desktop fallback."""
    rendered_html = render_dark_email(
        tier=TemplateTier.T1,
        eyebrow="INVOICE #1042",
        heading="Your Invoice from Zoiko",
        body_content="Please find your invoice details below.",
        primary_action_label="View Invoice",
        primary_action_url="https://zoikoone.com/invoices/1042",
    )

    # Must contain HTML bgcolor="#0B1220" attribute
    assert 'bgcolor="#0B1220"' in rendered_html
    assert 'bgcolor="#131D31"' in rendered_html
    assert 'linear-gradient(164.56deg, #0B1220 0%, #101B33 60%, #0A0F1F 100%)' in rendered_html


def test_representative_templates_render_per_tier():
    """Verification #1: Render representative templates across T0–T4 through the master dark shell."""
    # T0 — Security Notice (Neutral calm blue accent ONLY)
    t0_html = render_dark_email(
        tier=TemplateTier.T0,
        eyebrow="SECURITY NOTICE",
        heading="Admin Account Created",
        body_content="Your administrator account has been created.",
        primary_action_label="Sign In",
        primary_action_url="https://zoikoone.com/login",
    )
    assert "#60A5FA" in t0_html
    assert "#EF4444" not in t0_html  # No alarm colors in T0
    assert "Unsubscribe" not in t0_html  # No unsubscribe link in T0

    # T1 Positive — Payment Received (Success Green Accent)
    t1_pos_html = render_dark_email(
        tier=TemplateTier.T1,
        eyebrow="PAYMENT RECEIVED",
        heading="Payment Confirmed",
        body_content="Thank you for your payment.",
        outcome_type="positive",
    )
    assert COLOR_SUCCESS in t1_pos_html

    # T1 Negative — Invoice Overdue (Error Red Accent)
    t1_neg_html = render_dark_email(
        tier=TemplateTier.T1,
        eyebrow="INVOICE OVERDUE",
        heading="Invoice Past Due",
        body_content="Your invoice is past due.",
        outcome_type="negative",
    )
    assert COLOR_ERROR in t1_neg_html

    # T3 / T4 — Promotional (Radial Glow + Unsubscribe)
    t4_html = render_dark_email(
        tier=TemplateTier.T4,
        eyebrow="FEATURE UPDATE",
        heading="New Billing Features Available",
        body_content="Discover the new automated dunning features.",
        context={"unsubscribe_url": "https://zoikoone.com/unsubscribe"},
    )
    assert "radial-gradient" in t4_html
    assert "Unsubscribe from promotional emails" in t4_html


def test_t0_enforces_no_unsubscribe_or_promo():
    """Verification #4: T0 strictly enforces no promo content and no unsubscribe link."""
    with pytest.raises(TierEnforcementError):
        render_dark_email(
            tier=TemplateTier.T0,
            eyebrow="SECURITY",
            heading="Security Alert",
            body_content="Security notification.",
            context={"unsubscribe_url": "https://zoikoone.com/unsub"},
        )
