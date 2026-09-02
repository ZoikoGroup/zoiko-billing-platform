"""
main.py
-------
Entry point of the standalone Zoiko Billing Platform backend.

Serves ONLY this platform's own API under /api and its own auth surface.
Nothing from the old ZoikoOne codebase is imported at runtime.

Router mounting:
  - /api/auth            → auth + user management
  - /api/organizations   → org profile (own org) + super-admin org CRUD
  - /api/billing/...     → the extracted Billing module (its own prefix /billing)
  - /api/webhooks/stripe → Stripe webhook (deliberately outside the
                            subscription-gated billing_router, since Stripe
                            calls it unauthenticated)
  - /api/super-admin      → platform admin
"""

import logging
import re
import time
import uuid
import warnings
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config import settings
from app.core.cors import (
    ALLOWED_ORIGINS as _cors_origins,
    parse_cors_origins,
    validate_production_cors,
)
from app.core.exceptions import (
    ZoikoException,
    zoiko_exception_handler,
    generic_exception_handler,
)
from app.core.rate_limiter import limiter
from app.database import initialize_database

logger = logging.getLogger("zoiko_billing")

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(name)s] [%(levelname)s] %(message)s",
)

# ── Access-log redaction for security tokens in query strings ───────────────

_ACCESS_LOG_REDACT_RE = re.compile(r"(?i)([?&](?:token|code)=)[^&\s\"']+")


class _RedactSensitiveQueryFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            args = record.args
            if isinstance(args, tuple) and len(args) == 5:
                record.args = (
                    args[0],
                    args[1],
                    _ACCESS_LOG_REDACT_RE.sub(r"\1[REDACTED]", str(args[2])),
                    args[3],
                    args[4],
                )
            else:
                record.msg = _ACCESS_LOG_REDACT_RE.sub(r"\1[REDACTED]", record.getMessage())
                record.args = ()
        except Exception:
            pass
        return True


logging.getLogger("uvicorn.access").addFilter(_RedactSensitiveQueryFilter())

# Suppress harmless SQLAlchemy cycle warning from document-conversion FKs
# (quotations ↔ invoices ↔ contracts ↔ subscriptions ↔ organizations ↔ users).
# All cross-table FKs are nullable with SET NULL; no INSERT ordering dependency exists.
warnings.filterwarnings(
    "ignore",
    message=".*Cannot correctly sort tables.*",
    category=Warning,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _SECRET_PLACEHOLDERS = frozenset({
        "change-me-billing-platform-secret",
        "change-me-to-a-long-random-string",
    })
    if not settings.DEBUG and settings.BILLING_SECRET_KEY in _SECRET_PLACEHOLDERS:
        logger.critical(
            "BILLING_SECRET_KEY is still a default placeholder (%r). "
            "Set a unique secret in .env before running in production.",
            settings.BILLING_SECRET_KEY,
        )
        raise SystemExit("BILLING_SECRET_KEY must be overridden in production.")
    if not settings.DEBUG:
        mfa_key = (settings.MFA_ENCRYPTION_KEY or "").strip()
        if not mfa_key:
            logger.critical(
                "MFA_ENCRYPTION_KEY is not configured. Set a Fernet key before "
                "running Super Admin MFA in production."
            )
            raise SystemExit("MFA_ENCRYPTION_KEY must be configured in production.")
        try:
            from cryptography.fernet import Fernet

            Fernet(mfa_key.encode("utf-8"))
        except (TypeError, ValueError):
            logger.critical("MFA_ENCRYPTION_KEY is not a valid Fernet key.")
            raise SystemExit("MFA_ENCRYPTION_KEY must be a valid Fernet key in production.")
    validate_production_cors(_cors_origins, settings.DEBUG)
    try:
        initialize_database()
    except Exception as exc:
        logger.warning(
            "Database initialization failed (%s). "
            "The backend will start but API endpoints requiring the database "
            "will return 503 until the database becomes reachable.",
            exc,
        )
    if settings.ENABLE_RECURRING_BILLING_SCHEDULER:
        from app.core.scheduler import start_scheduler
        start_scheduler()
    else:
        logger.info("Recurring billing scheduler disabled (ENABLE_RECURRING_BILLING_SCHEDULER=false).")
    logger.info("Zoiko Billing Platform backend is ready.")
    yield
    if settings.ENABLE_RECURRING_BILLING_SCHEDULER:
        from app.core.scheduler import shutdown_scheduler
        shutdown_scheduler()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
    openapi_url="/openapi.json" if settings.DEBUG else None,
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_exception_handler(ZoikoException, zoiko_exception_handler)
app.add_exception_handler(Exception, generic_exception_handler)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    """Standard, safe security headers appropriate for a SPA + JSON API.

    - X-Content-Type-Options: nosniff — prevents MIME-type sniffing (no
      CSP dependency, safe for any deployment).
    - Referrer-Policy: strict-origin-when-cross-origin — modern browsers send
      full URL same-origin, only origin cross-origin. Safe and default-y.
    - X-Frame-Options: DENY — prevents clickjacking of any page that renders
      in a browser (the SPA never legitimately embeds in an <iframe>).
    - X-XSS-Protection: 0 — the legacy XSS filter is disabled by modern
      browsers and can introduce cross-site issues; CSP is the real defense
      (deliberately not set to 1;mode=block).

    HSTS is intentionally NOT set here: it must only be enabled when the
    deployment topology is known to be HTTPS-only across the board (set it
    at the proxy/edge instead). CSP is not set on API responses because the
    frontend serves its own CSP headers via the static host; adding one here
    risks breaking the app without validation.
    """
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "0"
    response.headers["X-Request-ID"] = getattr(request.state, "request_id", "")
    return response


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """Assigns a correlation ID to every request (reused from an incoming
    X-Request-ID header if the caller already has one, e.g. a frontend retry
    or an upstream proxy). Exposed on request.state for the error handlers
    (core/exceptions.py) and echoed back as a response header so a Super
    Admin reporting "something went wrong" can hand an engineer one ID that
    resolves directly to the matching server log line — see Section AD of
    docs/SUPER_ADMIN_ENTERPRISE_AUDIT.md for why this was added.

    Also records server-side handling time for /api/super-admin/* into the
    in-memory sliding window (core/api_metrics.py) — the real measurement
    behind launch-readiness item PERF-01 (ZB-SA-CMD-003 §18.2)."""
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    request.state.request_id = request_id

    is_command_center = request.url.path.startswith("/api/super-admin/")
    started = time.perf_counter() if is_command_center else None

    response = await call_next(request)

    if started is not None:
        try:
            import app.core.api_metrics as api_metrics

            api_metrics.record(
                (time.perf_counter() - started) * 1000, response.status_code
            )
        except Exception:  # noqa: BLE001 - telemetry must never break a request
            pass
    response.headers["X-Request-ID"] = request_id
    return response

# ── CORS ─────────────────────────────────────────────────────────────────────
# _cors_origins is computed above (before `lifespan`), which refuses to boot
# in production if it is empty or contains a wildcard — see lifespan().

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=r".*" if settings.DEBUG else None,
    allow_credentials=True,
    allow_methods=["*"] if settings.DEBUG else ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["*"] if settings.DEBUG else [
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "X-Request-ID",
    ],
)

# ── Routers ──────────────────────────────────────────────────────────────────

from app.modules.auth.router import router as auth_router
from app.modules.auth.router import user_router as auth_user_router
from app.modules.organizations.router import router as organizations_router
from app.modules.super_admin.router import router as super_admin_router
from app.modules.chatbot.router import router as chatbot_router
from app.modules.billing.router import billing_router
from app.modules.billing.routers.quote_router import public_quote_router
from app.modules.billing.routers.invoice_router import public_invoice_router
from app.modules.billing.routers.webhook_router import router as stripe_webhook_router
from app.modules.commercial.commercial_billing_router import (
    router as commercial_billing_router,
    public_quote_router as commercial_public_quote_router,
    public_invoice_router as commercial_public_invoice_router,
)
from app.modules.commercial.platform_stripe_router import (
    checkout_router as commercial_stripe_checkout_router,
    webhook_router as commercial_stripe_webhook_router,
)
from app.modules.commercial.org_self_service_router import router as commercial_org_self_service_router
from app.modules.commercial.entitlement_router import router as commercial_entitlement_router

app.include_router(auth_router, prefix="/api")
app.include_router(auth_user_router, prefix="/api")
app.include_router(organizations_router, prefix="/api")
app.include_router(super_admin_router, prefix="/api")
app.include_router(commercial_billing_router, prefix="/api")
app.include_router(commercial_entitlement_router, prefix="/api")
app.include_router(chatbot_router, prefix="/api")
# Billing is mounted at /billing (root), exactly like the ZoikoOne main
# platform — the billing frontend (modules/billing) calls /billing/* paths.
app.include_router(billing_router)
# Public estimate links live OUTSIDE billing_router (which is gated by
# require_active_subscription) — the HMAC-signed token is the authentication.
app.include_router(public_quote_router, prefix="/billing")
# Public invoice view + payment links, same pattern.
app.include_router(public_invoice_router, prefix="/billing")
app.include_router(commercial_public_quote_router, prefix="/billing")
app.include_router(commercial_public_invoice_router, prefix="/billing")
app.include_router(commercial_stripe_checkout_router, prefix="/billing")
app.include_router(stripe_webhook_router, prefix="/api")
# New endpoint/secret, isolated from Plane 2's /api/webhooks/stripe above.
app.include_router(commercial_stripe_webhook_router, prefix="/api")
# Prefix baked into the router itself (/billing/workspace) — same pattern as
# billing_router — so it lives alongside /billing/workspace/* Plane 2 routes.
app.include_router(commercial_org_self_service_router)

# ── Root health ──────────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
def health_root():
    return {
        "name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "ok",
        **({"docs": "/docs"} if settings.DEBUG else {}),
    }


@app.get("/health", tags=["Health"])
def health_check():
    """Liveness: is the process up and able to respond at all. Does not
    imply the database is reachable -- see /ready for that."""
    from app.database import check_connection

    return {"status": "ok", "database": "connected" if check_connection() else "unavailable"}


@app.get("/ready", tags=["Health"])
def readiness_check(response: Response):
    """Readiness: is the app able to serve real billing requests right now.
    Kept separate from /health (liveness) so an orchestrator restarts the
    process only when it's truly unresponsive, but pulls it out of the load
    balancer -- without restarting it -- purely for a transient DB outage.
    Never leaks connection details (host/credentials/stack traces)."""
    from app.database import check_connection

    db_ok = check_connection()
    response.status_code = status.HTTP_200_OK if db_ok else status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ready" if db_ok else "not_ready", "checks": {"database": "ok" if db_ok else "unavailable"}}
