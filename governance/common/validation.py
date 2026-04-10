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
    """Return ``True`` if *value* matches :data:`EMAIL_REGEX`, else ``False``.

    ``None`` and non-string inputs are treated as invalid.
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
    """Recursively expand ``{EMAIL_REGEX}``-style placeholders in *value*.

    Walks dicts, lists, and strings. Non-string leaves are returned unchanged.
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
