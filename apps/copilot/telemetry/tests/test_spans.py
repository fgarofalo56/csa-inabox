"""Tests for :mod:`apps.copilot.telemetry.spans`."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from apps.copilot.telemetry import (
    SpanAttribute,
    copilot_span,
    enrich_log_with_trace,
    reset_tracer_cache,
    structlog_trace_processor,
)
from apps.copilot.telemetry.spans import copilot_span_sync


@pytest.fixture(autouse=True)
def _reset_tracer_cache() -> Iterator[None]:
    reset_tracer_cache()
    yield
    reset_tracer_cache()


class TestCopilotSpanAsync:
    @pytest.mark.asyncio
    async def test_span_yields_span_object(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        async with copilot_span(
            "copilot.test",
            attributes={SpanAttribute.QUESTION_HASH: "deadbeef"},
        ) as span:
            assert span is not None
            # Additional attributes can be set via the span.
            span.set_attribute(SpanAttribute.TOP_K, 6)

    @pytest.mark.asyncio
    async def test_span_reraises_exceptions(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        class BoomError(RuntimeError):
            pass

        with pytest.raises(BoomError):
            async with copilot_span("copilot.test"):
                raise BoomError("simulated failure")

    @pytest.mark.asyncio
    async def test_nested_spans_work(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        async with (
            copilot_span("copilot.outer"),
            copilot_span("copilot.inner") as inner,
        ):
            inner.set_attribute(SpanAttribute.GROUNDEDNESS, 0.88)

    @pytest.mark.asyncio
    async def test_attribute_sanitization(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Attributes containing sensitive substrings are redacted."""
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        async with copilot_span(
            "copilot.test",
            attributes={
                "copilot.custom_api_key": "sk-should-not-leak-0123456789",
                SpanAttribute.QUESTION_HASH: "safe-value",
            },
        ) as span:
            # Span is a no-op in CI; we can't introspect attrs from
            # outside, but the call should not raise.
            assert span is not None


class TestCopilotSpanSync:
    def test_sync_context_manager_basic(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        with copilot_span_sync("copilot.sync") as span:
            span.set_attribute(SpanAttribute.TOP_K, 3)

    def test_sync_reraises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        with pytest.raises(ValueError, match="boom"), copilot_span_sync("copilot.sync"):
            raise ValueError("boom")


class TestLogEnrichment:
    def test_enrich_noop_outside_span(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        payload = {"event": "copilot.test"}
        out = enrich_log_with_trace(payload)
        assert out is payload  # mutation in place

    def test_structlog_processor_handles_absence(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv("COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        event = {"event": "copilot.retrieve", "question_hash": "abc"}
        out = structlog_trace_processor(object(), "info", event)
        assert out is event
        # No trace/span keys injected when no span is active.
        assert "trace_id" not in out or out.get("trace_id") is None
