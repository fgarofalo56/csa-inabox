"""Typed exceptions for the Data Activator outbound notification path.

These exceptions let the retry/DLQ layer distinguish between transient
network failures (retry with exponential backoff) and fatal errors
(send directly to the DLQ, no retry).

Usage::

    from csa_platform.data_activator.actions.errors import (
        DataActivatorFatalError,
        DataActivatorTransientError,
    )

    try:
        resp = requests.post(url, json=body, timeout=10)
        resp.raise_for_status()
    except requests.Timeout as exc:
        raise DataActivatorTransientError("timeout") from exc
    except requests.HTTPError as exc:
        status = getattr(exc.response, "status_code", 0)
        if 500 <= status < 600 or status == 429:
            raise DataActivatorTransientError(f"http {status}") from exc
        raise DataActivatorFatalError(f"http {status}") from exc
"""

from __future__ import annotations


class DataActivatorError(Exception):
    """Base class for all Data Activator notification errors."""


class DataActivatorTransientError(DataActivatorError):
    """Transient failure that should be retried (timeouts, 5xx, 429, connection reset).

    The retry decorator catches this exception, applies exponential backoff,
    and re-raises after ``max_attempts`` when the retry budget is exhausted.
    After exhaustion the failed event is pushed to the DLQ.
    """


class DataActivatorFatalError(DataActivatorError):
    """Non-transient failure that must NOT be retried (4xx auth, 400 validation).

    Retrying would only compound the problem (e.g. invalid webhook URL,
    auth rejected, malformed payload).  The failed event is pushed
    directly to the DLQ without retry.
    """


__all__ = [
    "DataActivatorError",
    "DataActivatorFatalError",
    "DataActivatorTransientError",
]
