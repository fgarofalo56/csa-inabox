"""
Tests for the pipelines router — pipeline listing, details, and triggering.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


class TestListPipelines:
    """GET /api/v1/pipelines"""

    def test_list_pipelines_returns_demo_data(self, client: TestClient):
        """Should return seeded demo pipelines."""
        response = client.get("/api/v1/pipelines")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 4  # 4 demo pipelines

    def test_list_pipelines_filter_by_status(self, client: TestClient):
        """Should filter pipelines by status."""
        client.get("/api/v1/pipelines")  # seed
        response = client.get("/api/v1/pipelines", params={"status": "running"})
        assert response.status_code == 200
        data = response.json()
        assert all(p["status"] == "running" for p in data)

    def test_list_pipelines_filter_by_source(self, client: TestClient):
        """Should filter pipelines by source_id."""
        client.get("/api/v1/pipelines")  # seed
        response = client.get("/api/v1/pipelines", params={"source_id": "src-001"})
        assert response.status_code == 200
        data = response.json()
        assert all(p["source_id"] == "src-001" for p in data)

    def test_list_pipelines_limit(self, client: TestClient):
        """Should respect the limit parameter."""
        client.get("/api/v1/pipelines")  # seed
        response = client.get("/api/v1/pipelines", params={"limit": 2})
        assert response.status_code == 200
        data = response.json()
        assert len(data) <= 2


class TestGetPipeline:
    """GET /api/v1/pipelines/{pipeline_id}"""

    def test_get_pipeline_by_id(self, client: TestClient):
        """Should return a single pipeline."""
        client.get("/api/v1/pipelines")  # seed
        response = client.get("/api/v1/pipelines/pl-001")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "pl-001"
        assert data["name"] == "pl-hr-employees-batch"

    def test_get_pipeline_not_found(self, client: TestClient):
        """Should return 404 for nonexistent pipeline."""
        client.get("/api/v1/pipelines")  # seed
        response = client.get("/api/v1/pipelines/nonexistent")
        assert response.status_code == 404


class TestPipelineRuns:
    """GET /api/v1/pipelines/{pipeline_id}/runs"""

    def test_get_pipeline_runs(self, client: TestClient):
        """Should return runs for a pipeline."""
        client.get("/api/v1/pipelines")  # seed
        response = client.get("/api/v1/pipelines/pl-001/runs")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 1

    def test_get_pipeline_runs_not_found(self, client: TestClient):
        """Should return 404 for nonexistent pipeline."""
        client.get("/api/v1/pipelines")  # seed
        response = client.get("/api/v1/pipelines/nonexistent/runs")
        assert response.status_code == 404


class TestTriggerPipeline:
    """POST /api/v1/pipelines/{pipeline_id}/trigger"""

    def test_trigger_pipeline_creates_run(self, client: TestClient):
        """Should trigger a new pipeline run."""
        client.get("/api/v1/pipelines")  # seed
        response = client.post("/api/v1/pipelines/pl-001/trigger")
        assert response.status_code == 200
        data = response.json()
        assert data["pipeline_id"] == "pl-001"
        assert data["status"] == "running"
        assert "id" in data

    def test_trigger_pipeline_not_found(self, client: TestClient):
        """Should return 404 for nonexistent pipeline."""
        client.get("/api/v1/pipelines")  # seed
        response = client.post("/api/v1/pipelines/nonexistent/trigger")
        assert response.status_code == 404
