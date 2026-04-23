"""Tests for the portal observability stack — CSA-0042 / CSA-0061 / CSA-0030.

Covers:

* OpenTelemetry bootstrap with a mocked SDK so no OTLP network call is
  ever made during the test suite.
* Prometheus ``/metrics`` endpoint — flag-gated, auth-gated, and returns
  valid Prometheus text exposition format.
* In-process custom metric helpers (token-cache, sqlite-store,
  async-store-errors).
* Rate-limit configuration helpers + no-op limiter stub path.
"""

from __future__ import annotations

import importlib
import importlib.util
from collections.abc import Iterator
from typing import Any

import pytest

# ── Helpers ────────────────────────────────────────────────────────────────


def _reload_observability() -> None:
    """Reload the observability package so env-var changes take effect.

    The module reads env vars at import / first-call time and caches the
    result.  We clear the cache explicitly via the test-only resetter
    helpers, then re-import to pick up flag toggles set by the test.
    """
    from portal.shared.api.observability import metrics as _metrics
    from portal.shared.api.observability import rate_limit as _rate_limit

    _metrics.reset_metrics_registry_for_tests()
    _rate_limit.reset_rate_limiter_for_tests()


@pytest.fixture
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Wipe observability-related env vars so tests start from a clean slate."""
    for key in (
        "PORTAL_METRICS_ENABLED",
        "PORTAL_METRICS_AUTH_TOKEN",
        "PORTAL_RATE_LIMIT_ENABLED",
        "PORTAL_RATE_LIMIT_STORAGE_URI",
        "PORTAL_RATE_LIMIT_DEFAULT_READ",
        "PORTAL_RATE_LIMIT_DEFAULT_WRITE",
        "PORTAL_RATE_LIMIT_SOURCES_POST_PER_MINUTE",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
    ):
        monkeypatch.delenv(key, raising=False)
    _reload_observability()
    yield
    _reload_observability()


# ── CSA-0042: OpenTelemetry bootstrap ──────────────────────────────────────


@pytest.mark.usefixtures("_clean_env")
class TestTracer:
    """Tracing configuration + lazy SDK imports."""

    def test_disabled_when_endpoint_unset(self) -> None:
        from portal.shared.api.observability.tracer import build_tracing_config

        cfg = build_tracing_config()
        assert cfg.enabled is False
        assert cfg.otlp_endpoint is None

    def test_enabled_when_endpoint_set(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318/v1/traces")
        from portal.shared.api.observability.tracer import build_tracing_config

        cfg = build_tracing_config()
        assert cfg.enabled is True
        assert cfg.otlp_endpoint == "http://localhost:4318/v1/traces"

    def test_configure_tracing_noop_when_disabled(self) -> None:
        """configure_tracing returns cleanly when OTel is disabled."""
        from fastapi import FastAPI
        from portal.shared.api.observability.tracer import configure_tracing

        app = FastAPI()
        cfg = configure_tracing(app)
        assert cfg.enabled is False

    @pytest.mark.skipif(
        not importlib.util.find_spec("opentelemetry") or not importlib.util.find_spec("opentelemetry.sdk"),
        reason="opentelemetry-sdk not installed",
    )
    def test_configure_tracing_with_real_sdk(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Real OTel SDK is installed — configure_tracing must wire up a provider.

        This exercises the full code path: BatchSpanProcessor construction,
        OTLPSpanExporter instantiation, and W3C propagator installation.
        The OTLP exporter defers its network connection until the first
        export attempt, so no real traffic leaves the process.
        """
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318/v1/traces")

        # Spy on trace.set_tracer_provider to confirm it was called.
        from opentelemetry import trace as _otel_trace

        calls: dict[str, Any] = {}
        original = _otel_trace.set_tracer_provider

        def _spy(provider: Any) -> Any:
            calls["provider"] = provider
            return original(provider)

        monkeypatch.setattr(_otel_trace, "set_tracer_provider", _spy)

        from fastapi import FastAPI
        from portal.shared.api.observability.tracer import (
            configure_tracing,
            shutdown_tracing,
        )

        app = FastAPI()
        cfg = configure_tracing(app)

        try:
            assert cfg.enabled is True
            # Provider from the real SDK package.
            from opentelemetry.sdk.trace import TracerProvider

            assert isinstance(calls["provider"], TracerProvider)
        finally:
            shutdown_tracing()

    def test_configure_tracing_degrades_when_sdk_missing(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """When the OTel SDK import fails, the bootstrap logs + returns disabled.

        Simulates a slim deployment where the optional ``opentelemetry-*``
        extras are not installed.  The portal must still start cleanly and
        return an ``enabled=False`` config so downstream callers can safely
        no-op.
        """
        import sys

        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")

        # Block the SDK imports — the real import statement inside
        # configure_tracing will raise ImportError and the function must
        # catch + degrade gracefully.
        blocked = [
            "opentelemetry",
            "opentelemetry.trace",
            "opentelemetry.sdk.trace",
            "opentelemetry.sdk.trace.export",
            "opentelemetry.sdk.resources",
            "opentelemetry.propagate",
            "opentelemetry.propagators.composite",
            "opentelemetry.trace.propagation.tracecontext",
        ]
        for mod in blocked:
            monkeypatch.setitem(sys.modules, mod, None)

        from fastapi import FastAPI

        # Importing tracer still works (top-level does no SDK imports).
        from portal.shared.api.observability import tracer as _tracer_mod

        importlib.reload(_tracer_mod)

        app = FastAPI()
        cfg = _tracer_mod.configure_tracing(app)
        assert cfg.enabled is False

    def test_set_span_attributes_noop_without_span(self) -> None:
        """set_span_attributes must not raise when no span is active."""
        from portal.shared.api.observability.tracer import set_span_attributes

        # When the real OTel is installed but no span is active, this
        # should silently no-op.
        set_span_attributes(
            route="sources.register",
            user_principal="00000000-0000-0000-0000-000000000001",
            domain_scope="finance",
            store_backend="sqlite",
        )


# ── CSA-0061: Prometheus metrics endpoint ──────────────────────────────────


@pytest.mark.usefixtures("_clean_env")
class TestMetricsEndpoint:
    """/metrics exposition + in-process custom metrics."""

    def _build_app(self, monkeypatch: pytest.MonkeyPatch, **env: str) -> Any:
        """Create a tiny FastAPI app with metrics installed."""
        from fastapi import FastAPI

        for k, v in env.items():
            monkeypatch.setenv(k, v)
        _reload_observability()

        from portal.shared.api.observability.metrics import install_metrics

        app = FastAPI()

        @app.get("/api/ping")
        async def _ping() -> dict[str, str]:
            return {"ok": "yes"}

        install_metrics(app)
        return app

    def test_metrics_disabled_returns_404(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """With the flag off, /metrics is not mounted at all."""
        from starlette.testclient import TestClient

        app = self._build_app(monkeypatch)  # flag off

        client = TestClient(app)
        resp = client.get("/metrics")
        assert resp.status_code == 404

    def test_metrics_enabled_returns_prometheus_exposition(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Exposition body is well-formed Prometheus text format."""
        from starlette.testclient import TestClient

        app = self._build_app(monkeypatch, PORTAL_METRICS_ENABLED="true")

        client = TestClient(app)
        # Seed the histograms by hitting the app once first.
        client.get("/api/ping")

        resp = client.get("/metrics")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/plain")

        body = resp.text
        # Well-formed exposition format contains HELP / TYPE lines.
        assert "# HELP portal_http_requests_total" in body
        assert "# TYPE portal_http_requests_total counter" in body
        assert "# TYPE portal_http_request_duration_seconds histogram" in body
        # The ping hit must have produced at least one observation.
        assert 'portal_http_requests_total{method="GET",route="/api/ping",status_code="200"}' in body

    def test_metrics_bearer_auth(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """When PORTAL_METRICS_AUTH_TOKEN is set, bearer auth is enforced."""
        from starlette.testclient import TestClient

        app = self._build_app(
            monkeypatch,
            PORTAL_METRICS_ENABLED="true",
            PORTAL_METRICS_AUTH_TOKEN="s3cret-token",
        )
        client = TestClient(app)

        # Missing token -> 401.
        resp = client.get("/metrics")
        assert resp.status_code == 401
        assert resp.headers["www-authenticate"].startswith("Bearer")

        # Wrong token -> 401.
        resp = client.get("/metrics", headers={"Authorization": "Bearer wrong"})
        assert resp.status_code == 401

        # Correct token -> 200.
        resp = client.get("/metrics", headers={"Authorization": "Bearer s3cret-token"})
        assert resp.status_code == 200
        assert "portal_http_requests_total" in resp.text

    def test_record_helpers_increment_counters(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Custom metric helpers update the labelled counters."""
        monkeypatch.setenv("PORTAL_METRICS_ENABLED", "true")
        _reload_observability()

        from portal.shared.api.observability.metrics import (
            get_metrics_registry,
            record_async_store_error,
            record_sqlite_store_op,
            record_token_cache_hit,
        )

        record_token_cache_hit("hit")
        record_token_cache_hit("miss")
        record_token_cache_hit("miss")
        record_sqlite_store_op("add")
        record_sqlite_store_op("get")
        record_async_store_error("postgres", "update")

        from prometheus_client import generate_latest

        body = generate_latest(get_metrics_registry().registry).decode("utf-8")
        assert 'portal_bff_token_cache_hits_total{result="hit"} 1.0' in body
        assert 'portal_bff_token_cache_hits_total{result="miss"} 2.0' in body
        assert 'portal_sqlite_store_ops_total{op="add"} 1.0' in body
        assert 'portal_sqlite_store_ops_total{op="get"} 1.0' in body
        assert (
            'portal_async_store_errors_total{backend="postgres",op="update"} 1.0'
            in body
        )

    def test_record_helpers_noop_when_disabled(self) -> None:
        """Helpers silently no-op when PORTAL_METRICS_ENABLED is false."""
        from portal.shared.api.observability.metrics import (
            record_async_store_error,
            record_sqlite_store_op,
            record_token_cache_hit,
        )

        # No exception means the helpers gated correctly.
        record_token_cache_hit("hit")
        record_sqlite_store_op("add")
        record_async_store_error("sqlite", "add")


# ── CSA-0030: Rate limiting ─────────────────────────────────────────────────


@pytest.mark.usefixtures("_clean_env")
class TestRateLimit:
    """Rate-limit configuration + no-op + slowapi wiring."""

    def test_noop_limiter_when_disabled(self) -> None:
        """When the flag is off, build_rate_limiter returns a no-op."""
        from portal.shared.api.observability.rate_limit import (
            _NoopLimiter,
            build_rate_limiter,
        )

        limiter = build_rate_limiter()
        assert isinstance(limiter, _NoopLimiter)

        # The .limit decorator must be a pass-through.
        @limiter.limit("5/minute")
        def _handler() -> int:
            return 42

        assert _handler() == 42

    def test_slowapi_limiter_when_enabled(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """With flag on + slowapi available, a real Limiter is returned."""
        monkeypatch.setenv("PORTAL_RATE_LIMIT_ENABLED", "true")
        _reload_observability()

        from portal.shared.api.observability.rate_limit import build_rate_limiter
        from slowapi import Limiter

        limiter = build_rate_limiter()
        assert isinstance(limiter, Limiter)

    def test_get_route_limit_defaults_and_override(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Env-var overrides format as N/minute; defaults kick in otherwise."""
        from portal.shared.api.observability.rate_limit import get_route_limit

        # Default for writes is 60/minute.
        assert get_route_limit("sources_post", write=True) == "60/minute"
        # Default for reads is 300/minute.
        assert get_route_limit("sources_list") == "300/minute"

        monkeypatch.setenv("PORTAL_RATE_LIMIT_SOURCES_POST_PER_MINUTE", "10")
        assert get_route_limit("sources_post", write=True) == "10/minute"

    def test_429_response_on_limit_exceeded(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Burst beyond the per-principal window yields a 429 with Retry-After."""
        from fastapi import FastAPI, Request
        from starlette.testclient import TestClient

        monkeypatch.setenv("PORTAL_RATE_LIMIT_ENABLED", "true")
        # Force a very low limit so the test is deterministic.
        monkeypatch.setenv("PORTAL_RATE_LIMIT_TEST_PER_MINUTE", "2")
        _reload_observability()

        from portal.shared.api.observability.rate_limit import (
            build_rate_limiter,
            get_route_limit,
            install_rate_limiting,
        )

        app = FastAPI()
        limiter = install_rate_limiting(app)

        # Prove we got a real slowapi limiter back (not the no-op stub).
        assert limiter is build_rate_limiter()

        async def _endpoint(request):  # type: ignore[no-untyped-def]  # noqa: ARG001
            return {"ok": "yes"}

        # Apply the annotation post-hoc so FastAPI's DI solver sees the
        # class object rather than the stringified ``Request`` name
        # produced by ``from __future__ import annotations`` in this
        # test file.
        _endpoint.__annotations__["request"] = Request
        _endpoint = limiter.limit(get_route_limit("test"))(_endpoint)
        app.add_api_route("/t", _endpoint, methods=["GET"])

        client = TestClient(app)
        # First two requests succeed.
        r1 = client.get("/t")
        r2 = client.get("/t")
        assert r1.status_code == 200, r1.text
        assert r2.status_code == 200, r2.text
        # Third request hits the limit.
        r3 = client.get("/t")
        assert r3.status_code == 429
        # The portal's 429 handler guarantees a Retry-After header + a
        # ``rate_limit_exceeded`` error body.
        assert r3.headers.get("retry-after") is not None
        assert "rate_limit_exceeded" in r3.text


# ── Integration smoke: wiring through portal main app ──────────────────────


def test_portal_main_app_still_boots_with_observability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Importing portal.shared.api.main with observability wired up must
    not raise, even with all feature flags off (default baseline).
    """
    # The conftest autouse fixture already loads the app; we just ensure
    # the observability package and its exports resolve cleanly.  Clear
    # OTel / metrics / rate-limit env vars so the default-off contract is
    # exercised regardless of the developer's shell state.
    for key in (
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "PORTAL_METRICS_ENABLED",
        "PORTAL_RATE_LIMIT_ENABLED",
    ):
        monkeypatch.delenv(key, raising=False)
    _reload_observability()

    from portal.shared.api import observability as obs

    assert callable(obs.build_metrics_registry)
    assert callable(obs.build_rate_limit_config)
    assert callable(obs.build_tracing_config)
    assert callable(obs.configure_tracing)
    # Feature-flag defaults: everything off.
    assert obs.build_rate_limit_config().enabled is False
    assert obs.build_tracing_config().enabled is False
    assert obs.build_metrics_registry().enabled is False
