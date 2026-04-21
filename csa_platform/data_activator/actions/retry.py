"""Tenacity-based retry helpers for Data Activator outbound calls.

Mirrors the retry pattern used by
:class:`csa_platform.streaming.breach_publisher.EventGridBreachPublisher` —
``tenacity`` is lazy-imported so the module remains importable when the
``functions`` or ``streaming`` extras are not installed, and callers can
opt out by passing ``retry_attempts=1``.

Design:
  * Async API (:func:`retry_async`) is used by the notifier hot path.
  * Sync API (:func:`retry_sync`) is used by the ``requests``-based paths
    (Teams, webhook, email, PagerDuty, ServiceNow) until they are
    migrated to ``httpx.AsyncClient``.
  * Only :class:`DataActivatorTransientError` is retried; everything
    else (including :class:`DataActivatorFatalError`) skips retry and
    propagates to the DLQ layer.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from .errors import DataActivatorTransientError

T = TypeVar("T")


def _load_tenacity() -> Any:
    import tenacity

    return tenacity


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


def retry_sync(
    func: Callable[[], T],
    *,
    max_attempts: int = 3,
    wait_multiplier: float = 0.1,
    wait_min: float = 0.1,
    wait_max: float = 1.0,
) -> T:
    """Call ``func`` with exponential-backoff retries on transient errors.

    Args:
        func: A zero-arg callable that performs the outbound call.
        max_attempts: Maximum attempts (including the first try).
        wait_multiplier: tenacity wait multiplier (seconds).
        wait_min: Minimum backoff (seconds).
        wait_max: Maximum backoff (seconds).

    Returns:
        Whatever ``func`` returns on the first successful attempt.

    Raises:
        DataActivatorTransientError: If all attempts are exhausted.
        DataActivatorFatalError: Immediately on fatal errors (no retry).
        Exception: Any other exception type propagates without retry.
    """
    tenacity = _load_tenacity()
    retryer = tenacity.Retrying(
        stop=tenacity.stop_after_attempt(max(1, max_attempts)),
        wait=tenacity.wait_exponential(
            multiplier=wait_multiplier,
            min=wait_min,
            max=wait_max,
        ),
        retry=tenacity.retry_if_exception_type(DataActivatorTransientError),
        reraise=True,
    )
    for attempt in retryer:
        with attempt:
            return func()
    # Unreachable — reraise=True means the last exception is raised
    raise RuntimeError("retry_sync: exhausted attempts without result")  # pragma: no cover


# ---------------------------------------------------------------------------
# Async
# ---------------------------------------------------------------------------


async def retry_async(
    func: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = 3,
    wait_multiplier: float = 0.1,
    wait_min: float = 0.1,
    wait_max: float = 1.0,
) -> T:
    """Async counterpart of :func:`retry_sync`."""
    tenacity = _load_tenacity()
    retryer = tenacity.AsyncRetrying(
        stop=tenacity.stop_after_attempt(max(1, max_attempts)),
        wait=tenacity.wait_exponential(
            multiplier=wait_multiplier,
            min=wait_min,
            max=wait_max,
        ),
        retry=tenacity.retry_if_exception_type(DataActivatorTransientError),
        reraise=True,
    )
    async for attempt in retryer:
        with attempt:
            return await func()
    raise RuntimeError("retry_async: exhausted attempts without result")  # pragma: no cover


__all__ = [
    "retry_async",
    "retry_sync",
]
