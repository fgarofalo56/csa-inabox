"""Redaction for the migrate reader error envelope.

DEPENDENCY-FREE ON PURPOSE, so a test can load it with
`importlib.util.spec_from_file_location` — `main.py` pulls FastAPI and dbt-core,
neither of which is installed in the default test environment.

Deliberately a copy of apps/loom-transform-runner/app/redact.py (and apps/fiab-dbt-runner) rather than a
shared import: these are separate container images with separate requirements,
and neither builds the other's directory into its context. Keep the two in sync
by hand; they are ~20 lines each.
"""

from __future__ import annotations

# Env values at or below this length are left alone. `db`, `1`, `s` occur inside
# ordinary words, so blanking every occurrence would shred a legitimate source
# message while protecting nothing that is secret at that length.
_MIN_REDACTABLE_LEN = 3


def redact(text: str, env: dict[str, str] | None) -> str:
    """Blank out connection VALUES that appear verbatim in a source error.

    `EnumerateRequest.connection` carries the source bearer token the BFF
    resolved from Key Vault. The token is sent as a HEADER and is never
    interpolated into a message, so the exposure here is narrower than in the
    dbt / transform runners: it requires the SOURCE to echo the Authorization
    header back inside its own error body, which `_get_json` forwards (truncated
    to 300 chars) as "Source returned {code}: {body}". Some APIs do exactly that.

    Cheap defence in depth rather than a known live leak — recorded honestly so
    the next reader does not over-rate it.
    """
    if not env:
        return text
    out = text
    for value in env.values():
        v = (value or "").strip()
        if len(v) > _MIN_REDACTABLE_LEN and v in out:
            out = out.replace(v, "[redacted]")
    return out
