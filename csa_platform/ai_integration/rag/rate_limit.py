"""Rate limiting + retry for Azure OpenAI calls (CSA-0108).

:class:`AzureOpenAIRateLimiter` pairs an :class:`asyncio.Semaphore`
with a simple token bucket to enforce both a requests-per-minute (RPM)
and tokens-per-minute (TPM) budget, then delegates 429 recovery to a
``tenacity`` retry loop that honours the ``Retry-After`` header.

The limiter is intentionally stateless on the wire: it does *not* own
the ``AsyncAzureOpenAI`` client.  Instead it exposes :meth:`run` which
takes a zero-arg async callable and returns whatever the callable
returns — so ``generate.py`` and ``indexer.py`` can wrap
``chat.completions.create`` + ``embeddings.create`` without a new
dependency injection graph.

Typed errors:

* :class:`RateLimitExhausted` — raised when tenacity gives up after
  ``retry_attempts`` 429s.  Callers should convert this into a 503 /
  retry-later response at the edge.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

from tenacity import (
    AsyncRetrying,
    RetryError,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from csa_platform.common.logging import get_logger

logger = get_logger(__name__)

T = TypeVar("T")


# ---------------------------------------------------------------------------
# Typed errors
# ---------------------------------------------------------------------------


class RateLimitExhausted(RuntimeError):  # noqa: N818 — public API name per CSA-0108 spec
    """Raised when 429 retries are exhausted for an Azure OpenAI call."""

    def __init__(self, model: str, attempts: int, last_exception: BaseException) -> None:
        super().__init__(
            f"Azure OpenAI rate-limit exhausted for model '{model}' after "
            f"{attempts} attempts: {last_exception}"
        )
        self.model = model
        self.attempts = attempts
        self.last_exception = last_exception


# ---------------------------------------------------------------------------
# Token bucket
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RateLimiterConfig:
    """Immutable config snapshot for :class:`AzureOpenAIRateLimiter`."""

    rpm: int
    tpm: int
    max_concurrency: int
    retry_attempts: int
    retry_min_seconds: float
    retry_max_seconds: float


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("rag_rate_limit.env_parse_failed", env=name, value=raw)
        return default
    return max(1, value)


class _TokenBucket:
    """Simple TPM token bucket (thread/coroutine safe via asyncio.Lock)."""

    def __init__(self, *, capacity_per_minute: int) -> None:
        self.capacity = max(1, capacity_per_minute)
        self._tokens = float(self.capacity)
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    async def consume(self, amount: int) -> None:
        """Block until *amount* tokens can be consumed from the bucket."""
        if amount <= 0:
            return
        # Cap a single call at the full per-minute capacity so a 1M-token
        # embedding call cannot permanently stall the bucket.
        want = min(amount, self.capacity)
        while True:
            async with self._lock:
                now = time.monotonic()
                elapsed = now - self._last_refill
                refill = elapsed * (self.capacity / 60.0)
                if refill > 0:
                    self._tokens = min(self.capacity, self._tokens + refill)
                    self._last_refill = now
                if self._tokens >= want:
                    self._tokens -= want
                    return
                deficit = want - self._tokens
                # Seconds to wait for (deficit) tokens at capacity/60 per sec.
                wait_for = deficit / (self.capacity / 60.0)
            await asyncio.sleep(max(0.05, wait_for))


# ---------------------------------------------------------------------------
# Limiter facade
# ---------------------------------------------------------------------------


class AzureOpenAIRateLimiter:
    """Shared RPM / TPM guard + 429-aware retry wrapper.

    Args:
        rpm: Requests per minute budget.  Defaults to the
            ``RAG_OPENAI_RPM`` env or 240.
        tpm: Tokens per minute budget.  Defaults to the
            ``RAG_OPENAI_TPM`` env or 480000.
        max_concurrency: Cap on simultaneously in-flight requests; tracks
            ``rpm`` when omitted.
        retry_attempts: Total attempts including the first call.  Default 5.
        retry_min_seconds: Minimum backoff between retries (exponential
            base).  Default 1.0 s.
        retry_max_seconds: Upper cap on a single backoff sleep.  Default 30.0 s.
    """

    def __init__(
        self,
        *,
        rpm: int | None = None,
        tpm: int | None = None,
        max_concurrency: int | None = None,
        retry_attempts: int | None = None,
        retry_min_seconds: float = 1.0,
        retry_max_seconds: float = 30.0,
    ) -> None:
        resolved_rpm = rpm if rpm is not None else _env_int("RAG_OPENAI_RPM", 240)
        resolved_tpm = tpm if tpm is not None else _env_int("RAG_OPENAI_TPM", 480_000)
        resolved_concurrency = max_concurrency if max_concurrency is not None else min(
            32, max(1, resolved_rpm)
        )
        resolved_attempts = (
            retry_attempts if retry_attempts is not None else _env_int("RAG_OPENAI_RETRIES", 5)
        )
        self.config = RateLimiterConfig(
            rpm=resolved_rpm,
            tpm=resolved_tpm,
            max_concurrency=resolved_concurrency,
            retry_attempts=max(1, resolved_attempts),
            retry_min_seconds=retry_min_seconds,
            retry_max_seconds=retry_max_seconds,
        )
        self._rpm_bucket = _TokenBucket(capacity_per_minute=resolved_rpm)
        self._tpm_bucket = _TokenBucket(capacity_per_minute=resolved_tpm)
        self._semaphore = asyncio.Semaphore(resolved_concurrency)

    # -- main entry point ---------------------------------------------------

    async def run(
        self,
        call: Callable[[], Awaitable[T]],
        *,
        model: str,
        estimated_tokens: int = 0,
    ) -> T:
        """Invoke *call* under the RPM + TPM + semaphore + retry envelope.

        ``estimated_tokens`` is consumed from the TPM bucket *before*
        the request leaves.  This is deliberately approximate — the
        final ``response.usage`` count is what gets billed, and the
        caller should feed that back to :meth:`record_usage` so the
        bucket reflects reality for the next request.
        """
        await self._rpm_bucket.consume(1)
        if estimated_tokens > 0:
            await self._tpm_bucket.consume(estimated_tokens)

        async with self._semaphore:
            return await self._run_with_retry(call, model=model)

    def record_usage(self, *, prompt_tokens: int, completion_tokens: int) -> None:
        """Reconcile actual token usage with the TPM bucket (fire-and-forget)."""
        actual = max(0, int(prompt_tokens)) + max(0, int(completion_tokens))
        if actual <= 0:
            return
        # Drain any additional tokens synchronously — consume locks are
        # re-entered under asyncio but ``record_usage`` is called from
        # the same event loop, so spawn a best-effort background task.
        loop = _current_loop()
        if loop is None:  # pragma: no cover — defensive path
            return
        loop.create_task(self._tpm_bucket.consume(actual))

    # -- internals ----------------------------------------------------------

    async def _run_with_retry(
        self,
        call: Callable[[], Awaitable[T]],
        *,
        model: str,
    ) -> T:
        """Invoke *call* with tenacity 429-aware retry + ``Retry-After``."""
        retry_exceptions = _retryable_exception_types()
        retryer = AsyncRetrying(
            stop=stop_after_attempt(self.config.retry_attempts),
            wait=wait_exponential(
                multiplier=self.config.retry_min_seconds,
                min=self.config.retry_min_seconds,
                max=self.config.retry_max_seconds,
            ),
            retry=retry_if_exception_type(retry_exceptions),
            reraise=True,
        )
        try:
            async for attempt in retryer:
                with attempt:
                    try:
                        return await call()
                    except retry_exceptions as exc:
                        # Honour server-provided Retry-After before tenacity's
                        # exponential backoff kicks in.  If the server asked
                        # for a longer wait than our exponential plan, we
                        # sleep for the delta up-front.
                        delay = _extract_retry_after(exc)
                        if delay is not None:
                            logger.warning(
                                "rag_rate_limit.honour_retry_after",
                                model=model,
                                retry_after_s=delay,
                                attempt=attempt.retry_state.attempt_number,
                            )
                            await asyncio.sleep(delay)
                        raise
        except RetryError as exc:  # pragma: no cover — reraise=True bypasses
            last = exc.last_attempt.exception() or exc
            raise RateLimitExhausted(model, self.config.retry_attempts, last) from exc
        except retry_exceptions as exc:
            raise RateLimitExhausted(model, self.config.retry_attempts, exc) from exc
        # AsyncRetrying always re-raises or returns; this is unreachable.
        raise RuntimeError("unreachable: AsyncRetrying neither returned nor raised")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _current_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover
        return None


def _retryable_exception_types() -> tuple[type[BaseException], ...]:
    """Return the exception types that should trigger a retry.

    Pulls in ``openai.RateLimitError`` / ``openai.APIStatusError`` /
    ``openai.APITimeoutError`` when the ``openai`` SDK is installed;
    always includes :class:`_RateLimitSignal` so tests can simulate a
    429 without importing ``openai``.
    """
    classes: list[type[BaseException]] = [_RateLimitSignal]
    try:  # pragma: no cover — depends on install layout
        from openai import APIStatusError, APITimeoutError, RateLimitError

        classes.extend([RateLimitError, APIStatusError, APITimeoutError])
    except ImportError:  # pragma: no cover
        pass
    return tuple(classes)


def _extract_retry_after(exc: BaseException) -> float | None:
    """Return the ``Retry-After`` value (seconds) embedded on *exc*."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        headers = getattr(exc, "headers", None)
    if not headers:
        return None
    try:
        raw = headers.get("Retry-After") if hasattr(headers, "get") else None
    except Exception:  # pragma: no cover — defensive
        return None
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return None


class _RateLimitSignal(Exception):  # noqa: N818 — private test-only signal
    """Test-only signal equivalent to ``openai.RateLimitError``.

    Tests raise this to simulate a 429 without needing a mocked openai
    SDK surface; production code paths rely on the actual openai
    exception classes pulled in by :func:`_retryable_exception_types`.
    """

    def __init__(self, message: str = "simulated 429", retry_after: float | None = None) -> None:
        super().__init__(message)
        self.headers: dict[str, str] = {}
        if retry_after is not None:
            self.headers["Retry-After"] = str(retry_after)


# ---------------------------------------------------------------------------
# Module-level singleton for the indexer / generator to reuse.
# ---------------------------------------------------------------------------


_DEFAULT_LIMITER: AzureOpenAIRateLimiter | None = None


def get_default_limiter() -> AzureOpenAIRateLimiter:
    """Return the shared rate limiter (env-driven config on first call)."""
    global _DEFAULT_LIMITER
    if _DEFAULT_LIMITER is None:
        _DEFAULT_LIMITER = AzureOpenAIRateLimiter()
    return _DEFAULT_LIMITER


def reset_default_limiter() -> None:
    """Drop the cached default limiter (test hook)."""
    global _DEFAULT_LIMITER
    _DEFAULT_LIMITER = None


__all__ = [
    "AzureOpenAIRateLimiter",
    "RateLimitExhausted",
    "RateLimiterConfig",
    "get_default_limiter",
    "reset_default_limiter",
]
