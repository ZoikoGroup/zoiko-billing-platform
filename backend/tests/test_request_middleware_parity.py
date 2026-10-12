"""
Parity: the merged pure-ASGI RequestContextMiddleware must behave exactly like
the two BaseHTTPMiddleware functions it replaced (copied verbatim below from
the pre-change main.py): identical response header sets (normal / 404 / handled
error / streaming), X-Request-ID reuse + echo, request.state.request_id visible
to handlers and exception handlers, per-route metrics + query counter.
"""
import time
import uuid

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app.core.request_middleware import RequestContextMiddleware


def _old_stack(app: FastAPI):
    """Verbatim logic of the former two @app.middleware("http") functions
    (registration order preserved: security first, request-id second/outer)."""

    @app.middleware("http")
    async def security_headers_middleware(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "0"
        response.headers["X-Request-ID"] = getattr(request.state, "request_id", "")
        return response

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        request.state.request_id = request_id
        from app.core import query_counter

        qtoken = query_counter.start()
        try:
            response = await call_next(request)
        finally:
            query_counter.finish(qtoken)
        response.headers["X-Request-ID"] = request_id
        return response


def _build(new: bool) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(HTTPException)
    async def _h(request: Request, exc: HTTPException):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": exc.detail, "rid": request.state.request_id},
                            status_code=exc.status_code)

    @app.get("/ok")
    def ok(request: Request):
        return {"rid": request.state.request_id}

    @app.get("/err")
    def err():
        raise HTTPException(status_code=409, detail="nope")

    @app.get("/stream")
    def stream():
        def gen():
            yield b"a"
            yield b"b"
        return StreamingResponse(gen(), media_type="application/octet-stream",
                                 headers={"Content-Disposition": "attachment; filename=x.bin"})

    if new:
        app.add_middleware(RequestContextMiddleware)
    else:
        _old_stack(app)
    return app


def _norm(resp):
    return [(k.lower(), v) for k, v in resp.headers.multi_items()]


@pytest.mark.parametrize("path,status", [("/ok", 200), ("/missing", 404), ("/err", 409), ("/stream", 200)])
def test_header_sets_identical(path, status):
    old = TestClient(_build(False)).get(path, headers={"X-Request-ID": "req-123"})
    new = TestClient(_build(True)).get(path, headers={"X-Request-ID": "req-123"})
    assert old.status_code == new.status_code == status
    assert _norm(old) == _norm(new)  # same names, values AND order
    assert new.headers["x-request-id"] == "req-123"
    assert new.headers["x-content-type-options"] == "nosniff"
    assert new.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert new.headers["x-frame-options"] == "DENY"
    assert new.headers["x-xss-protection"] == "0"
    assert old.content == new.content


def test_generated_request_id_and_state_visibility():
    for flag in (False, True):
        r = TestClient(_build(flag)).get("/ok")
        rid = r.headers["x-request-id"]
        uuid.UUID(rid)
        assert r.json()["rid"] == rid
        e = TestClient(_build(flag)).get("/err")
        assert e.json()["rid"] == e.headers["x-request-id"]


def test_empty_incoming_request_id_is_regenerated():
    for flag in (False, True):
        r = TestClient(_build(flag)).get("/ok", headers={"X-Request-ID": ""})
        uuid.UUID(r.headers["x-request-id"])


def test_metrics_and_query_counter_recorded(monkeypatch):
    import app.core.api_metrics as api_metrics

    seen = []
    monkeypatch.setattr(api_metrics, "record_route", lambda *a: seen.append(a))
    app = _build(True)
    TestClient(app).get("/ok")
    assert seen and seen[0][0] == "GET" and seen[0][1] == "/ok" and seen[0][3] == 200
    assert seen[0][4] == 0  # query count


def test_super_admin_path_records_command_center_metric(monkeypatch):
    import app.core.api_metrics as api_metrics

    rec = []
    monkeypatch.setattr(api_metrics, "record", lambda *a: rec.append(a))
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    @app.get("/api/super-admin/x")
    def x():
        return {}

    TestClient(app).get("/api/super-admin/x")
    assert rec and rec[0][1] == 200


def test_slow_request_logged(monkeypatch, caplog):
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    @app.get("/slow")
    def slow():
        time.sleep(0.01)
        return {}

    import app.core.request_middleware as rm
    from types import SimpleNamespace
    ticks = iter([0.0, 2.0] + [2.0] * 10)
    monkeypatch.setattr(rm, "time", SimpleNamespace(perf_counter=lambda: next(ticks)))
    with caplog.at_level("WARNING", logger="zoiko_billing.perf"):
        TestClient(app).get("/slow", headers={"X-Request-ID": "slow-1"})
    assert any("slow/chatty request GET /slow" in m and "slow-1" in m for m in caplog.messages)


def test_real_app_registers_single_custom_middleware():
    from app.main import app as real_app

    names = [m.cls.__name__ for m in real_app.user_middleware]
    assert names.count("RequestContextMiddleware") == 1
    assert "BaseHTTPMiddleware" not in names
