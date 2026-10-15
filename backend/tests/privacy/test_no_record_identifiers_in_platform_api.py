"""Schema guard: no /api/super-admin response model may declare a field that
identifies an individual customer or record (ZB-SEC-PRIV-001).

Walks every route under /api/super-admin, recursively collects the field names
of its response_model (nested models, list/dict/union/Optional wrappers
included) and fails loudly with route + field name on a forbidden name.
"""
import types
import typing

from pydantic import BaseModel

from app.main import app
from app.modules.super_admin.privacy import FORBIDDEN_FIELD_NAMES
from tests.privacy.conftest import control

# Reviewed exceptions: (route path, field name) pairs that are NOT record-level
# customer data. Every entry needs a justification; keep this list tiny.
ALLOWLIST: dict[tuple[str, str], str] = {
    # (none currently — add ("/api/super-admin/...", "field"): "reason" after review)
}


def _collect(annotation, path, seen, out):
    origin = typing.get_origin(annotation)
    if origin is not None:
        for arg in typing.get_args(annotation):
            _collect(arg, path, seen, out)
        return
    if isinstance(annotation, types.UnionType):
        for arg in annotation.__args__:
            _collect(arg, path, seen, out)
        return
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        if annotation in seen:
            return
        seen = seen | {annotation}
        for name, field in annotation.model_fields.items():
            out.append((f"{path}.{name}", name))
            _collect(field.annotation, f"{path}.{name}", seen, out)


def _iter_routes(routes):
    """Yield (path, methods, response_model) for every route, flattening the
    lazily-included routers newer FastAPI versions keep in app.routes."""
    for route in routes:
        contexts = getattr(route, "effective_route_contexts", None)
        if callable(contexts):
            for ctx in contexts():
                orig = getattr(ctx, "original_route", None)
                yield ctx.path, getattr(orig, "methods", None), getattr(ctx, "response_model", None)
        else:
            yield getattr(route, "path", ""), getattr(route, "methods", None), getattr(route, "response_model", None)


@control("PRV-03")
def test_no_forbidden_field_names_in_super_admin_response_models():
    violations = []
    checked = 0
    for path, methods, model in _iter_routes(app.routes):
        if not path.startswith("/api/super-admin"):
            continue
        if model is None:
            continue
        checked += 1
        collected: list[tuple[str, str]] = []
        _collect(model, "$", frozenset(), collected)
        for dotted, name in collected:
            if name in FORBIDDEN_FIELD_NAMES and (path, name) not in ALLOWLIST:
                violations.append(f"{sorted(methods or [])} {path} -> {dotted}")
    assert checked > 50, "route walk found suspiciously few super-admin routes"
    assert not violations, (
        "Platform API response models expose record-level identifiers "
        "(ZB-SEC-PRIV-001). Remove the field or return an aggregate:\n  " + "\n  ".join(violations)
    )
