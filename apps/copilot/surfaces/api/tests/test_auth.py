"""Tests for startup gates, auth, and rate limiting on the API surface."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from apps.copilot.broker.broker import ConfirmationBroker
from apps.copilot.config import CopilotSettings
from apps.copilot.surfaces.api.app import StartupConfigurationError, build_app
from apps.copilot.surfaces.api.auth import SlidingWindowRateLimiter, get_principal
from apps.copilot.surfaces.api.dependencies import (
    get_agent,
    get_broker,
    get_registry,
)
from apps.copilot.surfaces.config import SurfacesSettings
from apps.copilot.tools.registry import ToolRegistry


def test_staging_refuses_to_start_without_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """Staging/production refuses to boot without auth enabled."""
    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.delenv("AZURE_TENANT_ID", raising=False)
    settings = SurfacesSettings(api_auth_enabled=False)
    with pytest.raises(StartupConfigurationError, match="refuses to start"):
        build_app(settings=settings)


def test_production_requires_tenant_and_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """Production rejects missing tenant / client IDs."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("AZURE_TENANT_ID", raising=False)
    monkeypatch.delenv("AZURE_CLIENT_ID", raising=False)
    settings = SurfacesSettings(api_auth_enabled=True)
    with pytest.raises(StartupConfigurationError, match="AZURE_TENANT_ID"):
        build_app(settings=settings)


def test_cors_rejects_wildcards_in_staging(monkeypatch: pytest.MonkeyPatch) -> None:
    """CORS wildcards refused outside local/dev."""
    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.setenv("AZURE_TENANT_ID", "t")
    monkeypatch.setenv("AZURE_CLIENT_ID", "c")
    settings = SurfacesSettings(
        api_auth_enabled=True,
        api_cors_origins=["https://*.example.com"],
    )
    with pytest.raises(StartupConfigurationError, match="wildcard"):
        build_app(settings=settings)


def test_local_env_accepts_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local env is allowed to run without auth."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    settings = SurfacesSettings(api_auth_enabled=False)
    app = build_app(settings=settings)
    # Sanity — app constructed successfully.
    assert app.title == "CSA Copilot API"


def test_rate_limiter_allows_requests_under_limit() -> None:
    """Basic sliding-window limiter — below threshold → allowed."""
    limiter = SlidingWindowRateLimiter(requests_per_minute=3)
    assert limiter.check("a")
    assert limiter.check("a")
    assert limiter.check("a")
    # 4th hit in the same 60s window → blocked.
    assert not limiter.check("a")
    # Different principal → not affected.
    assert limiter.check("b")


def test_rate_limiter_disabled_when_zero() -> None:
    """requests_per_minute=0 short-circuits the limiter."""
    limiter = SlidingWindowRateLimiter(requests_per_minute=0)
    for _ in range(1000):
        assert limiter.check("a")


def test_rate_limit_returns_429_through_router(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The router returns 429 once the limiter trips."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    settings = SurfacesSettings(
        api_auth_enabled=False,
        api_rate_limit_per_minute=2,
    )
    app = build_app(settings=settings)

    from apps.copilot.surfaces.api.tests.conftest import StubAgent

    stub = StubAgent()
    app.dependency_overrides[get_agent] = lambda: stub
    app.dependency_overrides[get_broker] = lambda: ConfirmationBroker(
        CopilotSettings(broker_signing_key="t"),
    )
    app.dependency_overrides[get_registry] = ToolRegistry
    app.dependency_overrides[get_principal] = lambda: "alice@example.com"

    client = TestClient(app)
    r1 = client.post("/copilot/ask", json={"question": "hello"})
    r2 = client.post("/copilot/ask", json={"question": "hello"})
    r3 = client.post("/copilot/ask", json={"question": "hello"})
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r3.status_code == 429
    assert r3.headers.get("retry-after") == "60"


def test_unauthenticated_requests_blocked_when_auth_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When auth is enabled and no bearer token is supplied, 401.

    We exercise this path by building a real app (no dependency override
    for ``get_principal``) in an ENVIRONMENT=local/AUTH_DISABLED=false
    configuration — the underlying ``csa_platform.common.auth`` then
    enforces the bearer requirement.
    """
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_DISABLED", "false")
    monkeypatch.setenv("AZURE_TENANT_ID", "tenant")
    monkeypatch.setenv("AZURE_CLIENT_ID", "client")
    settings = SurfacesSettings(
        api_auth_enabled=True,
        api_rate_limit_per_minute=0,
    )
    app = build_app(settings=settings)

    from apps.copilot.surfaces.api.tests.conftest import StubAgent

    app.dependency_overrides[get_agent] = lambda: StubAgent()
    app.dependency_overrides[get_broker] = lambda: ConfirmationBroker(
        CopilotSettings(broker_signing_key="t"),
    )
    app.dependency_overrides[get_registry] = ToolRegistry

    client = TestClient(app)
    resp = client.post("/copilot/ask", json={"question": "hello"})
    assert resp.status_code == 401
