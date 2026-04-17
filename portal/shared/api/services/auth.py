"""
Azure AD / Entra ID authentication service.

Thin wrapper around :mod:`csa_platform.common.auth` that adds
portal-specific conveniences (Role enum, ``get_user_domain`` helper)
and fires the safety gate at import time so the portal refuses to
start without authentication in non-local environments.

Usage in routers::

    from portal.shared.api.services.auth import require_role, get_current_user

    @router.get("/admin-only")
    async def admin_endpoint(user: dict = Depends(require_role("Admin"))):
        ...
"""

from __future__ import annotations

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
