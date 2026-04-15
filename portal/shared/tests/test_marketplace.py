"""
Tests for the marketplace router — data product discovery and quality metrics.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


class TestListProducts:
    """GET /api/v1/marketplace/products"""

    def test_list_products_returns_demo_data(self, client: TestClient):
        """Should return seeded demo data products."""
        response = client.get("/api/v1/marketplace/products")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 5  # 5 demo products

    def test_list_products_filter_by_domain(self, client: TestClient):
        """Should filter products by domain."""
        client.get("/api/v1/marketplace/products")  # seed
        response = client.get("/api/v1/marketplace/products", params={"domain": "finance"})
        assert response.status_code == 200
        data = response.json()
        assert all(p["domain"] == "finance" for p in data)

    def test_list_products_filter_by_quality(self, client: TestClient):
        """Should filter products by minimum quality score."""
        client.get("/api/v1/marketplace/products")  # seed
        response = client.get("/api/v1/marketplace/products", params={"min_quality": 95})
        assert response.status_code == 200
        data = response.json()
        assert all(p["quality_score"] >= 95 for p in data)

    def test_list_products_search(self, client: TestClient):
        """Should search products by name or description."""
        client.get("/api/v1/marketplace/products")  # seed
        response = client.get("/api/v1/marketplace/products", params={"search": "employee"})
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 1

    def test_list_products_sorted_by_quality(self, client: TestClient):
        """Should return products sorted by quality score descending."""
        response = client.get("/api/v1/marketplace/products")
        data = response.json()
        scores = [p["quality_score"] for p in data]
        assert scores == sorted(scores, reverse=True)


class TestGetProduct:
    """GET /api/v1/marketplace/products/{product_id}"""

    def test_get_product_by_id(self, client: TestClient):
        """Should return a single data product."""
        client.get("/api/v1/marketplace/products")  # seed
        response = client.get("/api/v1/marketplace/products/dp-001")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "dp-001"
        assert data["name"] == "Employee Master Data"

    def test_get_product_not_found(self, client: TestClient):
        """Should return 404 for nonexistent product."""
        client.get("/api/v1/marketplace/products")  # seed
        response = client.get("/api/v1/marketplace/products/nonexistent")
        assert response.status_code == 404


class TestQualityHistory:
    """GET /api/v1/marketplace/products/{product_id}/quality"""

    def test_get_quality_history(self, client: TestClient):
        """Should return quality metric history for a product."""
        client.get("/api/v1/marketplace/products")  # seed
        response = client.get("/api/v1/marketplace/products/dp-001/quality")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) > 0
        assert "quality_score" in data[0]
        assert "date" in data[0]

    def test_get_quality_history_not_found(self, client: TestClient):
        """Should return 404 for nonexistent product."""
        client.get("/api/v1/marketplace/products")  # seed
        response = client.get("/api/v1/marketplace/products/nonexistent/quality")
        assert response.status_code == 404


class TestDomains:
    """GET /api/v1/marketplace/domains"""

    def test_list_domains(self, client: TestClient):
        """Should return domains with product counts."""
        response = client.get("/api/v1/marketplace/domains")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert all("name" in d and "product_count" in d for d in data)


class TestMarketplaceStats:
    """GET /api/v1/marketplace/stats"""

    def test_marketplace_stats(self, client: TestClient):
        """Should return aggregate marketplace statistics."""
        response = client.get("/api/v1/marketplace/stats")
        assert response.status_code == 200
        data = response.json()
        assert "total_products" in data
        assert "total_domains" in data
        assert "avg_quality_score" in data
