"""Canonical validation patterns shared across dbt, Great Expectations, and Python.

This module is the single source of truth for validation regexes used by the
data-quality pipeline. The same patterns also live in:

- ``domains/shared/dbt/dbt_project.yml`` (as dbt ``vars:`` consumed by the
  ``flag_invalid_email`` macro in ``domains/shared/dbt/macros/data_quality.sql``)
- ``governance/dataquality/quality-rules.yaml`` (as ``{EMAIL_REGEX}`` placeholders
  that :func:`substitute_common_patterns` expands at load time)

When a pattern needs to change, update :data:`EMAIL_REGEX_PATTERN` below and
mirror it to ``dbt_project.yml``. The YAML rules file needs no edits because it
uses the placeholder.
"""

from __future__ import annotations

import re
from typing import Any

# Canonical email validation regex (RFC-5322-ish lite).
# Local part: letters/digits and the subset `._%+-` commonly permitted.
# Domain: letters/digits with dots and hyphens, TLD at least 2 letters.
# NOT a full RFC 5322 validator — we intentionally keep this simple so dbt's
# Spark SQL ``rlike`` and Great Expectations ``expect_column_values_to_match_regex``
# stay in sync.
EMAIL_REGEX_PATTERN = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"

EMAIL_REGEX: re.Pattern[str] = re.compile(EMAIL_REGEX_PATTERN)


def is_valid_email(value: str | None) -> bool:
    """Return True if value matches the canonical email regex pattern, else False.

    This function validates email addresses using a simplified RFC-5322-ish regex
    pattern that focuses on common cases and ensures compatibility with dbt's
    Spark SQL 'rlike' function and Great Expectations regex validation.

    Args:
        value: The email address string to validate, or None

    Returns:
        bool: True if the value is a valid email format, False otherwise.
              None and non-string inputs are treated as invalid.

    Examples:
        >>> is_valid_email("user@example.com")
        True
        >>> is_valid_email("invalid.email")
        False
        >>> is_valid_email(None)
        False
        >>> is_valid_email(123)
        False
    """
    if not isinstance(value, str):
        return False
    return EMAIL_REGEX.match(value) is not None


# Placeholders expanded by :func:`substitute_common_patterns` when loading YAML
# rule files.  Extend this mapping as new canonical patterns are introduced.
_COMMON_PATTERN_SUBSTITUTIONS: dict[str, str] = {
    "{EMAIL_REGEX}": EMAIL_REGEX_PATTERN,
}


def substitute_common_patterns(value: Any) -> Any:
    """Recursively expand placeholder patterns in configuration values.

    This function walks through dictionaries, lists, and strings to replace
    standardized placeholders like '{EMAIL_REGEX}' with their canonical values.
    This ensures that validation patterns defined in this module are consistently
    applied across dbt macros, Great Expectations rules, and Python validation.

    Args:
        value: The configuration value to process. Can be a string containing
               placeholders, a dict with nested values, a list of values, or
               any other type (returned unchanged).

    Returns:
        Any: The processed value with placeholders expanded:
             - Strings: placeholders replaced with canonical patterns
             - Dicts: recursively processed with placeholders in values replaced
             - Lists: recursively processed with placeholders in items replaced
             - Other types: returned unchanged

    Examples:
        >>> substitute_common_patterns("Email must match {EMAIL_REGEX}")
        'Email must match ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'

        >>> substitute_common_patterns({"pattern": "{EMAIL_REGEX}", "enabled": True})
        {'pattern': '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$', 'enabled': True}

        >>> substitute_common_patterns(["{EMAIL_REGEX}", "other"])
        ['^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$', 'other']
    """
    if isinstance(value, str):
        result = value
        for placeholder, replacement in _COMMON_PATTERN_SUBSTITUTIONS.items():
            if placeholder in result:
                result = result.replace(placeholder, replacement)
        return result
    if isinstance(value, dict):
        return {k: substitute_common_patterns(v) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute_common_patterns(v) for v in value]
    return value
