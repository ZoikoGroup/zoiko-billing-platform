"""
email_foundation/renderer.py
----------------------------
Dark Theme Template Rendering Engine for Zoiko Billing Email System.

Renders all 220 templates through the shared master shell (_base_dark.html),
enforcing exact dark branding palette from LoginPage.jsx and tier-based accent rules.
"""

import os
import re
import math
import logging
from typing import Dict, Any, Tuple, Optional
from app.services.email_foundation.enums import TemplateTier
from app.services.email_foundation.contract import validate_tier_compliance

logger = logging.getLogger("zoiko_billing")

# Color Constants matching LoginPage.jsx
COLOR_BG_DARK = "#0B1220"
COLOR_TEXT_PRIMARY = "#FFFFFF"
COLOR_TEXT_SECONDARY = "#B0C4DE"
COLOR_TEXT_MUTED = "rgba(255,255,255,0.5)"
COLOR_ACCENT_BLUE = "#60A5FA"
COLOR_SUCCESS = "#22C55E"
COLOR_WARNING = "#F59E0B"
COLOR_ERROR = "#EF4444"

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "email_templates")


def _default_logo_url() -> str:
    """Hosted product logo. Mirrors email_service._default_logo_url so that the
    master shell renders a real image instead of <img src=""> when the caller
    does not supply branding. Resolved lazily to match the deferred app.config
    import convention."""
    from app.config import settings as _settings

    return f"{_settings.FRONTEND_URL.rstrip('/')}/zoiko-billing-logo.png"


def calculate_relative_luminance(hex_color: str) -> float:
    """Calculates relative luminance according to WCAG 2.1 specs."""
    hex_clean = hex_color.lstrip("#")
    if len(hex_clean) == 3:
        hex_clean = "".join([c * 2 for c in hex_clean])
    r_s = int(hex_clean[0:2], 16) / 255.0
    g_s = int(hex_clean[2:4], 16) / 255.0
    b_s = int(hex_clean[4:6], 16) / 255.0

    def _adjust(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else math.pow((c + 0.055) / 1.055, 2.4)

    return 0.2126 * _adjust(r_s) + 0.7152 * _adjust(g_s) + 0.0722 * _adjust(b_s)


def calculate_contrast_ratio(hex_fg: str, hex_bg: str) -> float:
    """Calculates contrast ratio between foreground and background colors."""
    lum1 = calculate_relative_luminance(hex_fg)
    lum2 = calculate_relative_luminance(hex_bg)
    lighter = max(lum1, lum2)
    darker = min(lum1, lum2)
    return (lighter + 0.05) / (darker + 0.05)


def determine_eyebrow_accent_color(tier: TemplateTier, outcome_type: str = "neutral") -> str:
    """Tier-Based Accent Rules:
    - T0: Standard blue accent ONLY (#60A5FA), no alarm colors.
    - T1 Negative (failed, past_due, dispute, write_off): #EF4444 or #F59E0B.
    - T1 Positive (paid, renewed, activated, resolved): #22C55E.
    - T2/T3/T4: #60A5FA or category color.
    """
    if tier == TemplateTier.T0:
        return COLOR_ACCENT_BLUE

    if outcome_type == "negative":
        return COLOR_ERROR
    elif outcome_type == "warning":
        return COLOR_WARNING
    elif outcome_type == "positive":
        return COLOR_SUCCESS

    return COLOR_ACCENT_BLUE


def _format_body_html(body: str) -> str:
    """Converts plain text body with newlines into HTML paragraphs if not already HTML."""
    if "<p" in body or "<div" in body or "<table" in body:
        return body
    paragraphs = [p.strip() for p in body.split("\n\n") if p.strip()]
    if not paragraphs:
        paragraphs = [body.strip()]
    formatted = []
    for p in paragraphs:
        lines = p.split("\n")
        joined = "<br />".join(lines)
        formatted.append(f'<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #CBD5E1;">{joined}</p>')
    return "".join(formatted)


def render_dark_email(
    tier: TemplateTier,
    eyebrow: str,
    heading: str,
    body_content: str,
    primary_action_label: str = "",
    primary_action_url: str = "",
    secondary_content: str = "",
    preheader: str = "",
    outcome_type: str = "neutral",
    context: Dict[str, Any] = None,
) -> str:
    """Renders an email using the master dark shell _base_dark.html.

    Enforces tier compliance, contrast safety, and branding context.
    """
    if context is None:
        context = {}

    # Format body paragraphs if needed
    formatted_body = _format_body_html(body_content)

    # Tier compliance validation
    validate_tier_compliance(tier, context, formatted_body)

    base_path = os.path.join(TEMPLATE_DIR, "_base_dark.html")
    if not os.path.exists(base_path):
        raise FileNotFoundError(f"Master email shell not found at {base_path}")

    with open(base_path, "r", encoding="utf-8") as f:
        shell_html = f.read()

    eyebrow_color = determine_eyebrow_accent_color(tier, outcome_type)
    show_unsubscribe = (tier in (TemplateTier.T3, TemplateTier.T4)) and bool(context.get("unsubscribe_url"))
    show_radial_glow = tier in (TemplateTier.T3, TemplateTier.T4)

    render_context = {
        "preheader": preheader or context.get("preheader") or heading,
        "eyebrow": eyebrow.upper(),
        "eyebrow_color": eyebrow_color,
        "heading": heading,
        "body_content": formatted_body,
        "secondary_content": secondary_content,
        "primary_action_label": primary_action_label,
        "primary_action_url": primary_action_url,
        "company_name": context.get("company_name", "Zoiko Billing"),
        "sender_identity": context.get("sender_identity", "Zoiko Billing"),
        "logo_url": context.get("logo_url") or _default_logo_url(),
        "legal_entity": context.get("legal_entity", context.get("company_name", "Zoiko Billing Inc.")),
        "billing_address": context.get("billing_address", ""),
        "support_email": context.get("support_email", "support@zoikobilling.com"),
        "show_unsubscribe": show_unsubscribe,
        "unsubscribe_url": context.get("unsubscribe_url", ""),
        "show_radial_glow": show_radial_glow,
    }

    # Merged context for condition evaluation and variable interpolation
    merged_context = {**context, **render_context}

    # Evaluate Handlebars {{#if key}}...{{/if}}
    if_block_re = re.compile(r"\{\{#if (\w+)\}\}(.*?)\{\{/if\}\}", re.DOTALL)

    def _eval_if(match):
        key, inner = match.group(1), match.group(2)
        return inner if merged_context.get(key) else ""

    result = if_block_re.sub(_eval_if, shell_html)

    # 1. Substitute render_context variables (shell structure)
    for k, v in render_context.items():
        placeholder = "{{" + k + "}}"
        result = result.replace(placeholder, str(v if v is not None else ""))

    # 2. Substitute all caller context variables across the entire template
    for k, v in context.items():
        if v is not None:
            placeholder = "{{" + k + "}}"
            result = result.replace(placeholder, str(v))

    return result


def render_template_by_id(template_id: str, context: Dict[str, Any]) -> str:
    """Renders any catalog template by its ZB-* template ID using the master dark shell."""
    from app.modules.notifications.template_registry import TEMPLATE_REGISTRY, NotificationTier

    if template_id not in TEMPLATE_REGISTRY:
        raise KeyError(f"Unknown template ID: {template_id}")

    meta = TEMPLATE_REGISTRY[template_id]
    tier = TemplateTier(meta.tier.value if hasattr(meta.tier, "value") else meta.tier)

    # Resolve variables in heading, preheader, body
    heading = meta.subject
    preheader = meta.preheader
    body = meta.body_template
    action_label = meta.primary_action_label
    sender_identity = context.get("sender_identity") or meta.sender_identity

    # Action URL resolution
    action_url = (
        context.get("primary_action_url")
        or context.get("cta_url")
        or context.get("action_url")
        or context.get("invoice_url")
        or context.get("exception_url")
        or context.get("incident_url")
        or context.get("portal_url")
        or context.get("settings_url")
        or ""
    )

    ctx = dict(context)
    ctx["sender_identity"] = sender_identity

    return render_dark_email(
        tier=tier,
        eyebrow=meta.trigger_event_name,
        heading=heading,
        body_content=body,
        primary_action_label=action_label,
        primary_action_url=action_url,
        preheader=preheader,
        context=ctx,
    )
