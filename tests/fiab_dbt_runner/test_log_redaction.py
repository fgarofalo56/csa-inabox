"""`_run_dbt` must not echo caller-supplied credentials back in its log.

FOUND BY AUDIT, NOT BY THE SCANNER — which is the point of this file.

CodeQL's py/stack-trace-exposure flagged apps/fiab-dbt-runner/app/main.py:126,
the `except ValueError` from `_write_project`. That one carries the caller's own
file paths and no credential.

The line it did NOT flag is the leak: `_run_dbt` appends `res.exception` to the
summary that becomes the `log` the Console renders. `RunRequest.env` is the
per-run env the Console injects — warehouse credentials and DSNs — and
`_run_dbt` writes it into `os.environ` so dbt's `env_var()` resolves at parse
time. dbt quotes the connection it failed on, so a connection error returns the
caller's secret verbatim.

Redacting the VALUE rather than suppressing the message keeps no-vaporware.md's
requirement that the real dbt error reaches the user.

FIXTURE VALUES ARE DELIBERATELY LOW-ENTROPY AND REPETITIVE. A realistic-looking
fake trips gitleaks' generic-api-key rule; the Secret Scan gate failed the
sibling transform-runner test on exactly that, and was right to. The redaction is
length- and containment-based, so a repetitive placeholder exercises it
identically.

Loaded by source rather than by importing app.main, which pulls FastAPI + dbt-core.
"""

from __future__ import annotations

import importlib.util
import pathlib
from typing import Callable

import pytest

_SRC = (
    pathlib.Path(__file__).resolve().parents[2]
    / "apps"
    / "fiab-dbt-runner"
    / "app"
    / "redact.py"
)


def _load_redact() -> Callable[[str, dict[str, str] | None], str]:
    spec = importlib.util.spec_from_file_location("fiab_dbt_redact", _SRC)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.redact  # type: ignore[no-any-return]


redact = _load_redact()

FAKE_DSN = "Server=tcp:example;Pwd=xxxxxxxxxxxx"
FAKE_TOKEN = "xxxxxxxxxxxxxxxx"
ENV: dict[str, str] = {
    "DBT_PASSWORD": FAKE_DSN,
    "DBT_TOKEN": FAKE_TOKEN,
    "SHORT": "db",
    "EMPTY": "",
}


def test_dsn_quoted_by_dbt_is_redacted() -> None:
    out = redact(f"Runtime Error: could not connect to {FAKE_DSN}", ENV)
    assert FAKE_DSN not in out
    assert "[redacted]" in out


def test_token_is_redacted() -> None:
    assert FAKE_TOKEN not in redact(f"auth failed using {FAKE_TOKEN}", ENV)


def test_ordinary_dbt_error_is_untouched() -> None:
    msg = "Compilation Error in model orders: depends on a node named 'missing'"
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
