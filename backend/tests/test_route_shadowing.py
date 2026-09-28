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
"""
from app.main import app

# Methods that are derived from another and never declared explicitly.
_IGNORED_METHODS = {"HEAD", "OPTIONS"}


def _routes_in_order():
    """(method, path) pairs in the exact order Starlette will try them."""
    out = []
    for route in app.routes:
        path = getattr(route, "path", None)
        if not path:
            continue
        for method in getattr(route, "methods", None) or []:
            if method.upper() not in _IGNORED_METHODS:
                out.append((method.upper(), path))
    return out


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


def test_legacy_breaker_alias_resolves_to_its_dedicated_handler():
    """The specific regression, pinned by handler identity so a future
    reordering (or a rename of either path) fails loudly here."""
    import asyncio

    from starlette.routing import Match

    from app.modules.super_admin.router import (
        get_tenant_invoice_finalization_breaker,
        set_tenant_invoice_finalization_breaker,
    )

    async def _first_full_match(method, path):
        scope = {"type": "http", "method": method, "path": path, "root_path": ""}
        for route in app.routes:
            match, _ = route.matches(scope)
            if match == Match.FULL:
                return route
        return None

    for method, expected in (
        ("GET", get_tenant_invoice_finalization_breaker),
        ("PUT", set_tenant_invoice_finalization_breaker),
    ):
        path = "/api/super-admin/circuit-breakers/tenant-invoice-finalization"
        route = asyncio.run(_first_full_match(method, path))
        assert route is not None, f"{method} {path} resolves to no route at all"
        assert route.endpoint is expected, (
            f"{method} {path} resolves to {route.path} -> "
            f"{getattr(route.endpoint, '__name__', route.endpoint)}"
        )


def test_canonical_underscore_scope_still_resolves_through_generic_route():
    """The catalog, approval-request flow and break-glass toggle all use the
    canonical underscore scope, so it must keep hitting the generic handler."""
    import asyncio

    from starlette.routing import Match

    async def _first_full_match(method, path):
        scope = {"type": "http", "method": method, "path": path, "root_path": ""}
        for route in app.routes:
            match, _ = route.matches(scope)
            if match == Match.FULL:
                return route
        return None

    route = asyncio.run(
        _first_full_match("GET", "/api/super-admin/circuit-breakers/tenant_invoice_finalization")
    )
    assert route is not None
    assert route.path == "/api/super-admin/circuit-breakers/{scope}"
    assert getattr(route.endpoint, "__name__", "") == "get_circuit_breaker"
