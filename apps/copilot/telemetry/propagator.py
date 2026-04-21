"""Context-propagation helpers for the Copilot telemetry package.

OTel's async context propagation works out of the box within the same
event loop — every :func:`copilot_span` call binds the span into the
current :class:`contextvars.Context` so nested coroutines see it.
This module layers on two ergonomic helpers for the edge cases:

1. :func:`inject_context_headers` — serialise the current span context
   into W3C Trace-Context headers for outbound HTTP calls.
2. :func:`extract_context_headers` — parse incoming W3C Trace-Context
   headers and return a context token usable with
   :func:`attach_context`.

Both helpers no-op when OTel is unavailable.
"""

from __future__ import annotations

from typing import Any

from apps.copilot.telemetry.tracer import is_otel_available


def inject_context_headers(headers: dict[str, str] | None = None) -> dict[str, str]:
    """Return *headers* augmented with W3C Trace-Context values.

    The input dict is not mutated.  When OTel is unavailable the
    function returns the input unchanged.
    """
    result: dict[str, str] = dict(headers or {})
    if not is_otel_available():
        return result

    from opentelemetry import propagate

    class _Setter:
        def set(self, carrier: dict[str, str], key: str, value: str) -> None:
            carrier[key] = value

    propagate.inject(result, setter=_Setter())  # type: ignore[arg-type]
    return result


def extract_context_headers(headers: dict[str, str]) -> Any:
    """Return an OTel context parsed from *headers*, or ``None`` on no-op.

    The caller attaches it via
    :func:`opentelemetry.context.attach` inside a ``try/finally``
    block.  When OTel is unavailable, returns ``None``.
    """
    if not is_otel_available():
        return None

    from opentelemetry import propagate

    class _Getter:
        def get(self, carrier: dict[str, str], key: str) -> list[str] | None:
            value = carrier.get(key)
            if value is None:
                return None
            return [value]

        def keys(self, carrier: dict[str, str]) -> list[str]:
            return list(carrier.keys())

    return propagate.extract(headers, getter=_Getter())  # type: ignore[arg-type]


__all__ = [
    "extract_context_headers",
    "inject_context_headers",
]
