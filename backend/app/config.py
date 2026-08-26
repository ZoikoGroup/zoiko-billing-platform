"""
config.py
---------
Environment configuration for the standalone Zoiko Billing Platform.

Fully independent of the main ZoikoOne platform: its own database
(BILLING_DATABASE_URL), its own JWT secret (BILLING_SECRET_KEY), its own
CORS origins and its own token namespace. Nothing here is shared with the
old repo's app.config.
"""

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Database (own, separate from the main platform) ────────────────
    BILLING_DATABASE_URL: str = ""

    # ── JWT / Auth (own secret — never reuse the main platform's) ──────
    BILLING_SECRET_KEY: str = "change-me-billing-platform-secret"
    ALGORITHM: str = "HS256"
    # Distinct issuer/token-namespace so tokens from this platform can
    # never be confused with (or accepted by) the main platform.
    JWT_ISSUER: str = "zoiko-billing-platform"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # ── App Info ──────────────────────────────────────────────────────
    APP_NAME: str = "Zoiko Billing Platform Backend"
    APP_VERSION: str = "1.0.0"
    APP_PORT: int = 8001
    DEBUG: bool = False
    LOG_LEVEL: str = "INFO"

    @field_validator("LOG_LEVEL", mode="before")
    @classmethod
    def normalize_log_level(cls, value):
        if isinstance(value, str):
            normalized = value.strip().upper()
            valid = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
            if normalized in valid:
                return normalized
        return value

    @field_validator("DEBUG", mode="before")
    @classmethod
    def normalize_debug(cls, value):
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"release", "prod", "production", "false", "0", "off", "no"}:
                return False
            if normalized in {"dev", "development", "true", "1", "yes", "on"}:
                return True
        return value

    # ── CORS ──────────────────────────────────────────────────────────
    BILLING_CORS_ORIGINS: str = (
        "http://localhost:5173,http://localhost:5174,http://localhost:5175,"
        "http://127.0.0.1:5173,http://127.0.0.1:5174"
    )

    # ── Public-facing links ─────────────────────────────────────────────
    FRONTEND_URL: str = "http://localhost:5173"

    # ── Email / SMTP ──────────────────────────────────────────────────
    SMTP_HOST: str = ""
    SMTP_PORT: str = "587"
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM_EMAIL: str = "no-reply@billing.zoiko.example"
    SMTP_USE_TLS: str = "true"

    # ── Super Admin setup key ─────────────────────────────────────────
    # Required to run scripts/seed_super_admin.py and to create Super
    # Admin accounts. Never create a Super Admin through public /auth/register.
    SETUP_KEY: str = ""

    # ── Super Admin MFA (TOTP) — release-blocker pass, Blocker 4 ────────
    # Separate key from BILLING_SECRET_KEY — see core/mfa_crypto.py.
    MFA_ENCRYPTION_KEY: str = ""
    MFA_ISSUER_NAME: str = "Zoiko Billing"
    MFA_MAX_FAILED_ATTEMPTS: int = 5
    MFA_LOCKOUT_MINUTES: int = 15
    MFA_PENDING_TOKEN_EXPIRE_MINUTES: int = 10

    # ── Stripe (ported from the old platform's billing module) ─────────
    # Blank/inert by default. Fill these in once real Stripe credentials
    # are available; nothing in this platform requires them to boot.
    STRIPE_SECRET_KEY: str = ""
    STRIPE_PUBLISHABLE_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_CURRENCY_DEFAULT: str = "usd"
    STRIPE_PAYMENT_METHOD_TYPES: str = "card"
    STRIPE_BILLING_ADDRESS_COLLECTION: str = "auto"
    # Plane 2 — Stripe Connect (tenant-as-merchant).
    # STRIPE_CONNECT_CLIENT_ID is the OAuth client_id for Zoiko's Connect
    # Platform (non-secret; safe to embed in the onboarding URL).
    STRIPE_CONNECT_CLIENT_ID: str = ""
    # Outbound transport hardening (ID-3): bounded automatic retries with
    # SDK-managed idempotency keys for transport-level retries, plus a bounded
    # per-attempt HTTP timeout.
    STRIPE_MAX_NETWORK_RETRIES: int = 2
    STRIPE_TIMEOUT_SECONDS: int = 25
    # OAuth state (CON-2): TTL for the signed, organization-bound state token.
    STRIPE_OAUTH_STATE_TTL_SECONDS: int = 600

    # ── AI Model Gateway (provider-neutral) ────────────────────────────
    # Provider selection: "groq" | "anthropic" | "" (auto — first key set).
    AI_MODEL_PROVIDER: str = ""
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL_DEFAULT: str = "claude-sonnet-4-20250514"
    ANTHROPIC_MAX_TOKENS: int = 4096
    ANTHROPIC_TEMPERATURE: float = 0.1
    # Groq (OpenAI-compatible chat-completions API; free tier at
    # console.groq.com). No extra SDK needed — plain httpx.
    GROQ_API_KEY: str = ""
    GROQ_MODEL_DEFAULT: str = "llama-3.3-70b-versatile"
    GROQ_MAX_TOKENS: int = 2048
    GROQ_TEMPERATURE: float = 0.1
    AI_MODEL_TIMEOUT_SECONDS: int = 30
    AI_SAFE_MODE: bool = False

    # ── Recurring-billing scheduler (ported, OFF by default) ────────────
    # Dunning / recurring-billing / overdue-invoice jobs only start if this
    # is explicitly enabled — see app/core/scheduler.py.
    ENABLE_RECURRING_BILLING_SCHEDULER: bool = False
    BILLING_AUTO_EXPIRY_ENABLED: bool = False
    RECURRING_BILLING_INTERVAL_MINUTES: int = 60
    OVERDUE_INVOICE_CHECK_INTERVAL_MINUTES: int = 60
    DUNNING_PROCESS_INTERVAL_MINUTES: int = 1440
    ESCALATION_TO_COLLECTIONS_INTERVAL_MINUTES: int = 1440
    PROMISE_TO_PAY_CHECK_INTERVAL_MINUTES: int = 1440
    # N1: Plane-1 (Zoiko's own subscription) failed-payment dunning sweep —
    # independent of the Plane-2 jobs above (see commercial/dunning_service.py).
    COMMERCIAL_DUNNING_INTERVAL_MINUTES: int = 1440
    # ZB-SA-CMD-003 §8/§15 — internal financial-integrity check cadence.
    FINANCIAL_CONSISTENCY_INTERVAL_MINUTES: int = 60
    # REC-01 — ledger reconciliation cadence.
    RECONCILIATION_INTERVAL_MINUTES: int = 1440
    # Commercial (Plane 1) recurring invoice generation on subscription
    # renewal — see commercial/tasks/recurring_invoice.py. OFF by default,
    # independent of ENABLE_RECURRING_BILLING_SCHEDULER's Plane-2 jobs.
    ENABLE_COMMERCIAL_RECURRING_INVOICING: bool = False
    COMMERCIAL_RECURRING_INVOICING_INTERVAL_MINUTES: int = 1440

    # ── Commercial (Plane 1) free-trial enforcement ─────────────────────
    # A self-serve subscription is created PENDING with a
    # COMMERCIAL_TRIAL_PERIOD_DAYS deadline (see provision_default_
    # subscription). If it hasn't been paid (transitioned to ACTIVE) by
    # then, commercial/tasks/trial_expiry.py suspends it and
    # require_active_subscription blocks /billing/* access until a super
    # admin reactivates it or the org pays. OFF by default — the trial
    # deadline is stamped regardless, but nothing acts on it until enabled.
    COMMERCIAL_TRIAL_PERIOD_DAYS: int = 3
    ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT: bool = False
    COMMERCIAL_TRIAL_EXPIRY_CHECK_INTERVAL_MINUTES: int = 60

    # ── Commercial (Plane 1) quote discount approval (§B7) ──────────────
    # A quote-level discount at or above this percentage of subtotal requires
    # discount_reason + a discount_approver_id different from the creator
    # before the quote may be sent. PLACEHOLDER business rule pending
    # Finance sign-off — not an approved threshold.
    COMMERCIAL_QUOTE_DISCOUNT_APPROVAL_THRESHOLD_PERCENT: float = 15.0

    # ── Commercial (Plane 1) Stripe — Zoiko's own Stripe account, entirely
    # separate from Plane 2's STRIPE_* settings above (never shared). ──────
    PLATFORM_STRIPE_SECRET_KEY: str = ""
    PLATFORM_STRIPE_PUBLISHABLE_KEY: str = ""
    PLATFORM_STRIPE_WEBHOOK_SECRET: str = ""


settings = Settings()
