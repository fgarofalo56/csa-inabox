"""Tests for :mod:`apps.copilot.telemetry.tracer`."""

from __future__ import annotations

import importlib
import sys
from collections.abc import Iterator
from types import ModuleType

import pytest

import apps.copilot.telemetry.tracer as tracer_mod


@pytest.fixture(autouse=True)
def _reset_tracer_cache() -> Iterator[None]:
    """Clear tracer cache before and after each test."""
    tracer_mod.reset_tracer_cache()
    yield
    tracer_mod.reset_tracer_cache()


class TestOTelAvailability:
    def test_is_otel_available_is_cached(self) -> None:
        first = tracer_mod.is_otel_available()
        # Mutating the cache should not change result on repeat call.
        second = tracer_mod.is_otel_available()
        assert first == second

    def test_is_otel_available_false_when_module_missing(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Simulate an env without opentelemetry.trace installed."""

        # Save real module (if present) so we restore it on teardown.
        real = sys.modules.get("opentelemetry.trace")
        sys.modules["opentelemetry.trace"] = None  # type: ignore[assignment]
        try:
            tracer_mod.reset_tracer_cache()

            # Patch importlib + __import__ so the ``import
            # opentelemetry.trace`` inside is_otel_available() raises.
            import builtins

            original_import = builtins.__import__

            def fake_import(
                name: str,
                globals: dict[str, object] | None = None,  # noqa: A002
                locals: dict[str, object] | None = None,  # noqa: A002
                fromlist: tuple[str, ...] = (),
                level: int = 0,
            ) -> ModuleType:
                if name == "opentelemetry.trace" or name.startswith("opentelemetry.trace."):
                    raise ImportError("simulated absence of opentelemetry")
                return original_import(name, globals, locals, fromlist, level)

            monkeypatch.setattr("builtins.__import__", fake_import)
            assert tracer_mod.is_otel_available() is False
        finally:
            if real is not None:
                sys.modules["opentelemetry.trace"] = real
            else:
                sys.modules.pop("opentelemetry.trace", None)

    def test_package_imports_without_otel(self) -> None:
        """Negative test: the telemetry package MUST import without OTel installed."""
        # Simulate by blocking the import via sys.modules.
        original = {
            k: sys.modules[k]
            for k in list(sys.modules)
            if k == "opentelemetry" or k.startswith("opentelemetry.")
        }
        for mod_name in original:
            sys.modules[mod_name] = None  # type: ignore[assignment]

        # Reload our telemetry modules.
        try:
            import apps.copilot.telemetry
            importlib.reload(apps.copilot.telemetry.tracer)
            importlib.reload(apps.copilot.telemetry.spans)
            importlib.reload(apps.copilot.telemetry)
            tracer_mod.reset_tracer_cache()
            # get_tracer must return a no-op tracer that supports
            # start_as_current_span without raising.
            tracer = apps.copilot.telemetry.get_tracer("test.noop")
            ctx = tracer.start_as_current_span("test.span")
            with ctx as span:
                span.set_attribute("copilot.test", "ok")
        finally:
            for k, v in original.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v
            # Reload to restore the real state.
            importlib.reload(apps.copilot.telemetry.tracer)
            importlib.reload(apps.copilot.telemetry.spans)
            importlib.reload(apps.copilot.telemetry)


class TestGetTracer:
    def test_returns_noop_when_endpoint_unset(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        tracer = tracer_mod.get_tracer("apps.copilot.test")
        # Regardless of OTel availability, no endpoint -> no-op.
        assert tracer.__class__.__name__ == "_NoOpTracer"

    def test_returns_noop_when_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", "http://example.invalid")
        monkeypatch.setenv("COPILOT_OTEL_DISABLE", "1")
        tracer = tracer_mod.get_tracer("apps.copilot.test")
        assert tracer.__class__.__name__ == "_NoOpTracer"

    def test_tracer_is_cached(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        t1 = tracer_mod.get_tracer("apps.copilot.cache")
        t2 = tracer_mod.get_tracer("apps.copilot.cache")
        assert t1 is t2


class TestNoOpSpan:
    def test_noop_span_supports_full_surface(self) -> None:
        tracer = tracer_mod._NoOpTracer()
        cm = tracer.start_as_current_span("noop")
        with cm as span:
            span.set_attribute("copilot.x", 1)
            span.set_status("ok")
            ctx = span.get_span_context()
            assert ctx.is_valid is False
            assert ctx.trace_id == 0
            assert ctx.span_id == 0
            assert span.is_recording() is False
            span.record_exception(RuntimeError("noop"))
            span.end()


class TestCurrentTraceIds:
    def test_returns_none_when_otel_unavailable(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(tracer_mod, "is_otel_available", lambda: False)
        assert tracer_mod.current_trace_ids() == (None, None)

    def test_returns_none_outside_span(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Even with OTel installed, outside a span we get (None, None)."""
        if not tracer_mod.is_otel_available():
            pytest.skip("opentelemetry.api not installed")
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        trace_id, span_id = tracer_mod.current_trace_ids()
        # Outside any span, trace_id/span_id are invalid.
        assert trace_id is None
        assert span_id is None
