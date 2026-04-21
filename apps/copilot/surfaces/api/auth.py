"""Authentication + rate-limiting helpers for the FastAPI surface.

The Copilot API reuses ``csa_platform.common.auth.get_current_user`` for
the JWT bearer flow — no re-implementation.  This module only adds the
Copilot-specific plumbing:

* :func:`get_principal` — thin wrapper that extracts the principal UPN /
  email from the validated claims dict, falling back to the ``sub`` id.
* :class:`SlidingWindowRateLimiter` — in-memory per-principal rate
  limiter (process-local, single-replica deployments).
* :class:`RedisRateLimiter` — ``redis.asyncio``-backed sliding-window
  limiter for multi-replica deployments.  Backed by an atomic Lua
  script so ``ZREMRANGEBYSCORE`` + ``ZCARD`` + ``ZADD`` are executed
  as a single Redis command.
* :func:`rate_limit_dependency` — FastAPI dependency factory that
  enforces a 60-req/min (configurable) window per principal.

Backend selection is driven by ``COPILOT_API_RATE_LIMIT_BACKEND``
(``memory`` by default, or ``redis`` for the Redis-backed variant).
The ``redis`` import is lazy: ``memory``-configured deployments never
import the optional ``redis`` extra.

Staging/prod startup gates live in :mod:`apps.copilot.surfaces.api.app`
— the dependencies in this module are safe for tests (they never read
environment variables directly; the factory reads env once and never
again).
"""

from __future__ import annotations

import os
import time
from collections import deque
from typing import Any, Protocol, runtime_checkable

from fastapi import Depends, HTTPException, Request, status

from apps.copilot.surfaces.config import SurfacesSettings
from csa_platform.common.auth import get_current_user
from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Typed errors
# ─────────────────────────────────────────────────────────────────────────


class RateLimiterConfigurationError(RuntimeError):
    """Raised when a rate-limiter backend cannot be constructed.

    Covers the two failure modes we care about at boot:

    * ``COPILOT_API_RATE_LIMIT_BACKEND=redis`` without
      ``COPILOT_API_RATE_LIMIT_REDIS_URL`` set.
    * ``redis`` optional extra not installed while the Redis backend
      is selected.
    """


class RateLimiterBackendError(RuntimeError):
    """Raised when a configured rate-limiter backend fails at runtime.

    The FastAPI dependency converts this into a 503 rather than
    allowing an unbounded exception to escape — we deliberately
    surface the failure so ops can page, but never mask it behind a
    silent ``allow``.
    """


def get_principal(
    user: dict[str, Any] = Depends(get_current_user),
) -> str:
    """Return the caller principal (UPN / email / ``sub``).

    Used for structured-logging correlation and rate limiting.  The
    dependency delegates JWT validation entirely to
    :func:`csa_platform.common.auth.get_current_user` and therefore
    inherits its safety gate (``AUTH_DISABLED`` outside local/demo is
    rejected at validation time).
    """
    for key in ("preferred_username", "email", "upn", "sub"):
        value = user.get(key)
        if isinstance(value, str) and value:
            return value
    return "anonymous"


# ─────────────────────────────────────────────────────────────────────────
# Rate limiter protocol + implementations
# ─────────────────────────────────────────────────────────────────────────


@runtime_checkable
class RateLimiter(Protocol):
    """Minimal async interface implemented by every rate-limiter backend.

    The in-memory :class:`SlidingWindowRateLimiter` is synchronous
    under the hood but exposes this async method so callers can treat
    both backends uniformly.
    """

    async def check_async(self, principal: str) -> bool:
        """Return True when *principal* is under the per-minute limit."""
        ...


class SlidingWindowRateLimiter:
    """Process-local sliding-window limiter keyed by principal.

    A single replica deployment uses this directly; multi-replica
    deployments should plug in :class:`RedisRateLimiter` via
    ``COPILOT_API_RATE_LIMIT_BACKEND=redis``.  The limiter uses
    ``time.monotonic`` so it is insensitive to wall-clock jumps.
    """

    def __init__(self, *, requests_per_minute: int) -> None:
        self.requests_per_minute = requests_per_minute
        self._hits: dict[str, deque[float]] = {}

    def check(self, principal: str) -> bool:
        """Return True when the caller is under the per-minute limit."""
        if self.requests_per_minute <= 0:
            return True
        now = time.monotonic()
        window_start = now - 60.0
        hits = self._hits.setdefault(principal, deque())
        while hits and hits[0] < window_start:
            hits.popleft()
        if len(hits) >= self.requests_per_minute:
            return False
        hits.append(now)
        return True

    async def check_async(self, principal: str) -> bool:
        """Async adapter — delegates to the synchronous :meth:`check`."""
        return self.check(principal)

    def reset(self) -> None:
        """Clear all recorded hits — used by tests."""
        self._hits.clear()


# Atomic Lua script for Redis-backed sliding-window counter.
#
# KEYS[1] = sorted-set key for this principal
# ARGV[1] = current timestamp (float seconds)
# ARGV[2] = window size in seconds (float)
# ARGV[3] = requests per window (int)
# ARGV[4] = monotonically-unique member for this hit (string)
#
# Returns 1 when the hit is admitted, 0 when the caller is over limit.
_REDIS_LUA_SCRIPT: str = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = tonumber(redis.call('ZCARD', key))
if count >= limit then
    return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(window) + 1)
return 1
""".strip()


_REDIS_KEY_PREFIX = "csa:copilot:ratelimit:"


def _redis_key(principal: str) -> str:
    """Return the Redis sorted-set key for *principal*."""
    return f"{_REDIS_KEY_PREFIX}{principal}"


class RedisRateLimiter:
    """``redis.asyncio``-backed sliding-window rate limiter.

    Uses a sorted set per principal keyed under
    ``csa:copilot:ratelimit:<principal>`` with timestamps as scores.
    A Lua script performs the window trim + count + admit as a single
    atomic operation so concurrent replicas cannot double-count.

    The ``redis`` client is injected so tests can pass a fake — the
    production factory (:func:`build_rate_limiter`) constructs the
    client lazily from the env URL.
    """

    def __init__(
        self,
        *,
        requests_per_minute: int,
        client: Any,
        window_seconds: float = 60.0,
        fail_open: bool = False,
    ) -> None:
        self.requests_per_minute = requests_per_minute
        self.client = client
        self.window_seconds = window_seconds
        # When the Redis backend is unreachable we prefer to fail
        # *closed* (raise) so ops sees the outage; ``fail_open=True``
        # is only for tests / demos where Redis blip tolerance matters.
        self.fail_open = fail_open
        self._counter = 0

    async def check_async(self, principal: str) -> bool:
        """Atomically admit-or-reject a hit for *principal*.

        Returns True when the hit is admitted (under limit), False
        when the limit has been reached.  Raises
        :class:`RateLimiterBackendError` when the Redis backend fails
        and ``fail_open`` is False.
        """
        if self.requests_per_minute <= 0:
            return True

        self._counter += 1
        now = time.time()
        # Monotonic-unique member avoids collisions when two requests
        # arrive in the same millisecond for the same principal.
        member = f"{now:.6f}:{self._counter}"

        try:
            result = await self.client.eval(
                _REDIS_LUA_SCRIPT,
                1,
                _redis_key(principal),
                str(now),
                str(self.window_seconds),
                str(self.requests_per_minute),
                member,
            )
        except Exception as exc:
            logger.warning(
                "copilot.api.rate_limiter_backend_error",
                backend="redis",
                error=str(exc),
                fail_open=self.fail_open,
            )
            if self.fail_open:
                return True
            raise RateLimiterBackendError(
                f"Redis rate limiter backend failed: {exc}",
            ) from exc

        return int(result) == 1

    async def reset_async(self, principal: str | None = None) -> None:
        """Clear all records for *principal* (or all principals when None)."""
        if principal is not None:
            await self.client.delete(_redis_key(principal))
            return
        # Test-only convenience: nuke the whole namespace.  Production
        # callers should never call this with principal=None.
        keys = await self.client.keys(f"{_REDIS_KEY_PREFIX}*")
        if keys:
            await self.client.delete(*keys)


# ─────────────────────────────────────────────────────────────────────────
# Backend factory
# ─────────────────────────────────────────────────────────────────────────


def _rate_limit_backend() -> str:
    """Return the configured rate-limiter backend, lowered + trimmed."""
    return os.environ.get("COPILOT_API_RATE_LIMIT_BACKEND", "memory").strip().lower()


def _rate_limit_redis_url() -> str:
    """Return the Redis URL used by the Redis limiter backend."""
    return os.environ.get("COPILOT_API_RATE_LIMIT_REDIS_URL", "").strip()


def _build_redis_client(redis_url: str) -> Any:
    """Construct an ``redis.asyncio`` client lazily.

    Raises :class:`RateLimiterConfigurationError` when the optional
    ``redis`` extra is not installed so the boot fails loudly — we
    must not silently fall back to in-memory storage on a multi-
    replica deployment.
    """
    try:
        # Local import keeps the optional dep optional.  The ignore
        # covers environments where the ``redis`` wheel is not
        # installed — mypy drops the unused-ignore warning via the
        # module-level settings.
        from redis.asyncio import from_url
    except ImportError as exc:  # pragma: no cover — exercised at boot
        msg = (
            "COPILOT_API_RATE_LIMIT_BACKEND=redis requires the optional "
            "'redis' extra.  Install with `pip install redis>=5` or "
            "switch the backend to 'memory' for single-replica deploys."
        )
        raise RateLimiterConfigurationError(msg) from exc
    return from_url(redis_url, decode_responses=True)


def build_rate_limiter(
    settings: SurfacesSettings,
    *,
    redis_client: Any = None,
) -> RateLimiter:
    """Construct the configured rate limiter.

    The backend is chosen by ``COPILOT_API_RATE_LIMIT_BACKEND``:

    * ``memory`` (default) → :class:`SlidingWindowRateLimiter`.
    * ``redis`` → :class:`RedisRateLimiter`.  Requires
      ``COPILOT_API_RATE_LIMIT_REDIS_URL`` when *redis_client* is not
      provided by the caller.

    Tests inject *redis_client* directly to avoid touching the env or
    the optional ``redis`` dependency.
    """
    backend = _rate_limit_backend()
    if backend == "memory":
        return SlidingWindowRateLimiter(
            requests_per_minute=settings.api_rate_limit_per_minute,
        )
    if backend == "redis":
        if redis_client is None:
            url = _rate_limit_redis_url()
            if not url:
                raise RateLimiterConfigurationError(
                    "COPILOT_API_RATE_LIMIT_BACKEND=redis requires "
                    "COPILOT_API_RATE_LIMIT_REDIS_URL to be set.",
                )
            redis_client = _build_redis_client(url)
        logger.info(
            "copilot.api.rate_limiter_backend",
            backend="redis",
            requests_per_minute=settings.api_rate_limit_per_minute,
        )
        return RedisRateLimiter(
            requests_per_minute=settings.api_rate_limit_per_minute,
            client=redis_client,
        )
    raise RateLimiterConfigurationError(
        f"Unknown COPILOT_API_RATE_LIMIT_BACKEND={backend!r}; "
        "must be 'memory' or 'redis'.",
    )


def rate_limit_dependency(limiter: RateLimiter) -> Any:
    """Return a FastAPI dependency closing over *limiter*.

    Using a closure keeps the limiter swappable via FastAPI's
    ``app.dependency_overrides[...]`` hook — every test that needs a
    fresh limiter just replaces the dependency.

    Works against both :class:`SlidingWindowRateLimiter` and
    :class:`RedisRateLimiter` via the shared
    :meth:`RateLimiter.check_async` surface.
    """

    async def _enforce(
        request: Request,
        principal: str = Depends(get_principal),
    ) -> None:
        try:
            admitted = await limiter.check_async(principal)
        except RateLimiterBackendError as exc:
            # Fail closed on backend outage — never serve traffic we
            # cannot meter.
            logger.error(
                "copilot.api.rate_limiter_unavailable",
                error=str(exc),
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Rate limiter backend unavailable; retry shortly.",
                headers={"Retry-After": "5"},
            ) from exc
        if admitted:
            return
        # Structured log — no caller-supplied values leak into logs.
        request.state.rate_limited = True
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded; retry in <60s.",
            headers={"Retry-After": "60"},
        )

    return _enforce


__all__ = [
    "RateLimiter",
    "RateLimiterBackendError",
    "RateLimiterConfigurationError",
    "RedisRateLimiter",
    "SlidingWindowRateLimiter",
    "build_rate_limiter",
    "get_principal",
    "rate_limit_dependency",
]
