"""
Tests for the sources router — CRUD operations on data source registrations.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError


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


class TestProvisioningResultContract:
    """ProvisioningResult is an immutable DTO (CSA-0045 / AQ-0015).

    The service must return a frozen result that the caller applies to
    the record; the service itself must never mutate the input.
    """

    def test_provisioning_result_is_frozen(self):
        """Attempting to mutate a ProvisioningResult must raise."""
        from portal.shared.api.models.source import SourceStatus
        from portal.shared.api.services.provisioning import ProvisioningResult

        result = ProvisioningResult(
            success=True,
            message="ok",
            new_status=SourceStatus.PROVISIONING,
        )
        with pytest.raises(ValidationError):
            result.success = False  # type: ignore[misc]

    @pytest.mark.asyncio
    async def test_provision_does_not_mutate_input_on_success(self):
        """The service must not mutate the SourceRecord on success."""
        from portal.shared.api.models.source import (
            ConnectionConfig,
            OwnerInfo,
            SourceRecord,
            SourceStatus,
            SourceType,
            TargetConfig,
        )
        from portal.shared.api.services.provisioning import provisioning_service

        source = SourceRecord(
            id="src-test-nomutate",
            name="nomutate",
            source_type=SourceType.AZURE_SQL,
            domain="testing",
            connection=ConnectionConfig(host="h"),
            target=TargetConfig(),
            owner=OwnerInfo(name="T", email="t@t.com", team="T"),
            status=SourceStatus.APPROVED,
        )
        snapshot = source.model_dump()

        result = await provisioning_service.provision(source)

        # Service succeeded and returned a populated result ...
        assert result.success is True
        assert result.new_status == SourceStatus.PROVISIONING
        assert result.pipeline_id is not None
        assert result.scan_id is not None
        # ... but the input record is untouched.
        assert source.model_dump() == snapshot

    @pytest.mark.asyncio
    async def test_provision_validation_failure_does_not_raise(self):
        """Ineligible status yields a non-success result without raising."""
        from portal.shared.api.models.source import (
            ConnectionConfig,
            OwnerInfo,
            SourceRecord,
            SourceStatus,
            SourceType,
            TargetConfig,
        )
        from portal.shared.api.services.provisioning import provisioning_service

        source = SourceRecord(
            id="src-test-invalid",
            name="invalid",
            source_type=SourceType.AZURE_SQL,
            domain="testing",
            connection=ConnectionConfig(host="h"),
            target=TargetConfig(),
            owner=OwnerInfo(name="T", email="t@t.com", team="T"),
            status=SourceStatus.ACTIVE,  # not eligible for provisioning
        )

        result = await provisioning_service.provision(source)

        assert result.success is False
        assert result.new_status is None  # don't overwrite caller status
        assert "errors" in result.details

    @pytest.mark.asyncio
    async def test_provision_infrastructure_failure_returns_error_result(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Infra exceptions must be caught and surfaced as ERROR result.

        The service must not re-raise; it must return
        ``ProvisioningResult(success=False, new_status=ERROR, ...)`` with
        structured error details and have logged the stack trace.
        """
        from portal.shared.api.models.source import (
            ConnectionConfig,
            OwnerInfo,
            SourceRecord,
            SourceStatus,
            SourceType,
            TargetConfig,
        )
        from portal.shared.api.services import provisioning as provisioning_module

        async def _boom(self, source):  # pragma: no cover - trivial stub
            raise RuntimeError("ADF unreachable")

        monkeypatch.setattr(
            provisioning_module.ProvisioningService,
            "create_adf_pipeline",
            _boom,
        )

        source = SourceRecord(
            id="src-test-infraerr",
            name="infraerr",
            source_type=SourceType.AZURE_SQL,
            domain="testing",
            connection=ConnectionConfig(host="h"),
            target=TargetConfig(),
            owner=OwnerInfo(name="T", email="t@t.com", team="T"),
            status=SourceStatus.APPROVED,
        )
        snapshot = source.model_dump()

        result = await provisioning_module.provisioning_service.provision(source)

        assert result.success is False
        assert result.new_status == SourceStatus.ERROR
        assert result.details["error_type"] == "RuntimeError"
        assert "ADF unreachable" in result.details["error_message"]
        # Input must still be untouched on failure.
        assert source.model_dump() == snapshot


class TestProvisionSourceRouter:
    """POST /api/v1/sources/{source_id}/provision — router wiring."""

    def test_provision_success_applies_result_and_persists(
        self, client: TestClient
    ):
        """Router must apply ProvisioningResult fields and persist them."""
        client.get("/api/v1/sources")  # seed
        # src-003 is in APPROVED status — eligible for provisioning.
        response = client.post("/api/v1/sources/src-003/provision")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["pipeline_id"] is not None
        assert body["scan_id"] is not None

        # The record must now reflect the service result.
        fetched = client.get("/api/v1/sources/src-003").json()
        assert fetched["status"] == "provisioning"
        assert fetched["pipeline_id"] == body["pipeline_id"]
        assert fetched["purview_scan_id"] == body["scan_id"]

    def test_provision_validation_failure_returns_400(self, client: TestClient):
        """Ineligible source (ACTIVE) must yield a 400 without mutating."""
        client.get("/api/v1/sources")  # seed
        # src-001 is ACTIVE — not eligible.
        response = client.post("/api/v1/sources/src-001/provision")
        assert response.status_code == 400

    def test_provision_infrastructure_failure_returns_502(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ):
        """Infra error from the service must surface as HTTP 502."""
        from portal.shared.api.services import provisioning as provisioning_module

        async def _boom(self, source):  # pragma: no cover - trivial stub
            raise RuntimeError("Purview offline")

        monkeypatch.setattr(
            provisioning_module.ProvisioningService,
            "trigger_purview_scan",
            _boom,
        )

        client.get("/api/v1/sources")  # seed
        response = client.post("/api/v1/sources/src-003/provision")
        assert response.status_code == 502

        # The record should have been marked ERROR by the router
        # applying the service's ERROR result.
        fetched = client.get("/api/v1/sources/src-003").json()
        assert fetched["status"] == "error"
