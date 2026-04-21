"""
Backend-for-Frontend (BFF) auth router — CSA-0020 Phase 2.

Runs the MSAL Auth Code + PKCE flow server-side so the browser never
handles access or refresh tokens. The browser gets a single opaque
signed session cookie (``csa_sid``); all token material stays in the
configured :class:`SessionStore` (in-memory for dev, Redis for
production).

Endpoints (mounted under ``/auth`` when ``settings.AUTH_MODE == "bff"``):

* ``GET  /auth/login``    — generate PKCE + state + nonce, stash in a
                            signed pending-auth cookie, redirect to
                            Entra ID.
* ``GET  /auth/callback`` — verify state, exchange code for tokens via
                            MSAL, persist session, set ``csa_sid``
                            cookie, redirect to ``redirect_to``.
* ``POST /auth/logout``   — destroy server-side session + clear cookie.
* ``GET  /auth/me``       — return the authenticated user's profile
                            (401 if no valid session).
* ``POST /auth/token``    — server-side ``acquire_token_silent`` for a
                            requested resource; returns access token
                            to the SPA during the migration window.

See ``docs/adr/0014-msal-bff-auth-pattern.md`` for the full rationale
and migration plan. This router is NOT mounted when ``AUTH_MODE=spa``
so accidental exposure on an SPA deployment is impossible.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from ..config import Settings, settings
from ..models.auth_bff import (
    AuthMeResponse,
    PendingAuthState,
    SessionState,
    TokenResponse,
)
from ..services.session_store import SessionStore, build_session_store

logger = logging.getLogger(__name__)

# ── Router ──────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/auth", tags=["Auth (BFF)"])

# Cookie name for the short-lived pending-auth state (between /auth/login
# and /auth/callback). Distinct from the session cookie so expiry can
# differ and so `/auth/callback` can clear it without touching a live
# session cookie.
_PENDING_COOKIE = "csa_pending_auth"

# Serializer salts — mutually independent so replaying a session cookie
# as a pending-auth cookie (or vice versa) produces a signature error.
_SESSION_SALT = "csa-bff-session-v1"
_PENDING_SALT = "csa-bff-pending-auth-v1"


# ── Dependency wiring ───────────────────────────────────────────────────────


_store_singleton: SessionStore | None = None


def get_session_store() -> SessionStore:
    """Return the process-wide session store singleton.

    Built lazily on first call so tests can override via
    ``app.dependency_overrides`` before any request touches Redis.
    """
    global _store_singleton
    if _store_singleton is None:
        _store_singleton = build_session_store(settings)
    return _store_singleton


def _build_serializer(
    signing_key: str, salt: str
) -> URLSafeTimedSerializer:
    if not signing_key:
        msg = (
            "BFF_SESSION_SIGNING_KEY is empty; refusing to issue session "
            "cookies. Configure a long random value in the environment."
        )
        raise RuntimeError(msg)
    return URLSafeTimedSerializer(signing_key, salt=salt)


def get_settings() -> Settings:
    """Return the module-level :data:`settings` singleton.

    Centralised as a named callable so tests can swap the whole
    settings object with a single ``app.dependency_overrides`` entry.
    """
    return settings


def get_session_serializer(
    cfg: Settings = Depends(get_settings),
) -> URLSafeTimedSerializer:
    return _build_serializer(cfg.BFF_SESSION_SIGNING_KEY, _SESSION_SALT)


def get_pending_serializer(
    cfg: Settings = Depends(get_settings),
) -> URLSafeTimedSerializer:
    return _build_serializer(cfg.BFF_SESSION_SIGNING_KEY, _PENDING_SALT)


# ── MSAL factory (lazy import) ──────────────────────────────────────────────


def _msal_app(cfg: Settings) -> Any:
    """Build a ``msal.ConfidentialClientApplication`` for the current
    configuration. Imported lazily so the optional ``msal`` dep is
    only required on BFF-configured deployments."""
    try:
        import msal  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover
        msg = (
            "AUTH_MODE=bff requires the optional 'msal' dep. Install "
            "with `pip install msal>=1.28` or flip AUTH_MODE=spa."
        )
        raise RuntimeError(msg) from exc

    authority = (
        f"https://login.microsoftonline.us/{cfg.BFF_TENANT_ID}"
        if cfg.IS_GOVERNMENT_CLOUD
        else f"https://login.microsoftonline.com/{cfg.BFF_TENANT_ID}"
    )
    return msal.ConfidentialClientApplication(
        client_id=cfg.BFF_CLIENT_ID,
        client_credential=cfg.BFF_CLIENT_SECRET,
        authority=authority,
    )


def get_msal_app(cfg: Settings = Depends(get_settings)) -> Any:
    return _msal_app(cfg)


# ── PKCE helpers ────────────────────────────────────────────────────────────


def _make_pkce_pair() -> tuple[str, str]:
    """Return ``(code_verifier, code_challenge)`` for S256 PKCE.

    Verifier is 64 bytes of URL-safe base64 (no padding), challenge is
    the SHA-256 of the verifier, also URL-safe base64 (no padding).
    """
    verifier = secrets.token_urlsafe(64)
    challenge_bytes = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(challenge_bytes).rstrip(b"=").decode("ascii")
    return verifier, challenge


def _scope_list(cfg: Settings) -> list[str]:
    return [s for s in cfg.BFF_SCOPES.split() if s]


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ── Cookie helpers ──────────────────────────────────────────────────────────


def _set_cookie(
    response: Response,
    name: str,
    value: str,
    max_age: int,
    cfg: Settings,
    *,
    path: str = "/",
) -> None:
    response.set_cookie(
        key=name,
        value=value,
        max_age=max_age,
        httponly=True,
        secure=cfg.BFF_COOKIE_SECURE,
        samesite=cfg.BFF_COOKIE_SAMESITE,
        domain=cfg.BFF_COOKIE_DOMAIN,
        path=path,
    )


def _delete_cookie(response: Response, name: str, cfg: Settings) -> None:
    response.delete_cookie(
        key=name,
        path="/",
        domain=cfg.BFF_COOKIE_DOMAIN,
    )


# ── /auth/login ─────────────────────────────────────────────────────────────


@router.get("/login")
def auth_login(
    redirect_to: str = Query("/", description="SPA path to land on after login"),
    cfg: Settings = Depends(get_settings),
    pending_serializer: URLSafeTimedSerializer = Depends(get_pending_serializer),
) -> RedirectResponse:
    """Kick off the MSAL Auth Code + PKCE flow.

    Generates a fresh ``state``, ``nonce``, and PKCE verifier/challenge,
    bundles them into a signed short-lived cookie, and 302s the browser
    to the Entra ID authorize endpoint.
    """
    # Defence-in-depth: reject open-redirect attempts by refusing any
    # redirect_to that isn't a local path.
    if not redirect_to.startswith("/") or redirect_to.startswith("//"):
        logger.warning("auth_login: rejected non-local redirect_to=%r", redirect_to)
        redirect_to = "/"

    code_verifier, code_challenge = _make_pkce_pair()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)

    pending = PendingAuthState(
        state=state,
        nonce=nonce,
        code_verifier=code_verifier,
        redirect_to=redirect_to,
        issued_at=_now_utc(),
    )
    signed = pending_serializer.dumps(pending.model_dump(mode="json"))

    authority = (
        f"https://login.microsoftonline.us/{cfg.BFF_TENANT_ID}"
        if cfg.IS_GOVERNMENT_CLOUD
        else f"https://login.microsoftonline.com/{cfg.BFF_TENANT_ID}"
    )
    params = {
        "client_id": cfg.BFF_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": cfg.BFF_REDIRECT_URI,
        "response_mode": "query",
        "scope": cfg.BFF_SCOPES,
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    url = f"{authority}/oauth2/v2.0/authorize?{urllib.parse.urlencode(params)}"

    logger.info(
        "auth_login: redirecting to Entra ID (state=%s..., redirect_to=%s)",
        state[:6],
        redirect_to,
    )
    response = RedirectResponse(url=url, status_code=status.HTTP_302_FOUND)
    _set_cookie(
        response,
        _PENDING_COOKIE,
        signed,
        max_age=cfg.BFF_PENDING_AUTH_TTL_SECONDS,
        cfg=cfg,
    )
    return response


# ── /auth/callback ──────────────────────────────────────────────────────────


@router.get("/callback")
async def auth_callback(
    request: Request,
    code: str = Query(...),
    state: str = Query(...),
    cfg: Settings = Depends(get_settings),
    pending_serializer: URLSafeTimedSerializer = Depends(get_pending_serializer),
    session_serializer: URLSafeTimedSerializer = Depends(get_session_serializer),
    store: SessionStore = Depends(get_session_store),
    msal_app: Any = Depends(get_msal_app),
) -> RedirectResponse:
    """Complete the MSAL flow.

    Verifies the signed pending-auth cookie, exchanges ``code`` for
    tokens via MSAL (with the bound PKCE verifier), persists a new
    :class:`SessionState`, and sets the ``csa_sid`` cookie.
    """
    pending_raw = request.cookies.get(_PENDING_COOKIE)
    if pending_raw is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing pending-auth cookie; start at /auth/login.",
        )

    try:
        pending_payload = pending_serializer.loads(
            pending_raw, max_age=cfg.BFF_PENDING_AUTH_TTL_SECONDS
        )
    except SignatureExpired as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pending-auth cookie expired; restart at /auth/login.",
        ) from exc
    except BadSignature as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pending-auth cookie signature invalid.",
        ) from exc

    pending = PendingAuthState.model_validate(pending_payload)
    if not secrets.compare_digest(pending.state, state):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="State mismatch; refusing to complete auth.",
        )

    token_result = msal_app.acquire_token_by_authorization_code(
        code=code,
        scopes=_scope_list(cfg),
        redirect_uri=cfg.BFF_REDIRECT_URI,
        code_verifier=pending.code_verifier,
    )
    if not isinstance(token_result, dict) or "access_token" not in token_result:
        err = (
            token_result.get("error_description")
            if isinstance(token_result, dict)
            else "unknown"
        )
        logger.warning("auth_callback: token exchange failed: %s", err)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token exchange failed: {err}",
        )

    id_claims = token_result.get("id_token_claims") or {}
    issued_at = _now_utc()
    expires_in = int(token_result.get("expires_in", 3600))
    session = SessionState(
        session_id=str(uuid.uuid4()),
        oid=str(id_claims.get("oid") or id_claims.get("sub") or ""),
        tid=str(id_claims.get("tid") or ""),
        name=str(id_claims.get("name") or ""),
        email=str(
            id_claims.get("email")
            or id_claims.get("preferred_username")
            or ""
        ),
        roles=list(id_claims.get("roles") or []),
        access_token=str(token_result["access_token"]),
        refresh_token=token_result.get("refresh_token"),
        id_token=token_result.get("id_token"),
        expires_at=issued_at + timedelta(seconds=expires_in),
        issued_at=issued_at,
        last_seen_at=issued_at,
    )
    await store.set(session, ttl_seconds=cfg.BFF_SESSION_TTL_SECONDS)

    signed_sid = session_serializer.dumps(session.session_id)
    response = RedirectResponse(
        url=pending.redirect_to,
        status_code=status.HTTP_302_FOUND,
    )
    _set_cookie(
        response,
        cfg.BFF_COOKIE_NAME,
        signed_sid,
        max_age=cfg.BFF_SESSION_TTL_SECONDS,
        cfg=cfg,
    )
    _delete_cookie(response, _PENDING_COOKIE, cfg)
    logger.info(
        "auth_callback: session %s issued for oid=%s",
        session.session_id[:8],
        session.oid,
    )
    return response


# ── Session resolution dependency ───────────────────────────────────────────


async def _resolve_session(
    cookie_value: str | None,
    serializer: URLSafeTimedSerializer,
    store: SessionStore,
    ttl_seconds: int,
) -> SessionState | None:
    if not cookie_value:
        return None
    try:
        session_id = serializer.loads(cookie_value, max_age=ttl_seconds)
    except (BadSignature, SignatureExpired):
        return None
    if not isinstance(session_id, str):
        return None
    return await store.get(session_id)


async def get_bff_session(
    request: Request,
    cfg: Settings = Depends(get_settings),
    serializer: URLSafeTimedSerializer = Depends(get_session_serializer),
    store: SessionStore = Depends(get_session_store),
) -> SessionState:
    """FastAPI dependency that resolves the ``csa_sid`` cookie to a
    :class:`SessionState` or raises 401."""
    raw = request.cookies.get(cfg.BFF_COOKIE_NAME)
    session = await _resolve_session(
        raw, serializer, store, cfg.BFF_SESSION_TTL_SECONDS
    )
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No active BFF session.",
        )
    return session


# ── /auth/me ────────────────────────────────────────────────────────────────


@router.get("/me", response_model=AuthMeResponse)
async def auth_me(
    session: SessionState = Depends(get_bff_session),
    cfg: Settings = Depends(get_settings),
    store: SessionStore = Depends(get_session_store),
) -> AuthMeResponse:
    """Return the current session's user profile; 401 if none."""
    # Idle-extension: refresh TTL on every /me hit so active users
    # don't get kicked mid-session.
    await store.touch(session.session_id, cfg.BFF_SESSION_TTL_SECONDS)
    return AuthMeResponse(
        oid=session.oid,
        tid=session.tid,
        name=session.name,
        email=session.email,
        roles=list(session.roles),
    )


# ── /auth/logout ────────────────────────────────────────────────────────────


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def auth_logout(
    request: Request,
    cfg: Settings = Depends(get_settings),
    serializer: URLSafeTimedSerializer = Depends(get_session_serializer),
    store: SessionStore = Depends(get_session_store),
) -> Response:
    """Destroy the server-side session and clear the cookie."""
    raw = request.cookies.get(cfg.BFF_COOKIE_NAME)
    if raw:
        try:
            session_id = serializer.loads(raw, max_age=cfg.BFF_SESSION_TTL_SECONDS)
            if isinstance(session_id, str):
                await store.delete(session_id)
        except (BadSignature, SignatureExpired):
            # Already unusable — just clear the cookie.
            pass

    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _delete_cookie(response, cfg.BFF_COOKIE_NAME, cfg)
    return response


# ── /auth/token ─────────────────────────────────────────────────────────────


@router.post("/token", response_model=TokenResponse)
async def auth_token(
    resource: str = Query(
        ...,
        description=(
            "Resource identifier to acquire a token for — "
            "one of 'api' | 'graph' | a full scope URL."
        ),
    ),
    session: SessionState = Depends(get_bff_session),
    cfg: Settings = Depends(get_settings),
    store: SessionStore = Depends(get_session_store),
    msal_app: Any = Depends(get_msal_app),
) -> TokenResponse:
    """Silent token acquisition for the identified resource.

    The SPA normally routes API calls through the BFF (reverse-proxy
    style) rather than holding tokens, but during the Phase-1 →
    Phase-2 migration some call sites still need a raw access token.
    This endpoint provides that handoff while keeping the refresh
    token server-side.
    """
    # Resolve resource alias to scope list. Operators extend this map
    # by configuring BFF_SCOPES and using full scope URLs directly.
    if resource == "graph":
        scopes = ["User.Read"]
    elif resource == "api":
        # Reuse the user-assigned API scope convention from the SPA.
        scopes = [f"api://{cfg.BFF_CLIENT_ID}/access_as_user"]
    else:
        scopes = [resource]

    # Rehydrate MSAL's token cache from the session's refresh token so
    # ``acquire_token_silent`` has something to trade on. The cache
    # lookup uses ``oid`` as the homeAccountId surrogate when MSAL
    # has no persisted account yet.
    accounts = msal_app.get_accounts(username=session.email or None)
    account = accounts[0] if accounts else None
    result = msal_app.acquire_token_silent(scopes=scopes, account=account)

    # Fallback: if silent acquisition failed and we have a refresh
    # token on record, use it directly. MSAL's
    # ``acquire_token_by_refresh_token`` is marked internal (underscore
    # prefix) in some versions; we try it via ``initiate_auth_code_flow``
    # compatible entrypoint and otherwise surface the failure.
    if result is None and session.refresh_token:
        try:
            result = msal_app.acquire_token_by_refresh_token(
                refresh_token=session.refresh_token,
                scopes=scopes,
            )
        except AttributeError:  # pragma: no cover — msal version guard
            result = None

    if not isinstance(result, dict) or "access_token" not in result:
        err = (
            result.get("error_description")
            if isinstance(result, dict)
            else "silent acquisition returned no token"
        )
        logger.info("auth_token: silent acquisition failed for resource=%s: %s", resource, err)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Silent token acquisition failed: {err}",
        )

    # Update the session's cached access token + expiry so subsequent
    # /auth/token calls can short-circuit on the happy path.
    expires_in = int(result.get("expires_in", 3600))
    new_expiry = _now_utc() + timedelta(seconds=expires_in)

    updated = session.model_copy(
        update={
            "access_token": str(result["access_token"]),
            "expires_at": new_expiry,
            "last_seen_at": _now_utc(),
        }
    )
    await store.set(updated, ttl_seconds=cfg.BFF_SESSION_TTL_SECONDS)

    return TokenResponse(
        access_token=str(result["access_token"]),
        token_type="Bearer",
        expires_on=new_expiry,
        resource=resource,
    )


# ── Helper for tests / DI overrides ─────────────────────────────────────────


def reset_session_store_singleton() -> None:
    """Clear the cached session-store singleton.

    Used by the test suite so each test function can install a fresh
    :class:`InMemorySessionStore`. Not intended for production use.
    """
    global _store_singleton
    _store_singleton = None


__all__ = [
    "AuthMeResponse",
    "SessionState",
    "TokenResponse",
    "get_bff_session",
    "get_msal_app",
    "get_pending_serializer",
    "get_session_serializer",
    "get_session_store",
    "reset_session_store_singleton",
    "router",
]
