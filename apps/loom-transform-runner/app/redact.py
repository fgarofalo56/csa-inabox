"""Redaction for the transform-runner failure envelope.

DEPENDENCY-FREE ON PURPOSE. This lives apart from `main.py` so it can be
imported by a test with `importlib.util.spec_from_file_location` — `main.py`
pulls FastAPI and the whole dbt/SQLMesh stack, which is not installed in the
default test environment.

The first version of the test loaded this function out of `main.py` with
an exec/compile pair and was rejected by the repo's own py/code-injection guard
("new py/code-injection candidates — each must be bounded like app.py"). The
guard was right: adding a dynamic-execution call to dodge an import is precisely the pattern it
exists to stop. A plain module is the correct answer.
"""

from __future__ import annotations

# Env values at or below this length are left alone. `db`, `1`, `s` occur inside
# ordinary words, so blanking every occurrence would shred a legitimate engine
# message while protecting nothing that is secret at that length.
_MIN_REDACTABLE_LEN = 3


def redact(text: str, env: dict[str, str] | None) -> str:
    """Blank out per-run env VALUES that appear verbatim in an engine message.

    `TransformRequest.env` is "per-run env the runner injects before invoking the
    engine" — in practice warehouse credentials and DSNs. dbt and SQLMesh quote
    the connection they failed on, so a connection error can echo one straight
    back through the failure envelope (CodeQL py/stack-trace-exposure).

    Redacting the VALUE, not the whole message, keeps `no-vaporware.md`'s
    requirement that the real engine error reaches the user — an opaque
    "transform failed" is exactly the dishonest error that rule forbids.
    """
    if not env:
        return text
    out = text
    for value in env.values():
        v = (value or "").strip()
        if len(v) > _MIN_REDACTABLE_LEN and v in out:
            out = out.replace(v, "[redacted]")
    return out
