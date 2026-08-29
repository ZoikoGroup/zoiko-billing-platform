"""
core/exceptions.py
------------------
Custom error classes and handlers for the entire application.

Why custom exceptions?
  FastAPI by default returns technical errors. We want clean, consistent
  JSON error responses that the frontend can easily understand.

Standard error response format we use everywhere:
  {
    "success": false,
    "error": "NOT_FOUND",
    "message": "Employee with id 5 not found"
  }
"""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.cors import is_origin_allowed


def _cors_headers(request: Request) -> dict:
    """CORS headers for error responses (ZoikoException / unhandled 500).

    CORSMiddleware (main.py) only ever ADDS an Access-Control-Allow-Origin
    header when the origin is allowed -- it never strips one a response
    already carries. This used to reflect ANY request Origin unconditionally
    with credentials=true, which meant every error response (400/401/403/
    404/409/500) bypassed BILLING_CORS_ORIGINS entirely, in both DEBUG and
    production. Routed through the same is_origin_allowed() check the
    middleware itself uses, so a disallowed origin gets no CORS header here
    either (Phase 6 production-readiness finding)."""
    origin = request.headers.get("origin", "")
    headers = {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Expose-Headers": "*",
    }
    if origin and is_origin_allowed(origin):
        headers["Access-Control-Allow-Origin"] = origin
    return headers


def _request_id(request: Request):
    """The per-request correlation ID set by main.py's request-ID middleware.

    Included in every error response (both handlers below) so a user-facing
    "something went wrong" message is still diagnosable: the generic handler
    deliberately never leaks raw exception/DB detail to the browser (correct
    security posture), but pairing the scrubbed message with this ID lets an
    operator find the full server-side log line (which DOES capture
    exc_info=True) without exposing internals to the client."""
    return getattr(request.state, "request_id", None)


# ── Custom Exception Classes ──────────────────────────────────────────────────

class ZoikoException(HTTPException):
    """Base exception for all Zoiko errors. All custom errors inherit from this."""
    def __init__(self, status_code: int, error_code: str, message: str):
        super().__init__(status_code=status_code, detail=message)
        self.error_code = error_code
        self.message = message


class NotFoundException(ZoikoException):
    """Use when a requested resource doesn't exist (404)."""
    def __init__(self, resource: str, identifier=None):
        msg = f"{resource} not found"
        if identifier:
            msg = f"{resource} with id '{identifier}' not found"
        super().__init__(status_code=404, error_code="NOT_FOUND", message=msg)


class AlreadyExistsException(ZoikoException):
    """Use when trying to create something that already exists (409)."""
    def __init__(self, resource: str, field: str = None):
        msg = f"{resource} already exists"
        if field:
            msg = f"{resource} with this {field} already exists"
        super().__init__(status_code=409, error_code="ALREADY_EXISTS", message=msg)


class UnauthorizedException(ZoikoException):
    """Use when user is not logged in or token is invalid (401)."""
    def __init__(self, message: str = "Authentication required. Please log in."):
        super().__init__(status_code=401, error_code="UNAUTHORIZED", message=message)


class ForbiddenException(ZoikoException):
    """Use when user is logged in but doesn't have permission (403)."""
    def __init__(self, message: str = "You do not have permission to perform this action."):
        super().__init__(status_code=403, error_code="FORBIDDEN", message=message)


class BadRequestException(ZoikoException):
    """Use when the request data is invalid or makes no logical sense (400)."""
    def __init__(self, message: str):
        super().__init__(status_code=400, error_code="BAD_REQUEST", message=message)


class ServiceUnavailableException(ZoikoException):
    """Use when a downstream dependency (e.g. the database) is temporarily
    unreachable (503). Deliberately distinct from a 500: it tells the caller
    the failure is transient/environmental and worth retrying, not a bug —
    e.g. the documented intermittent Neon DNS resolution failures (ISS-012)."""
    def __init__(self, message: str = "Service temporarily unavailable. Please try again shortly."):
        super().__init__(status_code=503, error_code="SERVICE_UNAVAILABLE", message=message)


# ── Global Exception Handlers ─────────────────────────────────────────────────
# These are registered in main.py so every error returns our clean JSON format.

async def zoiko_exception_handler(request: Request, exc: ZoikoException):
    """Handles all our custom ZoikoException errors."""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "success": False,
            "error": exc.error_code,
            "message": exc.message,
            "detail": exc.message,
            "request_id": _request_id(request),
        },
        headers=_cors_headers(request),
    )


async def generic_exception_handler(request: Request, exc: Exception):
    """Catches any unexpected server error and returns a clean message."""
    import logging
    from app.config import settings as _settings

    request_id = _request_id(request)
    logging.getLogger("zoiko_billing").error(
        f"Unhandled error on {request.method} {request.url.path} [request_id={request_id}]: {exc}",
        exc_info=True,
    )
    body: dict = {
        "success": False,
        "error": "INTERNAL_SERVER_ERROR",
        "message": "Something went wrong on the server. Please try again later.",
        "request_id": request_id,
    }
    # DEVELOPMENT diagnostics only: surface the real exception so the browser
    # Network tab / console shows exactly what failed. Never leaked outside
    # DEBUG (production keeps the generic message).
    if bool(getattr(_settings, "DEBUG", False)):
        body["detail"] = f"{type(exc).__name__}: {exc}"
    return JSONResponse(
        status_code=500,
        content=body,
        headers=_cors_headers(request),
    )
