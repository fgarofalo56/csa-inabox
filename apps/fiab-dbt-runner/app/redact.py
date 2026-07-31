"""Redaction for the dbt-runner log envelope.

DEPENDENCY-FREE ON PURPOSE, so a test can load it with
`importlib.util.spec_from_file_location` — `main.py` pulls FastAPI and dbt-core,
neither of which is installed in the default test environment.

Deliberately a copy of apps/loom-transform-runner/app/redact.py rather than a
shared import: these are separate container images with separate requirements,
and neither builds the other's directory into its context. Keep the two in sync
by hand; they are ~20 lines each.
"""

from __future__ import annotations

# Env values at or below this length are left alone. `db`, `1`, `s` occur inside
# ordinary words, so blanking every occurrence would shred a legitimate dbt
# message while protecting nothing that is secret at that length.
_MIN_REDACTABLE_LEN = 3


def redact(text: str, env: dict[str, str] | None) -> str:
    """Blank out per-run env VALUES that appear verbatim in a dbt message.

    `RunRequest.env` is the per-run env the Console injects before invoking dbt —
    in practice warehouse credentials and DSNs, which `_run_dbt` writes into
    `os.environ` so `env_var()` resolves at parse time. dbt quotes the connection
    it failed on, so `res.exception` can echo one straight back into the `log`
    the Console renders.

    Redacting the VALUE, not the whole message, keeps `no-vaporware.md`'s
    requirement that the real dbt error reaches the user — an opaque
    "dbt failed" is exactly the dishonest error that rule forbids.
    """
    if not env:
        return text
    out = text
    for value in env.values():
        v = (value or "").strip()
        if len(v) > _MIN_REDACTABLE_LEN and v in out:
            out = out.replace(v, "[redacted]")
    return out
