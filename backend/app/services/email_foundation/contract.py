"""
email_foundation/contract.py
----------------------------
Tier enforcement and variable contract validation rules for Zoiko Billing Email System.
"""

import re
import logging
from typing import Dict, Any, List
from app.services.email_foundation.enums import TemplateTier
from app.services.email_foundation.registries import TemplateDefinition

logger = logging.getLogger("zoiko_billing")


class TierEnforcementError(Exception):
    """Raised when a tier rule is violated (e.g., T0 template carrying promo content or unsubscribe links)."""
    pass


class VariableValidationError(Exception):
    """Raised when required template variables are missing or null."""
    pass


_PROMO_CONTEXT_KEYS = {
    "promotional_content",
    "promo_banner",
    "promo_code",
    "discount_banner",
    "marketing_text",
    "marketing_link",
}

_UNSUBSCRIBE_CONTEXT_KEYS = {
    "unsubscribe_url",
    "unsubscribe_link",
    "opt_out_link",
    "unsubscribe_footer",
}

_UNSUBSCRIBE_HTML_RE = re.compile(r"(?i)href=[\"'][^\"']*unsubscribe[^\"']*[\"']|unsubscribe", re.IGNORECASE)
_PROMO_HTML_RE = re.compile(r"(?i)class=[\"'][^\"']*promo[^\"']*[\"']|special offer|limited time offer", re.IGNORECASE)


def validate_tier_compliance(tier: TemplateTier, context: Dict[str, Any], html_content: str = "") -> None:
    """Enforces tier-level restrictions in code.

    Rule: T0 templates can NEVER carry promotional content or an unsubscribe link,
    checked in code, not left as a convention.
    """
    if tier == TemplateTier.T0:
        # 1. Context Key Inspection
        present_promo_keys = _PROMO_CONTEXT_KEYS.intersection(context.keys())
        if present_promo_keys:
            raise TierEnforcementError(
                f"T0 templates cannot carry promotional content. Disallowed keys in context: {present_promo_keys}"
            )

        present_unsub_keys = _UNSUBSCRIBE_CONTEXT_KEYS.intersection(context.keys())
        if present_unsub_keys:
            raise TierEnforcementError(
                f"T0 templates cannot carry unsubscribe links. Disallowed keys in context: {present_unsub_keys}"
            )

        # 2. Rendered HTML Inspection (if provided)
        if html_content:
            if _UNSUBSCRIBE_HTML_RE.search(html_content):
                raise TierEnforcementError(
                    "T0 templates cannot carry an unsubscribe link or opt-out directive in rendered content."
                )
            if _PROMO_HTML_RE.search(html_content):
                raise TierEnforcementError(
                    "T0 templates cannot carry promotional banners or promotional language in rendered content."
                )


def validate_variable_contract(template_def: TemplateDefinition, context: Dict[str, Any]) -> None:
    """Validates that all required variables for a template are present in context.

    Calculations (amounts, tax, proration, dates) must be performed upstream —
    only pre-formatted values are accepted.
    """
    missing_vars: List[str] = []
    for var_name in template_def.required_variables:
        if var_name not in context or context[var_name] is None:
            missing_vars.append(var_name)

    if missing_vars:
        msg = f"Template {template_def.id} variable contract validation failed. Missing required variables: {missing_vars}"
        logger.error(msg)
        raise VariableValidationError(msg)
