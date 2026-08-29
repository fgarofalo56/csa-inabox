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
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from http.client import HTTPMessage
from typing import IO, Protocol, runtime_checkable

from csa_loom.errors import LoomTransportError

__all__ = ["Response", "Transport", "UrllibTransport"]

#: Schemes the SDK will open. Anything else (file:, ftp:, data:) is refused so a
#: mis-configured base URL can never turn into a local-file read.
#:
#: THIS COVERS THE URL THE SDK BUILDS, AND NOTHING ELSE (#3717). It says nothing
#: about where the SERVER redirects the request to; see
#: :class:`_SameOriginRedirectHandler` for that half.
ALLOWED_SCHEMES = ("http", "https")


# ── Credential-safe opener (#3717) ────────────────────────────────────────────
#
# `LoomClient` passes `Authorization: Bearer <token>` through `headers` on every
# authenticated call, and `send` used to hand the Request to
# `urllib.request.urlopen`, i.e. the DEFAULT GLOBAL OPENER. Measured properties
# of that opener:
#
#   * `HTTPRedirectHandler.redirect_request` rebuilds the Request copying EVERY
#     header except content-length/content-type. urllib does NOT strip
#     `Authorization` across a host change the way `requests` does.
#   * `http_error_302` permits a `Location:` whose scheme is in
#     `('http','https','ftp','')`, and the default handler set installs
#     `FTPHandler` / `FileHandler` / `DataHandler` with NO proxy variable set.
#
# The scheme check above therefore did not close what its neighbouring comment
# claimed. That comment read "Scheme validated above, so this cannot open a
# file:/ftp: URL": the `file:` half stands (the stdlib refuses `file:` redirect
# targets), but the `ftp:` half was measurably untrue, and per
# `deploy-integrity.md` R7 a comment must not assert something the code did not
# establish. It is corrected at the call site below.
#
# Two remedies that do NOT work, both measured: `build_opener(HTTPHandler,
# HTTPSHandler, HTTPRedirectHandler)` only DE-DUPLICATES the default handler set
# (ftp/file/data stay installed), and an unscoped `ProxyHandler()` re-registers
# an `ftp` route from a single `ftp_proxy` env var and then fails OPEN through
# `proxy_open`.
#
# Long-form argument and full measurement log:
# `scripts/csa-loom/livy-session-census.py`. Duplicated rather than imported
# because this package installs with ZERO runtime dependencies and cannot reach
# anything outside `csa_loom`.
_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(url: str) -> tuple[str, str, int | None]:
    """The (scheme, host, port) triple two URLs must share to be same-origin."""
    parts = urllib.parse.urlsplit(url)
    scheme = (parts.scheme or "").lower()
    return (scheme, (parts.hostname or "").lower(), parts.port or _DEFAULT_PORTS.get(scheme))


def _origin_str(origin: tuple[str, str, int | None]) -> str:
    scheme, host, port = origin
    return f"{scheme}://{host}" + (f":{port}" if port is not None else "")


class CrossOriginRedirectRefused(urllib.error.HTTPError):
    """A redirect off the request's origin was refused, not followed.

    A DISTINCT TYPE ON PURPOSE, and this is load-bearing for THIS package rather
    than cosmetic. :meth:`UrllibTransport.send` deliberately RETURNS 4xx/5xx as a
    :class:`Response` instead of raising, so a plain ``HTTPError`` raised by the
    redirect guard would be caught by that arm and handed back as
    ``Response(status=302)`` — a refusal rendered as an ordinary server response,
    with the reason discarded. That is exactly the "unknown reported as a known"
    shape `deploy-integrity.md` R7 forbids. This subclass is caught FIRST and
    re-raised as a :class:`LoomTransportError`, which is what it is: the
    transport refused to make a request, the server never answered one.
    """


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse any redirect that leaves the origin the request was aimed at.

    THIS is the guard that closes the exfiltration vector; the scheme scoping in
    :func:`_http_only_opener` is defence in depth, not the fix. It REFUSES
    rather than stripping the header: a request that silently lost its
    credentials comes back 401 from an unexpected host, which sends the reader
    somewhere else entirely. Same-origin redirects still work.
    """

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> urllib.request.Request | None:
        # ANNOTATED RATHER THAN IGNORED. The first cut carried
        # `# type: ignore[no-untyped-def]`, which silenced the definition and
        # left every CALL SITE failing `no-untyped-call` under this package's
        # strict config — a suppression that moved the error rather than
        # answering it. The signature is typeshed's for the method being
        # overridden, so an incompatible override now fails here instead of
        # somewhere downstream.
        target = urllib.parse.urljoin(req.full_url, newurl)
        if _origin(target) != _origin(req.full_url):
            raise CrossOriginRedirectRefused(
                target,
                code,
                f"refusing cross-origin redirect "
                f"{_origin_str(_origin(req.full_url))} -> "
                f"{_origin_str(_origin(target))} — urllib copies the "
                f"Authorization header across a host change, so following this "
                f"would hand your Loom token to that host",
                headers,
                fp,
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _http_only_opener() -> urllib.request.OpenerDirector:
    """An opener whose only URL schemes are http and https (defence in depth).

    The proxy dict is SCOPED on purpose: `ProxyHandler.__init__` registers a
    `<scheme>_open` for EVERY key in the dict and the default `ProxyHandler()`
    reads `getproxies()`, so one `ftp_proxy` re-registers the ftp route on an
    otherwise-locked-down opener — and it fails OPEN. Dropping the `'no'` key
    does not break `no_proxy`: `proxy_open` calls the module-level
    `proxy_bypass()`, which re-reads the environment itself.
    """
    proxies = {
        scheme: url
        for scheme, url in urllib.request.getproxies().items()
        if scheme in ("http", "https")
    }
    handlers: list[urllib.request.BaseHandler] = [
        urllib.request.ProxyHandler(proxies),
        urllib.request.HTTPHandler(),
        _SameOriginRedirectHandler(),
        urllib.request.HTTPErrorProcessor(),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.UnknownHandler(),
    ]
    # The stdlib defines HTTPSHandler only under
    # `hasattr(http.client, "HTTPSConnection")`; referencing it unconditionally
    # would turn an ssl-less interpreter into an ImportError at import time.
    https_handler = getattr(urllib.request, "HTTPSHandler", None)
    if https_handler is not None:
        handlers.insert(2, https_handler())

    opener = urllib.request.OpenerDirector()
    for handler in handlers:
        opener.add_handler(handler)
    return opener


_OPENER = _http_only_opener()


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
            # THE COMMENT THAT USED TO SIT HERE WAS HALF FALSE (#3717). It read
            # "Scheme validated above, so this cannot open a file:/ftp: URL".
            # The `file:` half stands — the stdlib refuses a `file:` REDIRECT
            # target. The `ftp:` half did not: the check above validates only the
            # URL the SDK builds, never the redirect target, and
            # `HTTPRedirectHandler.http_error_302` permits `ftp:`. Per
            # `deploy-integrity.md` R7 a comment must not assert a property the
            # code did not establish.
            #
            # It is now TRUE, and for a stronger reason than the scheme check:
            # `_OPENER` has no ftp/file/data route at all, and
            # `_SameOriginRedirectHandler` refuses ANY redirect off the origin,
            # which closes the plain cross-host `http:` variant the old comment
            # never mentioned and which needs no unusual scheme.
            with _OPENER.open(request, timeout=timeout) as raw:
                return Response(
                    status=int(raw.status),
                    body=raw.read(),
                    headers={k.lower(): v for k, v in raw.headers.items()},
                )
        except CrossOriginRedirectRefused as exc:
            # CAUGHT AHEAD OF THE HTTPError ARM BELOW, deliberately. This is not a
            # response the server sent — it is the transport refusing to send a
            # second request. Returning it as `Response(status=302)` would hand
            # the caller a status to branch on and throw away the reason.
            raise LoomTransportError(str(exc.reason)) from exc
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
