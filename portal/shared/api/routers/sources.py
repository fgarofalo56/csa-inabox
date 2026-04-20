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

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from csa_platform.common.audit import audit_event_from_request, audit_logger

from ..config import settings
from ..dependencies import get_sources_store
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
from ..persistence import StoreBackend
from ..persistence_async import AsyncStoreBackend
from ..persistence_factory import build_store_backend
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


async def _load_source_with_domain_check(
    source_id: str,
    user: dict,
    store: AsyncStoreBackend,
) -> SourceRecord:
    """Fetch a source by id, enforcing domain scoping against ``user``."""
    stored = await store.get(source_id)
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

# ── Persistence ─────────────────────────────────────────────────────────────
# Backend selection (SQLite vs Postgres) is centralised in the async
# factory and driven by ``settings.DATABASE_URL``.  Routers depend on
# the AsyncStoreBackend Protocol via FastAPI ``Depends`` — see ADR-0016.
#
# The sync ``_sources_store`` module-level singleton below is retained
# as a transitional compatibility layer for (a) the stats router that
# computes aggregates synchronously and (b) the existing
# test_persistence*.py suite that patches it directly.  New code should
# use ``from ..dependencies import get_sources_store`` and ``Depends``.
_sources_store: StoreBackend = build_store_backend("sources.json", settings)


def get_store() -> StoreBackend:
    """Return the sync sources store (compat; new code uses async DI)."""
    return _sources_store


async def seed_demo_sources() -> None:
    """Populate a handful of realistic demo sources on first access.

    Called once at application startup from the lifespan handler.  Uses
    the async store so startup participates in the same event loop as
    the routes.
    """
    async_store = get_sources_store()
    if await async_store.count() > 0:
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
        await async_store.add(s.model_dump())


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
    store: AsyncStoreBackend = Depends(get_sources_store),
) -> list[SourceRecord]:
    """Return all registered data sources, with optional filters."""
    results = [SourceRecord.model_validate(item) for item in await store.load()]

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
    store: AsyncStoreBackend = Depends(get_sources_store),
) -> SourceRecord:
    """Return a single data source by its unique identifier."""
    stored_source = await store.get(source_id)
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
    request: Request,
    user: dict = Depends(require_role("Contributor", "Admin")),
    store: AsyncStoreBackend = Depends(get_sources_store),
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
    await store.add(record.model_dump())

    # Tamper-evident audit sink (CSA-0016) — source registration is an
    # authorised state-changing operation that affects downstream
    # provisioning and data governance.
    audit_logger.emit(
        audit_event_from_request(
            request=request,
            user=user,
            action="source.register",
            resource={
                "type": "source",
                "id": source_id,
                "domain": registration.domain,
                "classification": registration.classification.value
                if registration.classification
                else None,
            },
            outcome="success",
            after={
                "name": registration.name,
                "source_type": registration.source_type.value,
                "status": record.status.value,
            },
        )
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
    store: AsyncStoreBackend = Depends(get_sources_store),
) -> SourceRecord:
    """Apply a partial update to an existing source registration.

    Non-admin users may only update sources within their own domain.
    """
    existing = await _load_source_with_domain_check(source_id, user, store)
    existing_data = existing.model_dump(by_alias=True)
    existing_data.update(updates.model_dump(exclude_unset=True))
    existing_data["updated_at"] = datetime.now(timezone.utc)

    updated = SourceRecord(**existing_data)
    await store.update(source_id, updated.model_dump())
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
    request: Request,
    user: dict = Depends(require_role("Contributor", "Admin")),
    store: AsyncStoreBackend = Depends(get_sources_store),
) -> SourceRecord:
    """Soft-delete a data source by setting its status to *decommissioned*.

    Non-admin users may only decommission sources within their own domain.
    """
    source = await _load_source_with_domain_check(source_id, user, store)
    previous_status = source.status
    source.status = SourceStatus.DECOMMISSIONED
    source.updated_at = datetime.now(timezone.utc)
    await store.update(source_id, source.model_dump())

    # Tamper-evident audit sink (CSA-0016) — decommission is a
    # security-relevant terminal state transition.
    audit_logger.emit(
        audit_event_from_request(
            request=request,
            user=user,
            action="source.decommission",
            resource={
                "type": "source",
                "id": source_id,
                "domain": source.domain,
                "classification": source.classification.value
                if source.classification
                else None,
            },
            outcome="success",
            before={"status": previous_status.value},
            after={"status": SourceStatus.DECOMMISSIONED.value},
        )
    )
    return source


@router.post(
    "/{source_id}/provision",
    summary="Trigger DLZ provisioning",
)
async def provision_source(
    source_id: str,
    request: Request,
    user: dict = Depends(require_role("Contributor", "Admin")),
    store: AsyncStoreBackend = Depends(get_sources_store),
) -> dict:
    """Trigger the full Data Landing Zone provisioning workflow.

    Deploys infrastructure, creates ADF pipeline, and triggers Purview
    scan.  Non-admin users may only provision sources within their own
    domain.

    The provisioning service returns an immutable
    :class:`ProvisioningResult` (CSA-0045 / AQ-0015).  This handler
    applies the result fields to the record and persists the update so
    the service never mutates the input directly.  The service does not
    raise — infrastructure errors surface as ``success=False`` results
    with ``new_status=ERROR`` (already logged with stack context by the
    service).
    """
    source = await _load_source_with_domain_check(source_id, user, store)

    result = await provisioning_service.provision(source)

    # Apply whatever fields the service populated and persist.  Doing
    # this for *every* outcome (including errors) keeps the persisted
    # record aligned with what the service reported.
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
        await store.update(source_id, update_payload)

    # Branch on the result to emit the correct audit outcome + HTTP
    # response.  ``new_status == ERROR`` means infrastructure failure;
    # any other ``success=False`` is a validation / eligibility denial.
    if not result.success:
        is_infra_error = result.new_status == SourceStatus.ERROR
        outcome = "error" if is_infra_error else "denied"
        reason_prefix = "infrastructure_error" if is_infra_error else "provisioning_rejected"
        error_detail = result.details.get("error_message") if is_infra_error else result.message
        reason = f"{reason_prefix}: {error_detail}"[:256] if error_detail else reason_prefix

        # Tamper-evident audit sink (CSA-0016) — record the failed
        # provisioning attempt so the audit trail is complete on error.
        audit_logger.emit(
            audit_event_from_request(
                request=request,
                user=user,
                action="source.provision",
                resource={
                    "type": "source",
                    "id": source_id,
                    "domain": source.domain,
                    "classification": source.classification.value
                    if source.classification
                    else None,
                },
                outcome=outcome,
                reason=reason,
            )
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY
            if is_infra_error
            else status.HTTP_400_BAD_REQUEST,
            detail=result.message,
        )

    # Tamper-evident audit sink (CSA-0016) — provisioning is a
    # high-impact state transition that deploys infrastructure.
    audit_logger.emit(
        audit_event_from_request(
            request=request,
            user=user,
            action="source.provision",
            resource={
                "type": "source",
                "id": source_id,
                "domain": source.domain,
                "classification": source.classification.value
                if source.classification
                else None,
            },
            outcome="success",
            after={
                "status": result.new_status.value if result.new_status else None,
                "pipeline_id": result.pipeline_id,
                "scan_id": result.scan_id,
            },
        )
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
    request: Request,
    user: dict = Depends(require_role("Contributor", "Admin")),
    store: AsyncStoreBackend = Depends(get_sources_store),
) -> dict:
    """Trigger a Microsoft Purview metadata scan for this source.

    Non-admin users may only scan sources within their own domain.
    """
    source = await _load_source_with_domain_check(source_id, user, store)

    try:
        scan_id = await provisioning_service.trigger_purview_scan(source)
    except Exception as exc:
        logger.exception("Purview scan failed for source %s", source_id)
        audit_logger.emit(
            audit_event_from_request(
                request=request,
                user=user,
                action="source.scan",
                resource={
                    "type": "source",
                    "id": source_id,
                    "domain": source.domain,
                    "classification": source.classification.value
                    if source.classification
                    else None,
                },
                outcome="error",
                reason=f"purview_error: {exc!s}"[:256],
            )
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Purview scan failed due to an infrastructure error. Check server logs.",
        ) from exc

    source.purview_scan_id = scan_id
    source.updated_at = datetime.now(timezone.utc)
    await store.update(source_id, source.model_dump())

    # Tamper-evident audit sink (CSA-0016) — triggers a Purview scan that
    # touches the source's data plane; security-relevant.
    audit_logger.emit(
        audit_event_from_request(
            request=request,
            user=user,
            action="source.scan",
            resource={
                "type": "source",
                "id": source_id,
                "domain": source.domain,
                "classification": source.classification.value
                if source.classification
                else None,
            },
            outcome="success",
            after={"scan_id": scan_id},
        )
    )

    return {"status": "scanning", "scan_id": scan_id}
