"""OpenTelemetry tracer bootstrap with graceful SDK absence.

The Copilot telemetry package is designed to import *without* the OTel
SDK available — it only hard-depends on ``opentelemetry-api`` when it
is installed, and otherwise falls back to a no-op tracer.  This keeps
CI lean, unit tests fast, and avoids coupling every developer install
to the heavier OTel sidecar.

Activation is driven by environment variables:

* ``COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT`` — when set, the tracer
  configures an OTLP gRPC exporter pointing at that endpoint.
* ``COPILOT_OTEL_SERVICE_NAME`` — optional, defaults to
  ``"csa-copilot"``.
* ``COPILOT_OTEL_DISABLE`` — truthy value force-disables OTel even
  when the endpoint is set (useful in tests).

The module caches a single :class:`TracerProvider` so repeated calls
to :func:`get_tracer` reuse the same provider and BatchSpanProcessor.
Tests can reset the cache via :func:`reset_tracer_cache`.
"""

from __future__ import annotations

import os
import threading
from typing import Any

_TRACER_CACHE: dict[str, Any] = {}
_CACHE_LOCK = threading.Lock()
_OTEL_AVAILABLE: bool | None = None


def is_otel_available() -> bool:
    """Return ``True`` when ``opentelemetry.api`` can be imported.

    The check is cached for the lifetime of the process so repeated
    calls are zero-cost.  Resetting the cache (e.g. for tests that
    monkey-patch ``sys.modules``) is available via
    :func:`reset_tracer_cache`.
    """
    global _OTEL_AVAILABLE
    if _OTEL_AVAILABLE is not None:
        return _OTEL_AVAILABLE
    try:
        import opentelemetry.trace  # noqa: F401
    except ImportError:
        _OTEL_AVAILABLE = False
    else:
        _OTEL_AVAILABLE = True
    return _OTEL_AVAILABLE


def _truthy(value: str | None) -> bool:
    """Return True for the common truthy strings ('1', 'true', 'yes')."""
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _otlp_endpoint_configured() -> str | None:
    """Return the configured OTLP endpoint, or ``None`` when disabled."""
    if _truthy(os.environ.get("COPILOT_OTEL_DISABLE")):
        return None
    endpoint = os.environ.get("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return None
    return endpoint.strip()


def _build_tracer_provider(service_name: str, endpoint: str) -> Any:
    """Build a configured :class:`TracerProvider` with an OTLP exporter.

    Imports are deferred so this function only runs when OTel is
    available and an endpoint is configured.
    """
    # Deferred imports - only when OTel is present.
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    try:
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )
    except ImportError:
        # Fallback: try the HTTP exporter if gRPC isn't installed.
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    return provider


class _NoOpSpan:
    """No-op span used when OTel SDK is unavailable or disabled.

    Implements just enough surface area for our :class:`copilot_span`
    context manager to call ``set_attribute`` / ``set_status`` /
    ``record_exception`` without raising.
    """

    def set_attribute(self, key: str, value: Any) -> None:  # noqa: ARG002
        return None

    def set_status(self, status: Any) -> None:  # noqa: ARG002
        return None

    def record_exception(self, exc: BaseException, attributes: Any = None) -> None:  # noqa: ARG002
        return None

    def get_span_context(self) -> Any:
        return _NoOpSpanContext()

    def is_recording(self) -> bool:
        return False

    def end(self) -> None:
        return None


class _NoOpSpanContext:
    """Minimal :class:`SpanContext` stand-in for the no-op path."""

    trace_id: int = 0
    span_id: int = 0
    is_valid: bool = False


class _NoOpTracer:
    """No-op tracer returned when OTel SDK is unavailable.

    The return value implements :class:`_NoOpSpan` which the
    context-manager helpers know how to consume without importing
    ``opentelemetry.trace`` at all.
    """

    def start_as_current_span(self, name: str, attributes: Any = None) -> Any:  # noqa: ARG002
        return _NoOpContextManager()


class _NoOpContextManager:
    """Sync + async context manager yielding a :class:`_NoOpSpan`.

    Mirrors the OTel ``Tracer.start_as_current_span`` shape so our
    callers see a uniform interface.
    """

    def __enter__(self) -> _NoOpSpan:
        return _NoOpSpan()

    def __exit__(self, *exc: Any) -> None:
        return None

    async def __aenter__(self) -> _NoOpSpan:
        return _NoOpSpan()

    async def __aexit__(self, *exc: Any) -> None:
        return None


def get_tracer(name: str) -> Any:
    """Return a tracer for *name* (idempotent + cached).

    When the OTel SDK is installed AND
    ``COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT`` is set, returns a real
    :class:`~opentelemetry.trace.Tracer` wired to a BatchSpanProcessor
    + OTLP exporter.  Otherwise returns a :class:`_NoOpTracer` that
    supports the same public surface so instrumented code never
    branches on OTel availability.
    """
    with _CACHE_LOCK:
        if name in _TRACER_CACHE:
            return _TRACER_CACHE[name]

        endpoint = _otlp_endpoint_configured()
        if not endpoint or not is_otel_available():
            tracer: Any = _NoOpTracer()
            _TRACER_CACHE[name] = tracer
            return tracer

        # Real OTel path.
        service_name = os.environ.get("COPILOT_OTEL_SERVICE_NAME", "csa-copilot")

        # Cache the provider under a sentinel key so we only build it once.
        provider = _TRACER_CACHE.get("__provider__")
        if provider is None:
            try:
                provider = _build_tracer_provider(service_name, endpoint)
            except ImportError:
                # SDK pieces present but exporter missing — fall back to no-op.
                tracer = _NoOpTracer()
                _TRACER_CACHE[name] = tracer
                return tracer

            from opentelemetry import trace as _trace

            # Only set the global provider once per process.  If
            # something else has already set one (e.g. the host app),
            # prefer the existing provider so spans correlate.
            existing = _trace.get_tracer_provider()
            if type(existing).__name__ == "ProxyTracerProvider":
                _trace.set_tracer_provider(provider)
            else:
                provider = existing
            _TRACER_CACHE["__provider__"] = provider

        from opentelemetry import trace as _trace

        tracer = _trace.get_tracer(name, tracer_provider=provider)
        _TRACER_CACHE[name] = tracer
        return tracer


def reset_tracer_cache() -> None:
    """Forget any cached tracers and the availability flag.

    Useful in tests that manipulate ``sys.modules`` or environment
    variables between runs.
    """
    global _OTEL_AVAILABLE
    with _CACHE_LOCK:
        _TRACER_CACHE.clear()
        _OTEL_AVAILABLE = None


def current_trace_ids() -> tuple[str | None, str | None]:
    """Return ``(trace_id, span_id)`` for the currently active span.

    Both values are hex strings without the ``0x`` prefix, matching
    OTel's canonical log-correlation representation.  Returns
    ``(None, None)`` when no span is active or OTel is unavailable.
    """
    if not is_otel_available():
        return (None, None)
    # Import lazily so the no-op path never requires opentelemetry.api.
    from opentelemetry import trace as _trace

    span = _trace.get_current_span()
    if span is None:  # pragma: no cover - API always returns a span
        return (None, None)
    ctx = span.get_span_context()
    if not getattr(ctx, "is_valid", False):
        return (None, None)

    trace_id = f"{ctx.trace_id:032x}"
    span_id = f"{ctx.span_id:016x}"
    return (trace_id, span_id)


__all__ = [
    "current_trace_ids",
    "get_tracer",
    "is_otel_available",
    "reset_tracer_cache",
]
