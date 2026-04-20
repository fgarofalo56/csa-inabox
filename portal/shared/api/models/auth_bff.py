"""
Pydantic models for the BFF (Backend-for-Frontend) auth pattern.

CSA-0020 Phase 2 — see ``docs/adr/0014-msal-bff-auth-pattern.md`` and
``portal/shared/api/routers/auth_bff.py``.

These models cross the trust boundary between the browser (untrusted)
and the FastAPI backend (trusted). ``SessionState`` is only ever
instantiated server-side from a successful
``ConfidentialClientApplication.acquire_token_by_authorization_code``
result; ``AuthMeResponse`` is the outbound projection the React app
consumes on ``GET /auth/me``.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# ── Server-side session record ──────────────────────────────────────────────


class SessionState(BaseModel):
    """Opaque server-side session backing the ``csa_sid`` cookie.

    This record never leaves the backend; callers receive an opaque
    session id signed with ``itsdangerous`` and indexed against a
    ``SessionStore`` implementation.

    Attributes
    ----------
    session_id:
        Unguessable UUID; the signed form of this value is the
        ``csa_sid`` cookie value.
    oid, tid:
        Entra ID stable subject + tenant claims from the id_token.
    name, email:
        Display fields; populated from id_token claims.
    roles:
        Application roles from the ``roles`` claim. Empty list when
        the caller holds no app roles.
    access_token, refresh_token:
        MSAL-issued tokens. ``refresh_token`` may be ``None`` when the
        authority did not grant one (e.g. if the ``offline_access``
        scope was not requested — the BFF always requests it).
    expires_at:
        UTC datetime at which the cached ``access_token`` expires.
        ``acquire_token_silent`` is called near this boundary.
    issued_at, last_seen_at:
        Lifecycle timestamps for telemetry + idle-session eviction.
    """

    model_config = ConfigDict(frozen=False, extra="forbid")

    session_id: str
    oid: str
    tid: str
    name: str = ""
    email: str = ""
    roles: list[str] = Field(default_factory=list)
    access_token: str
    refresh_token: str | None = None
    id_token: str | None = None
    expires_at: datetime
    issued_at: datetime
    last_seen_at: datetime


# ── Outbound DTOs (cross the wire) ──────────────────────────────────────────


class AuthMeResponse(BaseModel):
    """Response shape for ``GET /auth/me``.

    Mirrors the React ``BffUserProfile`` interface in
    ``portal/react-webapp/src/services/authBff.ts``.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    oid: str
    tid: str
    name: str
    email: str
    roles: list[str]


class TokenResponse(BaseModel):
    """Response shape for ``POST /auth/token``.

    The BFF returns the access token so the SPA can still call
    per-resource APIs during the migration window. Long-term, callers
    should route API requests through the BFF as a reverse proxy and
    never touch tokens in the browser — see ADR-0014.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    access_token: str
    token_type: str = "Bearer"
    expires_on: datetime
    resource: str


# ── Pending-auth state (cookie-backed, short-lived) ─────────────────────────


class PendingAuthState(BaseModel):
    """Short-lived auth-flow state stored in a signed cookie between
    ``/auth/login`` and ``/auth/callback``.

    Binding the PKCE verifier + state + nonce to a cookie prevents
    cross-tab / CSRF-style hijacks of the auth flow. The cookie is
    signed with ``BFF_SESSION_SIGNING_KEY`` via ``itsdangerous`` so a
    tampered cookie is rejected at ``/auth/callback``.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    state: str
    nonce: str
    code_verifier: str
    redirect_to: str
    issued_at: datetime
