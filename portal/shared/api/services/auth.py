"""
Azure AD / Entra ID authentication service.

Validates JWT bearer tokens issued by Azure AD (Commercial) or Azure AD for
Government.  Provides FastAPI dependency-injection helpers for role-based
access control.

Usage in routers::

    from portal.shared.api.services.auth import require_role, get_current_user

    @router.get("/admin-only")
    async def admin_endpoint(user: dict = Depends(require_role("Admin"))):
        ...
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any

import httpx
from cachetools import TTLCache
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ..config import settings

logger = logging.getLogger(__name__)

# ── Environment Safety Gate ─────────────────────────────────────────────────
# Fail-fast: if AUTH_DISABLED is true in a non-local / non-demo environment
# the application must refuse to start.  This prevents accidental production
# deployments without authentication.

_auth_disabled = settings.AUTH_DISABLED or not settings.AZURE_TENANT_ID
_is_local_or_demo = settings.ENVIRONMENT.lower() == "local" or settings.DEMO_MODE

if _auth_disabled and not _is_local_or_demo:
    raise RuntimeError(
        "SECURITY: AUTH_DISABLED=true (or AZURE_TENANT_ID is empty) but "
        f"ENVIRONMENT={settings.ENVIRONMENT!r} is not 'local' and DEMO_MODE "
        "is not enabled.  Refusing to start without authentication in a "
        "non-local environment.  Set ENVIRONMENT=local or DEMO_MODE=true for "
        "local development, or configure AZURE_TENANT_ID for production."
    )

if _auth_disabled and _is_local_or_demo:
    logger.warning(
        "⚠ AUTH DISABLED — running in demo/local mode.  All requests will "
        "receive a synthetic 'Reader' identity.  Do NOT use this in production."
    )

# ── Constants ────────────────────────────────────────────────────────────────

# Azure AD v2.0 OIDC endpoints
_COMMERCIAL_AUTHORITY = "https://login.microsoftonline.com"
_GOVERNMENT_AUTHORITY = "https://login.microsoftonline.us"

# TTL-based JWKS cache: keys are refreshed every 24 hours (Azure AD rotates
# signing keys periodically).  maxsize=10 is generous — typically there is
# only one JWKS document per tenant.
_JWKS_CACHE: TTLCache[str, dict[str, Any]] = TTLCache(maxsize=10, ttl=86400)

bearer_scheme = HTTPBearer(auto_error=False)


class Role(str, Enum):
    """Application roles configured in the Entra ID app registration."""

    READER = "Reader"
    CONTRIBUTOR = "Contributor"
    ADMIN = "Admin"


# ── Helpers ──────────────────────────────────────────────────────────────────


def _authority_url() -> str:
    """Return the correct authority URL based on cloud type."""
    base = _GOVERNMENT_AUTHORITY if settings.IS_GOVERNMENT_CLOUD else _COMMERCIAL_AUTHORITY
    return f"{base}/{settings.AZURE_TENANT_ID}"


def _openid_config_url() -> str:
    """Return the OIDC discovery document URL."""
    return f"{_authority_url()}/v2.0/.well-known/openid-configuration"


async def _get_jwks() -> dict[str, Any]:
    """Fetch (and cache with 24h TTL) the JSON Web Key Set from Azure AD."""
    cache_key = f"{settings.AZURE_TENANT_ID}:{settings.IS_GOVERNMENT_CLOUD}"

    cached = _JWKS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    async with httpx.AsyncClient() as client:
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

    Returns the decoded token claims on success.

    In local/demo mode (AUTH_DISABLED + ENVIRONMENT=local or DEMO_MODE=true)
    returns a synthetic claims dict with Reader-only access so the API can
    run without Azure AD for development purposes.
    """
    # ── Local / Demo mode — skip real validation ────────────────────────
    if _auth_disabled and _is_local_or_demo:
        logger.debug("Auth disabled (local/demo mode) — returning demo claims with Reader role")
        return {
            "sub": "demo-user-id",
            "name": "Demo User",
            "preferred_username": "demo@csainabox.local",
            "email": "demo@csainabox.local",
            "roles": ["Reader"],
            "oid": "00000000-0000-0000-0000-000000000000",
            "tid": "demo-tenant",
        }

    # ── Production: validate with python-jose ────────────────────────────
    try:
        from jose import JWTError  # type: ignore[import-untyped]
        from jose import jwt as jose_jwt

        jwks = await _get_jwks()

        # Extract kid from token header to find the right key
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

        return jose_jwt.decode(
            token,
            rsa_key,
            algorithms=["RS256"],
            audience=settings.AZURE_CLIENT_ID,
            issuer=f"{_authority_url()}/v2.0",
        )

    except JWTError as exc:
        logger.warning("JWT validation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
        ) from exc


# ── FastAPI Dependencies ─────────────────────────────────────────────────────


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict[str, Any]:
    """Extract and validate the current user from the Authorization header.

    Returns the decoded JWT claims dict.  In demo mode (no tenant configured)
    returns synthetic claims so endpoints work without Azure AD.
    """
    if credentials is None:
        if _auth_disabled and _is_local_or_demo:
            # Demo mode — no auth required
            return await _validate_token("")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization header.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return await _validate_token(credentials.credentials)


def get_user_domain(user: dict[str, Any] = Depends(get_current_user)) -> str | None:
    """Extract the user's domain from their token claims."""
    return user.get("domain") or user.get("team")


def require_role(*allowed_roles: str):
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
                detail=f"One of the following roles is required: {', '.join(allowed_roles)}",
            )
        return user

    return _check_role
