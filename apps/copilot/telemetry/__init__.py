"""Copilot telemetry — OpenTelemetry tracing + span helpers + log enrichment.

This sub-package provides production-grade observability for the CSA
Copilot without forcing the OpenTelemetry SDK as a hard import-time
dependency.  When the OTel SDK is not installed, every helper
transparently no-ops so code paths that instrument spans still run in
constrained environments (CI, unit tests, minimal local installs).

Typical use::

    from apps.copilot.telemetry import copilot_span, SpanAttribute

    async with copilot_span(
        "copilot.retrieve",
        attributes={SpanAttribute.QUESTION_HASH: "abcd1234"},
    ) as span:
        ...

See :mod:`apps.copilot.telemetry.spans` for the public helpers and
:mod:`apps.copilot.telemetry.attributes` for the canonical attribute
names.
"""

from __future__ import annotations

from apps.copilot.telemetry.attributes import SpanAttribute
from apps.copilot.telemetry.spans import (
    copilot_span,
    enrich_log_with_trace,
    structlog_trace_processor,
)
from apps.copilot.telemetry.tracer import (
    get_tracer,
    is_otel_available,
    reset_tracer_cache,
)

__all__ = [
    "SpanAttribute",
    "copilot_span",
    "enrich_log_with_trace",
    "get_tracer",
    "is_otel_available",
    "reset_tracer_cache",
    "structlog_trace_processor",
]
