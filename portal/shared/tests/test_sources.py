"""
Tests for the sources router — CRUD operations on data source registrations.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


class TestListSources:
    """GET /api/v1/sources"""

    def test_list_sources_returns_demo_data(self, client: TestClient):
        """Should return seeded demo sources on first access."""
        response = client.get("/api/v1/sources")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 4  # 4 demo sources

    def test_list_sources_filter_by_domain(self, client: TestClient):
        """Should filter sources by domain."""
        # First populate demo data
        client.get("/api/v1/sources")
        response = client.get("/api/v1/sources", params={"domain": "finance"})
        assert response.status_code == 200
        data = response.json()
        assert all(s["domain"] == "finance" for s in data)

    def test_list_sources_filter_by_status(self, client: TestClient):
        """Should filter sources by status."""
        client.get("/api/v1/sources")
        response = client.get("/api/v1/sources", params={"status": "active"})
        assert response.status_code == 200
        data = response.json()
        assert all(s["status"] == "active" for s in data)

    def test_list_sources_search(self, client: TestClient):
        """Should search sources by name or description."""
        client.get("/api/v1/sources")
        response = client.get("/api/v1/sources", params={"search": "HR"})
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 1

    def test_list_sources_pagination(self, client: TestClient):
        """Should support limit and offset parameters."""
        client.get("/api/v1/sources")
        response = client.get("/api/v1/sources", params={"limit": 2, "offset": 0})
        assert response.status_code == 200
        data = response.json()
        assert len(data) <= 2


class TestGetSource:
    """GET /api/v1/sources/{source_id}"""

    def test_get_source_by_id(self, client: TestClient):
        """Should return a single source by ID."""
        # Populate demo data
        client.get("/api/v1/sources")
        response = client.get("/api/v1/sources/src-001")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "src-001"
        assert data["name"] == "HR Employee Records"

    def test_get_source_not_found(self, client: TestClient):
        """Should return 404 for nonexistent source."""
        client.get("/api/v1/sources")  # seed
        response = client.get("/api/v1/sources/nonexistent")
        assert response.status_code == 404


class TestRegisterSource:
    """POST /api/v1/sources"""

    def test_register_source_creates_record(self, client: TestClient):
        """Should create a new source in draft status."""
        payload = {
            "name": "Test Source",
            "description": "A test data source",
            "source_type": "azure_sql",
            "domain": "testing",
            "classification": "internal",
            "connection": {"host": "test-server.database.windows.net"},
            "ingestion": {"mode": "full"},
            "owner": {"name": "Tester", "email": "tester@test.com", "team": "QA"},
            "tags": {"env": "test"},
        }
        response = client.post("/api/v1/sources", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Test Source"
        assert data["status"] == "draft"
        assert "id" in data

    def test_register_source_validates_name(self, client: TestClient):
        """Should reject sources with empty name."""
        payload = {
            "name": "",
            "source_type": "azure_sql",
            "domain": "test",
            "connection": {},
            "owner": {"name": "Tester", "email": "t@t.com", "team": "T"},
        }
        response = client.post("/api/v1/sources", json=payload)
        assert response.status_code == 422  # Validation error


class TestUpdateSource:
    """PATCH /api/v1/sources/{source_id}"""

    def test_update_source(self, client: TestClient):
        """Should apply partial update to a source."""
        client.get("/api/v1/sources")  # seed
        response = client.patch(
            "/api/v1/sources/src-001",
            json={"description": "Updated description"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["description"] == "Updated description"
