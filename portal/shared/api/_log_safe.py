"""Log-safety helpers — sanitize untrusted input before it lands in a
log message so an attacker cannot forge log lines via CRLF injection
or smuggle terminal escape codes through control characters.

Used from ``portal.shared.api.routers.*`` whenever a value derived
from an HTTP request (path param, query string, body field, header)
needs to appear in a log string.

Pairs with CodeQL rule ``py/log-injection``.
"""

from __future__ import annotations

_CRLF_PRINTABLE_LIMIT = 500


def safe_for_log(value: object, *, limit: int = _CRLF_PRINTABLE_LIMIT) -> str:
    """Return a printable, single-line repr of ``value`` for log output.

    - Coerces non-strings via ``str()``.
    - Drops CR / LF and ASCII control characters (``0x00–0x1F`` and
      ``0x7F``) — these are the building blocks of log-line forgery
      and terminal-escape attacks.
    - Truncates to ``limit`` characters (default 500) to bound log
      volume from oversized input.
    - Returns the empty string for ``None``.
    """
    if value is None:
        return ""
    s = str(value)
    cleaned = "".join(c for c in s if c >= " " and c != "\x7f")
    if len(cleaned) > limit:
        return cleaned[: limit - 1] + "…"
    return cleaned
