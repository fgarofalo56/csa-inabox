"""OpenTelemetry bootstrap for the portal FastAPI backend (CSA-0042).

This module is deliberately defensive: every ``opentelemetry`` import
happens inside :func:`configure_tracing` so the portal boots cleanly on
slim deployments where the OTel extras are absent.  When the OTLP
endpoint is unset OR the SDK cannot be imported, all helpers in this
module fall back to a no-op code path — callers never need to branch on
"telemetry enabled?".

Configuration
-------------

OpenTelemetry is activated when
``OTEL_EXPORTER_OTLP_ENDPOINT`` is set in the environment.  The exporter
uses the HTTP/Protobuf transport by default (most OTel collectors accept
both gRPC and HTTP; HTTP avoids pulling the larger gRPC dependency into
the portal).  Service identity comes from the standard
``OTEL_SERVICE_NAME`` / ``OTEL_RESOURCE_ATTRIBUTES`` env vars — if they
are unset we inject sane defaults so spans land in a discoverable
service group.

Instrumentations wired up when enabled:

* FastAPI — auto-captures inbound HTTP requests.
* httpx — outbound calls to Entra ID, ADF, Purview, the BFF upstream.
* SQLAlchemy (async) — Postgres queries through the async store backend.
* redis — session-store and MSAL cache traffic when the redis backend
  is selected.

Span attributes
---------------

Hand-authored spans set a standard attribute set so dashboards and
SIEM queries can slice by portal-specific dimensions:

* ``portal.route`` — logical route name (e.g. ``sources.register``).
* ``portal.user_principal_hash`` — stable SHA-256 prefix of the user's
  object-id so audit correlation is possible without PII in traces.
* ``portal.domain_scope`` — the caller's resolved domain scope (Admin
  or the per-domain tag).
* ``portal.store_backend`` — which persistence backend served the
  request (``sqlite``, ``postgres``, ``mixed``).

The helper :func:`set_span_attributes` centralises these keys so
typo-drift is impossible at the call site.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — type-checking only
    from fastapi import FastAPI


logger = logging.getLogger(__name__)


# ── Config ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TracingConfig:
    """Resolved OpenTelemetry bootstrap configuration.

    Frozen so tests and ``configure_tracing`` cannot mutate the loaded
    config after it's been captured.  All fields default to values that
    keep OTel disabled, so :func:`build_tracing_config()` with no env
    vars set returns an ``enabled=False`` instance.
    """

    enabled: bool = False
    otlp_endpoint: str | None = None
    service_name: str = "csa-portal-api"
    environment: str = "local"
    headers: str | None = None
    insecure: bool = False


def build_tracing_config() -> TracingConfig:
    """Read OTel env vars and return an immutable :class:`TracingConfig`.

    ``OTEL_EXPORTER_OTLP_ENDPOINT`` is the canonical switch — when it is
    empty or unset, :attr:`TracingConfig.enabled` is ``False`` and all
    downstream helpers become no-ops.
    """
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip() or None
    return TracingConfig(
        enabled=bool(endpoint),
        otlp_endpoint=endpoint,
        service_name=os.getenv("OTEL_SERVICE_NAME", "csa-portal-api"),
        environment=os.getenv("OTEL_DEPLOYMENT_ENVIRONMENT", os.getenv("ENVIRONMENT", "local")),
        headers=os.getenv("OTEL_EXPORTER_OTLP_HEADERS") or None,
        insecure=os.getenv("OTEL_EXPORTER_OTLP_INSECURE", "false").lower() in ("1", "true", "yes"),
    )


# ── Bootstrap ───────────────────────────────────────────────────────────────


_TRACER_PROVIDER: Any = None
_INSTRUMENTED: set[str] = set()


def configure_tracing(app: FastAPI, config: TracingConfig | None = None) -> TracingConfig:
    """Wire up the OpenTelemetry SDK and instrument the FastAPI app.

    Safe to call multiple times — instrumentations are idempotent and
    keyed by a module-level set.  When ``config.enabled`` is ``False``
    the function short-circuits and returns the config unchanged.

    Any :class:`ImportError` from the optional OTel extras is caught and
    logged at WARNING; the portal continues to serve traffic without
    telemetry.
    """
    global _TRACER_PROVIDER

    if config is None:
        config = build_tracing_config()
    if not config.enabled:
        logger.debug("OpenTelemetry disabled (OTEL_EXPORTER_OTLP_ENDPOINT unset)")
        return config

    try:
        from opentelemetry import trace
        from opentelemetry.propagate import set_global_textmap
        from opentelemetry.propagators.composite import CompositePropagator
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
    except ImportError as exc:  # pragma: no cover — exercised only when extras missing
        logger.warning(
            "OpenTelemetry SDK not installed; tracing disabled (%s). "
            "Install the portal OTel extras to enable.",
            exc,
        )
        return TracingConfig()  # enabled=False sentinel

    # Build a Resource with service + environment identity so spans are
    # discoverable without relying on operator-set env vars.
    resource = Resource.create(
        {
            "service.name": config.service_name,
            "service.namespace": "csa-inabox",
            "deployment.environment": config.environment,
        },
    )

    provider = TracerProvider(resource=resource)

    # OTLP exporter — HTTP/Protobuf keeps the dependency footprint small
    # relative to gRPC.  We try HTTP first and fall back to gRPC only if
    # the operator explicitly picked grpc via env var.
    exporter = _build_span_exporter(config)
    if exporter is not None:
        provider.add_span_processor(BatchSpanProcessor(exporter))

    trace.set_tracer_provider(provider)
    # W3C Trace-Context is the default in modern OTel, but set it
    # explicitly so nothing silently overrides it later.
    set_global_textmap(CompositePropagator([TraceContextTextMapPropagator()]))

    _TRACER_PROVIDER = provider

    _instrument_fastapi(app)
    _instrument_httpx()
    _instrument_sqlalchemy()
    _instrument_redis()

    logger.info(
        "OpenTelemetry configured (endpoint=%s, service=%s)",
        config.otlp_endpoint,
        config.service_name,
    )
    return config


def _build_span_exporter(config: TracingConfig) -> Any:
    """Return an OTLP span exporter or ``None`` if imports fail."""
    protocol = os.getenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf").lower()
    try:
        if protocol.startswith("grpc"):
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (  # type: ignore[import-not-found]
                OTLPSpanExporter as GrpcExporter,
            )

            return GrpcExporter(
                endpoint=config.otlp_endpoint,
                insecure=config.insecure,
            )
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter as HttpExporter,
        )

        headers: dict[str, str] | None = None
        if config.headers:
            headers = {}
            for pair in config.headers.split(","):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    headers[k.strip()] = v.strip()
        return HttpExporter(endpoint=config.otlp_endpoint, headers=headers)
    except ImportError as exc:  # pragma: no cover — guarded
        logger.warning("OTLP exporter not available (%s); traces will not ship", exc)
        return None


# ── Instrumentations ────────────────────────────────────────────────────────
# Every helper is a no-op when the corresponding instrumentation package
# is missing.  We short-circuit via the ``_INSTRUMENTED`` set so repeated
# lifespan-start cycles (e.g. from tests reusing the app fixture) never
# double-register hooks.


def _instrument_fastapi(app: FastAPI) -> None:
    if "fastapi" in _INSTRUMENTED:
        return
    try:
        from opentelemetry.instrumentation.fastapi import (  # type: ignore[import-not-found]
            FastAPIInstrumentor,
        )
    except ImportError:
        logger.debug("opentelemetry-instrumentation-fastapi not installed")
        return
    try:
        FastAPIInstrumentor.instrument_app(app)
        _INSTRUMENTED.add("fastapi")
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("FastAPI instrumentation failed: %s", exc)


def _instrument_httpx() -> None:
    if "httpx" in _INSTRUMENTED:
        return
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    except ImportError:
        logger.debug("opentelemetry-instrumentation-httpx not installed")
        return
    try:
        HTTPXClientInstrumentor().instrument()
        _INSTRUMENTED.add("httpx")
    except Exception as exc:  # pragma: no cover
        logger.warning("httpx instrumentation failed: %s", exc)


def _instrument_sqlalchemy() -> None:
    if "sqlalchemy" in _INSTRUMENTED:
        return
    try:
        from opentelemetry.instrumentation.sqlalchemy import (  # type: ignore[import-not-found]
            SQLAlchemyInstrumentor,
        )
    except ImportError:
        logger.debug("opentelemetry-instrumentation-sqlalchemy not installed")
        return
    try:
        SQLAlchemyInstrumentor().instrument()
        _INSTRUMENTED.add("sqlalchemy")
    except Exception as exc:  # pragma: no cover
        logger.warning("SQLAlchemy instrumentation failed: %s", exc)


def _instrument_redis() -> None:
    if "redis" in _INSTRUMENTED:
        return
    try:
        from opentelemetry.instrumentation.redis import (  # type: ignore[import-not-found]
            RedisInstrumentor,
        )
    except ImportError:
        logger.debug("opentelemetry-instrumentation-redis not installed")
        return
    try:
        RedisInstrumentor().instrument()
        _INSTRUMENTED.add("redis")
    except Exception as exc:  # pragma: no cover
        logger.warning("redis instrumentation failed: %s", exc)


# ── Span helpers ────────────────────────────────────────────────────────────


def set_span_attributes(
    *,
    route: str | None = None,
    user_principal: str | None = None,
    domain_scope: str | None = None,
    store_backend: str | None = None,
    extra: dict[str, str] | None = None,
) -> None:
    """Attach the portal's standard attribute set to the current span.

    All parameters are optional — absent attributes are simply skipped.
    ``user_principal`` is hashed with SHA-256 before being written so the
    raw oid / upn never leaves the process.  When no span is active (or
    OTel is disabled) this function is a no-op.
    """
    try:
        from opentelemetry import trace
    except ImportError:
        return

    span = trace.get_current_span()
    if span is None or not span.is_recording():
        return

    if route is not None:
        span.set_attribute("portal.route", route)
    if user_principal is not None:
        digest = hashlib.sha256(user_principal.encode("utf-8")).hexdigest()[:16]
        span.set_attribute("portal.user_principal_hash", digest)
    if domain_scope is not None:
        span.set_attribute("portal.domain_scope", domain_scope)
    if store_backend is not None:
        span.set_attribute("portal.store_backend", store_backend)
    if extra:
        for k, v in extra.items():
            span.set_attribute(k, v)


def shutdown_tracing() -> None:
    """Flush pending spans and shut down the tracer provider.

    Call from FastAPI lifespan shutdown to avoid losing batched spans on
    a graceful pod drain.  Safe when OTel was never initialised.
    """
    global _TRACER_PROVIDER
    if _TRACER_PROVIDER is None:
        return
    try:
        _TRACER_PROVIDER.shutdown()
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("Tracer provider shutdown failed: %s", exc)
    _TRACER_PROVIDER = None
