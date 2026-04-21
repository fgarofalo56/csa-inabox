"""Span + structlog helpers for the Copilot.

The public surface:

* :func:`copilot_span` — async + sync context manager wrapping
  :meth:`Tracer.start_as_current_span` with attribute sanitisation,
  exception recording, and automatic status propagation.
* :func:`structlog_trace_processor` — a structlog processor that
  enriches every event with ``trace_id``/``span_id`` when a span is
  active.
* :func:`enrich_log_with_trace` — a one-shot helper for callers that
  manage their own logger (useful outside structlog).

All helpers route through :mod:`apps.copilot.telemetry.tracer` so the
no-op path continues to work without ``opentelemetry.api`` installed.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Iterator, Mapping
from typing import Any

from apps.copilot.telemetry.attributes import sanitize_attribute_value
from apps.copilot.telemetry.tracer import (
    current_trace_ids,
    get_tracer,
    is_otel_available,
)

# Default tracer name used when callers don't pass one explicitly.
_DEFAULT_TRACER_NAME = "apps.copilot"


def _apply_attributes(span: Any, attributes: Mapping[str, Any] | None) -> None:
    """Set sanitised attributes on *span*.

    The no-op span implements ``set_attribute`` so this function is
    safe to call regardless of whether OTel is active.
    """
    if not attributes:
        return
    for key, value in attributes.items():
        span.set_attribute(str(key), sanitize_attribute_value(str(key), value))


@contextlib.asynccontextmanager
async def copilot_span(
    name: str,
    *,
    attributes: Mapping[str, Any] | None = None,
    tracer_name: str = _DEFAULT_TRACER_NAME,
    record_exception: bool = True,
) -> AsyncIterator[Any]:
    """Async context manager wrapping a Copilot OTel span.

    ``name`` SHOULD follow the ``copilot.<stage>`` convention (see the
    Phase 6 spec for the canonical list).  Attributes are sanitised
    via :func:`sanitize_attribute_value` so secrets in string values
    are redacted before export.

    When *record_exception* is True (default), any exception raised
    inside the block is recorded on the span before being re-raised so
    the OTLP receiver sees a complete trace of failures.  The
    exception itself is always re-raised — the helper never swallows
    errors.
    """
    tracer = get_tracer(tracer_name)
    context = tracer.start_as_current_span(name)
    span: Any
    # Use a try/finally around enter/exit so we can inject attributes
    # + exception recording uniformly for both the real OTel and the
    # no-op paths.
    if hasattr(context, "__aenter__"):
        span = await context.__aenter__()
    else:
        span = context.__enter__()

    _apply_attributes(span, attributes)

    try:
        yield span
    except BaseException as exc:
        if record_exception and hasattr(span, "record_exception"):
            with contextlib.suppress(Exception):
                span.record_exception(exc)
        if hasattr(context, "__aexit__"):
            await context.__aexit__(type(exc), exc, exc.__traceback__)
        else:
            context.__exit__(type(exc), exc, exc.__traceback__)
        raise
    else:
        if hasattr(context, "__aexit__"):
            await context.__aexit__(None, None, None)
        else:
            context.__exit__(None, None, None)


@contextlib.contextmanager
def copilot_span_sync(
    name: str,
    *,
    attributes: Mapping[str, Any] | None = None,
    tracer_name: str = _DEFAULT_TRACER_NAME,
    record_exception: bool = True,
) -> Iterator[Any]:
    """Synchronous variant of :func:`copilot_span`.

    Useful in code paths that are not async but still need span
    instrumentation (e.g. CLI entry points, test fixtures).
    """
    tracer = get_tracer(tracer_name)
    with tracer.start_as_current_span(name) as span:
        _apply_attributes(span, attributes)
        try:
            yield span
        except BaseException as exc:
            if record_exception and hasattr(span, "record_exception"):
                with contextlib.suppress(Exception):
                    span.record_exception(exc)
            raise


def enrich_log_with_trace(payload: dict[str, Any]) -> dict[str, Any]:
    """Add ``trace_id``/``span_id`` to *payload* when a span is active.

    Returns the same dict (mutated in place) for ergonomic chaining.
    A no-op when OTel is unavailable.
    """
    trace_id, span_id = current_trace_ids()
    if trace_id is not None:
        payload["trace_id"] = trace_id
    if span_id is not None:
        payload["span_id"] = span_id
    return payload


def structlog_trace_processor(
    logger: Any,  # noqa: ARG001
    method_name: str,  # noqa: ARG001
    event_dict: dict[str, Any],
) -> dict[str, Any]:
    """structlog processor that injects trace/span ids into every event.

    Register once at structlog configuration time::

        structlog.configure(processors=[
            ...,
            structlog_trace_processor,
            ...,
        ])

    Events emitted inside a :func:`copilot_span` will gain
    ``trace_id`` and ``span_id`` keys.  Outside a span, the processor
    is a no-op.  Safe in environments without OTel installed — the
    underlying :func:`current_trace_ids` short-circuits.
    """
    if not is_otel_available():
        return event_dict
    return enrich_log_with_trace(event_dict)


__all__ = [
    "copilot_span",
    "copilot_span_sync",
    "enrich_log_with_trace",
    "structlog_trace_processor",
]
