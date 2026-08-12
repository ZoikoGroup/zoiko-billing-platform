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


def _cors_headers(request: Request) -> dict:
    """Return CORS headers that mirror the ForceCORSMiddleware logic."""
    origin = request.headers.get("origin", "")
    return {
        "Access-Control-Allow-Origin": origin if origin else "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Expose-Headers": "*",
    }


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
        },
        headers=_cors_headers(request),
    )


async def generic_exception_handler(request: Request, exc: Exception):
    """Catches any unexpected server error and returns a clean message."""
    import logging
    logging.getLogger("zoiko").error(f"Unhandled error on {request.method} {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": "INTERNAL_SERVER_ERROR",
            "message": "Something went wrong on the server. Please try again later.",
        },
        headers=_cors_headers(request),
    )
