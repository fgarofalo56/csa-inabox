"""Structured JSON logging with trace / correlation IDs.

This is the single place where Python services in CSA-in-a-Box configure
logging.  It wraps :mod:`structlog` so every log line comes out as JSON with
a consistent schema (see ``docs/LOG_SCHEMA.md``) and a trace/correlation
context that propagates across the request lifecycle.

Typical use:

.. code-block:: python

    from governance.common.logging import configure_structlog, get_logger, bind_trace_context

    configure_structlog(service="csa-data-quality")
    logger = get_logger(__name__)

    with bind_trace_context(trace_id="abc123"):
        logger.info("data_quality.run_started", suite="bronze", tables=42)

All log records include ``service``, ``timestamp`` (ISO-8601 UTC), ``level``,
``event``, and whatever key/value pairs the caller supplied plus the bound
trace context.  Azure Functions, the CLI quality runner, and (eventually) the
Databricks notebooks all share the same schema so Log Analytics can parse
them with a single KQL expression.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from contextlib import contextmanager
from typing import Any, Iterator, Mapping

import structlog
from structlog.contextvars import (
    bind_contextvars,
    clear_contextvars,
    merge_contextvars,
    unbind_contextvars,
)

# W3C traceparent header format: `00-<trace-id>-<parent-id>-<trace-flags>`.
# See https://www.w3.org/TR/trace-context/#traceparent-header
_TRACEPARENT_RE = re.compile(
    r"^[0-9a-f]{2}-(?P<trace_id>[0-9a-f]{32})-(?P<parent_id>[0-9a-f]{16})-[0-9a-f]{2}$"
)

_CONFIGURED = False


def configure_structlog(
    *,
    service: str,
    level: str | int = "INFO",
    json_output: bool | None = None,
) -> None:
    """Idempotently configure structlog for the current process.

    Args:
        service: Logical service name baked into every log line as the
            ``service`` field (e.g. ``"csa-data-quality"``,
            ``"csa-ai-enrichment"``).
        level: Minimum log level — accepts either a string (``"DEBUG"``,
            ``"INFO"``, ...) or a numeric :mod:`logging` level.
        json_output: Force JSON output on or off.  When ``None`` (the
            default) we output JSON whenever ``LOG_FORMAT`` is unset or set
            to ``"json"``, and fall back to a human-readable console
            renderer when ``LOG_FORMAT=console``.  Azure Functions and Log
            Analytics both want JSON, so JSON is the default.
    """
    global _CONFIGURED
    if _CONFIGURED:
        # Re-binding the service name is the only thing safe to do on a
        # second call — otherwise we keep the existing configuration so
        # tests and importers don't stomp on each other.
        bind_contextvars(service=service)
        return

    if isinstance(level, str):
        numeric_level = logging.getLevelName(level.upper())
        if not isinstance(numeric_level, int):
            numeric_level = logging.INFO
    else:
        numeric_level = level

    # Route stdlib logging through structlog so third-party libraries
    # (e.g. azure.*) still get JSON-formatted output.
    logging.basicConfig(format="%(message)s", level=numeric_level)

    if json_output is None:
        json_output = os.environ.get("LOG_FORMAT", "json").lower() != "console"

    # NOTE: we intentionally do not use ``structlog.stdlib.add_logger_name``
    # because we use ``PrintLoggerFactory`` rather than the stdlib factory
    # (PrintLogger has no ``name`` attribute).  Callers that want a logger
    # name in the output should pass ``logger_name=...`` explicitly via
    # kwargs.
    shared_processors: list[Any] = [
        merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]

    renderer = (
        structlog.processors.JSONRenderer()
        if json_output
        else structlog.dev.ConsoleRenderer(colors=False)
    )

    structlog.configure(
        processors=[*shared_processors, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(numeric_level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )

    bind_contextvars(service=service)
    _CONFIGURED = True


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Return a structlog BoundLogger.

    Args:
        name: Optional logger name — typically ``__name__`` at the call
            site.  When set, it is added as ``logger`` to each log entry.
    """
    logger: structlog.stdlib.BoundLogger = (
        structlog.get_logger(name) if name else structlog.get_logger()
    )
    return logger


def new_trace_id() -> str:
    """Generate a new 32-character lowercase hex trace id (W3C compatible)."""
    return uuid.uuid4().hex


def new_correlation_id() -> str:
    """Generate a new correlation id (UUID4 string)."""
    return str(uuid.uuid4())


def extract_trace_id_from_headers(headers: Mapping[str, str]) -> str | None:
    """Return the trace id from a W3C ``traceparent`` header, if present.

    Header names are matched case-insensitively.  Returns ``None`` when
    the header is missing or malformed so callers can fall back to
    :func:`new_trace_id`.
    """
    if not headers:
        return None
    for key, value in headers.items():
        if key.lower() == "traceparent" and isinstance(value, str):
            match = _TRACEPARENT_RE.match(value.strip().lower())
            if match:
                return match.group("trace_id")
    return None


@contextmanager
def bind_trace_context(
    *,
    trace_id: str | None = None,
    correlation_id: str | None = None,
    **extra: Any,
) -> Iterator[dict[str, Any]]:
    """Context manager that temporarily binds trace context to every log line.

    Use at the top of a request handler so every log emitted for that
    request carries the same trace / correlation ids:

    .. code-block:: python

        with bind_trace_context(trace_id=req_trace_id, request_path="/enrich"):
            logger.info("request.received")
            ...

    Missing values are auto-generated so callers can always rely on the
    bound fields existing.
    """
    trace_id = trace_id or new_trace_id()
    correlation_id = correlation_id or new_correlation_id()
    bindings: dict[str, Any] = {
        "trace_id": trace_id,
        "correlation_id": correlation_id,
        **extra,
    }
    bind_contextvars(**bindings)
    try:
        yield bindings
    finally:
        unbind_contextvars(*bindings.keys())


def reset_logging_state() -> None:
    """Test-only helper: reset the module-level configuration flag and clear context vars."""
    global _CONFIGURED
    _CONFIGURED = False
    clear_contextvars()
