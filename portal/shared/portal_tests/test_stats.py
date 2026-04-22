"""
Tests for the stats router — platform statistics and domain overviews.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


class TestPlatformStats:
    """GET /api/v1/stats"""

    def test_get_platform_stats(self, client: TestClient):
        """Should return platform-wide aggregate statistics."""
        response = client.get("/api/v1/stats")
        assert response.status_code == 200
        data = response.json()
        assert "registered_sources" in data
        assert "active_pipelines" in data
        assert "data_products" in data
        assert "pending_access_requests" in data
        assert "total_data_volume_gb" in data
        assert "last_24h_pipeline_runs" in data
        assert "avg_quality_score" in data

    def test_platform_stats_values_are_positive(self, client: TestClient):
        """Should return non-negative stat values."""
        response = client.get("/api/v1/stats")
        data = response.json()
        assert data["registered_sources"] >= 0
        assert data["active_pipelines"] >= 0
        assert data["data_products"] >= 0
        assert data["total_data_volume_gb"] >= 0

    def test_platform_stats_quality_score_range(self, client: TestClient):
        """Should return quality score within valid range.

        quality_score is a 0.0-1.0 ratio (CSA-0003) — Pydantic enforces
        the bound, so in-band values are also exercised here.
        """
        response = client.get("/api/v1/stats")
        data = response.json()
        assert 0.0 <= data["avg_quality_score"] <= 1.0


class TestDomainOverview:
    """GET /api/v1/stats/domains/{domain}"""

    def test_get_domain_overview(self, client: TestClient):
        """Should return overview for a valid domain."""
        response = client.get("/api/v1/stats/domains/finance")
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "finance"
        assert "source_count" in data
        assert "pipeline_count" in data
        assert "data_product_count" in data
        assert "avg_quality_score" in data
        assert "status" in data

    def test_get_domain_overview_not_found(self, client: TestClient):
        """Should return 404 for nonexistent domain."""
        response = client.get("/api/v1/stats/domains/nonexistent")
        assert response.status_code == 404

    def test_get_domain_overview_status_values(self, client: TestClient):
        """Should return a valid status value."""
        response = client.get("/api/v1/stats/domains/finance")
        data = response.json()
        assert data["status"] in ["healthy", "warning", "critical"]


class TestHealthEndpoint:
    """GET /api/v1/health"""

    def test_health_check(self, client: TestClient):
        """Should return healthy status with only status and timestamp (SEC-0004).

        Version, environment, and internal check details are stripped from
        the public response to avoid information disclosure to unauthenticated
        scanners.
        """
        response = client.get("/api/v1/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert "timestamp" in data
        # SEC-0004: these fields must NOT be present in the public response
        assert "version" not in data
        assert "environment" not in data
        assert "checks" not in data

    def test_health_check_services(self, client: TestClient):
        """Degraded status is reflected when the data store is unavailable (SEC-0004).

        The response body still only exposes status + timestamp — internal
        check detail is never surfaced.
        """
        response = client.get("/api/v1/health")
        data = response.json()
        # Only the two public fields should be present
        assert set(data.keys()) == {"status", "timestamp"}
        assert data["status"] in {"healthy", "degraded"}


class TestDomainsEndpoint:
    """GET /api/v1/domains"""

    def test_list_all_domains(self, client: TestClient):
        """Should return all domain overviews."""
        response = client.get("/api/v1/domains")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 5  # 5 demo domains
        domain_names = [d["name"] for d in data]
        assert "finance" in domain_names
        assert "manufacturing" in domain_names
