"""
Token broker — CSA-0020 Phase 3 / ADR-0019.

Wraps MSAL's ``acquire_token_silent`` / ``acquire_token_by_refresh_token``
behind a single async surface that the API reverse-proxy calls per
request. Responsibilities:

* Rehydrate the per-session :class:`SealedTokenCache` from the backend
  before each acquisition, so MSAL has up-to-date account state.
* Attempt silent acquisition first — cache hits avoid a round-trip to
  Entra ID and are the happy path.
* Fall back to the stored refresh token when silent acquisition
  returns ``None`` or an error dict, then re-save the cache.
* Surface :class:`TokenRefreshRequiredError` when no acquisition path
  yields a token, so the proxy can 401 the client with a
  ``reauth_required`` signal for the SPA to restart ``/auth/login``.

Every code path emits structlog events with ``session_id_hash``,
``cache_hit``, ``acquisition_ms``, ``scope`` so cache hit ratios +
refresh-token churn are observable without dumping tokens.
"""

from __future__ import annotations

import hashlib
import time
from typing import TYPE_CHECKING, Any

import structlog
from fastapi import HTTPException, status
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from ..models.auth_bff import AcquiredToken, SessionState
from .token_cache import (
    SealedTokenCache,
    TokenCacheBackend,
    build_sealed_cache,
)

if TYPE_CHECKING:  # pragma: no cover — avoid runtime msal import on SPA mode
    from ..config import Settings


logger = structlog.get_logger(__name__)


# ── Typed errors ────────────────────────────────────────────────────────────


class TokenRefreshRequiredError(HTTPException):
    """Raised when neither silent nor refresh-token acquisition works.

    Surfaces as HTTP 401 with body ``{"error": "reauth_required",
    "reauth_url": "/auth/login?..."}`` so the SPA knows to redirect the
    user through the login flow instead of retrying blindly.
    """

    def __init__(self, *, reauth_url: str, reason: str = "silent+refresh failed") -> None:
        super().__init__(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "reauth_required",
                "reauth_url": reauth_url,
                "reason": reason,
            },
        )


class TransientTokenAcquisitionError(Exception):
    """Raised to force a tenacity retry on transient MSAL failures.

    Separate from :class:`TokenRefreshRequiredError` because we only
    retry transient network errors, not authoritative refusals.
    """


# ── Helpers ─────────────────────────────────────────────────────────────────


def _hash_session_id(session_id: str) -> str:
    """First 16 hex chars of ``sha256(session_id)`` — enough for log
    correlation, short enough to scan in a dashboard, never reversible
    to the original id."""
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]


def _scope_list(scope: str | list[str]) -> list[str]:
    if isinstance(scope, list):
        return [s for s in scope if s]
    return [s for s in scope.split() if s]


# ── Broker ──────────────────────────────────────────────────────────────────


class TokenBroker:
    """MSAL token acquisition with persistent, sealed cache.

    One broker is created per process (lifespan-managed in ``main.py``)
    and shared across every proxied request. MSAL's
    ``ConfidentialClientApplication`` is reused so the authority
    discovery payload and the connection pool are amortised; only the
    per-session :class:`SealedTokenCache` is swapped per call via
    :meth:`_build_app_for_session`.
    """

    def __init__(
        self,
        *,
        settings: Settings,
        backend: TokenCacheBackend,
        reauth_url: str = "/auth/login",
    ) -> None:
        self._settings = settings
        self._backend = backend
        self._reauth_url = reauth_url

    # -- Public surface ----------------------------------------------------

    async def acquire_token(
        self,
        session: SessionState,
        scope: str | list[str],
    ) -> AcquiredToken:
        """Acquire a bearer token for ``session`` + ``scope``.

        Returns :class:`AcquiredToken`. Raises
        :class:`TokenRefreshRequiredError` when re-authentication is
        required. Transient MSAL / network errors are retried via
        tenacity (3 attempts, jittered exponential backoff).
        """
        scopes = _scope_list(scope)
        sid_hash = _hash_session_id(session.session_id)
        started_at = time.monotonic()
        try:
            result, cache_hit = await self._acquire_with_retry(
                session=session, scopes=scopes,
            )
        except TokenRefreshRequiredError:
            # Re-raise — the proxy surfaces these directly to the SPA.
            raise
        except Exception as exc:  # log + reclassify into reauth_required
            logger.warning(
                "bff.token_broker.unexpected_error",
                session_id_hash=sid_hash,
                scope=" ".join(scopes),
                error_class=type(exc).__name__,
            )
            raise TokenRefreshRequiredError(
                reauth_url=self._reauth_url,
                reason=f"unexpected: {type(exc).__name__}",
            ) from exc

        elapsed_ms = (time.monotonic() - started_at) * 1000.0
        from datetime import datetime, timedelta, timezone

        expires_on = datetime.now(timezone.utc) + timedelta(
            seconds=int(result.get("expires_in", 3600)),
        )
        logger.info(
            "bff.token_broker.acquired",
            session_id_hash=sid_hash,
            scope=" ".join(scopes),
            cache_hit=cache_hit,
            acquisition_ms=round(elapsed_ms, 2),
        )
        return AcquiredToken(
            access_token=str(result["access_token"]),
            token_type="Bearer",
            expires_on=expires_on,
            cache_hit=cache_hit,
            acquisition_ms=round(elapsed_ms, 2),
        )

    # -- Internals ---------------------------------------------------------

    async def _acquire_with_retry(
        self,
        *,
        session: SessionState,
        scopes: list[str],
    ) -> tuple[dict[str, Any], bool]:
        """Run the silent → refresh fallback with tenacity-managed
        retries on transient failures.

        Returns ``(result_dict, cache_hit)``. ``cache_hit`` is True when
        ``acquire_token_silent`` returned a usable token before the
        refresh-token fallback ran.
        """

        @retry(
            stop=stop_after_attempt(3),
            wait=wait_exponential_jitter(initial=0.2, max=2.0),
            retry=retry_if_exception_type(TransientTokenAcquisitionError),
            reraise=True,
        )
        async def _attempt() -> tuple[dict[str, Any], bool]:
            return await self._acquire_once(session=session, scopes=scopes)

        return await _attempt()

    async def _acquire_once(
        self,
        *,
        session: SessionState,
        scopes: list[str],
    ) -> tuple[dict[str, Any], bool]:
        """Single attempt: silent → refresh-token fallback."""
        cache = await self._load_cache(session.session_id)
        msal_app = self._build_app_for_session(cache=cache)

        # -- Silent first ------------------------------------------------
        accounts = msal_app.get_accounts(username=session.email or None)
        account = accounts[0] if accounts else None
        silent_result = msal_app.acquire_token_silent(scopes=scopes, account=account)
        if isinstance(silent_result, dict) and "access_token" in silent_result:
            await self._persist_cache(cache)
            logger.debug(
                "bff.token_cache.hit",
                session_id_hash=_hash_session_id(session.session_id),
            )
            return silent_result, True

        logger.debug(
            "bff.token_cache.miss",
            session_id_hash=_hash_session_id(session.session_id),
        )

        # -- Refresh-token fallback --------------------------------------
        if not session.refresh_token:
            raise TokenRefreshRequiredError(
                reauth_url=self._reauth_url,
                reason="no_refresh_token_on_session",
            )

        try:
            refreshed = msal_app.acquire_token_by_refresh_token(
                refresh_token=session.refresh_token,
                scopes=scopes,
            )
        except AttributeError as exc:  # pragma: no cover — msal version guard
            raise TokenRefreshRequiredError(
                reauth_url=self._reauth_url,
                reason="msal_refresh_api_missing",
            ) from exc
        except Exception as exc:
            # Unknown shape — assume transient and let tenacity retry.
            raise TransientTokenAcquisitionError(
                f"acquire_token_by_refresh_token raised: {type(exc).__name__}",
            ) from exc

        if not isinstance(refreshed, dict) or "access_token" not in refreshed:
            err = (
                refreshed.get("error_description")
                if isinstance(refreshed, dict)
                else "unknown"
            )
            raise TokenRefreshRequiredError(
                reauth_url=self._reauth_url,
                reason=f"refresh_failed: {err}",
            )

        await self._persist_cache(cache)
        logger.info(
            "bff.token_cache.refreshed",
            session_id_hash=_hash_session_id(session.session_id),
        )
        return refreshed, False

    async def _load_cache(self, session_id: str) -> SealedTokenCache:
        cache = build_sealed_cache(
            backend=self._backend,
            settings=self._settings,
            session_id=session_id,
        )
        await cache.async_load()
        return cache

    async def _persist_cache(self, cache: SealedTokenCache) -> None:
        await cache.async_save()

    def _build_app_for_session(self, *, cache: SealedTokenCache) -> Any:
        """Build a per-session :class:`msal.ConfidentialClientApplication`.

        MSAL binds the cache at construction, so we build a fresh
        instance per request. This is cheap because MSAL caches the
        authority discovery metadata at the class level, not the
        instance level.
        """
        try:
            import msal
        except ImportError as exc:  # pragma: no cover — guarded by AUTH_MODE
            msg = (
                "TokenBroker requires the optional 'msal' dep. Install "
                "with `pip install msal>=1.28` or flip BFF_PROXY_ENABLED=false."
            )
            raise RuntimeError(msg) from exc

        cfg = self._settings
        authority = (
            f"https://login.microsoftonline.us/{cfg.BFF_TENANT_ID}"
            if cfg.IS_GOVERNMENT_CLOUD
            else f"https://login.microsoftonline.com/{cfg.BFF_TENANT_ID}"
        )
        return msal.ConfidentialClientApplication(
            client_id=cfg.BFF_CLIENT_ID,
            client_credential=cfg.BFF_CLIENT_SECRET,
            authority=authority,
            token_cache=cache,
        )


__all__ = [
    "TokenBroker",
    "TokenRefreshRequiredError",
    "TransientTokenAcquisitionError",
]
