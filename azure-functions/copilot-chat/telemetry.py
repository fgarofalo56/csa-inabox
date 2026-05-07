"""Application Insights custom-event helper for the Copilot Chat function.

Events are routed to the `customEvents` table via OpenCensus'
``AzureEventHandler``, which is the recommended path for emitting
discrete events (vs. trace logs) from Python on Azure Functions.

If App Insights is not configured (the ``APPLICATIONINSIGHTS_CONNECTION_STRING``
env var is unset, or the SDK is unavailable), all helpers no-op so the
function stays healthy in local development.

**Flush behaviour (important on Consumption plan).** ``AzureEventHandler``
buffers events and flushes asynchronously. On Linux Consumption the
worker can be torn down before the buffer drains, dropping events.
Each ``track_event`` therefore force-flushes the handler after emitting,
trading a small per-call latency hit for at-most-once delivery.

KQL example::

    customEvents
    | where name == "chat.request"
    | summarize count() by tostring(customDimensions.uncovered), bin(timestamp, 1h)
"""

from __future__ import annotations

import logging
import os
from typing import Any

_log = logging.getLogger("copilot.telemetry")

# Event logger + handler are initialised lazily so module import never fails.
_event_logger: logging.Logger | None = None
_event_handler: Any = None
_init_attempted = False


def _get_event_logger() -> logging.Logger | None:
    global _event_logger, _event_handler, _init_attempted
    if _init_attempted:
        return _event_logger
    _init_attempted = True

    conn_str = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING") or ""
    if not conn_str:
        return None

    try:
        # Lazy import — keeps the cold-start path tiny when the SDK is missing.
        from opencensus.ext.azure.log_exporter import AzureEventHandler  # type: ignore

        handler = AzureEventHandler(connection_string=conn_str)
        logger = logging.getLogger("copilot.events")
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        logger.propagate = False
        _event_logger = logger
        _event_handler = handler
        return logger
    except Exception:
        _log.exception("App Insights event logger init failed; events disabled")
        return None


def track_event(name: str, properties: dict[str, Any] | None = None) -> None:
    """Emit a custom event and force-flush the buffer.

    Properties become ``customDimensions`` in KQL. Numeric values are
    serialised as strings — cast with ``toint()`` / ``todouble()`` on the
    query side if you need numeric aggregation.
    """
    logger = _get_event_logger()
    if logger is None:
        return
    try:
        logger.info(name, extra={"custom_dimensions": properties or {}})
        # Force-flush so the worker doesn't tear down with events in the buffer.
        # Bounded flush — never block the request path more than a second.
        if _event_handler is not None:
            try:
                _event_handler.flush(timeout=1.0)
            except TypeError:
                # Older opencensus versions don't accept a timeout kwarg.
                _event_handler.flush()
    except Exception:
        _log.exception("track_event failed: %s", name)
