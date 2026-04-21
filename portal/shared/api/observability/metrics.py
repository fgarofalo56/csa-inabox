"""Prometheus metrics registry + middleware for the portal (CSA-0061).

Design
------

* **Private registry** — a :class:`prometheus_client.CollectorRegistry`
  keeps portal metrics isolated from the module-level default registry
  used by libraries we don't control.  Tests and multi-app deployments
  can instantiate fresh registries without leaking state.
* **Feature flag** — ``PORTAL_METRICS_ENABLED=true`` toggles the HTTP
  surface.  The registry is always built (constant-cost) but the
  ``/metrics`` endpoint and the request-observing middleware only
  register with the FastAPI app when the flag is on.  Back-compat
  default is off.
* **Auth modes** — ``/metrics`` can be public (typical Prometheus
  scrape) or bearer-gated via ``PORTAL_METRICS_AUTH_TOKEN``.  The token
  is compared with :func:`hmac.compare_digest` to avoid timing leaks.
* **Lazy imports** — ``prometheus_client`` is imported inside
  :func:`build_metrics_registry` so a deployment without the optional
  extra still starts cleanly.

Metric surface
--------------

HTTP metrics (auto-recorded by the middleware):

* ``portal_http_requests_total{route, method, status_code}``
* ``portal_http_request_duration_seconds_bucket{route, method}``
* ``portal_http_errors_total{route, method, status_code}``

In-process custom metrics (helper functions mutate these):

* ``portal_bff_token_cache_hits_total{result}`` — miss / hit counter
  for the MSAL token cache so SRE can track how often the refresh-token
  fast-path saves a round-trip to Entra ID.
* ``portal_sqlite_store_ops_total{op}`` — add / get / update / delete
  counters for the async SQLite store.
* ``portal_async_store_errors_total{backend, op}`` — error counter
  partitioned by backend (``sqlite`` / ``postgres``) and operation.
"""

from __future__ import annotations

import hmac
import logging
import os
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — type-checking only
    from fastapi import FastAPI
    from starlette.requests import Request
    from starlette.responses import Response


logger = logging.getLogger(__name__)


# ── Registry container ──────────────────────────────────────────────────────


@dataclass
class MetricsRegistry:
    """Container for the portal's private Prometheus registry + metrics.

    Fields are populated lazily inside :func:`build_metrics_registry` to
    avoid eagerly importing ``prometheus_client`` at module-load time.
    The dataclass is *not* frozen because its internal metric objects
    mutate — but the container itself is created once per process and
    should not be reassigned.
    """

    enabled: bool = False
    registry: Any = None
    http_requests_total: Any = None
    http_request_duration_seconds: Any = None
    http_errors_total: Any = None
    token_cache_hits_total: Any = None
    sqlite_store_ops_total: Any = None
    async_store_errors_total: Any = None
    auth_token: str | None = None
    auth_constant_time_digest: bytes | None = field(default=None, repr=False)


_REGISTRY: MetricsRegistry | None = None


# ── Builder ─────────────────────────────────────────────────────────────────


def build_metrics_registry() -> MetricsRegistry:
    """Construct (or return the cached) :class:`MetricsRegistry`.

    When ``PORTAL_METRICS_ENABLED`` is not truthy, returns a disabled
    registry with all fields ``None`` so callers can cheaply gate
    metric emissions behind ``if registry.enabled:``.
    """
    global _REGISTRY
    if _REGISTRY is not None:
        return _REGISTRY

    enabled = os.getenv("PORTAL_METRICS_ENABLED", "false").lower() in ("1", "true", "yes")
    auth_token = os.getenv("PORTAL_METRICS_AUTH_TOKEN") or None

    if not enabled:
        _REGISTRY = MetricsRegistry(enabled=False, auth_token=auth_token)
        return _REGISTRY

    try:
        from prometheus_client import CollectorRegistry, Counter, Histogram
    except ImportError as exc:  # pragma: no cover — exercised when extras missing
        logger.warning(
            "prometheus_client not installed; PORTAL_METRICS_ENABLED=true "
            "but metrics disabled (%s).  Install the portal metrics extra.",
            exc,
        )
        _REGISTRY = MetricsRegistry(enabled=False, auth_token=auth_token)
        return _REGISTRY

    registry = CollectorRegistry()

    http_requests_total = Counter(
        "portal_http_requests_total",
        "Total HTTP requests served by the portal backend.",
        labelnames=("route", "method", "status_code"),
        registry=registry,
    )
    http_request_duration_seconds = Histogram(
        "portal_http_request_duration_seconds",
        "HTTP request latency in seconds, labelled by route and method.",
        labelnames=("route", "method"),
        # Buckets tuned for internal API latencies (sub-second dominated).
        buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
        registry=registry,
    )
    http_errors_total = Counter(
        "portal_http_errors_total",
        "HTTP responses with 4xx/5xx status codes, labelled by route.",
        labelnames=("route", "method", "status_code"),
        registry=registry,
    )
    token_cache_hits_total = Counter(
        "portal_bff_token_cache_hits_total",
        "BFF MSAL token-cache outcomes (hit / miss / tamper).",
        labelnames=("result",),
        registry=registry,
    )
    sqlite_store_ops_total = Counter(
        "portal_sqlite_store_ops_total",
        "Async SQLite store operations, partitioned by op kind.",
        labelnames=("op",),
        registry=registry,
    )
    async_store_errors_total = Counter(
        "portal_async_store_errors_total",
        "Async store backend errors, partitioned by backend and op.",
        labelnames=("backend", "op"),
        registry=registry,
    )

    digest: bytes | None = None
    if auth_token:
        digest = auth_token.encode("utf-8")

    _REGISTRY = MetricsRegistry(
        enabled=True,
        registry=registry,
        http_requests_total=http_requests_total,
        http_request_duration_seconds=http_request_duration_seconds,
        http_errors_total=http_errors_total,
        token_cache_hits_total=token_cache_hits_total,
        sqlite_store_ops_total=sqlite_store_ops_total,
        async_store_errors_total=async_store_errors_total,
        auth_token=auth_token,
        auth_constant_time_digest=digest,
    )
    return _REGISTRY


def get_metrics_registry() -> MetricsRegistry:
    """Return the cached registry, building it on first call."""
    return build_metrics_registry()


def reset_metrics_registry_for_tests() -> None:
    """Clear the cached registry — used by test fixtures only."""
    global _REGISTRY
    _REGISTRY = None


# ── In-process metric helpers ──────────────────────────────────────────────


def record_token_cache_hit(result: str) -> None:
    """Increment the BFF token-cache outcome counter.

    ``result`` is one of ``hit`` / ``miss`` / ``tamper`` — any other
    value is accepted but should be documented in ADR-0020.
    """
    registry = get_metrics_registry()
    if not registry.enabled or registry.token_cache_hits_total is None:
        return
    registry.token_cache_hits_total.labels(result=result).inc()


def record_sqlite_store_op(op: str) -> None:
    """Increment the async SQLite store operation counter."""
    registry = get_metrics_registry()
    if not registry.enabled or registry.sqlite_store_ops_total is None:
        return
    registry.sqlite_store_ops_total.labels(op=op).inc()


def record_async_store_error(backend: str, op: str) -> None:
    """Increment the async store error counter."""
    registry = get_metrics_registry()
    if not registry.enabled or registry.async_store_errors_total is None:
        return
    registry.async_store_errors_total.labels(backend=backend, op=op).inc()


# ── Middleware ──────────────────────────────────────────────────────────────


def _route_name(request: Request) -> str:
    """Return the logical route path for labelling.

    Uses the FastAPI route's ``path`` attribute (the template, e.g.
    ``/api/v1/sources/{source_id}``) rather than the concrete request
    URL so label cardinality stays bounded.  Falls back to the raw path
    for unmatched routes (404s).
    """
    route = request.scope.get("route")
    if route is not None and hasattr(route, "path"):
        return str(route.path)
    return request.url.path


async def _metrics_middleware_dispatch(request: Request, call_next: Any) -> Response:
    """ASGI middleware — record latency, request count, and errors.

    Timing is measured with :func:`time.perf_counter` for monotonicity.
    Any exception raised by the downstream app is re-raised after
    being counted so the existing exception handlers still produce
    structured responses.
    """
    registry = get_metrics_registry()
    if not registry.enabled:
        result: Response = await call_next(request)
        return result

    start = time.perf_counter()
    status_code = 500
    try:
        response: Response = await call_next(request)
        status_code = response.status_code
        return response
    except Exception:
        # The downstream exception handler will produce a 500; we still
        # want the metric to capture the failure.
        registry.http_errors_total.labels(
            route=_route_name(request),
            method=request.method,
            status_code="500",
        ).inc()
        raise
    finally:
        elapsed = time.perf_counter() - start
        route = _route_name(request)
        registry.http_requests_total.labels(
            route=route,
            method=request.method,
            status_code=str(status_code),
        ).inc()
        registry.http_request_duration_seconds.labels(
            route=route,
            method=request.method,
        ).observe(elapsed)
        if status_code >= 400:
            registry.http_errors_total.labels(
                route=route,
                method=request.method,
                status_code=str(status_code),
            ).inc()


def install_metrics(app: FastAPI) -> MetricsRegistry:
    """Mount the Prometheus middleware + ``/metrics`` route when enabled.

    Idempotent — repeated calls are safe because FastAPI refuses to
    double-register a route with the same path + method and the
    middleware registry is keyed on module state.
    """
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import PlainTextResponse
    from starlette.responses import Response as _Response

    registry = get_metrics_registry()
    if not registry.enabled:
        logger.debug("Portal metrics disabled (PORTAL_METRICS_ENABLED=false)")
        return registry

    # Avoid double-registering the middleware class on hot reloads.
    if not getattr(app.state, "_portal_metrics_middleware_installed", False):
        app.add_middleware(BaseHTTPMiddleware, dispatch=_metrics_middleware_dispatch)
        app.state._portal_metrics_middleware_installed = True

    # Avoid double-registering the route.
    if any(getattr(r, "path", None) == "/metrics" for r in app.routes):
        logger.debug("/metrics endpoint already registered; skipping")
        return registry

    from fastapi import Request as _FastAPIRequest

    # Function defined with annotations supplied via the ``__annotations__``
    # dictionary directly so FastAPI's dependency resolver sees the class
    # object (not the stringified form introduced by ``from __future__ import
    # annotations``).  Using the class reference keeps the endpoint free of
    # the 422 "missing query parameter" misclassification.
    async def metrics_endpoint(request):  # type: ignore[no-untyped-def]
        """Prometheus exposition endpoint.

        Returns 401 when ``PORTAL_METRICS_AUTH_TOKEN`` is set and the
        caller does not present a matching ``Authorization: Bearer``
        token.  When the token is unset the endpoint is public — the
        typical deployment pattern for Prometheus scrape jobs running
        inside the cluster.
        """
        from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

        current = get_metrics_registry()
        if current.auth_token:
            header = request.headers.get("authorization", "")
            presented = ""
            if header.lower().startswith("bearer "):
                presented = header[7:].strip()
            if not presented or not hmac.compare_digest(
                presented.encode("utf-8"),
                current.auth_token.encode("utf-8"),
            ):
                return PlainTextResponse(
                    "unauthorized",
                    status_code=401,
                    headers={"WWW-Authenticate": 'Bearer realm="metrics"'},
                )

        body = generate_latest(current.registry)
        return _Response(content=body, media_type=CONTENT_TYPE_LATEST)

    # Set the annotation post-hoc so FastAPI's dependency solver sees the
    # actual Request class (not the string produced by
    # ``from __future__ import annotations``) and correctly injects the
    # request object instead of treating ``request`` as a query param.
    metrics_endpoint.__annotations__["request"] = _FastAPIRequest
    app.add_api_route(
        "/metrics",
        metrics_endpoint,
        methods=["GET"],
        include_in_schema=False,
    )

    logger.info("Prometheus /metrics endpoint mounted")
    return registry
