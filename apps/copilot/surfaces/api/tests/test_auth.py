"""Tests for startup gates, auth, and rate limiting on the API surface."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from apps.copilot.broker.broker import ConfirmationBroker
from apps.copilot.config import CopilotSettings
from apps.copilot.surfaces.api.app import StartupConfigurationError, build_app
from apps.copilot.surfaces.api.auth import (
    RateLimiterBackendError,
    RateLimiterConfigurationError,
    RedisRateLimiter,
    SlidingWindowRateLimiter,
    build_rate_limiter,
    get_principal,
)
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


# ─────────────────────────────────────────────────────────────────────────
# Redis-backed rate limiter
# ─────────────────────────────────────────────────────────────────────────


class FakeRedisClient:
    """Async in-memory stand-in for ``redis.asyncio.Redis``.

    Implements just enough of the async client surface for
    :class:`RedisRateLimiter` — ``eval`` (the Lua script), ``delete``,
    and ``keys`` — by executing the sliding-window logic in pure
    Python. We deliberately do not emulate real Redis semantics; the
    goal is to verify the limiter's call shape, not Redis itself.

    Mirrors the ``FakeRedisClient`` pattern used by
    ``portal/shared/tests/test_token_cache.py``.
    """

    def __init__(self) -> None:
        # key → list[(score, member)] sorted by insertion order.
        self._zsets: dict[str, list[tuple[float, str]]] = {}
        self.eval_calls: list[tuple[str, str]] = []
        self.fail_next: bool = False

    async def eval(
        self,
        script: str,  # noqa: ARG002
        numkeys: int,  # noqa: ARG002
        *args: str,
    ) -> int:
        """Emulate the sliding-window Lua script used by the limiter."""
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("simulated redis outage")

        key = args[0]
        now = float(args[1])
        window = float(args[2])
        limit = int(args[3])
        member = args[4]
        self.eval_calls.append((key, member))

        bucket = self._zsets.setdefault(key, [])
        # Trim expired entries.
        cutoff = now - window
        bucket[:] = [(s, m) for (s, m) in bucket if s > cutoff]
        if len(bucket) >= limit:
            return 0
        bucket.append((now, member))
        return 1

    async def delete(self, *keys: str) -> int:
        removed = 0
        for key in keys:
            if key in self._zsets:
                del self._zsets[key]
                removed += 1
        return removed

    async def keys(self, pattern: str) -> list[str]:
        # Only support the ``<prefix>*`` shape our limiter uses.
        if pattern.endswith("*"):
            prefix = pattern[:-1]
            return [k for k in self._zsets if k.startswith(prefix)]
        return [k for k in self._zsets if k == pattern]


@pytest.mark.asyncio
async def test_redis_rate_limiter_allows_under_limit() -> None:
    """Under-limit hits are all admitted by the Redis-backed limiter."""
    client = FakeRedisClient()
    limiter = RedisRateLimiter(
        requests_per_minute=3,
        client=client,
    )
    assert await limiter.check_async("alice")
    assert await limiter.check_async("alice")
    assert await limiter.check_async("alice")
    # 4th hit in the same window → rejected.
    assert await limiter.check_async("alice") is False
    # Different principal → unaffected.
    assert await limiter.check_async("bob") is True


@pytest.mark.asyncio
async def test_redis_rate_limiter_disabled_when_zero() -> None:
    """Zero requests_per_minute disables the limiter entirely."""
    client = FakeRedisClient()
    limiter = RedisRateLimiter(requests_per_minute=0, client=client)
    for _ in range(100):
        assert await limiter.check_async("alice")
    # The Lua path is never invoked.
    assert client.eval_calls == []


@pytest.mark.asyncio
async def test_redis_rate_limiter_fail_closed_on_backend_error() -> None:
    """Backend errors raise :class:`RateLimiterBackendError` by default."""
    client = FakeRedisClient()
    client.fail_next = True
    limiter = RedisRateLimiter(requests_per_minute=3, client=client)
    with pytest.raises(RateLimiterBackendError):
        await limiter.check_async("alice")


@pytest.mark.asyncio
async def test_redis_rate_limiter_fail_open_flag() -> None:
    """`fail_open=True` returns True on backend failure (demo mode only)."""
    client = FakeRedisClient()
    client.fail_next = True
    limiter = RedisRateLimiter(
        requests_per_minute=3,
        client=client,
        fail_open=True,
    )
    assert await limiter.check_async("alice") is True


@pytest.mark.asyncio
async def test_redis_rate_limiter_reset_clears_principal() -> None:
    """Per-principal reset removes only that principal's history."""
    client = FakeRedisClient()
    limiter = RedisRateLimiter(requests_per_minute=2, client=client)
    assert await limiter.check_async("alice")
    assert await limiter.check_async("alice")
    assert await limiter.check_async("alice") is False
    await limiter.reset_async("alice")
    # After reset, alice can hit again.
    assert await limiter.check_async("alice")


def test_build_rate_limiter_memory_backend_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default backend is the in-memory sliding-window limiter."""
    monkeypatch.delenv("COPILOT_API_RATE_LIMIT_BACKEND", raising=False)
    settings = SurfacesSettings(api_rate_limit_per_minute=5)
    limiter = build_rate_limiter(settings)
    assert isinstance(limiter, SlidingWindowRateLimiter)


def test_build_rate_limiter_redis_backend_with_injected_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Callers can inject a redis client so the env URL is not required."""
    monkeypatch.setenv("COPILOT_API_RATE_LIMIT_BACKEND", "redis")
    monkeypatch.delenv("COPILOT_API_RATE_LIMIT_REDIS_URL", raising=False)
    settings = SurfacesSettings(api_rate_limit_per_minute=5)
    fake = FakeRedisClient()
    limiter = build_rate_limiter(settings, redis_client=fake)
    assert isinstance(limiter, RedisRateLimiter)
    assert limiter.client is fake


def test_build_rate_limiter_redis_backend_requires_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Missing ``COPILOT_API_RATE_LIMIT_REDIS_URL`` fails loudly at build time."""
    monkeypatch.setenv("COPILOT_API_RATE_LIMIT_BACKEND", "redis")
    monkeypatch.delenv("COPILOT_API_RATE_LIMIT_REDIS_URL", raising=False)
    settings = SurfacesSettings(api_rate_limit_per_minute=5)
    with pytest.raises(RateLimiterConfigurationError, match="REDIS_URL"):
        build_rate_limiter(settings)


def test_build_rate_limiter_rejects_unknown_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Typos in the backend name refuse to boot."""
    monkeypatch.setenv("COPILOT_API_RATE_LIMIT_BACKEND", "etcd")
    settings = SurfacesSettings(api_rate_limit_per_minute=5)
    with pytest.raises(RateLimiterConfigurationError, match="Unknown"):
        build_rate_limiter(settings)


def test_redis_rate_limiter_trips_through_router(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: a Redis limiter trips via the router → 429.

    We mount the Copilot router on a throwaway FastAPI app that uses
    a :class:`RedisRateLimiter` backed by :class:`FakeRedisClient` so
    no env vars or real Redis are required.
    """
    monkeypatch.setenv("ENVIRONMENT", "local")

    from fastapi import Depends, FastAPI

    from apps.copilot.surfaces.api.auth import rate_limit_dependency
    from apps.copilot.surfaces.api.router import router as copilot_router
    from apps.copilot.surfaces.api.tests.conftest import StubAgent

    fake = FakeRedisClient()
    limiter = RedisRateLimiter(requests_per_minute=2, client=fake)

    fresh_app = FastAPI()
    fresh_app.include_router(
        copilot_router,
        prefix="/copilot",
        dependencies=[Depends(rate_limit_dependency(limiter))],
    )

    fresh_app.dependency_overrides[get_agent] = lambda: StubAgent()
    fresh_app.dependency_overrides[get_broker] = lambda: ConfirmationBroker(
        CopilotSettings(broker_signing_key="t"),
    )
    fresh_app.dependency_overrides[get_registry] = ToolRegistry
    fresh_app.dependency_overrides[get_principal] = lambda: "alice@example.com"

    client = TestClient(fresh_app)
    r1 = client.post("/copilot/ask", json={"question": "hi"})
    r2 = client.post("/copilot/ask", json={"question": "hi"})
    r3 = client.post("/copilot/ask", json={"question": "hi"})
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r3.status_code == 429
    assert r3.headers.get("retry-after") == "60"
