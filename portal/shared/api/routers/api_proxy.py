"""
BFF reverse-proxy — CSA-0020 Phase 3 / ADR-0019.

Mounted under ``/api/*`` when ``AUTH_MODE=bff`` AND ``BFF_PROXY_ENABLED=true``.
The SPA calls ``/api/...`` with just its ``csa_sid`` cookie; this
router:

1. Resolves the cookie → :class:`SessionState` via the shared session
   store (401 on miss/expired).
2. Acquires a bearer token for the upstream API via
   :class:`~portal.shared.api.services.token_broker.TokenBroker`
   (401 with ``reauth_required`` when the refresh token is exhausted).
3. Forwards the request — method, path, query, body, allowed headers —
   to ``settings.BFF_UPSTREAM_API_ORIGIN`` using a module-level
   ``httpx.AsyncClient`` singleton with an attached retry policy on
   502/503/504.
4. Streams the upstream response back to the browser minus any
   ``Set-Cookie`` (cookies on the BFF origin are BFF-managed only) and
   minus hop-by-hop headers (``connection``, ``keep-alive``, etc.).

Every request emits a structured ``bff.proxy.request`` log event with
``session_id_hash``, ``method``, ``path``, ``upstream_status``,
``upstream_ms``, ``cache_hit`` — no raw session id, no token body.
"""

from __future__ import annotations

import time
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from itsdangerous import URLSafeTimedSerializer
from tenacity import (
    AsyncRetrying,
    RetryError,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential_jitter,
)

from ..config import Settings
from ..models.auth_bff import SessionState
from ..services.session_store import SessionStore
from ..services.token_broker import TokenBroker, TokenRefreshRequiredError
from .auth_bff import (
    _resolve_session,  # re-use cookie → session resolver
    get_session_serializer,
    get_session_store,
    get_settings,
)

logger = structlog.get_logger(__name__)


router = APIRouter(tags=["BFF Proxy"])


# ── Hop-by-hop header filter ────────────────────────────────────────────────
# RFC 7230 §6.1 — these headers are connection-specific and MUST NOT be
# forwarded by proxies. Additionally ``cookie`` is filtered because the
# BFF session cookie is for BFF auth only; the upstream's notion of
# cookies is managed server-side via the Authorization header we attach.

_HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        # Scrubbed for defence in depth:
        "cookie",
        "host",  # httpx re-populates from the URL
        "content-length",  # httpx/starlette re-populate
    },
)

# Upstream-response headers we strip before passing back to the browser.
_UPSTREAM_STRIP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        # Cookies on the BFF origin are BFF-managed only. Upstream apps
        # sometimes set their own session cookies; those would collide
        # with ``csa_sid`` or worse, persist without the signed-cookie
        # guarantees the BFF provides.
        "set-cookie",
        # Let Starlette compute on the way out — re-sending the upstream
        # value risks mismatch after header mutation.
        "content-length",
    },
)


# ── Dependency injection surfaces ───────────────────────────────────────────


class ProxyResources:
    """Container for the lifespan-managed httpx client + token broker.

    Kept as a plain object (not a Pydantic model) so the async client
    and broker references are mutable — the lifespan hook attaches them
    once and the dependency below just hands them out.
    """

    def __init__(self) -> None:
        self.client: httpx.AsyncClient | None = None
        self.broker: TokenBroker | None = None

    def configure(self, *, client: httpx.AsyncClient, broker: TokenBroker) -> None:
        self.client = client
        self.broker = broker

    async def aclose(self) -> None:
        if self.client is not None:
            await self.client.aclose()
            self.client = None
        self.broker = None


_resources = ProxyResources()


def get_proxy_resources() -> ProxyResources:
    """FastAPI dependency — returns the process-wide proxy resources.

    The ``api_proxy`` router mount in :mod:`portal.shared.api.main` is
    gated on ``BFF_PROXY_ENABLED=true``, so ``client`` / ``broker`` are
    guaranteed non-None at request time. Tests override this dependency
    to inject fakes.
    """
    return _resources


# ── Session resolution (shared with auth_bff.get_bff_session) ──────────────
# Duplicated with a proxy-specific error body so the SPA receives a
# ``reauth_required`` hint consistently for both session-miss and
# token-refresh-exhausted cases.


async def _require_session(
    request: Request,
    cfg: Settings,
    serializer: URLSafeTimedSerializer,
    store: SessionStore,
) -> SessionState:
    raw = request.cookies.get(cfg.BFF_COOKIE_NAME)
    session = await _resolve_session(
        raw, serializer, store, cfg.BFF_SESSION_TTL_SECONDS,
    )
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "reauth_required",
                "reauth_url": "/auth/login",
                "reason": "no_active_session",
            },
        )
    return session


# ── Upstream forwarding ─────────────────────────────────────────────────────


def _build_upstream_url(
    origin: str, path: str, query_string: str,
) -> str:
    base = origin.rstrip("/")
    # FastAPI strips the leading slash on path parameters inside
    # ``api_route`` captures; normalise so ``/api/health`` and
    # ``api/health`` both land correctly.
    if not path.startswith("/"):
        path = "/" + path
    url = f"{base}/api{path}"
    if query_string:
        url = f"{url}?{query_string}"
    return url


def _forwarded_request_headers(src: httpx.Headers | Any) -> dict[str, str]:
    """Return a cleaned copy of ``src`` with hop-by-hop headers removed.

    Accepts either an ``httpx.Headers`` instance or the Starlette
    headers mapping (both expose ``.items()``).
    """
    return {
        k: v
        for k, v in src.items()
        if k.lower() not in _HOP_BY_HOP_HEADERS and not k.lower().startswith("x-csa-")
    }


def _scrubbed_response_headers(src: httpx.Headers) -> dict[str, str]:
    return {
        k: v for k, v in src.items() if k.lower() not in _UPSTREAM_STRIP_HEADERS
    }


def _is_retryable(exc: BaseException) -> bool:
    """Tenacity predicate — retry on transient 5xx or network errors.

    ``UpstreamRetryableError`` is raised below on 502/503/504. Actual
    network-level failures bubble up from httpx as
    :class:`httpx.TransportError` subclasses — retry those too.
    """
    if isinstance(exc, UpstreamRetryableError):
        return True
    return isinstance(exc, httpx.TransportError)


class UpstreamRetryableError(Exception):
    """Raised when the upstream returns 502/503/504 — drives tenacity."""

    def __init__(self, *, status_code: int, body: bytes) -> None:
        super().__init__(f"upstream returned {status_code}")
        self.status_code = status_code
        self.body = body


class UpstreamUnavailableError(HTTPException):
    """Surfaced to the SPA as 504 after retry exhaustion.

    Kept as an HTTPException subclass so FastAPI renders it cleanly.
    """

    def __init__(self, *, reason: str = "upstream_unavailable") -> None:
        super().__init__(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={"error": reason},
        )


# ── Main proxy handler ──────────────────────────────────────────────────────


@router.api_route(
    "/api/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    include_in_schema=False,
)
async def proxy_request(
    path: str,
    request: Request,
    cfg: Settings = Depends(get_settings),
    serializer: URLSafeTimedSerializer = Depends(get_session_serializer),
    store: SessionStore = Depends(get_session_store),
    resources: ProxyResources = Depends(get_proxy_resources),
) -> Response:
    """Reverse-proxy handler for ``/api/*``.

    Auth → token → forward → stream back. See module docstring for the
    contract.
    """
    session = await _require_session(request, cfg, serializer, store)
    sid_hash = _hash_session_id(session.session_id)

    assert resources.broker is not None, "proxy resources not initialised"
    assert resources.client is not None, "proxy resources not initialised"

    # -- Token acquisition -----------------------------------------------
    try:
        token = await resources.broker.acquire_token(
            session=session, scope=cfg.BFF_UPSTREAM_API_SCOPE,
        )
    except TokenRefreshRequiredError:
        raise
    logger.debug(
        "bff.proxy.token_acquired",
        session_id_hash=sid_hash,
        cache_hit=token.cache_hit,
        acquisition_ms=token.acquisition_ms,
    )

    # -- Build upstream request ------------------------------------------
    upstream_url = _build_upstream_url(
        str(cfg.BFF_UPSTREAM_API_ORIGIN), path, request.url.query,
    )
    forward_headers = _forwarded_request_headers(request.headers)
    forward_headers["authorization"] = f"{token.token_type} {token.access_token}"
    body = await request.body()

    # -- Dispatch with retry ---------------------------------------------
    started_at = time.monotonic()
    try:
        upstream_response = await _forward_with_retry(
            client=resources.client,
            method=request.method,
            url=upstream_url,
            headers=forward_headers,
            body=body,
            timeout=cfg.BFF_UPSTREAM_API_TIMEOUT_SECONDS,
        )
    except UpstreamUnavailableError:
        logger.warning(
            "bff.proxy.upstream_error",
            session_id_hash=sid_hash,
            method=request.method,
            path=path,
            upstream_status=None,
            upstream_ms=round((time.monotonic() - started_at) * 1000.0, 2),
            reason="retry_exhausted",
        )
        raise
    except httpx.TimeoutException as exc:
        logger.warning(
            "bff.proxy.upstream_error",
            session_id_hash=sid_hash,
            method=request.method,
            path=path,
            upstream_status=None,
            upstream_ms=round((time.monotonic() - started_at) * 1000.0, 2),
            reason="timeout",
        )
        raise UpstreamUnavailableError(reason="upstream_timeout") from exc

    elapsed_ms = round((time.monotonic() - started_at) * 1000.0, 2)
    logger.info(
        "bff.proxy.request",
        session_id_hash=sid_hash,
        method=request.method,
        path=path,
        upstream_status=upstream_response.status_code,
        upstream_ms=elapsed_ms,
        cache_hit=token.cache_hit,
    )

    # -- Stream the response back ----------------------------------------
    headers = _scrubbed_response_headers(upstream_response.headers)
    media_type = upstream_response.headers.get("content-type")

    async def _iter_body() -> Any:
        try:
            # ``aiter_raw`` preserves compression; we already stripped
            # the transfer-encoding header so Starlette recomputes it.
            async for chunk in upstream_response.aiter_raw():
                yield chunk
        except httpx.StreamConsumed:
            # ``httpx.MockTransport`` and some real transports fully
            # buffer the body before returning the ``Response``; in
            # those cases ``.content`` is already populated and
            # ``aiter_raw`` refuses a second read. Fall back to the
            # buffered content.
            yield upstream_response.content
        finally:
            await upstream_response.aclose()

    return StreamingResponse(
        _iter_body(),
        status_code=upstream_response.status_code,
        headers=headers,
        media_type=media_type,
    )


async def _forward_with_retry(
    *,
    client: httpx.AsyncClient,
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes,
    timeout: int,
) -> httpx.Response:
    """Forward the request with tenacity retry on transient failures.

    Non-retryable responses (including 4xx, 200-499 generally) return
    immediately. 5xx retryable statuses (502/503/504) raise
    :class:`UpstreamRetryableError` which tenacity catches and retries.
    All other statuses — including 5xx non-retryables (500, 501, 505+)
    — return unchanged for the handler to stream back. After three
    attempts, :class:`UpstreamUnavailableError` is raised so FastAPI
    renders a clean 504.
    """
    try:
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential_jitter(initial=0.2, max=1.5),
            retry=retry_if_exception(_is_retryable),
            reraise=True,
        ):
            with attempt:
                # Use ``build_request`` + ``send`` so we can attach a
                # per-call timeout without mutating the shared client's
                # default timeout.  ``httpx.AsyncClient.send`` doesn't
                # accept a timeout kwarg directly — we set it on the
                # request's extensions dict which httpx propagates to
                # the transport.
                upstream_request = client.build_request(
                    method=method,
                    url=url,
                    headers=headers,
                    content=body if body else None,
                    timeout=httpx.Timeout(timeout),
                )
                response = await client.send(upstream_request, stream=True)
                if response.status_code in (502, 503, 504):
                    # Drain the body so the connection can be reused and
                    # so the retry loop has the bytes on hand if it's
                    # the final attempt.
                    retry_body = await response.aread()
                    await response.aclose()
                    raise UpstreamRetryableError(
                        status_code=response.status_code, body=retry_body,
                    )
                return response
    except RetryError as exc:
        raise UpstreamUnavailableError(reason="retry_exhausted") from exc
    except UpstreamRetryableError as exc:
        # tenacity reraised the last exception after exhausting attempts.
        # Convert to an HTTP 504 for the SPA — the upstream was up but
        # unhealthy for the duration of this request.
        raise UpstreamUnavailableError(reason="retry_exhausted") from exc
    # pragma: no cover — ``reraise=True`` + ``stop_after_attempt`` means
    # we always either return inside the loop or raise; this line is
    # only reached if tenacity's contract changes.
    raise UpstreamUnavailableError(reason="retry_exhausted")  # pragma: no cover


def _hash_session_id(session_id: str) -> str:
    import hashlib as _hashlib

    return _hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]


__all__ = [
    "ProxyResources",
    "UpstreamRetryableError",
    "UpstreamUnavailableError",
    "get_proxy_resources",
    "router",
]
