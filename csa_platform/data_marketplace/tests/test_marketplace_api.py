"""Tests for the Data Marketplace FastAPI application.

Tests data product CRUD, search, and access request workflow using
the in-memory store (no external dependencies required).
"""

from __future__ import annotations

from collections.abc import Generator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from csa_platform.data_marketplace.api.marketplace_api import InMemoryStore, app, get_store

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fresh_store() -> InMemoryStore:
    """Return a clean in-memory store for each test."""
    return InMemoryStore()


@pytest.fixture
def test_client(fresh_store: InMemoryStore) -> Generator[None, None, None]:
    """Create a test client with a fresh store injected."""

    async def _override_store() -> InMemoryStore:
        return fresh_store

    app.dependency_overrides[get_store] = _override_store
    yield
    app.dependency_overrides.clear()


def _product_payload(**overrides: Any) -> dict[str, Any]:
    """Build a minimal valid data product creation payload."""
    base: dict[str, Any] = {
        "name": "test-product",
        "domain": "finance",
        "owner": "test-team@contoso.com",
        "description": "A test data product",
        "schema": {
            "format": "delta",
            "location": "abfss://gold@datalake.dfs.core.windows.net/finance/test/",
            "columns": [
                {"name": "id", "type": "string"},
                {"name": "amount", "type": "double", "nullable": False},
            ],
        },
        "tags": ["test", "finance"],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Data Product CRUD Tests
# ---------------------------------------------------------------------------


class TestCreateProduct:
    """Test POST /products endpoint."""

    @pytest.mark.anyio
    async def test_create_product_success(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            payload = _product_payload()
            resp = await client.post("/products", json=payload)

            assert resp.status_code == 201
            data = resp.json()
            assert data["name"] == "test-product"
            assert data["domain"] == "finance"
            assert "id" in data
            assert data["status"] == "active"

    @pytest.mark.anyio
    async def test_create_product_invalid_name(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            payload = _product_payload(name="Invalid Name!")
            resp = await client.post("/products", json=payload)

            assert resp.status_code == 422

    @pytest.mark.anyio
    async def test_create_product_missing_required_fields(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/products", json={"name": "test"})
            assert resp.status_code == 422


class TestGetProduct:
    """Test GET /products/{id} endpoint."""

    @pytest.mark.anyio
    async def test_get_product_success(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            create_resp = await client.post("/products", json=_product_payload())
            product_id = create_resp.json()["id"]

            resp = await client.get(f"/products/{product_id}")
            assert resp.status_code == 200
            assert resp.json()["id"] == product_id

    @pytest.mark.anyio
    async def test_get_product_not_found(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/products/nonexistent-id")
            assert resp.status_code == 404


class TestListProducts:
    """Test GET /products endpoint."""

    @pytest.mark.anyio
    async def test_list_empty(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/products")
            assert resp.status_code == 200
            data = resp.json()
            assert data["total"] == 0
            assert data["items"] == []

    @pytest.mark.anyio
    async def test_list_with_products(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            await client.post("/products", json=_product_payload(name="prod-a"))
            await client.post("/products", json=_product_payload(name="prod-b"))

            resp = await client.get("/products")
            assert resp.status_code == 200
            data = resp.json()
            assert data["total"] == 2

    @pytest.mark.anyio
    async def test_list_filter_by_domain(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            await client.post("/products", json=_product_payload(name="prod-a", domain="finance"))
            await client.post("/products", json=_product_payload(name="prod-b", domain="health"))

            resp = await client.get("/products", params={"domain": "finance"})
            assert resp.status_code == 200
            data = resp.json()
            assert data["total"] == 1

    @pytest.mark.anyio
    async def test_list_search(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            await client.post(
                "/products",
                json=_product_payload(name="revenue-data", description="Monthly revenue figures"),
            )
            await client.post(
                "/products",
                json=_product_payload(name="orders-data", description="Order transactions"),
            )

            resp = await client.get("/products", params={"search": "revenue"})
            assert resp.status_code == 200
            data = resp.json()
            assert data["total"] == 1


# ---------------------------------------------------------------------------
# Access Request Workflow Tests
# ---------------------------------------------------------------------------


class TestAccessRequestWorkflow:
    """Test the access request create -> check -> approve/deny workflow."""

    @pytest.mark.anyio
    async def test_create_access_request(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            create_resp = await client.post("/products", json=_product_payload())
            product_id = create_resp.json()["id"]

            req_resp = await client.post(
                "/access-requests",
                json={
                    "productId": product_id,
                    "requester": "analyst@contoso.com",
                    "requested_role": "read",
                    "justification": "Need access for quarterly reporting analysis",
                },
            )
            assert req_resp.status_code == 201
            req_data = req_resp.json()
            assert req_data["status"] == "pending"
            assert req_data["requester"] == "analyst@contoso.com"

    @pytest.mark.anyio
    async def test_access_request_product_not_found(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/access-requests",
                json={
                    "productId": "nonexistent",
                    "requester": "analyst@contoso.com",
                    "requested_role": "read",
                    "justification": "Need access for quarterly reporting analysis",
                },
            )
            assert resp.status_code == 404

    @pytest.mark.anyio
    async def test_approve_access_request(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # Create product
            product_resp = await client.post("/products", json=_product_payload())
            product_id = product_resp.json()["id"]

            # Create access request
            req_resp = await client.post(
                "/access-requests",
                json={
                    "productId": product_id,
                    "requester": "analyst@contoso.com",
                    "requested_role": "read",
                    "justification": "Need access for quarterly reporting analysis",
                },
            )
            request_id = req_resp.json()["id"]

            # Approve
            approve_resp = await client.put(
                f"/access-requests/{request_id}/approve",
                json={
                    "reviewer": "admin@contoso.com",
                    "approved": True,
                    "notes": "Approved for Q4 reporting",
                },
            )
            assert approve_resp.status_code == 200
            assert approve_resp.json()["status"] == "approved"
            assert approve_resp.json()["reviewer"] == "admin@contoso.com"

    @pytest.mark.anyio
    async def test_deny_access_request(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            product_resp = await client.post("/products", json=_product_payload())
            product_id = product_resp.json()["id"]

            req_resp = await client.post(
                "/access-requests",
                json={
                    "productId": product_id,
                    "requester": "analyst@contoso.com",
                    "requested_role": "read",
                    "justification": "Need access for quarterly reporting analysis",
                },
            )
            request_id = req_resp.json()["id"]

            deny_resp = await client.put(
                f"/access-requests/{request_id}/approve",
                json={
                    "reviewer": "admin@contoso.com",
                    "approved": False,
                    "notes": "Insufficient justification",
                },
            )
            assert deny_resp.status_code == 200
            assert deny_resp.json()["status"] == "denied"

    @pytest.mark.anyio
    async def test_cannot_approve_already_approved(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            product_resp = await client.post("/products", json=_product_payload())
            product_id = product_resp.json()["id"]

            req_resp = await client.post(
                "/access-requests",
                json={
                    "productId": product_id,
                    "requester": "analyst@contoso.com",
                    "requested_role": "read",
                    "justification": "Need access for quarterly reporting analysis",
                },
            )
            request_id = req_resp.json()["id"]

            # Approve first time
            await client.put(
                f"/access-requests/{request_id}/approve",
                json={
                    "reviewer": "admin@contoso.com",
                    "approved": True,
                },
            )

            # Try to approve again
            resp = await client.put(
                f"/access-requests/{request_id}/approve",
                json={
                    "reviewer": "admin@contoso.com",
                    "approved": True,
                },
            )
            assert resp.status_code == 409


class TestHealthCheck:
    """Test the health check endpoint."""

    @pytest.mark.anyio
    async def test_health(self, test_client: None) -> None:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/health")
            assert resp.status_code == 200
            assert resp.json()["status"] == "healthy"
