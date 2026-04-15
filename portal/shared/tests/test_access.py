"""
Tests for the access router — access request lifecycle management.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


class TestListAccessRequests:
    """GET /api/v1/access"""

    def test_list_access_requests_returns_demo_data(self, client: TestClient):
        """Should return seeded demo access requests."""
        response = client.get("/api/v1/access")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 4  # 4 demo requests

    def test_list_access_requests_filter_by_status(self, client: TestClient):
        """Should filter access requests by status."""
        client.get("/api/v1/access")  # seed
        response = client.get("/api/v1/access", params={"status": "pending"})
        assert response.status_code == 200
        data = response.json()
        assert all(r["status"] == "pending" for r in data)

    def test_list_access_requests_filter_by_product(self, client: TestClient):
        """Should filter access requests by data product ID."""
        client.get("/api/v1/access")  # seed
        response = client.get("/api/v1/access", params={"data_product_id": "dp-001"})
        assert response.status_code == 200
        data = response.json()
        assert all(r["data_product_id"] == "dp-001" for r in data)

    def test_list_access_requests_sorted_by_date(self, client: TestClient):
        """Should return requests sorted by requested_at descending."""
        response = client.get("/api/v1/access")
        data = response.json()
        dates = [r["requested_at"] for r in data]
        assert dates == sorted(dates, reverse=True)


class TestCreateAccessRequest:
    """POST /api/v1/access"""

    def test_create_access_request(self, client: TestClient):
        """Should create a new access request in pending status."""
        payload = {
            "data_product_id": "dp-001",
            "justification": "Need data for quarterly report.",
            "access_level": "read",
            "duration_days": 30,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["status"] == "pending"
        assert data["data_product_id"] == "dp-001"
        assert data["justification"] == "Need data for quarterly report."
        assert "id" in data

    def test_create_access_request_default_values(self, client: TestClient):
        """Should use default access_level and duration when not provided."""
        payload = {
            "data_product_id": "dp-002",
            "justification": "Analytics work.",
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["access_level"] == "read"
        assert data["duration_days"] == 90


class TestApproveAccessRequest:
    """POST /api/v1/access/{request_id}/approve"""

    def test_approve_pending_request(self, client: TestClient):
        """Should approve a pending request and set review fields."""
        client.get("/api/v1/access")  # seed
        response = client.post(
            "/api/v1/access/ar-002/approve",
            json={"notes": "Approved for ML training."},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "approved"
        assert data["reviewed_at"] is not None
        assert data["expires_at"] is not None

    def test_approve_non_pending_fails(self, client: TestClient):
        """Should reject approval of already processed requests."""
        client.get("/api/v1/access")  # seed
        response = client.post("/api/v1/access/ar-001/approve")
        assert response.status_code == 400

    def test_approve_not_found(self, client: TestClient):
        """Should return 404 for nonexistent request."""
        client.get("/api/v1/access")  # seed
        response = client.post("/api/v1/access/nonexistent/approve")
        assert response.status_code == 404


class TestDenyAccessRequest:
    """POST /api/v1/access/{request_id}/deny"""

    def test_deny_pending_request(self, client: TestClient):
        """Should deny a pending request."""
        client.get("/api/v1/access")  # seed
        response = client.post(
            "/api/v1/access/ar-003/deny",
            json={"notes": "Insufficient justification."},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "denied"
        assert data["reviewed_at"] is not None

    def test_deny_non_pending_fails(self, client: TestClient):
        """Should reject denial of already processed requests."""
        client.get("/api/v1/access")  # seed
        response = client.post("/api/v1/access/ar-004/deny")
        assert response.status_code == 400
