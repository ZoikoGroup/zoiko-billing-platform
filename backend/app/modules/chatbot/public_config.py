"""
chatbot/public_config.py
------------------------
Configuration for the UNAUTHENTICATED public marketing-site assistant
(ZB-AI-PUB-001).

Everything the public widget renders — copy, the eight approved topic tiles,
theme tokens, support mode and the link allowlist — is defined here so the
product team can change it WITHOUT touching the model prompt. Topic tiles carry
their starter intent only; they never embed feature promises in the AI prompt.
"""

from __future__ import annotations

from app.config import settings

# Bump when the shipped copy/tiles change. Echoed to the widget so a stale
# cached bundle is detectable.
PUBLIC_CONFIG_VERSION = "2026-10-14.3"

ASSISTANT_TITLE = "Billing Assistant"

GREETING_TITLE = "Hi, I’m your Zoiko Billing Assistant 👋"

GREETING_BODY = (
    "Ask me about invoices, payments, customers, or billing workflows. "
    "I can explain features and guide you to the right place. "
    "Sign in for account-specific information."
)

COMPOSER_PLACEHOLDER = "Ask about billing..."

# Full-width human-support card (spec §7 — sits below the eight topic tiles).
HUMAN_SUPPORT_LABEL = "Speak to a human"
HUMAN_SUPPORT_DESCRIPTION = "Get help from our support team"

DISCLOSURE = (
    "AI-assisted guidance about Zoiko Billing. Verify financial information "
    "in your billing records."
)

# Approved uncertainty copy (spec §4 / §8.2 "No approved answer").
UNCERTAINTY_MESSAGE = "I can’t verify that from published Zoiko Billing guidance."

# Degraded-service copy (spec §10 "Service degraded").
SERVICE_DEGRADED_MESSAGE = "The assistant is temporarily unavailable."

# Where a visitor signs in for account-specific information. Relative to the
# marketing site; never a tenant-scoped or credential-bearing URL.
SIGN_IN_URL = "/sign-in"
SIGN_IN_LABEL = "Sign in to view your billing account"

# Approved privacy / AI disclosure destination. Points at the existing
# published data-governance page. A dedicated "Privacy and AI assistance"
# disclosure is flagged as a product/legal configuration requirement until an
# approved page exists (see the gap analysis / final report).
PRIVACY_AND_AI_URL = "/privacy-and-data-governance"

HELP_CENTER_URL = "/help-center"
CONTACT_SUPPORT_URL = "/contact-support"

# ── The eight approved topic tiles, in their locked order ────────────────────
# Order is part of the specification and must be preserved across every
# breakpoint. `id` is the stable intent id sent with a message; `label`,
# `description` and `starter_question` are the visible copy. `icon` is a
# Lucide-style icon name; `accent` is the icon stroke color and `tint` its
# pastel container background (the reference screenshot's category palette).

PUBLIC_TOPIC_TILES: list[dict[str, str]] = [
    {
        "id": "getting_started",
        "label": "Getting started",
        "description": "Set up your account, connect payments",
        "icon": "rocket",
        "accent": "#0868F7",
        "tint": "#E8F1FE",
        "starter_question": "How do I get started with Zoiko Billing?",
    },
    {
        "id": "invoices",
        "label": "Invoices",
        "description": "Create, send, track and manage invoices",
        "icon": "file-text",
        "accent": "#10B981",
        "tint": "#E6F7F0",
        "starter_question": "How do I create and send an invoice?",
    },
    {
        "id": "payments",
        "label": "Payments",
        "description": "Accept, track and reconcile payments",
        "icon": "credit-card",
        "accent": "#7C3AED",
        "tint": "#F1EBFE",
        "starter_question": "How do payments work in Zoiko Billing?",
    },
    {
        "id": "reconciliation",
        "label": "Reconciliation",
        "description": "Match payments, resolve differences",
        "icon": "bar-chart-3",
        "accent": "#F97316",
        "tint": "#FEF0E7",
        "starter_question": "How does payment reconciliation work?",
    },
    {
        "id": "credits_refunds",
        "label": "Credits & refunds",
        "description": "Issue credits, refunds and adjustments",
        "icon": "rotate-ccw",
        "accent": "#E11D48",
        "tint": "#FDE9EE",
        "starter_question": "How can I issue a credit or refund?",
    },
    {
        "id": "entities_currencies",
        "label": "Entities & currencies",
        "description": "Manage entities, taxes and currencies",
        "icon": "database",
        "accent": "#0D9488",
        "tint": "#E3F6F3",
        "starter_question": "Can Zoiko Billing support multiple entities or currencies?",
    },
    {
        "id": "permissions",
        "label": "Permissions",
        "description": "Users, roles and access control",
        "icon": "users",
        "accent": "#7C3AED",
        "tint": "#F1EBFE",
        "starter_question": "How do user roles and permissions work?",
    },
    {
        "id": "what_assistant_can_do",
        "label": "What this assistant can do",
        "description": "Capabilities, limits and data privacy",
        "icon": "help-circle",
        "accent": "#D97706",
        "tint": "#FEF3E1",
        "starter_question": "What can you help me with?",
    },
]

# ── Link allowlist ───────────────────────────────────────────────────────────
# Only relative, same-site marketing paths and explicitly approved external
# domains may ever be rendered as a clickable source/action. Anything else is
# dropped by the widget (defence against injected unsafe links).

ALLOWED_RELATIVE_PREFIXES = (
    "/",
)
APPROVED_EXTERNAL_DOMAINS = (
    "zoikobilling.com",
    "www.zoikobilling.com",
)


def is_public_url_allowed(url: str | None) -> bool:
    """True only for URLs the public assistant may surface as a source link.

    Mirror of the widget's client-side allowlist (defence-in-depth): relative
    same-site paths under ``ALLOWED_RELATIVE_PREFIXES`` and absolute ``http(s)``
    URLs whose host is in ``APPROVED_EXTERNAL_DOMAINS``. Everything else —
    unsafe schemes, ``mailto:``/``#``/``javascript:``, protocol-relative URLs,
    and unapproved hosts — is rejected so a misconfigured or tampered
    ``source_url`` can never be presented as a trusted citation.
    """
    if not url:
        return False
    value = url.strip()
    if not value or value.startswith("#") or value.startswith("mailto:"):
        return False
    # Same-site relative path ("" and "/" are deliberately rejected: a source
    # link must point somewhere real, not the current page).
    if value.startswith("/") and not value.startswith("//"):
        return any(value.startswith(prefix) for prefix in ALLOWED_RELATIVE_PREFIXES)
    if "://" not in value:
        return False
    scheme, _, remainder = value.partition("://")
    if scheme not in ("http", "https"):
        return False
    host = remainder.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0].lower()
    if ":" in host:
        host = host.split(":", 1)[0]  # strip port before hostname comparison
    return host in APPROVED_EXTERNAL_DOMAINS

# Named issue types the support form may submit. Kept small and product-shaped;
# the server validates against this list.
SUPPORT_ISSUE_TYPES = (
    "account_and_signin",
    "invoices_and_billing",
    "payments_and_refunds",
    "technical_problem",
    "other",
)


def _live_chat_enabled() -> bool:
    return bool(settings.PUBLIC_ASSISTANT_LIVE_CHAT_ENABLED)


def build_public_config() -> dict:
    """Assemble the widget configuration object (GET /public/assistant/config)."""
    return {
        "config_version": PUBLIC_CONFIG_VERSION,
        "assistant_title": ASSISTANT_TITLE,
        "greeting_title": GREETING_TITLE,
        "greeting_body": GREETING_BODY,
        "composer_placeholder": COMPOSER_PLACEHOLDER,
        "disclosure": DISCLOSURE,
        "human_support_label": HUMAN_SUPPORT_LABEL,
        "human_support_description": HUMAN_SUPPORT_DESCRIPTION,
        "uncertainty_message": UNCERTAINTY_MESSAGE,
        "privacy_url": PRIVACY_AND_AI_URL,
        "privacy_label": "Privacy and AI assistance",
        "help_center_url": HELP_CENTER_URL,
        "contact_support_url": CONTACT_SUPPORT_URL,
        "sign_in_url": SIGN_IN_URL,
        "sign_in_label": SIGN_IN_LABEL,
        "tiles": PUBLIC_TOPIC_TILES,
        "support": {
            # "live_chat" only when a staffed live service is integrated;
            # otherwise the request form is offered.
            "mode": "live_chat_and_request" if _live_chat_enabled() else "request_only",
            "live_chat_enabled": _live_chat_enabled(),
            "request_form_enabled": True,
            "issue_types": list(SUPPORT_ISSUE_TYPES),
            "response_time_claim": None,  # never advertise unverified SLAs
        },
        "link_allowlist": {
            "relative_prefixes": list(ALLOWED_RELATIVE_PREFIXES),
            "external_domains": list(APPROVED_EXTERNAL_DOMAINS),
        },
    }
