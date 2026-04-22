"""
Pytest configuration and shared fixtures for the CSA-in-a-Box shared backend tests.

Provides a FastAPI TestClient with mocked authentication so tests can
exercise endpoints without requiring Azure AD.

The async ``AsyncStoreBackend`` instances in
:mod:`portal.shared.api.dependencies` are the canonical persistence
surface.  The sync ``SqliteStore`` is used directly for clearing and
seeding test data (no event loop required) — both share the same
physical SQLite file.
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

    Stores use the default ``./data/portal.db`` path.  Both async
    endpoints and sync seeders share the same physical SQLite file.
    """
    from portal.shared.api import dependencies as deps

    _ = deps.all_stores()  # side-effect import; value not needed here

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
    """Clear all stores and re-seed demo data between tests.

    Uses lightweight sync ``SqliteStore`` handles for clearing and
    seeding — these share the same physical SQLite file as the async
    stores so async endpoints see the seeded rows.
    """
    from portal.shared.api.persistence import SqliteStore

    _sync_stores = {
        "sources": SqliteStore("sources.json"),
        "pipelines": SqliteStore("pipelines.json"),
        "runs": SqliteStore("pipeline_runs.json"),
        "access": SqliteStore("access_requests.json"),
        "products": SqliteStore("marketplace_products.json"),
        "quality": SqliteStore("marketplace_quality.json"),
    }

    for store in _sync_stores.values():
        store.clear()

    _seed_sources_sync(_sync_stores["sources"])
    _seed_pipelines_sync(_sync_stores["pipelines"], _sync_stores["runs"])
    _seed_access_sync(_sync_stores["access"])
    _seed_marketplace_sync(_sync_stores["products"], _sync_stores["quality"])

    yield

    for store in _sync_stores.values():
        store.clear()


# ── Sync demo-data seeders (test helpers) ──────────────────────────────────


def _seed_sources_sync(store: Any) -> None:
    from datetime import datetime, timezone

    from portal.shared.api.models.source import (
        ClassificationLevel,
        SourceRecord,
        SourceStatus,
        SourceType,
    )

    if store.count() > 0:
        return
    demos = [
        SourceRecord(
            id="src-001",
            name="HR Employee Records",
            description="Daily extract of employee master data from the HR system.",
            source_type=SourceType.AZURE_SQL,
            domain="human-resources",
            classification=ClassificationLevel.CONFIDENTIAL,
            connection={"host": "hr-sql.database.windows.net", "database": "HRData"},
            ingestion={"mode": "incremental", "schedule_cron": "0 2 * * *"},
            quality_rules=[
                {
                    "rule_name": "email_not_null",
                    "rule_type": "not_null",
                    "column": "email",
                    "parameters": {},
                    "severity": "error",
                },
            ],
            target={
                "landing_zone": "dlz-hr",
                "container": "bronze",
                "path_pattern": "hr/employees/{year}/{month}/{day}",
                "format": "delta",
            },
            owner={"name": "Jane Smith", "email": "jane.smith@contoso.com", "team": "People Analytics"},
            tags={"env": "prod", "pii": "true"},
            status=SourceStatus.ACTIVE,
            created_at=datetime(2025, 6, 15, tzinfo=timezone.utc),
            updated_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
            provisioned_at=datetime(2025, 6, 16, tzinfo=timezone.utc),
            pipeline_id="pl-hr-employees-batch",
        ),
        SourceRecord(
            id="src-002",
            name="IoT Sensor Telemetry",
            description="Real-time telemetry from manufacturing floor sensors.",
            source_type=SourceType.EVENT_HUB,
            domain="manufacturing",
            classification=ClassificationLevel.INTERNAL,
            connection={"host": "eh-mfg.servicebus.windows.net"},
            ingestion={"mode": "streaming"},
            quality_rules=[],
            target={
                "landing_zone": "dlz-mfg",
                "container": "bronze",
                "path_pattern": "mfg/telemetry/{year}/{month}/{day}/{hour}",
                "format": "delta",
            },
            owner={"name": "Bob Chen", "email": "bob.chen@contoso.com", "team": "Manufacturing IT"},
            tags={"env": "prod", "real-time": "true"},
            status=SourceStatus.ACTIVE,
            created_at=datetime(2025, 9, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 2, 20, tzinfo=timezone.utc),
            provisioned_at=datetime(2025, 9, 2, tzinfo=timezone.utc),
            pipeline_id="pl-mfg-telemetry-stream",
        ),
        SourceRecord(
            id="src-003",
            name="Finance GL Export",
            description="General Ledger export from SAP via REST API.",
            source_type=SourceType.REST_API,
            domain="finance",
            classification=ClassificationLevel.RESTRICTED,
            connection={"api_url": "https://sap-gateway.contoso.com/odata/v4/gl"},
            ingestion={"mode": "full", "schedule_cron": "0 4 * * 1"},
            quality_rules=[
                {
                    "rule_name": "amount_range",
                    "rule_type": "range",
                    "column": "amount",
                    "parameters": {"min": -1e9, "max": 1e9},
                    "severity": "warning",
                },
            ],
            target={
                "landing_zone": "dlz-finance",
                "container": "bronze",
                "path_pattern": "finance/gl/{year}/{month}",
                "format": "parquet",
            },
            owner={"name": "Alice Park", "email": "alice.park@contoso.com", "team": "Financial Reporting"},
            tags={"env": "prod", "compliance": "sox"},
            status=SourceStatus.APPROVED,
            created_at=datetime(2026, 1, 10, tzinfo=timezone.utc),
            updated_at=datetime(2026, 1, 12, tzinfo=timezone.utc),
        ),
        SourceRecord(
            id="src-004",
            name="Customer 360 - Cosmos",
            description="Customer profile data from Cosmos DB change feed.",
            source_type=SourceType.COSMOS_DB,
            domain="marketing",
            classification=ClassificationLevel.CONFIDENTIAL,
            connection={"host": "cosmos-cust360.documents.azure.com", "database": "customers", "container": "profiles"},
            ingestion={"mode": "cdc"},
            quality_rules=[],
            target={
                "landing_zone": "dlz-marketing",
                "container": "bronze",
                "path_pattern": "marketing/customers/{year}/{month}/{day}",
                "format": "delta",
            },
            owner={"name": "Carlos Diaz", "email": "carlos.diaz@contoso.com", "team": "Customer Insights"},
            tags={"env": "prod"},
            status=SourceStatus.DRAFT,
            created_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
        ),
    ]
    for s in demos:
        store.add(s.model_dump())


def _seed_pipelines_sync(store: Any, runs_store: Any) -> None:
    import random as _rng
    import uuid
    from datetime import datetime, timedelta, timezone

    from portal.shared.api.models.pipeline import (
        PipelineRecord,
        PipelineRun,
        PipelineStatus,
        PipelineType,
    )

    if store.count() > 0:
        return
    _rng.seed(42)
    now = datetime.now(timezone.utc)
    demos = [
        PipelineRecord(
            id="pl-001",
            name="pl-hr-employees-batch",
            source_id="src-001",
            pipeline_type=PipelineType.BATCH_COPY,
            status=PipelineStatus.SUCCEEDED,
            created_at=datetime(2025, 6, 16, tzinfo=timezone.utc),
            last_run_at=now - timedelta(hours=6),
            schedule_cron="0 2 * * *",
            adf_pipeline_id="/subscriptions/.../pipelines/pl-hr-employees-batch",
        ),
        PipelineRecord(
            id="pl-002",
            name="pl-mfg-telemetry-stream",
            source_id="src-002",
            pipeline_type=PipelineType.STREAMING,
            status=PipelineStatus.RUNNING,
            created_at=datetime(2025, 9, 2, tzinfo=timezone.utc),
            last_run_at=now - timedelta(minutes=5),
            adf_pipeline_id="/subscriptions/.../pipelines/pl-mfg-telemetry-stream",
        ),
        PipelineRecord(
            id="pl-003",
            name="pl-finance-gl-full",
            source_id="src-003",
            pipeline_type=PipelineType.BATCH_COPY,
            status=PipelineStatus.CREATED,
            created_at=datetime(2026, 1, 12, tzinfo=timezone.utc),
            schedule_cron="0 4 * * 1",
        ),
        PipelineRecord(
            id="pl-004",
            name="pl-marketing-cust360-cdc",
            source_id="src-004",
            pipeline_type=PipelineType.CDC,
            status=PipelineStatus.WAITING,
            created_at=datetime(2026, 4, 2, tzinfo=timezone.utc),
        ),
    ]
    for p in demos:
        store.add(p.model_dump())
    for i in range(5):
        run_start = now - timedelta(days=i, hours=2)
        run_end = run_start + timedelta(minutes=_rng.randint(3, 25))
        run = PipelineRun(
            id=f"run-{uuid.uuid4().hex[:8]}",
            pipeline_id="pl-001",
            status=PipelineStatus.SUCCEEDED if i != 2 else PipelineStatus.FAILED,
            started_at=run_start,
            ended_at=run_end,
            rows_read=_rng.randint(50_000, 200_000),
            rows_written=_rng.randint(49_000, 199_000),
            error_message="Connection timeout after 600s" if i == 2 else None,
            duration_seconds=int((run_end - run_start).total_seconds()),
        )
        runs_store.add(run.model_dump())


def _seed_access_sync(store: Any) -> None:
    from datetime import datetime, timedelta, timezone

    from portal.shared.api.models.marketplace import AccessRequest, AccessRequestStatus

    if store.count() > 0:
        return
    now = datetime.now(timezone.utc)
    demos = [
        AccessRequest(
            id="ar-001",
            requester_email="dev.team@contoso.com",
            data_product_id="dp-001",
            justification="Need employee data for headcount dashboard.",
            access_level="read",
            duration_days=90,
            status=AccessRequestStatus.APPROVED,
            requested_at=now - timedelta(days=30),
            reviewed_at=now - timedelta(days=29),
            reviewed_by="jane.smith@contoso.com",
            review_notes="Approved for read-only analytics.",
            expires_at=now + timedelta(days=60),
        ),
        AccessRequest(
            id="ar-002",
            requester_email="ml.team@contoso.com",
            data_product_id="dp-004",
            justification="Training customer churn prediction model.",
            access_level="read",
            duration_days=180,
            status=AccessRequestStatus.PENDING,
            requested_at=now - timedelta(days=2),
        ),
        AccessRequest(
            id="ar-003",
            requester_email="finance.analyst@contoso.com",
            data_product_id="dp-003",
            justification="Quarterly audit report generation.",
            access_level="read_write",
            duration_days=30,
            status=AccessRequestStatus.PENDING,
            requested_at=now - timedelta(hours=6),
        ),
        AccessRequest(
            id="ar-004",
            requester_email="extern.contractor@partner.com",
            data_product_id="dp-002",
            justification="Sensor data analysis for maintenance optimization.",
            access_level="read",
            duration_days=60,
            status=AccessRequestStatus.DENIED,
            requested_at=now - timedelta(days=10),
            reviewed_at=now - timedelta(days=9),
            reviewed_by="bob.chen@contoso.com",
            review_notes="External contractors require VPN + NDA first.",
        ),
    ]
    for ar in demos:
        store.add(ar.model_dump())


def _seed_marketplace_sync(store: Any, quality_store: Any) -> None:
    import random as _rng
    from datetime import datetime, timedelta, timezone

    from portal.shared.api.models.marketplace import DataProduct, QualityMetric
    from portal.shared.api.models.source import ClassificationLevel

    if store.count() > 0:
        return
    _rng.seed(42)
    now = datetime.now(timezone.utc)
    demos = [
        DataProduct(
            id="dp-001",
            name="Employee Master Data",
            description="Curated, PII-masked employee records refreshed daily.",
            domain="human-resources",
            owner={"name": "Jane Smith", "email": "jane.smith@contoso.com", "team": "People Analytics"},
            classification=ClassificationLevel.CONFIDENTIAL,
            quality_score=0.945,
            freshness_hours=6.2,
            completeness=0.97,
            availability=0.998,
            tags={"pii": "masked", "refresh": "daily"},
            created_at=datetime(2025, 7, 1, tzinfo=timezone.utc),
            updated_at=now - timedelta(hours=6),
            version="2.1.0",
            status="active",
        ),
        DataProduct(
            id="dp-002",
            name="Manufacturing Sensor Analytics",
            description="Aggregated sensor telemetry from the manufacturing floor.",
            domain="manufacturing",
            owner={"name": "Bob Chen", "email": "bob.chen@contoso.com", "team": "Manufacturing IT"},
            classification=ClassificationLevel.INTERNAL,
            quality_score=0.912,
            freshness_hours=0.1,
            completeness=0.99,
            availability=0.995,
            tags={"real-time": "true", "iot": "true"},
            created_at=datetime(2025, 10, 1, tzinfo=timezone.utc),
            updated_at=now - timedelta(minutes=5),
            version="1.3.0",
            status="active",
        ),
        DataProduct(
            id="dp-003",
            name="Financial General Ledger",
            description="Weekly GL snapshot for financial reporting. SOX-compliant.",
            domain="finance",
            owner={"name": "Alice Park", "email": "alice.park@contoso.com", "team": "Financial Reporting"},
            classification=ClassificationLevel.RESTRICTED,
            quality_score=0.981,
            freshness_hours=168.0,
            completeness=1.0,
            availability=0.999,
            tags={"compliance": "sox", "audit": "true"},
            created_at=datetime(2025, 4, 15, tzinfo=timezone.utc),
            updated_at=now - timedelta(days=3),
            version="3.0.0",
            status="active",
        ),
        DataProduct(
            id="dp-004",
            name="Customer 360 Profile",
            description="Unified customer view combining CRM, web analytics, and transaction data.",
            domain="marketing",
            owner={"name": "Carlos Diaz", "email": "carlos.diaz@contoso.com", "team": "Customer Insights"},
            classification=ClassificationLevel.CONFIDENTIAL,
            quality_score=0.873,
            freshness_hours=1.5,
            completeness=0.93,
            availability=0.992,
            tags={"cdp": "true"},
            created_at=datetime(2025, 11, 20, tzinfo=timezone.utc),
            updated_at=now - timedelta(hours=2),
        ),
        DataProduct(
            id="dp-005",
            name="Supply Chain Inventory",
            description="Real-time inventory levels across all warehouses.",
            domain="supply-chain",
            owner={"name": "Diana Torres", "email": "diana.torres@contoso.com", "team": "Supply Chain Ops"},
            classification=ClassificationLevel.INTERNAL,
            quality_score=0.928,
            freshness_hours=0.5,
            completeness=0.96,
            availability=0.997,
            tags={"warehouse": "all"},
            created_at=datetime(2026, 1, 5, tzinfo=timezone.utc),
            updated_at=now - timedelta(minutes=30),
        ),
    ]
    for dp in demos:
        store.add(dp.model_dump())
    for dp in demos:
        history: list[dict] = []
        for days_ago in range(30):
            date = (now - timedelta(days=days_ago)).strftime("%Y-%m-%d")
            score = max(0.0, min(1.0, dp.quality_score + _rng.uniform(-0.03, 0.02)))
            comp = max(0.0, min(1.0, dp.completeness + _rng.uniform(-0.03, 0.01)))
            history.append(
                QualityMetric(
                    date=date,
                    quality_score=score,
                    completeness=comp,
                    freshness_hours=max(0.0, dp.freshness_hours + _rng.uniform(-1, 2)),
                    row_count=_rng.randint(100_000, 5_000_000),
                ).model_dump(),
            )
        quality_store.add({"product_id": dp.id, "history": history})
