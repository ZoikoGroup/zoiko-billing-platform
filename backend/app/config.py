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
    DEBUG: bool = False

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


settings = Settings()
