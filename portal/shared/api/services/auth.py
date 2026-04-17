"""
Azure AD / Entra ID authentication service.

Thin wrapper around :mod:`csa_platform.common.auth` that adds
portal-specific conveniences (Role enum, ``get_user_domain`` helper,
``DomainScope`` dependency) and fires the safety gate at import time
so the portal refuses to start without authentication in non-local
environments.

Usage in routers::

    from portal.shared.api.services.auth import require_role, get_current_user
    from portal.shared.api.services.auth import DomainScope, get_domain_scope

    @router.get("/admin-only")
    async def admin_endpoint(user: dict = Depends(require_role("Admin"))):
        ...

    @router.get("/scoped")
    async def scoped_endpoint(scope: DomainScope = Depends(get_domain_scope)):
        if not scope.is_admin and not scope.user_domain:
            return []
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

# ── Re-export the shared auth core ──────────────────────────────────────────
# All JWT validation, JWKS caching, demo-mode handling, and role enforcement
# live in the canonical csa_platform module.  The portal re-exports the
# public API so that router imports remain unchanged.
from csa_platform.common.auth import (  # noqa: F401 — re-exported
    bearer_scheme,
    enforce_auth_safety_gate,
    get_current_user,
    require_role,
)
from fastapi import Depends

# ── Safety gate (fires at import time) ──────────────────────────────────────
# Defence-in-depth: enforce the safety gate immediately when this module is
# first imported (i.e. at application startup).
enforce_auth_safety_gate()


# ── Portal-specific extras ──────────────────────────────────────────────────


class Role(str, Enum):
    """Application roles configured in the Entra ID app registration."""

    READER = "Reader"
    CONTRIBUTOR = "Contributor"
    ADMIN = "Admin"


def get_user_domain(user: dict[str, Any] = Depends(get_current_user)) -> str | None:
    """Extract the user's domain from their token claims."""
    return user.get("domain") or user.get("team")


@dataclass
class DomainScope:
    """Resolved domain context for the authenticated caller.

    Attributes
    ----------
    user_domain:
        The domain/team claim from the JWT, or ``None`` when the token
        carries no domain (e.g. synthetic demo users without a team).
    is_admin:
        ``True`` when the caller holds the ``Admin`` application role.
        Admins bypass per-domain filtering and can act cross-domain.
    """

    user_domain: str | None
    is_admin: bool


async def get_domain_scope(
    user: dict[str, Any] = Depends(get_current_user),
) -> DomainScope:
    """FastAPI dependency that resolves the caller's ``DomainScope``.

    Use this in list / GET endpoints that must be filtered to the caller's
    domain.  Write paths that need an explicit assertion should still use
    ``_assert_user_can_access_domain`` (or the equivalent in each router).

    Example::

        @router.get("/items")
        async def list_items(scope: DomainScope = Depends(get_domain_scope)):
            items = load_all_items()
            if not scope.is_admin:
                if not scope.user_domain:
                    return []          # demo / domain-less user — empty set
                items = [i for i in items if i.domain == scope.user_domain]
            return items
    """
    roles = user.get("roles", [])
    domain = user.get("domain") or user.get("team")
    return DomainScope(user_domain=domain, is_admin="Admin" in roles)
