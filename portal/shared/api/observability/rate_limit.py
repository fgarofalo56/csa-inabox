"""Per-principal sliding-window rate limiter for portal routers (CSA-0030).

Built on ``slowapi`` which wraps ``limits`` — a battle-tested rate-limit
backend with support for in-memory, Redis, and Memcached storage.  For
the portal we use the in-memory backend by default (multi-replica
deployments should flip to Redis via ``PORTAL_RATE_LIMIT_STORAGE_URI``).

Principal extraction
--------------------

We key the limiter on the authenticated user's object-id when
available, falling back to the remote IP so unauthenticated endpoints
(``/api/health/*``) are still protected from egress abuse.  A SHA-256
truncation keeps the key opaque in ``slowapi``'s internal maps.

Limits
------

Limits are resolved per-route via environment variables with sane
defaults: 60/minute for writes, 300/minute for reads.  The router call
site passes a logical route name to :func:`get_route_limit` which
consults the env var ``PORTAL_RATE_LIMIT_<ROUTE>_PER_MINUTE`` before
falling back to the default.  This keeps the router code free of
string concatenation while still allowing ops to turn the dial on each
individual endpoint without a code change.

Feature flag
------------

When ``PORTAL_RATE_LIMIT_ENABLED`` is ``false`` (default) the limiter
is returned in a disabled state and every ``limiter.limit(...)``
decoration becomes a no-op.  This preserves backward compatibility on
existing deployments while giving operators a single switch to enable
enforcement.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — type-checking only
    from fastapi import FastAPI
    from starlette.requests import Request


logger = logging.getLogger(__name__)


# ── Config ──────────────────────────────────────────────────────────────────


# Default limits — writes are half the read budget since they touch the
# store backend and kick off audit emissions.
_DEFAULT_READ_LIMIT = "300/minute"
_DEFAULT_WRITE_LIMIT = "60/minute"


@dataclass(frozen=True)
class RateLimitConfig:
    """Resolved rate-limit configuration.

    Frozen so downstream callers can safely hash it.  The storage URI
    defaults to ``memory://`` which is appropriate for single-replica
    dev deployments; production deployments should point at Redis.
    """

    enabled: bool = False
    storage_uri: str = "memory://"
    default_read_limit: str = _DEFAULT_READ_LIMIT
    default_write_limit: str = _DEFAULT_WRITE_LIMIT


def build_rate_limit_config() -> RateLimitConfig:
    """Load the rate-limit config from environment variables."""
    enabled = os.getenv("PORTAL_RATE_LIMIT_ENABLED", "false").lower() in ("1", "true", "yes")
    storage_uri = os.getenv("PORTAL_RATE_LIMIT_STORAGE_URI", "memory://")
    read_limit = os.getenv("PORTAL_RATE_LIMIT_DEFAULT_READ", _DEFAULT_READ_LIMIT)
    write_limit = os.getenv("PORTAL_RATE_LIMIT_DEFAULT_WRITE", _DEFAULT_WRITE_LIMIT)
    return RateLimitConfig(
        enabled=enabled,
        storage_uri=storage_uri,
        default_read_limit=read_limit,
        default_write_limit=write_limit,
    )


def get_route_limit(route_name: str, *, write: bool = False) -> str:
    """Return the ``<N>/<period>`` slowapi string for a route.

    The env var key is ``PORTAL_RATE_LIMIT_<NAME>_PER_MINUTE`` where
    ``<NAME>`` is the upper-snake-case route name.  When set we format
    it as ``<N>/minute``.  When unset we fall back to the configured
    default (read or write).
    """
    env_key = f"PORTAL_RATE_LIMIT_{route_name.upper()}_PER_MINUTE"
    override = os.getenv(env_key)
    if override:
        return f"{override.strip()}/minute"
    cfg = build_rate_limit_config()
    return cfg.default_write_limit if write else cfg.default_read_limit


# ── Principal extraction ────────────────────────────────────────────────────


def _portal_principal_key(request: Request) -> str:
    """Return a stable, low-cardinality key for rate-limit accounting.

    Order of precedence:

    1. The resolved ``user`` on ``request.state`` (set by downstream
       auth dependencies on a best-effort basis) — hashed so raw oids
       never reach the limiter's internal maps.
    2. The ``x-forwarded-for`` header's first entry, when present.
    3. The ASGI client tuple.
    """
    user = getattr(request.state, "user", None)
    if isinstance(user, dict):
        principal = user.get("oid") or user.get("sub") or user.get("preferred_username")
        if principal:
            return "u:" + hashlib.sha256(str(principal).encode("utf-8")).hexdigest()[:16]

    xff = request.headers.get("x-forwarded-for")
    if xff:
        return "ip:" + xff.split(",")[0].strip()

    client = request.scope.get("client")
    if client:
        return f"ip:{client[0]}"
    return "ip:unknown"


# ── Builder ─────────────────────────────────────────────────────────────────


_LIMITER: Any = None


def build_rate_limiter(config: RateLimitConfig | None = None) -> Any:
    """Return a ``slowapi.Limiter`` instance (or a no-op stub).

    When slowapi is absent OR ``config.enabled`` is ``False``, we return
    a lightweight :class:`_NoopLimiter` that exposes the same
    ``limit()`` decorator API so router call sites don't branch on the
    feature flag.
    """
    global _LIMITER
    if _LIMITER is not None:
        return _LIMITER

    if config is None:
        config = build_rate_limit_config()

    if not config.enabled:
        _LIMITER = _NoopLimiter()
        return _LIMITER

    try:
        from slowapi import Limiter
    except ImportError as exc:  # pragma: no cover — exercised when extras missing
        logger.warning(
            "slowapi not installed; PORTAL_RATE_LIMIT_ENABLED=true but limiter disabled (%s).",
            exc,
        )
        _LIMITER = _NoopLimiter()
        return _LIMITER

    limiter = Limiter(
        key_func=_portal_principal_key,
        storage_uri=config.storage_uri,
        default_limits=[],  # enforce per-route only
        strategy="moving-window",  # sliding window per the ticket spec
    )
    _LIMITER = limiter
    return _LIMITER


def reset_rate_limiter_for_tests() -> None:
    """Clear the cached limiter — used by test fixtures only."""
    global _LIMITER
    _LIMITER = None


def install_rate_limiting(app: FastAPI) -> Any:
    """Wire the limiter onto the FastAPI app + its 429 handler.

    Returns the limiter so caller code can decorate routers with
    ``@limiter.limit(...)``.  A no-op limiter is returned when slowapi
    is absent or the feature flag is off, so the caller contract is
    uniform.
    """
    config = build_rate_limit_config()
    limiter = build_rate_limiter(config)

    if isinstance(limiter, _NoopLimiter):
        logger.debug("Rate limiting disabled (PORTAL_RATE_LIMIT_ENABLED=false)")
        return limiter

    try:
        from slowapi.errors import RateLimitExceeded
        from slowapi.middleware import SlowAPIMiddleware
        from starlette.requests import Request as _StarletteRequest
        from starlette.responses import JSONResponse
    except ImportError:  # pragma: no cover — already guarded in build_rate_limiter
        return limiter

    app.state.limiter = limiter
    # slowapi middleware inspects request.state to find per-route limits.
    if not getattr(app.state, "_portal_rate_limit_middleware_installed", False):
        app.add_middleware(SlowAPIMiddleware)
        app.state._portal_rate_limit_middleware_installed = True

    # Custom 429 handler that guarantees a ``Retry-After`` header.  The
    # stock ``_rate_limit_exceeded_handler`` only injects headers via the
    # limiter's ``_inject_headers`` — which requires ``view_rate_limit``
    # on ``request.state`` and only sometimes emits ``Retry-After``.  For
    # deterministic behaviour we always compute the retry window from
    # the violated limit's period and set the header explicitly.
    def _portal_rate_limit_handler(
        request: _StarletteRequest, exc: RateLimitExceeded,
    ) -> JSONResponse:
        # ``exc.limit`` is a ``RequestLimit`` with the ``limit``
        # attribute carrying the parsed ``limits.RateLimitItem`` when
        # available.  Fall back to a 60-second hint when the object
        # shape is not predictable.
        retry_after = 60
        with contextlib.suppress(AttributeError, TypeError, ValueError):
            retry_after = int(exc.limit.limit.get_expiry())  # type: ignore[attr-defined]
        response = JSONResponse(
            {
                "error": "rate_limit_exceeded",
                "detail": f"Rate limit exceeded: {exc.detail}",
            },
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )
        # Also inject the slowapi-standard ``X-RateLimit-*`` headers when
        # the middleware has populated ``view_rate_limit`` on the state.
        view_limit = getattr(request.state, "view_rate_limit", None)
        if view_limit is not None:
            with contextlib.suppress(Exception):  # pragma: no cover — best-effort
                response = app.state.limiter._inject_headers(response, view_limit)
        return response

    app.add_exception_handler(RateLimitExceeded, _portal_rate_limit_handler)  # type: ignore[arg-type]
    logger.info(
        "Rate limiting installed (storage=%s, defaults read=%s write=%s)",
        config.storage_uri,
        config.default_read_limit,
        config.default_write_limit,
    )
    return limiter


# ── No-op stub ──────────────────────────────────────────────────────────────


class _NoopLimiter:
    """Sentinel limiter returned when slowapi / the feature flag are off.

    Exposes just enough of the slowapi ``Limiter`` surface that router
    modules can decorate endpoints unconditionally.  Every decorator is
    a pass-through.
    """

    def limit(self, *_args: Any, **_kwargs: Any) -> Any:
        def decorator(func: Any) -> Any:
            return func

        return decorator

    def shared_limit(self, *_args: Any, **_kwargs: Any) -> Any:
        return self.limit()

    def exempt(self, func: Any) -> Any:
        return func
