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
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config import settings
from app.core.exceptions import (
    ZoikoException,
    zoiko_exception_handler,
    generic_exception_handler,
)
from app.core.rate_limiter import limiter
from app.database import initialize_database

logger = logging.getLogger("zoiko_billing")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

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


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_database()
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
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_exception_handler(ZoikoException, zoiko_exception_handler)
app.add_exception_handler(Exception, generic_exception_handler)

# ── CORS ─────────────────────────────────────────────────────────────────────

_cors_origins = [
    o.strip()
    for o in settings.BILLING_CORS_ORIGINS.split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=r".*" if settings.DEBUG else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ──────────────────────────────────────────────────────────────────

from app.modules.auth.router import router as auth_router
from app.modules.auth.router import user_router as auth_user_router
from app.modules.organizations.router import router as organizations_router
from app.modules.super_admin.router import router as super_admin_router
from app.modules.billing.router import billing_router
from app.modules.billing.routers.quote_router import public_quote_router
from app.modules.billing.routers.webhook_router import router as stripe_webhook_router

app.include_router(auth_router, prefix="/api")
app.include_router(auth_user_router, prefix="/api")
app.include_router(organizations_router, prefix="/api")
app.include_router(super_admin_router, prefix="/api")
# Billing is mounted at /billing (root), exactly like the ZoikoOne main
# platform — the billing frontend (modules/billing) calls /billing/* paths.
app.include_router(billing_router)
# Public estimate links live OUTSIDE billing_router (which is gated by
# require_active_subscription) — the HMAC-signed token is the authentication.
app.include_router(public_quote_router, prefix="/billing")
app.include_router(stripe_webhook_router, prefix="/api")

# ── Root health ──────────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
def health_root():
    return {
        "name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "ok",
        "docs": "/docs",
    }


@app.get("/health", tags=["Health"])
def health_check():
    from app.database import check_connection

    return {"status": "ok", "database": "connected" if check_connection() else "unavailable"}
