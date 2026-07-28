"""The Loom API client.

:class:`LoomClient` is the hand-written half of the SDK: base-URL resolution,
authentication, request/response encoding and error mapping. Every *route* it
exposes comes from :class:`csa_loom._generated.api._GeneratedOperations`, which
is generated from ``sdk/openapi.json`` — the exact document a deployment serves
at ``GET /api/openapi.json``. That split is the point: routes can never drift
from the contract, and the transport can never drift from the routes.

Authentication (either scheme, matching the API's own security schemes):

* ``token=`` / ``LOOM_API_TOKEN`` — a scoped PAT, sent as
  ``Authorization: Bearer loom_pat_<id>_<secret>``.
* ``session_cookie=`` / ``LOOM_SESSION_COOKIE`` — the encrypted ``loom_session``
  cookie a browser or ``loom auth login`` mints.

The base URL is never hard-coded to a cloud: pass it, or set ``LOOM_BASE_URL``.
The same code therefore targets a Commercial or a Government deployment with no
change (no ``*.azurewebsites.us`` vs ``.com`` branching in the SDK).
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from types import TracebackType
from typing import Any
from urllib.parse import urlencode

from csa_loom._generated.api import _GeneratedOperations
from csa_loom._transport import Response, Transport, UrllibTransport
from csa_loom._version import __version__
from csa_loom.errors import (
    LoomApiError,
    LoomAuthError,
    LoomForbiddenError,
    LoomGateError,
    LoomNotFoundError,
    LoomRateLimitError,
)

__all__ = ["LoomClient"]

DEFAULT_TIMEOUT = 30.0
#: Environment variables the client falls back to, so scripts and CI jobs need
#: no arguments at all.
ENV_BASE_URL = "LOOM_BASE_URL"
ENV_TOKEN = "LOOM_API_TOKEN"  # noqa: S105 - an env var NAME, not a secret
ENV_SESSION = "LOOM_SESSION_COOKIE"


class LoomClient(_GeneratedOperations):
    """A synchronous client for one Loom deployment.

    Args:
        base_url: Origin of the deployment (``https://loom.example.gov``).
            Defaults to ``$LOOM_BASE_URL``.
        token: A scoped API token (``loom_pat_…``). Defaults to ``$LOOM_API_TOKEN``.
        session_cookie: An encrypted ``loom_session`` cookie value. Defaults to
            ``$LOOM_SESSION_COOKIE``. Used only when no token is supplied.
        timeout: Per-request timeout in seconds.
        transport: Any object implementing :class:`csa_loom.Transport`. Injecting
            one is how the test-suite runs the whole generated surface without a
            network.
        user_agent: Overrides the default ``csa-loom/<version>`` user agent.

    Raises:
        ValueError: if no base URL can be resolved.
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        token: str | None = None,
        session_cookie: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Transport | None = None,
        user_agent: str | None = None,
    ) -> None:
        resolved = (base_url or os.environ.get(ENV_BASE_URL) or "").strip()
        if not resolved:
            msg = f"no base URL: pass base_url= or set ${ENV_BASE_URL} (e.g. https://loom.example.com)"
            raise ValueError(msg)
        self.base_url = resolved.rstrip("/")
        self._token = token or os.environ.get(ENV_TOKEN) or None
        self._session_cookie = session_cookie or os.environ.get(ENV_SESSION) or None
        self.timeout = timeout
        self._transport: Transport = transport or UrllibTransport()
        self._user_agent = user_agent or f"csa-loom/{__version__}"

    # -- context manager ----------------------------------------------------
    def __enter__(self) -> LoomClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        return None

    def __repr__(self) -> str:
        auth = "pat" if self._token else ("cookie" if self._session_cookie else "anonymous")
        return f"LoomClient(base_url={self.base_url!r}, auth={auth!r})"

    # -- public helpers -----------------------------------------------------
    def openapi(self) -> Mapping[str, Any]:
        """Fetch this deployment's live ``/api/openapi.json``.

        The route is deliberately unauthenticated (it is public metadata), so
        this works before a token exists. The contract test uses it to verify a
        running deployment still matches the generated client.
        """
        result = self._request("GET", "/api/openapi.json", accept="application/json")
        if not isinstance(result, Mapping):
            msg = "/api/openapi.json did not return a JSON object"
            raise LoomApiError(200, msg, method="GET", path="/api/openapi.json", body=result)
        return result

    # -- transport ----------------------------------------------------------
    def _headers(self, *, content_type: str | None, accept: str | None) -> dict[str, str]:
        headers = {"Accept": accept or "application/json", "User-Agent": self._user_agent}
        if content_type:
            headers["Content-Type"] = content_type
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        elif self._session_cookie:
            headers["Cookie"] = f"loom_session={self._session_cookie}"
        return headers

    def _url(self, path: str, query: Mapping[str, Any] | None) -> str:
        url = f"{self.base_url}{path}"
        if query:
            pairs = [(k, _query_value(v)) for k, v in query.items() if v is not None]
            if pairs:
                url = f"{url}?{urlencode(pairs)}"
        return url

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        content_type: str | None = None,
        accept: str | None = None,
    ) -> Any:
        payload: bytes | None = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            content_type = content_type or "application/json"
        response = self._transport.send(
            method,
            self._url(path, query),
            headers=self._headers(content_type=content_type if payload is not None else None, accept=accept),
            body=payload,
            timeout=self.timeout,
        )
        return self._decode(response, method=method, path=path)

    def _decode(self, response: Response, *, method: str, path: str) -> Any:
        decoded: Any = None
        if response.body:
            try:
                decoded = json.loads(response.body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                decoded = response.body.decode("utf-8", errors="replace")

        if 200 <= response.status < 300:
            return decoded

        raise _to_error(response.status, decoded, response.headers, method=method, path=path)


def _query_value(value: Any) -> str:
    """Encode a query value the way the BFF routes parse them."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _to_error(
    status: int,
    decoded: Any,
    headers: Mapping[str, str],
    *,
    method: str,
    path: str,
) -> LoomApiError:
    """Map a failure response onto the most specific exception available."""
    message = f"HTTP {status}"
    code: str | None = None
    hint: str | None = None
    if isinstance(decoded, Mapping):
        raw_error = decoded.get("error") or decoded.get("detail") or decoded.get("message")
        if isinstance(raw_error, str) and raw_error:
            message = raw_error
        raw_code = decoded.get("code")
        code = raw_code if isinstance(raw_code, str) else None
        raw_hint = decoded.get("hint")
        hint = raw_hint if isinstance(raw_hint, str) else None
    elif isinstance(decoded, str) and decoded.strip():
        message = decoded.strip()[:500]

    kwargs: dict[str, Any] = {
        "code": code,
        "hint": hint,
        "body": decoded,
        "method": method,
        "path": path,
    }
    if status == 401:
        return LoomAuthError(status, message, **kwargs)
    if status == 403:
        return LoomForbiddenError(status, message, **kwargs)
    if status == 404:
        return LoomNotFoundError(status, message, **kwargs)
    if status == 429:
        return LoomRateLimitError(status, message, retry_after=_retry_after(headers), **kwargs)
    if hint:
        # An honest infra gate: the deployment is telling us exactly what to set.
        return LoomGateError(status, message, **kwargs)
    return LoomApiError(status, message, **kwargs)


def _retry_after(headers: Mapping[str, str]) -> float | None:
    raw = headers.get("retry-after")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None
