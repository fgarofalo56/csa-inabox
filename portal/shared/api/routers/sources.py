"""
Data source registration and management router.

Endpoints
---------
GET    /api/v1/sources                     — list with filtering
GET    /api/v1/sources/{source_id}         — get single source
POST   /api/v1/sources                     — register new source
PATCH  /api/v1/sources/{source_id}         — partial update
POST   /api/v1/sources/{source_id}/decommission  — decommission
POST   /api/v1/sources/{source_id}/provision     — trigger DLZ provisioning
POST   /api/v1/sources/{source_id}/scan          — trigger Purview scan
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..models.source import (
    ClassificationLevel,
    SourceRecord,
    SourceRegistration,
    SourceStatus,
    SourceType,
)
from ..services.auth import get_current_user, require_role
from ..services.provisioning import provisioning_service

logger = logging.getLogger(__name__)
router = APIRouter()

# ── In-memory store (demo) ───────────────────────────────────────────────────
# TODO: Replace with Cosmos DB / PostgreSQL repository class.
_sources: dict[str, SourceRecord] = {}


def _seed_demo_sources() -> None:
    """Populate a handful of realistic demo sources on first access."""
    if _sources:
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
                {"rule_name": "email_not_null", "rule_type": "not_null", "column": "email", "parameters": {}, "severity": "error"},
            ],
            target={"landing_zone": "dlz-hr", "container": "bronze", "path_pattern": "hr/employees/{year}/{month}/{day}", "format": "delta"},
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
            target={"landing_zone": "dlz-mfg", "container": "bronze", "path_pattern": "mfg/telemetry/{year}/{month}/{day}/{hour}", "format": "delta"},
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
                {"rule_name": "amount_range", "rule_type": "range", "column": "amount", "parameters": {"min": -1e9, "max": 1e9}, "severity": "warning"},
            ],
            target={"landing_zone": "dlz-finance", "container": "bronze", "path_pattern": "finance/gl/{year}/{month}", "format": "parquet"},
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
            target={"landing_zone": "dlz-marketing", "container": "bronze", "path_pattern": "marketing/customers/{year}/{month}/{day}", "format": "delta"},
            owner={"name": "Carlos Diaz", "email": "carlos.diaz@contoso.com", "team": "Customer Insights"},
            tags={"env": "prod"},
            status=SourceStatus.DRAFT,
            created_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
        ),
    ]
    for s in demos:
        _sources[s.id] = s


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[SourceRecord],
    summary="List registered data sources",
)
async def list_sources(
    domain: str | None = None,
    status_filter: SourceStatus | None = Query(None, alias="status"),
    source_type: SourceType | None = None,
    search: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: dict = Depends(get_current_user),
) -> list[SourceRecord]:
    """Return all registered data sources, with optional filters."""
    _seed_demo_sources()
    results = list(_sources.values())

    if domain:
        results = [s for s in results if s.domain == domain]
    if status_filter:
        results = [s for s in results if s.status == status_filter]
    if source_type:
        results = [s for s in results if s.source_type == source_type]
    if search:
        q = search.lower()
        results = [
            s for s in results
            if q in s.name.lower() or q in s.description.lower()
        ]

    return results[offset: offset + limit]


@router.get(
    "/{source_id}",
    response_model=SourceRecord,
    summary="Get a data source by ID",
)
async def get_source(
    source_id: str,
    _user: dict = Depends(get_current_user),
) -> SourceRecord:
    """Return a single data source by its unique identifier."""
    _seed_demo_sources()
    if source_id not in _sources:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source '{source_id}' not found.",
        )
    return _sources[source_id]


@router.post(
    "",
    response_model=SourceRecord,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new data source",
)
async def register_source(
    registration: SourceRegistration,
    _user: dict = Depends(get_current_user),
) -> SourceRecord:
    """Register a new data source in the platform.

    The source is created in *draft* status.  Use ``/provision`` to trigger
    infrastructure deployment once the registration is approved.
    """
    source_id = str(uuid.uuid4())
    record = SourceRecord(
        id=source_id,
        **registration.model_dump(by_alias=True),
    )
    # TODO: Persist to database
    _sources[source_id] = record
    logger.info(
        "Registered data source",
        extra={
            "source_id": source_id,
            "name": registration.name,
            "type": registration.source_type.value,
            "domain": registration.domain,
        },
    )
    return record


@router.patch(
    "/{source_id}",
    response_model=SourceRecord,
    summary="Update a data source",
)
async def update_source(
    source_id: str,
    updates: dict,
    _user: dict = Depends(get_current_user),
) -> SourceRecord:
    """Apply a partial update to an existing source registration."""
    _seed_demo_sources()
    if source_id not in _sources:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source '{source_id}' not found.",
        )

    existing = _sources[source_id]
    existing_data = existing.model_dump(by_alias=True)
    existing_data.update(updates)
    existing_data["updated_at"] = datetime.now(timezone.utc)

    updated = SourceRecord(**existing_data)
    _sources[source_id] = updated
    return updated


@router.post(
    "/{source_id}/decommission",
    response_model=SourceRecord,
    summary="Decommission a data source",
)
async def decommission_source(
    source_id: str,
    _user: dict = Depends(require_role("Contributor", "Admin")),
) -> SourceRecord:
    """Soft-delete a data source by setting its status to *decommissioned*."""
    _seed_demo_sources()
    if source_id not in _sources:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source '{source_id}' not found.",
        )

    source = _sources[source_id]
    source.status = SourceStatus.DECOMMISSIONED
    source.updated_at = datetime.now(timezone.utc)
    logger.info("Decommissioned source %s", source_id)
    return source


@router.post(
    "/{source_id}/provision",
    summary="Trigger DLZ provisioning",
)
async def provision_source(
    source_id: str,
    _user: dict = Depends(require_role("Contributor", "Admin")),
) -> dict:
    """Trigger the full Data Landing Zone provisioning workflow.

    Deploys infrastructure, creates ADF pipeline, and triggers Purview scan.
    """
    _seed_demo_sources()
    if source_id not in _sources:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source '{source_id}' not found.",
        )

    source = _sources[source_id]
    result = await provisioning_service.provision(source)

    if not result.success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.message,
        )

    return {
        "status": "provisioning",
        "message": result.message,
        **result.to_dict(),
    }


@router.post(
    "/{source_id}/scan",
    summary="Trigger Purview scan",
)
async def scan_source(
    source_id: str,
    _user: dict = Depends(require_role("Contributor", "Admin")),
) -> dict:
    """Trigger a Microsoft Purview metadata scan for this source."""
    _seed_demo_sources()
    if source_id not in _sources:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source '{source_id}' not found.",
        )

    source = _sources[source_id]
    scan_id = await provisioning_service.trigger_purview_scan(source)
    source.purview_scan_id = scan_id
    source.updated_at = datetime.now(timezone.utc)

    return {"status": "scanning", "scan_id": scan_id}
