"""Tests for :mod:`csa_platform.ai_integration.rag.rate_limit` (CSA-0108)."""

from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import AsyncMock

import pytest

from csa_platform.ai_integration.rag.rate_limit import (
    AzureOpenAIRateLimiter,
    RateLimitExhausted,
    _RateLimitSignal,
    _TokenBucket,
    get_default_limiter,
    reset_default_limiter,
)


@pytest.fixture(autouse=True)
def _reset_limiter() -> Any:
    reset_default_limiter()
    yield
    reset_default_limiter()


class TestConfig:
    def test_defaults_from_constructor(self) -> None:
        lim = AzureOpenAIRateLimiter(rpm=10, tpm=1000, retry_attempts=3)
        assert lim.config.rpm == 10
        assert lim.config.tpm == 1000
        assert lim.config.retry_attempts == 3
        assert lim.config.max_concurrency >= 1

    def test_env_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("RAG_OPENAI_RPM", "7")
        monkeypatch.setenv("RAG_OPENAI_TPM", "700")
        lim = AzureOpenAIRateLimiter()
        assert lim.config.rpm == 7
        assert lim.config.tpm == 700

    def test_bad_env_values_fall_back_to_default(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("RAG_OPENAI_RPM", "not-a-number")
        lim = AzureOpenAIRateLimiter(tpm=1000)
        # default RPM = 240 (hard-coded default kicks in).
        assert lim.config.rpm == 240


class TestTokenBucket:
    def test_immediate_consume_within_capacity(self) -> None:
        async def _run() -> float:
            bucket = _TokenBucket(capacity_per_minute=600)  # 10/sec
            start = time.monotonic()
            await bucket.consume(1)
            return time.monotonic() - start

        elapsed = asyncio.run(_run())
        assert elapsed < 0.05

    def test_consume_more_than_capacity_gets_clamped(self) -> None:
        async def _run() -> None:
            bucket = _TokenBucket(capacity_per_minute=60)  # 1/sec, cap 60
            # Asking for 1_000_000 tokens must not hang forever — it gets
            # clamped to the per-minute capacity (60).  Start fully
            # stocked so the call returns immediately.
            await asyncio.wait_for(bucket.consume(1_000_000), timeout=2.0)

        asyncio.run(_run())


class TestThrottling:
    def test_n_calls_beyond_rpm_are_throttled(self) -> None:
        """3 concurrent calls at RPM=2 throttle at least one of them.

        With RPM=2, the TPM refill rate is 2/60 tokens/s (~0.033/s) so
        the third request must wait for the bucket to refill before it
        can acquire its token.  We only need to prove the spread between
        the fastest and slowest request is non-trivial; exact ordering
        depends on asyncio scheduling of the per-bucket lock.
        """
        lim = AzureOpenAIRateLimiter(rpm=2, tpm=10_000, max_concurrency=8, retry_attempts=1)

        async def _call() -> float:
            return 0.0

        async def _timed() -> float:
            start = time.monotonic()
            await lim.run(_call, model="gpt-4o")
            return time.monotonic() - start

        async def _run() -> list[float]:
            out = await asyncio.gather(
                asyncio.wait_for(_timed(), timeout=60.0),
                asyncio.wait_for(_timed(), timeout=60.0),
                asyncio.wait_for(_timed(), timeout=60.0),
            )
            return list(out)

        durations = asyncio.run(_run())
        durations_sorted = sorted(durations)
        fastest = durations_sorted[0]
        slowest = durations_sorted[-1]
        # The first request drains the pre-stocked bucket and finishes
        # near-instantly.  The slowest must have waited for a bucket
        # refill: slowest - fastest should be at least ~0.5s.
        assert fastest < 0.5, f"fastest={fastest!r}"
        assert slowest - fastest > 0.5, f"spread={slowest - fastest!r}"


class TestRetry:
    def test_retries_on_429_signal(self) -> None:
        lim = AzureOpenAIRateLimiter(
            rpm=100, tpm=100_000, retry_attempts=3, retry_min_seconds=0.01,
            retry_max_seconds=0.02,
        )

        call_count = {"n": 0}

        async def _call() -> str:
            call_count["n"] += 1
            if call_count["n"] < 3:
                raise _RateLimitSignal("429 first two times")
            return "ok"

        out = asyncio.run(lim.run(_call, model="gpt-4o"))
        assert out == "ok"
        assert call_count["n"] == 3

    def test_retries_exhausted_raises_typed(self) -> None:
        lim = AzureOpenAIRateLimiter(
            rpm=100, tpm=100_000, retry_attempts=2, retry_min_seconds=0.01,
            retry_max_seconds=0.02,
        )

        async def _call() -> str:
            raise _RateLimitSignal("always 429")

        with pytest.raises(RateLimitExhausted) as ex:
            asyncio.run(lim.run(_call, model="my-deployment"))
        assert "my-deployment" in str(ex.value)
        assert ex.value.attempts == 2

    def test_retry_after_header_honoured(self) -> None:
        """A 429 carrying ``Retry-After: 0.1`` should delay the next attempt."""
        lim = AzureOpenAIRateLimiter(
            rpm=100, tpm=100_000, retry_attempts=2, retry_min_seconds=0.0,
            retry_max_seconds=0.0,
        )

        calls: list[float] = []

        async def _call() -> str:
            calls.append(time.monotonic())
            if len(calls) == 1:
                raise _RateLimitSignal("slow down", retry_after=0.2)
            return "ok"

        start = time.monotonic()
        out = asyncio.run(lim.run(_call, model="gpt-4o"))
        total = time.monotonic() - start
        assert out == "ok"
        assert total >= 0.15  # honoured the 0.2s Retry-After


class TestUsageRecording:
    def test_record_usage_refills_bucket(self) -> None:
        lim = AzureOpenAIRateLimiter(rpm=100, tpm=1_000_000, retry_attempts=1)
        # Run inside an event loop so create_task succeeds.
        async def _run() -> None:
            lim.record_usage(prompt_tokens=0, completion_tokens=0)  # no-op
            lim.record_usage(prompt_tokens=100, completion_tokens=50)
            await asyncio.sleep(0)  # allow the task to schedule

        asyncio.run(_run())


class TestSingleton:
    def test_get_default_limiter_is_cached(self) -> None:
        a = get_default_limiter()
        b = get_default_limiter()
        assert a is b

    def test_reset_default_limiter(self) -> None:
        a = get_default_limiter()
        reset_default_limiter()
        b = get_default_limiter()
        assert a is not b


class TestCall:
    def test_successful_call_returns_value(self) -> None:
        lim = AzureOpenAIRateLimiter(rpm=100, tpm=1_000_000, retry_attempts=1)
        mock = AsyncMock(return_value="payload")
        out = asyncio.run(lim.run(mock, model="gpt-4o", estimated_tokens=50))
        assert out == "payload"
        mock.assert_awaited_once()
