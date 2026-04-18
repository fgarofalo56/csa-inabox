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
from pydantic import BaseModel, Field

from ..models.source import (
    ClassificationLevel,
    ConnectionConfig,
    IngestionConfig,
    OwnerInfo,
    QualityRule,
    SchemaDefinition,
    SourceRecord,
    SourceRegistration,
    SourceStatus,
    SourceType,
    TargetConfig,
)
from ..persistence import SqliteStore
from ..services.auth import DomainScope, get_domain_scope, require_role
from ..services.provisioning import provisioning_service

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Domain-scoping helpers ─────────────────────────────────────────────────
#
# Non-Admin users are scoped to sources whose ``domain`` matches the
# ``domain`` / ``team`` claim on their JWT.  Read paths filter; write
# paths must explicitly assert that the target source (and, for POST, the
# requested domain) belongs to the user's scope.


def _assert_user_can_access_domain(user: dict, domain: str) -> None:
    """Raise 403 unless the user is an Admin or owns the given domain."""
    user_roles = user.get("roles", [])
    user_domain = user.get("domain") or user.get("team")
    if "Admin" in user_roles:
        return
    if user_domain is None:
        # User has no domain claim — only Admins can act cross-domain.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Your identity does not carry a domain claim; request an "
                "Admin role or a domain assignment to register / modify "
                "sources."
            ),
        )
    if user_domain != domain:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to sources outside your domain.",
        )


def _load_source_with_domain_check(source_id: str, user: dict) -> SourceRecord:
    """Fetch a source by id, enforcing domain scoping against ``user``."""
    stored = _sources_store.get(source_id)
    if not stored:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source '{source_id}' not found.",
        )
    source = SourceRecord.model_validate(stored)
    _assert_user_can_access_domain(user, source.domain)
    return source


# ── Request Models ─────────────────────────────────────────────────────────


class SourceUpdate(BaseModel):
    """Allowed fields for a partial source update (PATCH)."""

    name: str | None = None
    description: str | None = None
    domain: str | None = None
    classification: ClassificationLevel | None = None
    connection: ConnectionConfig | None = None
    schema_def: SchemaDefinition | None = Field(None, alias="schema")
    ingestion: IngestionConfig | None = None
    quality_rules: list[QualityRule] | None = None
    target: TargetConfig | None = None
    owner: OwnerInfo | None = None
    tags: dict[str, str] | None = None

    model_config = {"populate_by_name": True}

# ── SQLite persistence ──────────────────────────────────────────────────────
_sources_store = SqliteStore("sources.json")


def get_store() -> SqliteStore:
    """Return the sources store instance (public accessor for cross-router use)."""
    return _sources_store


def seed_demo_sources() -> None:
    """Populate a handful of realistic demo sources on first access.

    Called once at application startup from the lifespan handler.
    """
    if _sources_store.count() > 0:
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
        _sources_store.add(s.model_dump())


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
    scope: DomainScope = Depends(get_domain_scope),
) -> list[SourceRecord]:
    """Return all registered data sources, with optional filters."""
    results = [SourceRecord.model_validate(item) for item in _sources_store.load()]

    # Domain scoping: non-admin users only see their domain's sources.
    # When a non-admin has no domain claim (e.g. demo mode), return empty
    # rather than leaking data across all domains (SEC-0005).
    if not scope.is_admin:
        if not scope.user_domain:
            return []
        results = [s for s in results if s.domain == scope.user_domain]

    if domain:
        results = [s for s in results if s.domain == domain]
    if status_filter:
        results = [s for s in results if s.status == status_filter]
    if source_type:
        results = [s for s in results if s.source_type == source_type]
    if search:
        q = search.lower()
        results = [s for s in results if q in s.name.lower() or q in s.description.lower()]

    return results[offset : offset + limit]


@router.get(
    "/{source_id}",
    response_model=SourceRecord,
    summary="Get a data source by ID",
)
async def get_source(
    source_id: str,
    scope: DomainScope = Depends(get_domain_scope),
) -> SourceRecord:
    """Return a single data source by its unique identifier."""
    stored_source = _sources_store.get(source_id)
    if not stored_source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source '{source_id}' not found.",
        )
    source = SourceRecord.model_validate(stored_source)

    # Domain scoping: non-admin users can only access their domain's sources.
    # A non-admin with no domain claim is denied regardless of the source domain.
    if not scope.is_admin and (not scope.user_domain or source.domain != scope.user_domain):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this source.",
        )

    return source


@router.post(
    "",
    response_model=SourceRecord,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new data source",
)
async def register_source(
    registration: SourceRegistration,
    user: dict = Depends(require_role("Contributor", "Admin")),
) -> SourceRecord:
    """Register a new data source in the platform.

    The source is created in *draft* status.  Use ``/provision`` to trigger
    infrastructure deployment once the registration is approved.

    Non-admin users may only register sources within their own domain.
    """
    _assert_user_can_access_domain(user, registration.domain)

    source_id = str(uuid.uuid4())
    record = SourceRecord(
        id=source_id,
        **registration.model_dump(by_alias=True),
    )
    # Persist to JSON store
    _sources_store.add(record.model_dump())
    logger.info(
        "Registered data source",
        extra={
            "source_id": source_id,
            "name": registration.name,
            "type": registration.source_type.value,
            "domain": registration.domain,
            "user": user.get("preferred_username", user.get("sub", "unknown")),
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
    updates: SourceUpdate,
    user: dict = Depends(require_role("Contributor", "Admin")),
) -> SourceRecord:
    """Apply a partial update to an existing source registration.

    Non-admin users may only update sources within their own domain.
    """
    existing = _load_source_with_domain_check(source_id, user)
    existing_data = existing.model_dump(by_alias=True)
    existing_data.update(updates.model_dump(exclude_unset=True))
    existing_data["updated_at"] = datetime.now(timezone.utc)

    updated = SourceRecord(**existing_data)
    _sources_store.update(source_id, updated.model_dump())
    logger.info(
        "Updated data source",
        extra={
            "source_id": source_id,
            "user": user.get("preferred_username", user.get("sub", "unknown")),
        },
    )
    return updated


@router.post(
    "/{source_id}/decommission",
    response_model=SourceRecord,
    summary="Decommission a data source",
)
async def decommission_source(
    source_id: str,
    user: dict = Depends(require_role("Contributor", "Admin")),
) -> SourceRecord:
    """Soft-delete a data source by setting its status to *decommissioned*.

    Non-admin users may only decommission sources within their own domain.
    """
    source = _load_source_with_domain_check(source_id, user)
    source.status = SourceStatus.DECOMMISSIONED
    source.updated_at = datetime.now(timezone.utc)
    _sources_store.update(source_id, source.model_dump())
    logger.info(
        "Decommissioned source",
        extra={
            "source_id": source_id,
            "user": user.get("preferred_username", user.get("sub", "unknown")),
        },
    )
    return source


@router.post(
    "/{source_id}/provision",
    summary="Trigger DLZ provisioning",
)
async def provision_source(
    source_id: str,
    user: dict = Depends(require_role("Contributor", "Admin")),
) -> dict:
    """Trigger the full Data Landing Zone provisioning workflow.

    Deploys infrastructure, creates ADF pipeline, and triggers Purview
    scan.  Non-admin users may only provision sources within their own
    domain.

    The provisioning service returns a :class:`ProvisioningResult` with
    the new field values; this handler applies them to the record and
    persists the update so the service never mutates the input directly.
    """
    source = _load_source_with_domain_check(source_id, user)

    try:
        result = await provisioning_service.provision(source)
    except Exception as exc:
        # Unexpected infrastructure error — persist error state and re-raise
        # as an HTTP 502 so the caller gets a meaningful response.
        logger.exception("Provisioning failed for source %s", source_id)
        _sources_store.update(source_id, {
            "status": SourceStatus.ERROR.value,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Provisioning failed due to an infrastructure error. Check server logs.",
        ) from exc

    if not result.success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.message,
        )

    # Apply the result fields returned by the service and persist.
    update_payload: dict = {}
    if result.new_status is not None:
        update_payload["status"] = result.new_status.value
    if result.pipeline_id is not None:
        update_payload["pipeline_id"] = result.pipeline_id
    if result.scan_id is not None:
        update_payload["purview_scan_id"] = result.scan_id
    if result.updated_at is not None:
        update_payload["updated_at"] = result.updated_at.isoformat()
    if update_payload:
        _sources_store.update(source_id, update_payload)

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
    user: dict = Depends(require_role("Contributor", "Admin")),
) -> dict:
    """Trigger a Microsoft Purview metadata scan for this source.

    Non-admin users may only scan sources within their own domain.
    """
    source = _load_source_with_domain_check(source_id, user)

    try:
        scan_id = await provisioning_service.trigger_purview_scan(source)
    except Exception as exc:
        logger.exception("Purview scan failed for source %s", source_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Purview scan failed due to an infrastructure error. Check server logs.",
        ) from exc

    source.purview_scan_id = scan_id
    source.updated_at = datetime.now(timezone.utc)
    _sources_store.update(source_id, source.model_dump())

    return {"status": "scanning", "scan_id": scan_id}
