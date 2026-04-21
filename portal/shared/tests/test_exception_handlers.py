"""Regression tests for CSA-0029: global exception handlers.

Every failure path must return a structured JSON body with a
correlation id and MUST NOT leak tracebacks or internal details to the
caller. Inbound ``x-correlation-id`` / ``x-request-id`` headers are
propagated when supplied so upstream services can correlate logs.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.testclient import TestClient


def test_http_exception_carries_correlation_id(client: TestClient) -> None:
    """A 404 from FastAPI picks up the correlation-id envelope."""
    resp = client.get("/api/v1/does-not-exist")
    assert resp.status_code == 404
    body = resp.json()
    assert "correlation_id" in body
    assert body["correlation_id"]
    assert resp.headers.get("x-correlation-id") == body["correlation_id"]


def test_inbound_correlation_id_is_propagated(client: TestClient) -> None:
    """A caller-supplied correlation id round-trips in the response."""
    cid = "caller-provided-trace-123"
    resp = client.get("/api/v1/does-not-exist", headers={"x-correlation-id": cid})
    assert resp.status_code == 404
    assert resp.json()["correlation_id"] == cid
    assert resp.headers.get("x-correlation-id") == cid


def test_request_id_header_is_also_accepted(client: TestClient) -> None:
    """``x-request-id`` is an accepted synonym for the correlation id."""
    cid = "req-id-from-front-door-abc"
    resp = client.get("/api/v1/does-not-exist", headers={"x-request-id": cid})
    assert resp.status_code == 404
    assert resp.json()["correlation_id"] == cid


def test_validation_error_shape(client: TestClient) -> None:
    """Validation errors (422) include a typed correlation envelope."""
    # Sources listing accepts a typed query param — pass a non-int to
    # trigger FastAPI's own RequestValidationError.
    resp = client.get("/api/v1/sources?limit=not-an-int")
    assert resp.status_code == 422
    body = resp.json()
    assert body["type"] == "validation_error"
    assert "detail" in body
    assert "correlation_id" in body


def test_unhandled_exception_never_leaks_traceback(app) -> None:
    """Unhandled exceptions become a 500 with a correlation id only.

    Uses a dedicated TestClient with ``raise_server_exceptions=False``
    so the HTTP envelope (what a real caller would see on the wire) is
    observable. With the default setting the test client re-raises
    500-generating exceptions so Starlette's ``ServerErrorMiddleware``
    can't be asserted against.
    """
    # Mount a throwaway router that raises so we can exercise the
    # catch-all handler without breaking real endpoints.
    test_router = APIRouter()

    @test_router.get("/__test_boom__", include_in_schema=False)
    async def _boom() -> dict:
        raise RuntimeError("detailed internal secret — must not leak")

    app.include_router(test_router)
    try:
        with TestClient(app, raise_server_exceptions=False) as wire_client:
            resp = wire_client.get("/__test_boom__")
    finally:
        # Remove the test route so we don't pollute other tests.
        app.router.routes = [
            r for r in app.router.routes
            if getattr(r, "path", None) != "/__test_boom__"
        ]

    assert resp.status_code == 500
    body = resp.json()
    assert body["detail"] == "Internal server error"
    assert body["type"] == "internal_error"
    assert body["correlation_id"]
    # The secret exception message must never appear in the response.
    assert "detailed internal secret" not in resp.text
