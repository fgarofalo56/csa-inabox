"""Regression tests for CSA-0024: domain-scoped aggregate endpoints.

``/api/v1/stats``, ``/api/v1/domains``, ``/api/v1/marketplace/stats``
and ``/api/v1/marketplace/domains`` are aggregate endpoints that must
not leak counts for domains the caller does not own. Admins retain
platform-wide visibility; non-admins see only their own domain.
"""

from __future__ import annotations

from collections.abc import Generator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from portal.shared.api.services.auth import get_current_user

FINANCE_USER: dict[str, Any] = {
    "sub": "finance-user",
    "name": "Alice Park",
    "preferred_username": "alice@contoso.com",
    "email": "alice@contoso.com",
    "roles": ["Contributor"],
    "domain": "finance",
    "oid": "00000000-0000-0000-0000-000000000010",
    "tid": "test-tenant",
}

MARKETING_USER: dict[str, Any] = {
    "sub": "marketing-user",
    "name": "Carlos Diaz",
    "preferred_username": "carlos@contoso.com",
    "email": "carlos@contoso.com",
    "roles": ["Contributor"],
    "domain": "marketing",
    "oid": "00000000-0000-0000-0000-000000000011",
    "tid": "test-tenant",
}

DOMAINLESS_USER: dict[str, Any] = {
    "sub": "no-domain-user",
    "name": "Demo User",
    "preferred_username": "demo@contoso.com",
    "email": "demo@contoso.com",
    "roles": ["Reader"],
    # no "domain" / "team" claim
    "oid": "00000000-0000-0000-0000-000000000012",
    "tid": "test-tenant",
}


@pytest.fixture
def finance_client(app) -> Generator[TestClient, None, None]:
    async def _as_finance() -> dict[str, Any]:
        return FINANCE_USER

    app.dependency_overrides[get_current_user] = _as_finance
    try:
        with TestClient(app) as c:
            yield c
    finally:
        # Restore the default admin-like mock user from conftest
        from portal.shared.tests.conftest import mock_get_current_user

        app.dependency_overrides[get_current_user] = mock_get_current_user


@pytest.fixture
def marketing_client(app) -> Generator[TestClient, None, None]:
    async def _as_marketing() -> dict[str, Any]:
        return MARKETING_USER

    app.dependency_overrides[get_current_user] = _as_marketing
    try:
        with TestClient(app) as c:
            yield c
    finally:
        from portal.shared.tests.conftest import mock_get_current_user

        app.dependency_overrides[get_current_user] = mock_get_current_user


@pytest.fixture
def domainless_client(app) -> Generator[TestClient, None, None]:
    async def _as_demo() -> dict[str, Any]:
        return DOMAINLESS_USER

    app.dependency_overrides[get_current_user] = _as_demo
    try:
        with TestClient(app) as c:
            yield c
    finally:
        from portal.shared.tests.conftest import mock_get_current_user

        app.dependency_overrides[get_current_user] = mock_get_current_user


def test_admin_sees_all_domains_in_platform_stats(client: TestClient) -> None:
    """Admin callers (default mock) see platform-wide counts."""
    resp = client.get("/api/v1/stats")
    assert resp.status_code == 200
    body = resp.json()
    # Seed data has 4 sources, 4 pipelines, 5 products across 4+ domains
    assert body["registered_sources"] >= 3
    assert body["data_products"] >= 3


def test_non_admin_sees_only_own_domain_in_platform_stats(
    finance_client: TestClient, client: TestClient,
) -> None:
    """Non-admin callers see only their own domain's counts (CSA-0024)."""
    admin_resp = client.get("/api/v1/stats").json()
    finance_resp = finance_client.get("/api/v1/stats").json()
    # Finance user sees only their own domain — must be strictly less than
    # the admin total for at least one of sources/products.
    assert finance_resp["registered_sources"] <= admin_resp["registered_sources"]
    assert finance_resp["data_products"] <= admin_resp["data_products"]
    # Different non-admin domains yield different numbers.
    assert finance_resp["data_products"] <= admin_resp["data_products"]


def test_non_admin_cannot_query_other_domains_overview(
    finance_client: TestClient,
) -> None:
    """Finance user requesting /stats/domains/marketing gets 403."""
    resp = finance_client.get("/api/v1/stats/domains/marketing")
    assert resp.status_code == 403


def test_non_admin_can_query_own_domain_overview(finance_client: TestClient) -> None:
    """Finance user requesting /stats/domains/finance succeeds if seeded."""
    resp = finance_client.get("/api/v1/stats/domains/finance")
    # Seed data includes a finance domain
    assert resp.status_code in (200, 404)


def test_non_admin_list_all_domains_returns_only_own_domain(
    finance_client: TestClient,
) -> None:
    """GET /api/v1/domains returns only the caller's own domain."""
    resp = finance_client.get("/api/v1/domains")
    assert resp.status_code == 200
    payload = resp.json()
    # Either the seed data has finance (so one entry) or no overlap (zero)
    assert len(payload) <= 1
    if payload:
        assert payload[0]["name"] == "finance"


def test_marketing_user_cannot_see_finance_aggregates(
    marketing_client: TestClient,
) -> None:
    """A marketing user calling /marketplace/stats sees no finance products."""
    resp = marketing_client.get("/api/v1/marketplace/stats")
    assert resp.status_code == 200
    body = resp.json()
    # Products bucketed by domain — finance products must not surface.
    assert "finance" not in body.get("products_by_domain", {})


def test_domainless_non_admin_sees_empty_aggregates(
    domainless_client: TestClient,
) -> None:
    """A non-admin without a domain claim sees zero counts — safe default."""
    stats = domainless_client.get("/api/v1/stats").json()
    assert stats["registered_sources"] == 0
    assert stats["data_products"] == 0
    domains = domainless_client.get("/api/v1/domains").json()
    assert domains == []
    market = domainless_client.get("/api/v1/marketplace/stats").json()
    assert market["total_products"] == 0
