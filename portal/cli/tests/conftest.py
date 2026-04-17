"""Shared fixtures for CLI unit tests.

All tests use Click's ``CliRunner`` and mock :class:`APIClient` so no
running backend is required.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner

from portal.cli.__main__ import cli
from portal.cli.client import APIClient


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def runner() -> CliRunner:
    """Provide an isolated Click test runner."""
    return CliRunner()


@pytest.fixture
def mock_client(monkeypatch) -> MagicMock:
    """Patch APIClient so CLI tests never make real HTTP calls.

    Returns the mock instance; callers can configure return values via
    ``mock_client.list_sources.return_value = [...]``.

    We use sys.modules to get the actual module objects rather than
    ``import portal.cli.commands.sources``, which would resolve to the
    re-exported Click Group of the same name from commands/__init__.py.
    """
    import sys

    # Ensure the modules are imported so they appear in sys.modules.
    import portal.cli.commands  # noqa: F401  (triggers submodule imports)

    _sources_mod = sys.modules["portal.cli.commands.sources"]
    _pipelines_mod = sys.modules["portal.cli.commands.pipelines"]
    _marketplace_mod = sys.modules["portal.cli.commands.marketplace"]
    _stats_mod = sys.modules["portal.cli.commands.stats"]

    mock = MagicMock(spec=APIClient)
    monkeypatch.setattr(_sources_mod, "APIClient", lambda **_: mock)
    monkeypatch.setattr(_pipelines_mod, "APIClient", lambda **_: mock)
    monkeypatch.setattr(_marketplace_mod, "APIClient", lambda **_: mock)
    monkeypatch.setattr(_stats_mod, "APIClient", lambda **_: mock)
    return mock


# ── Sample data ────────────────────────────────────────────────────────────────


SAMPLE_SOURCE: dict = {
    "id": "src-001",
    "name": "HR Employee Records",
    "source_type": "azure_sql",
    "domain": "human-resources",
    "status": "active",
    "classification": "confidential",
    "description": "Daily extract of employee master data.",
    "pipeline_id": "pl-hr-employees-batch",
    "created_at": "2025-06-15T00:00:00",
    "updated_at": "2026-03-01T00:00:00",
    "provisioned_at": "2025-06-16T00:00:00",
    "owner": {"name": "Jane Smith", "email": "jane.smith@contoso.com", "team": "People Analytics"},
    "tags": {"env": "prod", "pii": "true"},
}

SAMPLE_PIPELINE: dict = {
    "id": "pl-001",
    "name": "pl-hr-employees-batch",
    "pipeline_type": "batch_copy",
    "status": "succeeded",
    "source_id": "src-001",
    "schedule_cron": "0 2 * * *",
    "adf_pipeline_id": "/subscriptions/.../pipelines/pl-hr-employees-batch",
    "created_at": "2025-06-16T00:00:00",
    "last_run_at": "2026-04-17T06:00:00",
}

SAMPLE_RUN: dict = {
    "id": "run-abc12345",
    "pipeline_id": "pl-001",
    "status": "succeeded",
    "started_at": "2026-04-17T06:00:00",
    "ended_at": "2026-04-17T06:10:00",
    "duration_seconds": 600,
    "rows_read": 150000,
    "rows_written": 149800,
    "error_message": None,
}

SAMPLE_PRODUCT: dict = {
    "id": "dp-001",
    "name": "Employee Master Data",
    "domain": "human-resources",
    "status": "active",
    "classification": "confidential",
    "quality_score": 94.5,
    "freshness_hours": 6.2,
    "completeness": 0.97,
    "availability": 0.998,
    "version": "2.1.0",
    "description": "Curated PII-masked employee records refreshed daily.",
    "updated_at": "2026-04-17T06:00:00",
    "owner": {"name": "Jane Smith", "email": "jane.smith@contoso.com"},
    "tags": {"pii": "masked"},
    "lineage": {
        "upstream": ["workday-hris-raw"],
        "downstream": ["workforce-analytics"],
    },
}

SAMPLE_QUALITY: list[dict] = [
    {
        "date": "2026-04-17",
        "quality_score": 94.5,
        "completeness": 0.97,
        "freshness_hours": 6.2,
        "row_count": 500000,
    },
    {
        "date": "2026-04-16",
        "quality_score": 93.1,
        "completeness": 0.96,
        "freshness_hours": 6.5,
        "row_count": 498000,
    },
]

SAMPLE_STATS: dict = {
    "registered_sources": 4,
    "active_pipelines": 4,
    "data_products": 5,
    "pending_access_requests": 2,
    "total_data_volume_gb": 300.0,
    "last_24h_pipeline_runs": 3,
    "avg_quality_score": 92.8,
}

SAMPLE_DOMAINS: list[dict] = [
    {
        "name": "finance",
        "source_count": 1,
        "pipeline_count": 1,
        "data_product_count": 1,
        "avg_quality_score": 98.1,
        "status": "healthy",
    },
    {
        "name": "human-resources",
        "source_count": 1,
        "pipeline_count": 1,
        "data_product_count": 1,
        "avg_quality_score": 94.5,
        "status": "healthy",
    },
]
