"""`_fail` must not echo caller-supplied credentials back in the error envelope.

CodeQL py/stack-trace-exposure flags 12 sites in apps/loom-transform-runner that
return engine error text to the caller. Returning the REAL engine message is
required by no-vaporware.md — an opaque "transform failed" is exactly the
dishonest error that rule forbids — so the fix is not to stop returning it.

The genuine leak is narrower: `TransformRequest.env` is "per-run env the runner
injects before invoking the engine", i.e. warehouse credentials and DSNs. dbt and
SQLMesh quote the connection they failed on, so a connection error can echo one
straight back. `_redact` blanks those VALUES while leaving the rest of the
message intact.

FIXTURE VALUES ARE DELIBERATELY LOW-ENTROPY AND REPETITIVE. A realistic-looking
fake trips gitleaks' `generic-api-key` rule — the Secret Scan gate failed this
file on exactly that, and it was right to: a scanner cannot tell a convincing
fake from a real leak, and "it's only a test" is what every real leak looks like
in review. The redaction is length- and containment-based, so a repetitive
placeholder exercises it identically.

Loaded by source rather than by importing app.main, which pulls FastAPI + the
whole engine stack and is not installed in the default test env.
"""

from __future__ import annotations

import io
import pathlib
from typing import Any, Callable

import pytest

_SRC = (
    pathlib.Path(__file__).resolve().parents[2]
    / "apps"
    / "loom-transform-runner"
    / "app"
    / "main.py"
)


def _load_redact() -> Callable[[str, dict[str, str] | None], str]:
    src = io.open(_SRC, encoding="utf-8").read()
    start = src.index("def _redact(")
    end = src.index("def _fail(")
    ns: dict[str, Any] = {}
    exec(compile(src[start:end], "<redact>", "exec"), ns)  # noqa: S102
    return ns["_redact"]  # type: ignore[no-any-return]


redact = _load_redact()

# Repetitive placeholders — see the module docstring on why these are not
# realistic-looking.
FAKE_DSN = "Server=tcp:example;Pwd=xxxxxxxxxxxx"
FAKE_TOKEN = "xxxxxxxxxxxxxxxx"
ENV: dict[str, str] = {
    "DBT_DSN": FAKE_DSN,
    "TOKEN": FAKE_TOKEN,
    "SHORT": "db",
    "EMPTY": "",
}


def test_dsn_echoed_by_the_engine_is_redacted() -> None:
    out = redact(f"Connection failed for {FAKE_DSN} after 30s", ENV)
    assert FAKE_DSN not in out
    assert "[redacted]" in out


def test_token_is_redacted() -> None:
    assert FAKE_TOKEN not in redact(f"auth failed using token {FAKE_TOKEN}", ENV)


def test_ordinary_message_is_untouched() -> None:
    msg = "Runtime Error: Database Error in model orders"
    assert redact(msg, ENV) == msg


def test_short_values_are_not_redacted() -> None:
    """A 1-3 char env value occurs inside ordinary words; blanking every
    occurrence would shred the message while protecting nothing secret."""
    msg = "could not find db in profiles.yml"
    assert redact(msg, ENV) == msg


def test_empty_value_does_not_blank_everything() -> None:
    assert redact("some message", {"EMPTY": ""}) == "some message"


@pytest.mark.parametrize("env", [None, {}])
def test_no_env_passes_through(env: dict[str, str] | None) -> None:
    assert redact("plain message", env) == "plain message"
