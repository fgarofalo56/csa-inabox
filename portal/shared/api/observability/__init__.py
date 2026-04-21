"""Portal observability package — OpenTelemetry + Prometheus + rate limiting.

This sub-package groups the cross-cutting runtime observability concerns
for the portal FastAPI backend:

* :mod:`tracer` — CSA-0042 OpenTelemetry bootstrap with OTLP exporter and
  FastAPI / httpx / SQLAlchemy / redis auto-instrumentation.  Every
  external library import is lazy so the portal remains startable when
  the ``opentelemetry-*`` extras are not installed.
* :mod:`metrics` — CSA-0061 Prometheus exposition (``/metrics``) backed
  by a private ``CollectorRegistry`` so in-process custom metrics never
  collide with the global registry used by third-party libraries.
* :mod:`rate_limit` — CSA-0030 per-principal sliding-window rate
  limiter built on ``slowapi`` with a feature flag and per-route
  environment-driven limits.

All three modules are wired into :mod:`portal.shared.api.main` at
application build time so the portal *always* exposes the public surface
but gracefully degrades to no-op behaviour when feature flags or extras
are absent.  See ADR-0020 for the full rationale.
"""

from __future__ import annotations

from .metrics import (
    MetricsRegistry,
    build_metrics_registry,
    get_metrics_registry,
    record_async_store_error,
    record_sqlite_store_op,
    record_token_cache_hit,
)
from .rate_limit import (
    RateLimitConfig,
    build_rate_limit_config,
    build_rate_limiter,
    get_route_limit,
)
from .tracer import (
    TracingConfig,
    build_tracing_config,
    configure_tracing,
    set_span_attributes,
    shutdown_tracing,
)

__all__ = [
    "MetricsRegistry",
    "RateLimitConfig",
    "TracingConfig",
    "build_metrics_registry",
    "build_rate_limit_config",
    "build_rate_limiter",
    "build_tracing_config",
    "configure_tracing",
    "get_metrics_registry",
    "get_route_limit",
    "record_async_store_error",
    "record_sqlite_store_op",
    "record_token_cache_hit",
    "set_span_attributes",
    "shutdown_tracing",
]
