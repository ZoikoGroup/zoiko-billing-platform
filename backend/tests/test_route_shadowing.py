"""
Route shadowing guard.

Starlette matches routes in DECLARATION order, and a path-parameter segment
compiles to ``[^/]+`` — exactly one segment, never spanning "/". That
combination means a route such as

    GET /api/super-admin/circuit-breakers/{scope}      (declared first)
    GET /api/super-admin/circuit-breakers/tenant-invoice-finalization  (after)

makes the SECOND one permanently unreachable: the generic handler wins, gets
scope="tenant-invoice-finalization", looks it up in KNOWN_BREAKER_SCOPES
(which stores the underscore canonical name "tenant_invoice_finalization"),
fails, and 404s. The dedicated handler below it is dead code.

This shipped silently because every other test in the suite calls handler
functions directly, which bypasses routing entirely. The user-visible symptom
was the Data Governance tab's Circuit Breakers card stuck on "Unable to load
breaker state — Unknown circuit breaker scope".

This test resolves the ASSEMBLED route table, so it covers every router in the
application, not just the one that was broken. It is cheap and runs on every
suite invocation.

`_flatten_routes` below, not raw `app.routes` iteration, is what makes that
possible: FastAPI's `include_router()` stopped eagerly flattening every
sub-router's routes into `app.routes` at registration time (a lazily-resolved
private wrapper is stored instead, exposing an `effective_candidates()` method
rather than `.path`/`.methods`/`.endpoint` directly) — a real break discovered
when upgrading to the pinned fastapi==0.141.1 (CI/production) exposed a stale
fastapi==0.111.0 in a local dev venv had been silently masking. Recursing
through `effective_candidates()` when present, and falling back to reading
`.path`/`.methods`/`.endpoint` directly otherwise, keeps this working against
either shape — this file has no way to pin exactly which one a given
environment's installed FastAPI produces.
"""
from app.main import app

# Methods that are derived from another and never declared explicitly.
_IGNORED_METHODS = {"HEAD", "OPTIONS"}


def _flatten_routes(routes):
    """Yield (method, path, endpoint) for every leaf route reachable from
    `routes`, in the same order Starlette will try them."""
    for route in routes:
        if hasattr(route, "effective_candidates"):
            # A lazy include-router wrapper: its own .path/.methods/.endpoint
            # are meaningless — recurse into what it actually wraps.
            yield from _flatten_routes(route.effective_candidates())
            continue
        path = getattr(route, "path", None)
        endpoint = getattr(route, "endpoint", None)
        methods = getattr(route, "methods", None) or []
        if not path or endpoint is None:
            continue
        for method in methods:
            if method.upper() not in _IGNORED_METHODS:
                yield (method.upper(), path, endpoint)


def _routes_in_order():
    """(method, path) pairs in the exact order Starlette will try them."""
    return [(method, path) for method, path, _endpoint in _flatten_routes(app.routes)]


def _segments(path):
    return [s for s in path.strip("/").split("/") if s]


def _is_param(segment):
    return segment.startswith("{") and segment.endswith("}")


def test_no_route_is_shadowed_by_an_earlier_path_parameter_route():
    routes = _routes_in_order()
    unreachable = []

    for i, (method, path) in enumerate(routes):
        own = _segments(path)
        for j, (other_method, other_path) in enumerate(routes):
            if j <= i or other_method != method:
                continue
            other = _segments(other_path)
            # A param matches exactly one segment, so a shorter route can
            # never fully match a longer path, and two paths only compete
            # when they have the same number of segments.
            if len(own) != len(other):
                continue
            matches = True
            has_param_where_other_has_literal = False
            for mine, theirs in zip(own, other):
                if _is_param(mine):
                    if not _is_param(theirs):
                        has_param_where_other_has_literal = True
                elif mine != theirs:
                    matches = False
                    break
            if matches and has_param_where_other_has_literal:
                unreachable.append(f"[{method}] {other_path}  <-  shadowed by {path}")

    assert not unreachable, (
        "These routes can never be reached because an earlier route with a "
        "path parameter matches them first. Move the literal route above the "
        "parameter route, or rename the parameter:\n  "
        + "\n  ".join(sorted(set(unreachable)))
    )


async def _resolve(method, path):
    """Dispatch a real (fake-transport) ASGI call through the whole app and
    read back Starlette's own `scope["route"]` — the leaf route it actually
    matched a concrete incoming URL against, set by Starlette's router
    regardless of what the endpoint itself does afterward (auth/DB errors
    included). This replicates real request-time path-parameter matching
    (a literal path and a `{param}` path are different regexes competing for
    the same concrete URL) — a `(method, path)` dict lookup keyed on the
    declared path *template* cannot express that competition at all, since
    the literal and templated paths are different strings and never collide
    as dict keys. Needs a complete scope (query_string/client/server) or
    dependency resolution raises before scope["route"] would matter anyway.
    """
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "root_path": "",
        "headers": [],
        "query_string": b"",
        "client": ("test", 0),
        "server": ("test", 80),
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        pass

    try:
        await app(scope, receive, send)
    except Exception:
        # The endpoint itself may fail past routing (missing auth, DB, etc.)
        # -- irrelevant here; scope["route"] is set before that ever runs.
        pass
    return scope.get("route")


def test_legacy_breaker_alias_resolves_to_its_dedicated_handler():
    """The specific regression, pinned by handler identity so a future
    reordering (or a rename of either path) fails loudly here."""
    import asyncio

    from app.modules.super_admin.router import (
        get_tenant_invoice_finalization_breaker,
        set_tenant_invoice_finalization_breaker,
    )

    for method, expected in (
        ("GET", get_tenant_invoice_finalization_breaker),
        ("PUT", set_tenant_invoice_finalization_breaker),
    ):
        path = "/api/super-admin/circuit-breakers/tenant-invoice-finalization"
        route = asyncio.run(_resolve(method, path))
        assert route is not None, f"{method} {path} resolves to no route at all"
        assert route.endpoint is expected, (
            f"{method} {path} resolves to {getattr(route.endpoint, '__name__', route.endpoint)}, not "
            f"{getattr(expected, '__name__', expected)}"
        )


def test_canonical_underscore_scope_still_resolves_through_generic_route():
    """The catalog, approval-request flow and break-glass toggle all use the
    canonical underscore scope, so it must keep hitting the generic handler."""
    import asyncio

    route = asyncio.run(
        _resolve("GET", "/api/super-admin/circuit-breakers/tenant_invoice_finalization")
    )
    assert route is not None
    assert getattr(route.endpoint, "__name__", "") == "get_circuit_breaker"
