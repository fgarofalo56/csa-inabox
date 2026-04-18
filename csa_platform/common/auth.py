"""Azure AD / Entra ID JWT authentication for csa_platform FastAPI apps.

Validates JWT bearer tokens against Azure AD (Commercial) or Azure AD for
Government JWKS documents and exposes FastAPI ``Depends(...)`` helpers for
role-based access control.

The portal package ships a near-identical implementation at
``portal.shared.api.services.auth``; this module is the csa_platform
counterpart for services that cannot import from portal (to keep the
dependency graph one-directional).  The two should be merged into a
single shared package once the portal / csa_platform monorepo split
(see ``REPO_SPLIT.md``) settles.

Configuration via environment variables (read on first use, not at
import time, so test suites can override them):

    AZURE_TENANT_ID            Entra ID tenant GUID.  Required unless
                               AUTH_DISABLED=true AND ENVIRONMENT=local.
    AZURE_CLIENT_ID            Application (client) ID — used as the
                               expected audience claim.  Required.
    AUTH_DISABLED              ``true`` disables all auth.  Refused in
                               non-local environments for safety.
    ENVIRONMENT                Deployment environment name.  Must be
                               ``local`` to enable AUTH_DISABLED.
    DEMO_MODE                  ``true`` is equivalent to ENVIRONMENT=local
                               for the purposes of the AUTH_DISABLED
                               safety gate (lets public demos run).
    IS_GOVERNMENT_CLOUD        ``true`` to use login.microsoftonline.us.

Usage::

    from csa_platform.common.auth import get_current_user, require_role

    @app.get("/public")
    async def public_route(user: dict = Depends(get_current_user)): ...

    @app.post("/admin-only")
    async def admin(user: dict = Depends(require_role("Admin"))): ...
"""

from __future__ import annotations

import logging
import os
from collections.abc import Awaitable, Callable
from typing import Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Configuration (environment-driven, read lazily so tests can override)
# ─────────────────────────────────────────────────────────────────────────


def _env_bool(name: str, default: bool = False) -> bool:
    """Parse a truthy environment variable."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"true", "1", "yes", "on"}


def _tenant_id() -> str:
    return os.environ.get("AZURE_TENANT_ID", "")


def _client_id() -> str:
    return os.environ.get("AZURE_CLIENT_ID", "")


def _is_government_cloud() -> bool:
    return _env_bool("IS_GOVERNMENT_CLOUD", False)


def _auth_disabled() -> bool:
    """Auth is disabled only when AUTH_DISABLED=true is explicitly set.

    An empty ``AZURE_TENANT_ID`` no longer silently disables auth
    (CSA-0001 / SEC-NEW-0001). Non-local environments with an empty tenant
    will fail fast at startup via ``enforce_auth_safety_gate``.
    """
    return _env_bool("AUTH_DISABLED", False)


def _is_local_or_demo() -> bool:
    """Strict allow-list for environments eligible to run without auth.

    Only ``ENVIRONMENT in ("local", "demo")`` qualifies.  ``DEMO_MODE`` is
    no longer a get-out-of-jail flag: misconfigured dev / qa / uat / test /
    preprod / staging / production deployments cannot accidentally serve
    unauthenticated traffic (CSA-0019 / SEC-NEW-0002).
    """
    env = os.environ.get("ENVIRONMENT", "local").strip().lower()
    return env in ("local", "demo")


# ─────────────────────────────────────────────────────────────────────────
# Safety gate — refuse to serve requests when AUTH_DISABLED in production
# ─────────────────────────────────────────────────────────────────────────


def enforce_auth_safety_gate() -> None:
    """Fail fast on any auth misconfiguration detectable at startup.

    Three failure modes are caught here:

    1. ``AUTH_DISABLED=true`` outside a local/demo environment.
    2. ``AZURE_TENANT_ID`` empty outside a local/demo environment (CSA-0001).
    3. ``DEMO_MODE=true`` set in an environment that is not in the
       ``{"local", "demo"}`` allow-list (CSA-0019).

    Call this once during application startup (e.g. FastAPI ``lifespan``)
    so mis-configured deployments refuse to serve requests rather than
    silently running unauthenticated.
    """
    env = os.environ.get("ENVIRONMENT", "")

    if _auth_disabled() and not _is_local_or_demo():
        raise RuntimeError(
            f"SECURITY: AUTH_DISABLED=true but ENVIRONMENT={env!r} is not in "
            "{'local', 'demo'}. Refusing to serve requests without "
            "authentication in a non-local environment."
        )

    if not _tenant_id() and not _is_local_or_demo():
        raise RuntimeError(
            f"SECURITY: AZURE_TENANT_ID is empty but ENVIRONMENT={env!r} is "
            "not in {'local', 'demo'}. Refusing to start without tenant "
            "configuration — empty tenant no longer silently disables auth."
        )

    if _env_bool("DEMO_MODE", False) and not _is_local_or_demo():
        raise RuntimeError(
            f"SECURITY: DEMO_MODE=true but ENVIRONMENT={env!r} is not in "
            "{'local', 'demo'}. DEMO_MODE is only honoured in those two "
            "environments; refusing to start."
        )

    if _auth_disabled() and _is_local_or_demo():
        logger.warning(
            "AUTH DISABLED — running in demo/local mode. All requests "
            "will receive a synthetic 'Reader' identity.  Do NOT use this "
            "in production."
        )


# ─────────────────────────────────────────────────────────────────────────
# Azure AD endpoints + JWKS cache
# ─────────────────────────────────────────────────────────────────────────


_COMMERCIAL_AUTHORITY = "https://login.microsoftonline.com"
_GOVERNMENT_AUTHORITY = "https://login.microsoftonline.us"

# PyJWKClient fetches the JWKS URI and caches signing keys internally.
# lifespan=86400 keeps keys for 24 hours, matching Azure AD's rotation period.
# One client per (tenant, cloud) pair is created lazily and reused.
_jwks_clients: dict[str, PyJWKClient] = {}

bearer_scheme = HTTPBearer(auto_error=False)


def _authority_url() -> str:
    base = _GOVERNMENT_AUTHORITY if _is_government_cloud() else _COMMERCIAL_AUTHORITY
    return f"{base}/{_tenant_id()}"


def _jwks_uri() -> str:
    """Return the JWKS URI for the current tenant and cloud."""
    return f"{_authority_url()}/discovery/v2.0/keys"


def _get_jwks_client() -> PyJWKClient:
    """Return a cached PyJWKClient for the current tenant.

    Config functions are called at validation time (not import time) so tests
    can override environment variables after module import.
    """
    cache_key = f"{_tenant_id()}:{_is_government_cloud()}"
    if cache_key not in _jwks_clients:
        _jwks_clients[cache_key] = PyJWKClient(
            uri=_jwks_uri(),
            lifespan=86400,  # 24h — matches Azure AD key rotation cadence
            cache_jwk_set=True,
        )
    return _jwks_clients[cache_key]


async def _validate_token(token: str) -> dict[str, Any]:
    """Validate a JWT bearer token against Azure AD JWKS.

    In local/demo mode returns a synthetic claims dict with Reader-only
    access so the API can run without Azure AD for development.
    """
    if _auth_disabled() and _is_local_or_demo():
        logger.debug("Auth disabled (local/demo mode) — returning demo claims")
        return {
            "sub": "demo-user-id",
            "name": "Demo User",
            "preferred_username": "demo@csainabox.local",
            "email": "demo@csainabox.local",
            "roles": ["Reader"],
            "oid": "00000000-0000-0000-0000-000000000000",
            "tid": "demo-tenant",
        }

    try:
        jwks_client = _get_jwks_client()
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        client_id = _client_id()
        # MSAL v2 issues tokens with ``aud`` equal to ``api://<client-id>``
        # for protected APIs but the raw client ID for some flows; accept
        # both forms to stay interoperable (CSA-0018 / SEC-NEW-0005).
        valid_audiences = [client_id, f"api://{client_id}"] if client_id else []

        claims: dict[str, Any] = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=valid_audiences,
            issuer=f"{_authority_url()}/v2.0",
            leeway=30,
            options={
                "require": ["exp", "nbf", "iss", "aud", "sub"],
                "verify_exp": True,
                "verify_nbf": True,
                "verify_iat": True,
                "verify_aud": True,
                "verify_iss": True,
                "verify_signature": True,
            },
        )

        # Pin the token to the expected tenant to block multi-tenant
        # token-swap attacks (CSA-0018 / SEC-NEW-0006).
        expected_tid = _tenant_id()
        actual_tid = claims.get("tid")
        if expected_tid and actual_tid != expected_tid:
            raise jwt.exceptions.InvalidTokenError(
                f"Token tenant mismatch: expected {expected_tid!r}, "
                f"got {actual_tid!r}"
            )

        return claims

    except jwt.exceptions.InvalidTokenError as exc:
        logger.warning("JWT validation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
        ) from exc


# ─────────────────────────────────────────────────────────────────────────
# FastAPI dependencies
# ─────────────────────────────────────────────────────────────────────────


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict[str, Any]:
    """Extract and validate the current user from the Authorization header."""
    if credentials is None:
        if _auth_disabled() and _is_local_or_demo():
            return await _validate_token("")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization header.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await _validate_token(credentials.credentials)


def require_role(
    *allowed_roles: str,
) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
    """Return a dependency that enforces one or more application roles.

    Usage::

        @router.post("/admin-action")
        async def admin_action(user=Depends(require_role("Admin"))):
            ...
    """

    async def _check_role(
        user: dict[str, Any] = Depends(get_current_user),
    ) -> dict[str, Any]:
        user_roles: list[str] = user.get("roles", [])
        if not any(r in user_roles for r in allowed_roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"One of the following roles is required: "
                    f"{', '.join(allowed_roles)}"
                ),
            )
        return user

    return _check_role
