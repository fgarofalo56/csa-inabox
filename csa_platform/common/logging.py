"""csa_platform.common.logging — structured logging for platform services.

Re-exports the logging primitives from :mod:`governance.common.logging` so
that platform code uses a stable, package-local import path::

    from csa_platform.common.logging import configure_structlog, get_logger

This avoids a hard cross-package import and makes it easy to swap the
implementation if the packages are ever split into separate repositories.
"""

from governance.common.logging import (
    bind_trace_context,
    configure_structlog,
    extract_trace_id_from_headers,
    get_logger,
    new_correlation_id,
    new_trace_id,
    reset_logging_state,
)

__all__ = [
    "bind_trace_context",
    "configure_structlog",
    "extract_trace_id_from_headers",
    "get_logger",
    "new_correlation_id",
    "new_trace_id",
    "reset_logging_state",
]
