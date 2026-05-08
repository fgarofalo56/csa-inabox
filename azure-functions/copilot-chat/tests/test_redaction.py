"""Tests for the redaction helpers."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import redaction  # noqa: E402


@pytest.mark.parametrize("text", [
    "contact me at alice@example.com",
    "my email is bob+filter@sub.example.org",
])
def test_redacts_email(text: str) -> None:
    out = redaction.redact(text)
    assert "@example" not in out
    assert "[redacted]" in out


def test_redacts_jwt() -> None:
    jwt = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ."
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    )
    out = redaction.redact(f"my token is {jwt} thanks")
    assert "eyJ" not in out
    assert "[redacted]" in out


@pytest.mark.parametrize("prefix,sep", [
    # Build the fixtures at runtime so they don't sit as literals in
    # source — GitHub's secret scanner false-positives on the real
    # ``ghp_<36chars>`` shape even when the body is obviously fake.
    ("ghp", "_"),
    ("sk", "-"),
    ("xoxb", "-"),
    ("AIza", ""),
    ("hf", "_"),
])
def test_redacts_provider_prefixed_credentials(prefix: str, sep: str) -> None:
    body = "Z" * 35  # well above the 20-char minimum in every prefix pattern
    creds = f"{prefix}{sep}{body}"
    out = redaction.redact(f"key {creds} end")
    assert creds not in out


def test_redacts_bearer() -> None:
    text = "Authorization: Bearer abc123def456ghi789jkl"
    out = redaction.redact(text)
    assert "abc123def456ghi789jkl" not in out
    assert "[redacted]" in out


def test_redacts_azure_connection_string() -> None:
    # Build the literal at runtime — gitleaks otherwise tags any fixed
    # base64-shaped key value as a leaked credential.
    fake_key = "z" * 24 + "=="
    cs = f"DefaultEndpointsProtocol=https;AccountName=foo;AccountKey={fake_key}"
    out = redaction.redact(cs)
    assert "AccountKey=" in out  # the keyword survives
    assert fake_key not in out   # the value does not


def test_redacts_ipv4() -> None:
    out = redaction.redact("client connected from 198.51.100.42")
    assert "198.51.100.42" not in out


def test_truncates_to_max_length() -> None:
    """max_length is a *cap* — the output may be shorter if a pattern
    matches the truncated text and replaces it with ``[redacted]``."""
    # No-pattern input → exact truncation
    out = redaction.redact("hello " * 50, max_length=20)
    assert len(out) == 20

    # All-pattern input → redacted, much shorter than the cap
    out2 = redaction.redact("a" * 100, max_length=50)
    assert len(out2) <= 50


def test_empty_input() -> None:
    assert redaction.redact("") == ""
    assert redaction.redact(None) == ""  # type: ignore[arg-type]


def test_hash_ip_is_deterministic_with_salt() -> None:
    a = redaction.hash_ip("203.0.113.1", "salt-x")
    b = redaction.hash_ip("203.0.113.1", "salt-x")
    c = redaction.hash_ip("203.0.113.1", "salt-y")
    assert a == b
    assert a != c
    assert len(a) == 16
