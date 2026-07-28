"""HTTP transport for the Loom SDK — standard library only.

Deliberately dependency-free: ``csa-loom`` installs with **zero runtime
dependencies** (``urllib`` from the standard library does the work), which keeps
the package license posture trivially clean (LIC0) and makes it safe to drop
into an air-gapped Government estate where an arbitrary wheel set cannot be
pulled.

Callers who want ``requests``/``httpx``/retry-with-jitter semantics can pass any
object satisfying :class:`Transport` to :class:`csa_loom.LoomClient` — the
generated API surface is transport-agnostic.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from csa_loom.errors import LoomTransportError

__all__ = ["Response", "Transport", "UrllibTransport"]

#: Schemes the SDK will open. Anything else (file:, ftp:, data:) is refused so a
#: mis-configured base URL can never turn into a local-file read.
ALLOWED_SCHEMES = ("http", "https")


@dataclass(frozen=True)
class Response:
    """A raw HTTP response. Status is returned, never raised, for 4xx/5xx."""

    status: int
    body: bytes
    headers: Mapping[str, str] = field(default_factory=dict)


@runtime_checkable
class Transport(Protocol):
    """The single method :class:`csa_loom.LoomClient` needs from a transport."""

    def send(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> Response:
        """Perform one HTTP request and return the response without raising on 4xx/5xx."""
        ...


class UrllibTransport:
    """The default transport: :mod:`urllib.request`, no third-party packages."""

    def send(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> Response:
        scheme = url.split(":", 1)[0].lower()
        if scheme not in ALLOWED_SCHEMES:
            msg = f"refusing to open {scheme!r} URL {url!r}; allowed schemes: {', '.join(ALLOWED_SCHEMES)}"
            raise LoomTransportError(msg)

        request = urllib.request.Request(url, data=body, method=method.upper())  # noqa: S310
        for key, value in headers.items():
            request.add_header(key, value)

        try:
            # Scheme validated above, so this cannot open a file:/ftp: URL.
            with urllib.request.urlopen(request, timeout=timeout) as raw:  # noqa: S310
                return Response(
                    status=int(raw.status),
                    body=raw.read(),
                    headers={k.lower(): v for k, v in raw.headers.items()},
                )
        except urllib.error.HTTPError as exc:  # 4xx / 5xx still carry a body
            return Response(
                status=int(exc.code),
                body=exc.read(),
                headers={k.lower(): v for k, v in exc.headers.items()} if exc.headers else {},
            )
        except urllib.error.URLError as exc:
            msg = f"{method.upper()} {url} failed: {exc.reason}"
            raise LoomTransportError(msg) from exc
        except TimeoutError as exc:
            msg = f"{method.upper()} {url} timed out after {timeout}s"
            raise LoomTransportError(msg) from exc
