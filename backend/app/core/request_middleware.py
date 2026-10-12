"""
core/request_middleware.py
--------------------------
ONE pure-ASGI middleware replacing the two ``@app.middleware("http")``
(BaseHTTPMiddleware) functions that used to live in main.py:

  * security headers (nosniff / Referrer-Policy / X-Frame-Options /
    X-XSS-Protection) -- see the rationale below;
  * request-id correlation + per-route metrics + SQL query counter +
    slow/chatty-request log.

Pure ASGI avoids BaseHTTPMiddleware's per-request task/stream plumbing, and
merging two layers into one halves the wrapping cost. Behavior is intended to
be byte-for-byte identical (see tests/test_request_middleware_parity.py):

  * request id: reused from an incoming ``X-Request-ID`` header (non-empty),
    else a new uuid4; exposed as ``request.state.request_id`` (stored in
    ``scope["state"]``) for handlers and core/exceptions.py; echoed on the
    response as ``X-Request-ID``.
  * HSTS and CSP are deliberately NOT set here (set HSTS at the edge; the
    frontend host serves CSP).
  * Unhandled exceptions propagate unchanged to Starlette's outermost
    ServerErrorMiddleware (as before, those 500s never carried these headers).
  * Metrics are recorded when the response *starts* (same instant the old
    ``call_next`` returned), so streaming bodies don't inflate latency.
"""

from __future__ import annotations

import logging
import time
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request

_SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("X-Frame-Options", "DENY"),
    ("X-XSS-Protection", "0"),
)


class RequestContextMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = Headers(scope=scope).get("X-Request-ID") or str(uuid.uuid4())
        # Request.state reads scope["state"], so handlers/exception handlers
        # see request.state.request_id exactly as with BaseHTTPMiddleware.
        state = scope.get("state")
        if state is None:
            state = scope["state"] = {}
        state["request_id"] = request_id

        from app.core import query_counter

        started = time.perf_counter()
        qtoken = query_counter.start()
        counter = qtoken.var.get()
        recorded = False

        async def send_wrapper(message):
            nonlocal recorded
            if message["type"] == "http.response.start":
                if not recorded:
                    recorded = True
                    _record(scope, message["status"], started, counter.count, request_id)
                headers = MutableHeaders(scope=message)
                for name, value in _SECURITY_HEADERS:
                    headers[name] = value
                headers["X-Request-ID"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            query_counter.finish(qtoken)


def _record(scope, status_code: int, started: float, query_count: int, request_id: str) -> None:
    try:
        import app.core.api_metrics as api_metrics

        path = Request(scope).url.path
        duration_ms = (time.perf_counter() - started) * 1000
        if path.startswith("/api/super-admin/"):
            api_metrics.record(duration_ms, status_code)
        # Per-route p50/p95 + SQL statements per request for ALL routes, keyed
        # by route template (set on the scope once routing has matched).
        route = scope.get("route")
        template = getattr(route, "path", None)
        method = scope.get("method")
        if template:
            api_metrics.record_route(method, template, duration_ms, status_code, query_count)
        if duration_ms > 1500 or query_count > 40:
            logging.getLogger("zoiko_billing.perf").warning(
                "slow/chatty request %s %s: %.0f ms, %d SQL statements (request_id=%s)",
                method, template or path, duration_ms, query_count, request_id,
            )
    except Exception:  # noqa: BLE001 - telemetry must never break a request
        pass
