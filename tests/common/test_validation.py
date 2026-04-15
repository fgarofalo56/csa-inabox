"""Tests for the canonical validation utilities.

These tests pin the behaviour of :mod:`governance.common.validation` so any
future change to the email regex has to be intentional (and propagated to the
dbt var in ``dbt_project.yml`` at the same time).
"""

from __future__ import annotations

import pytest

from governance.common.validation import (
    EMAIL_REGEX_PATTERN,
    is_valid_email,
    substitute_common_patterns,
)


@pytest.mark.parametrize(
    "email",
    [
        "user@example.com",
        "first.last@sub.example.co",
        "tag+filter@example.io",
        "u_ser-1%foo@example-domain.com",
    ],
)
def test_is_valid_email_accepts_valid_addresses(email: str) -> None:
    assert is_valid_email(email) is True


@pytest.mark.parametrize(
    "email",
    [
        "",
        "no-at-symbol",
        "@example.com",
        "user@",
        "user@example",  # missing TLD
        "user@example.c",  # TLD too short
        "user name@example.com",  # space in local part
        None,
    ],
)
def test_is_valid_email_rejects_invalid_addresses(email: str | None) -> None:
    assert is_valid_email(email) is False


def test_substitute_common_patterns_expands_email_placeholder_in_string() -> None:
    assert substitute_common_patterns("{EMAIL_REGEX}") == EMAIL_REGEX_PATTERN


def test_substitute_common_patterns_walks_nested_dicts_and_lists() -> None:
    raw = {
        "suite": "bronze",
        "expectations": [
            {"regex": "{EMAIL_REGEX}", "column": "email"},
            {"min_value": 0},
        ],
        "meta": {"note": "pattern is {EMAIL_REGEX}"},
    }

    expanded = substitute_common_patterns(raw)

    assert expanded["expectations"][0]["regex"] == EMAIL_REGEX_PATTERN
    assert expanded["expectations"][1]["min_value"] == 0
    assert EMAIL_REGEX_PATTERN in expanded["meta"]["note"]


def test_substitute_common_patterns_is_a_noop_when_no_placeholder_present() -> None:
    raw = {"a": 1, "b": ["x", "y"], "c": "literal string"}
    assert substitute_common_patterns(raw) == raw
