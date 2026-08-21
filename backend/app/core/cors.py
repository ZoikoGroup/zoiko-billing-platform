"""
core/cors.py
------------
Single source of truth for which browser origins this API trusts.

Shared by the CORSMiddleware setup (main.py, for normal 2xx responses)
AND the manual CORS headers on custom-exception/error responses
(core/exceptions.py) -- Starlette's CORSMiddleware only ever ADDS an
Access-Control-Allow-Origin header when the origin is allowed, it never
strips one a response already carries (verified against
starlette.middleware.cors.CORSMiddleware.send). Before this module
existed, exceptions.py computed its own CORS header unconditionally
(reflecting ANY request Origin with credentials=true), which meant every
error response -- 400/401/403/404/409/500, i.e. most non-2xx billing API
traffic -- bypassed BILLING_CORS_ORIGINS entirely, in both DEBUG and
production. Routing both call sites through is_origin_allowed() closes
that gap without duplicating the allow-list rule a second time.
"""

import logging

from app.config import settings

logger = logging.getLogger("zoiko_billing")


def parse_cors_origins(cors_origins_csv: str) -> list:
    """Pure parsing helper, unit-testable without booting the app."""
    return [o.strip() for o in cors_origins_csv.split(",") if o.strip()]


def validate_production_cors(origins: list, debug: bool) -> None:
    """Refuses to boot with an unrestricted CORS configuration outside
    DEBUG mode -- an empty origins list combined with allow_credentials=True
    would behave inconsistently across browsers, and a literal "*" entry
    combined with allow_credentials=True is the classic wildcard-with-
    credentials CORS misconfiguration. Mirrors the BILLING_SECRET_KEY
    placeholder guard in main.py: fail closed at startup, not silently in
    production traffic."""
    if not debug and (not origins or "*" in origins):
        logger.critical(
            "BILLING_CORS_ORIGINS must list explicit production frontend origin(s) "
            "when DEBUG=false. Wildcard ('*') or empty origins are not permitted."
        )
        raise SystemExit("BILLING_CORS_ORIGINS must be explicitly configured (no wildcard/empty) when DEBUG=false.")


ALLOWED_ORIGINS = parse_cors_origins(settings.BILLING_CORS_ORIGINS)


def is_origin_allowed(origin: str) -> bool:
    """Same rule CORSMiddleware applies for a simple (non-preflight)
    request: in DEBUG, any origin is allowed (matches allow_origin_regex=
    r".*"); otherwise only an explicit entry in BILLING_CORS_ORIGINS."""
    if not origin:
        return False
    if settings.DEBUG:
        return True
    return origin in ALLOWED_ORIGINS
