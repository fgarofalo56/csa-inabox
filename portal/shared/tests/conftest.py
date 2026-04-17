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
def _test_db_dir(tmp_path_factory):
    """Provide a session-scoped temporary directory for the test database."""
    return tmp_path_factory.mktemp("portal_test_data")


@pytest.fixture(scope="session")
def app(_test_db_dir):
    """Create the FastAPI app with mocked auth dependencies.

    All SqliteStore instances in the routers are pointed at a temporary
    database so tests never touch production data.
    """
    from portal.shared.api.routers import access, marketplace, pipelines, sources

    # Re-point every store to the temp directory (shared DB file inside it)
    for store in (
        sources._sources_store,
        pipelines._pipelines_store,
        pipelines._runs_store,
        access._access_store,
        marketplace._products_store,
        marketplace._quality_store,
    ):
        store.data_dir = _test_db_dir
        store.db_path = _test_db_dir / "test_portal.db"
        store._legacy_json_path = _test_db_dir / "nonexistent.json"
        store._ensure_table()

    from portal.shared.api.main import app as fastapi_app

    # Override auth dependencies
    fastapi_app.dependency_overrides[get_current_user] = mock_get_current_user

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
    """Clear all SQLite-backed stores and re-seed demo data between tests.

    The application seeds demo data once during lifespan startup, but the
    test client triggers lifespan only once per session.  We clear and
    re-seed before every test so each test starts with a known state.
    """
    from portal.shared.api.routers import access, marketplace, pipelines, sources

    stores = [
        sources._sources_store,
        pipelines._pipelines_store,
        pipelines._runs_store,
        access._access_store,
        marketplace._products_store,
        marketplace._quality_store,
    ]

    for store in stores:
        store.clear()

    # Re-seed demo data so tests that depend on it start with known state
    sources.seed_demo_sources()
    pipelines.seed_demo_pipelines()
    access.seed_demo_requests()
    marketplace.seed_demo_products()

    yield

    for store in stores:
        store.clear()
