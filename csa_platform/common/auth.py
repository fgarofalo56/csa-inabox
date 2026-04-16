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

import httpx
from cachetools import TTLCache
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

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
    return _env_bool("AUTH_DISABLED", False) or not _tenant_id()


def _is_local_or_demo() -> bool:
    env = os.environ.get("ENVIRONMENT", "").strip().lower()
    return env == "local" or _env_bool("DEMO_MODE", False)


# ─────────────────────────────────────────────────────────────────────────
# Safety gate — refuse to serve requests when AUTH_DISABLED in production
# ─────────────────────────────────────────────────────────────────────────


def enforce_auth_safety_gate() -> None:
    """Fail fast if auth is disabled outside local/demo environments.

    Call this once during application startup (e.g. FastAPI ``lifespan``)
    so mis-configured deployments refuse to serve requests rather than
    silently running unauthenticated.
    """
    if _auth_disabled() and not _is_local_or_demo():
        msg = (
            "SECURITY: AUTH_DISABLED=true (or AZURE_TENANT_ID is empty) "
            f"but ENVIRONMENT={os.environ.get('ENVIRONMENT', '')!r} is "
            "not 'local' and DEMO_MODE is not enabled.  Refusing to serve "
            "requests without authentication in a non-local environment."
        )
        raise RuntimeError(msg)
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

# 24h TTL JWKS cache — Azure AD rotates signing keys periodically.
_JWKS_CACHE: TTLCache[str, dict[str, Any]] = TTLCache(maxsize=10, ttl=86400)

bearer_scheme = HTTPBearer(auto_error=False)


def _authority_url() -> str:
    base = _GOVERNMENT_AUTHORITY if _is_government_cloud() else _COMMERCIAL_AUTHORITY
    return f"{base}/{_tenant_id()}"


def _openid_config_url() -> str:
    return f"{_authority_url()}/v2.0/.well-known/openid-configuration"


async def _get_jwks() -> dict[str, Any]:
    """Fetch (and cache with 24h TTL) the JSON Web Key Set from Azure AD."""
    cache_key = f"{_tenant_id()}:{_is_government_cloud()}"
    cached = _JWKS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(timeout=10.0) as client:
        oidc_resp = await client.get(_openid_config_url())
        oidc_resp.raise_for_status()
        jwks_uri = oidc_resp.json()["jwks_uri"]

        jwks_resp = await client.get(jwks_uri)
        jwks_resp.raise_for_status()
        jwks_data: dict[str, Any] = jwks_resp.json()
        _JWKS_CACHE[cache_key] = jwks_data

    return jwks_data


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
        from jose import JWTError  # type: ignore[import-untyped]
        from jose import jwt as jose_jwt

        jwks = await _get_jwks()
        unverified_header = jose_jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")

        rsa_key: dict[str, str] = {}
        for key in jwks.get("keys", []):
            if key["kid"] == kid:
                rsa_key = {
                    "kty": key["kty"],
                    "kid": key["kid"],
                    "use": key["use"],
                    "n": key["n"],
                    "e": key["e"],
                }
                break

        if not rsa_key:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unable to find appropriate signing key.",
            )

        claims: dict[str, Any] = jose_jwt.decode(
            token,
            rsa_key,
            algorithms=["RS256"],
            audience=_client_id(),
            issuer=f"{_authority_url()}/v2.0",
        )
        return claims

    except JWTError as exc:
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
