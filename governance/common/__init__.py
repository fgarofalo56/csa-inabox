"""Shared validation utilities for governance / data-quality tooling."""

from governance.common.validation import (
    EMAIL_REGEX,
    EMAIL_REGEX_PATTERN,
    is_valid_email,
    substitute_common_patterns,
)

__all__ = [
    "EMAIL_REGEX",
    "EMAIL_REGEX_PATTERN",
    "is_valid_email",
    "substitute_common_patterns",
]
