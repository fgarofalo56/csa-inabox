"""Shared governance utilities — validation patterns and structured logging."""

from csa_platform.governance.common.logging import (
    bind_trace_context,
    configure_structlog,
    extract_trace_id_from_headers,
    get_logger,
    new_correlation_id,
    new_trace_id,
)
from csa_platform.governance.common.validation import (
    EMAIL_REGEX,
    EMAIL_REGEX_PATTERN,
    is_valid_email,
    substitute_common_patterns,
)

__all__ = [
    "EMAIL_REGEX",
    "EMAIL_REGEX_PATTERN",
    "bind_trace_context",
    "configure_structlog",
    "extract_trace_id_from_headers",
    "get_logger",
    "is_valid_email",
    "new_correlation_id",
    "new_trace_id",
    "substitute_common_patterns",
]
