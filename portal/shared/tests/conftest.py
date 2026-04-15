"""
Pytest configuration and shared fixtures for the CSA-in-a-Box shared backend tests.

Provides a FastAPI TestClient with mocked authentication so tests
can exercise endpoints without requiring Azure AD.
"""

from __future__ import annotations

from collections.abc import Generator
from typing import Any

import pytest
from fastapi.testclient import TestClient

# Patch the auth dependency before importing the app
from portal.shared.api.services.auth import get_current_user

# ── Mock Auth ──────────────────────────────────────────────────────────────


MOCK_USER: dict[str, Any] = {
    "sub": "test-user-id",
    "name": "Test User",
    "preferred_username": "test@csainabox.local",
    "email": "test@csainabox.local",
    "roles": ["Admin", "Contributor", "Reader"],
    "oid": "00000000-0000-0000-0000-000000000001",
    "tid": "test-tenant",
}


async def mock_get_current_user() -> dict[str, Any]:
    """Return a mock user with all roles for testing."""
    return MOCK_USER


def mock_require_role(*_allowed_roles: str):
    """Return a mock dependency that always allows access."""

    async def _check_role() -> dict[str, Any]:
        return MOCK_USER

    return _check_role


# ── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def app():
    """Create the FastAPI app with mocked auth dependencies."""
    from portal.shared.api.main import app as fastapi_app

    # Override auth dependencies
    fastapi_app.dependency_overrides[get_current_user] = mock_get_current_user

    # We need to override require_role, but it's a factory function.
    # The actual dependency returned by require_role is different each time,
    # so we monkey-patch the module-level function instead.
    import portal.shared.api.services.auth as auth_module

    original_require_role = auth_module.require_role
    auth_module.require_role = mock_require_role

    yield fastapi_app

    # Restore
    fastapi_app.dependency_overrides.clear()
    auth_module.require_role = original_require_role


@pytest.fixture(scope="session")
def client(app) -> Generator[TestClient, None, None]:
    """Provide a TestClient bound to the app with mocked auth."""
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_stores():
    """Reset in-memory stores between tests to ensure isolation."""
    from portal.shared.api.routers import access, marketplace, pipelines, sources

    # Clear in-memory stores
    sources._sources.clear()
    pipelines._pipelines.clear()
    pipelines._runs.clear()
    access._requests.clear()
    marketplace._products.clear()
    marketplace._quality_history.clear()

    yield

    # Clean up after test
    sources._sources.clear()
    pipelines._pipelines.clear()
    pipelines._runs.clear()
    access._requests.clear()
    marketplace._products.clear()
    marketplace._quality_history.clear()
