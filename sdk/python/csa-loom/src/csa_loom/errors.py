"""Exception hierarchy for the Loom SDK.

Every failure the API can return is surfaced as a typed exception rather than a
``None`` or an empty list — the SDK equivalent of the console's no-vaporware
rule: a caller must never mistake "the backend refused" for "there is no data".

The API's failure envelope is ``{ok: false, error, code?, hint?}``. ``hint`` is
how Loom reports an *honest infra gate* (for example "AI Search not provisioned
in this deployment; set LOOM_AI_SEARCH_SERVICE"), so it is preserved verbatim on
:class:`LoomApiError` and re-raised as :class:`LoomGateError` when present.
"""

from __future__ import annotations

__all__ = [
    "LoomApiError",
    "LoomAuthError",
    "LoomError",
    "LoomForbiddenError",
    "LoomGateError",
    "LoomNotFoundError",
    "LoomRateLimitError",
    "LoomTransportError",
]


class LoomError(Exception):
    """Base class for every error raised by this SDK."""


class LoomTransportError(LoomError):
    """The request never produced an HTTP response (DNS, TLS, timeout, reset)."""


class LoomApiError(LoomError):
    """The API returned a non-2xx status.

    Attributes:
        status: The HTTP status code.
        message: The ``error`` field of the Loom envelope, or the raw body.
        code: The stable machine-readable ``code``, when the route emits one.
        hint: The remediation ``hint`` for an honest infra gate, when present.
        body: The decoded response body (``dict`` when the body was JSON).
        method: The HTTP verb of the failed request.
        path: The request path of the failed request.
    """

    def __init__(
        self,
        status: int,
        message: str,
        *,
        code: str | None = None,
        hint: str | None = None,
        body: object = None,
        method: str = "",
        path: str = "",
    ) -> None:
        detail = f"{method} {path} -> {status}: {message}" if method else f"{status}: {message}"
        if code:
            detail = f"{detail} [{code}]"
        if hint:
            detail = f"{detail}\n  hint: {hint}"
        super().__init__(detail)
        self.status = status
        self.message = message
        self.code = code
        self.hint = hint
        self.body = body
        self.method = method
        self.path = path


class LoomAuthError(LoomApiError):
    """401 — no usable credential (send a PAT or a session cookie)."""


class LoomForbiddenError(LoomApiError):
    """403 — the credential is valid but its scope or tenant does not allow this."""


class LoomNotFoundError(LoomApiError):
    """404 — the workspace, item or token does not exist (or is not visible)."""


class LoomRateLimitError(LoomApiError):
    """429 — throttled. ``retry_after`` carries the server's hint, in seconds."""

    def __init__(
        self,
        status: int,
        message: str,
        *,
        code: str | None = None,
        hint: str | None = None,
        body: object = None,
        method: str = "",
        path: str = "",
        retry_after: float | None = None,
    ) -> None:
        super().__init__(status, message, code=code, hint=hint, body=body, method=method, path=path)
        self.retry_after = retry_after


class LoomGateError(LoomApiError):
    """The deployment answered with an honest infra gate — ``hint`` names the fix.

    Raised instead of the plain :class:`LoomApiError` whenever the failure
    envelope carries a ``hint``, so automation can branch on "this deployment is
    missing a configuration" versus "this request was wrong".
    """
