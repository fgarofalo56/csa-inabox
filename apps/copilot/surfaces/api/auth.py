"""Authentication + rate-limiting helpers for the FastAPI surface.

The Copilot API reuses ``csa_platform.common.auth.get_current_user`` for
the JWT bearer flow — no re-implementation.  This module only adds the
Copilot-specific plumbing:

* :func:`get_principal` — thin wrapper that extracts the principal UPN /
  email from the validated claims dict, falling back to the ``sub`` id.
* :class:`SlidingWindowRateLimiter` — in-memory per-principal rate
  limiter used when no Redis backend is configured.
* :func:`rate_limit_dependency` — FastAPI dependency factory that
  enforces a 60-req/min (configurable) window per principal.

Staging/prod startup gates live in :mod:`apps.copilot.surfaces.api.app`
— the dependencies in this module are safe for tests (they never read
environment variables directly).
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any

from fastapi import Depends, HTTPException, Request, status

from apps.copilot.surfaces.config import SurfacesSettings
from csa_platform.common.auth import get_current_user


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
# Sliding-window rate limiter (in-memory)
# ─────────────────────────────────────────────────────────────────────────


class SlidingWindowRateLimiter:
    """Process-local sliding-window limiter keyed by principal.

    A single replica deployment uses this directly; multi-replica
    deployments should plug in a Redis-backed limiter by replacing the
    ``rate_limiter`` dependency at app-build time.  The limiter uses
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

    def reset(self) -> None:
        """Clear all recorded hits — used by tests."""
        self._hits.clear()


def build_rate_limiter(settings: SurfacesSettings) -> SlidingWindowRateLimiter:
    """Construct the default in-memory limiter from the provided settings."""
    return SlidingWindowRateLimiter(
        requests_per_minute=settings.api_rate_limit_per_minute,
    )


def rate_limit_dependency(limiter: SlidingWindowRateLimiter) -> Any:
    """Return a FastAPI dependency closing over *limiter*.

    Using a closure keeps the limiter swappable via FastAPI's
    ``app.dependency_overrides[...]`` hook — every test that needs a
    fresh limiter just replaces the dependency.
    """

    async def _enforce(
        request: Request,
        principal: str = Depends(get_principal),
    ) -> None:
        if limiter.check(principal):
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
    "SlidingWindowRateLimiter",
    "build_rate_limiter",
    "get_principal",
    "rate_limit_dependency",
]
