"""Log-safety helpers — sanitize untrusted input before it lands in a
log message so an attacker cannot forge log lines via CRLF injection
or smuggle terminal escape codes through control characters.

Used from ``portal.shared.api.routers.*`` whenever a value derived
from an HTTP request (path param, query string, body field, header)
needs to appear in a log string.

Pairs with CodeQL rule ``py/log-injection``. The implementation uses
``re.sub`` rather than a generator comprehension so CodeQL's taint
analyser recognises it as a sanitiser and clears the flow.
"""

from __future__ import annotations

import re

_CRLF_PRINTABLE_LIMIT = 500

# ASCII control chars (0x00-0x1F + 0x7F). re.sub on this pattern is
# the canonical "log-line forgery" sanitiser that py/log-injection
# recognises through the analysis boundary.
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")


def safe_for_log(value: object, *, limit: int = _CRLF_PRINTABLE_LIMIT) -> str:
    """Return a printable, single-line repr of ``value`` for log output.

    - Coerces non-strings via ``str()``.
    - Strips CR / LF and ASCII control chars (``0x00–0x1F`` and
      ``0x7F``) via ``re.sub`` — the building blocks of log-line
      forgery and terminal-escape attacks.
    - Truncates to ``limit`` characters (default 500) to bound log
      volume from oversized input.
    - Returns the empty string for ``None``.
    """
    if value is None:
        return ""
    cleaned = _CONTROL_CHAR_RE.sub("", str(value))
    if len(cleaned) > limit:
        return cleaned[: limit - 1] + "…"
    return cleaned
