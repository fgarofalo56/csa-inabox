"""
Pipeline management router.

Endpoints
---------
GET    /api/v1/pipelines                         — list pipelines
GET    /api/v1/pipelines/{pipeline_id}            — get pipeline
GET    /api/v1/pipelines/{pipeline_id}/runs       — get pipeline runs
POST   /api/v1/pipelines/{pipeline_id}/trigger    — trigger a pipeline run
"""

from __future__ import annotations

import logging
import random as _rng
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from csa_platform.common.audit import audit_event_from_request, audit_logger

from ..dependencies import (
    get_pipelines_store,
    get_sources_store,
)
from ..dependencies import (
    get_runs_store as _get_async_runs_store,
)
from ..models.pipeline import PipelineRecord, PipelineRun, PipelineStatus, PipelineType
from ..models.source import SourceRecord
from ..observability.rate_limit import build_rate_limiter, get_route_limit
from ..persistence_async import AsyncStoreBackend
from ..services.auth import DomainScope, get_domain_scope, require_role

logger = logging.getLogger(__name__)
router = APIRouter()

# Per-principal sliding-window rate limiter (CSA-0030).
_limiter = build_rate_limiter()


async def _resolve_pipeline_domain(
    pipeline: PipelineRecord,
    sources_store: AsyncStoreBackend,
) -> str | None:
    """Async variant of :func:`_get_pipeline_domain` used by async routes."""
    if pipeline.domain:
        return pipeline.domain
    stored_source = await sources_store.get(pipeline.source_id)
    if not stored_source:
        return None
    source = SourceRecord.model_validate(stored_source)
    return source.domain


def _get_pipeline_domain(pipeline: PipelineRecord) -> str | None:
    """Resolve the domain for a pipeline via its linked source.

    Pipelines do not store a domain directly — they carry a ``source_id``
    that points to the source record which owns the domain.  When the
    pipeline record itself has a ``domain`` set (populated at seed or
    trigger time) that value is used directly to avoid an extra lookup.
    """
    if pipeline.domain:
        return pipeline.domain
    from .sources import get_store as _get_sources_store
    stored_source = _get_sources_store().get(pipeline.source_id)
    if not stored_source:
        return None
    source = SourceRecord.model_validate(stored_source)
    return source.domain


async def seed_demo_pipelines() -> None:
    """Populate realistic demo pipelines once at startup (async)."""
    async_pipelines = get_pipelines_store()
    async_runs = _get_async_runs_store()
    if await async_pipelines.count() > 0:
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
        await async_pipelines.add(p.model_dump())

    # Seed some runs for the first pipeline
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
        await async_runs.add(run.model_dump())


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[PipelineRecord],
    summary="List pipelines",
)
async def list_pipelines(
    source_id: str | None = None,
    status_filter: PipelineStatus | None = Query(None, alias="status"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_pipelines_store),
    sources_store: AsyncStoreBackend = Depends(get_sources_store),
) -> list[PipelineRecord]:
    """Return all pipelines, optionally filtered by source or status."""
    results = [PipelineRecord.model_validate(item) for item in await store.load()]

    # Domain scoping: non-admin users can only see their domain's pipelines.
    # Resolve each pipeline's domain via its linked source when the record
    # does not carry an explicit domain field.
    # When a non-admin has no domain claim (e.g. demo mode), return empty
    # rather than leaking data across all domains (SEC-0005).
    if not scope.is_admin:
        if not scope.user_domain:
            return []
        filtered: list[PipelineRecord] = []
        for p in results:
            domain = await _resolve_pipeline_domain(p, sources_store)
            if domain == scope.user_domain:
                filtered.append(p)
        results = filtered

    if source_id:
        results = [p for p in results if p.source_id == source_id]
    if status_filter:
        results = [p for p in results if p.status == status_filter]

    return results[skip : skip + limit]


@router.get(
    "/{pipeline_id}",
    response_model=PipelineRecord,
    summary="Get a pipeline",
)
async def get_pipeline(
    pipeline_id: str,
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_pipelines_store),
    sources_store: AsyncStoreBackend = Depends(get_sources_store),
) -> PipelineRecord:
    """Return a single pipeline by ID.

    Non-admin users may only retrieve pipelines whose source belongs to
    their own domain.  Previously this endpoint had no domain scoping at
    all (ARCH-0006 / SEC-0009).
    """
    stored_pipeline = await store.get(pipeline_id)
    if not stored_pipeline:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found.")
    pipeline = PipelineRecord.model_validate(stored_pipeline)

    # Domain scoping: enforce for non-admin callers.
    if not scope.is_admin:
        pipeline_domain = await _resolve_pipeline_domain(pipeline, sources_store)
        if not scope.user_domain or pipeline_domain != scope.user_domain:
            raise HTTPException(
                status_code=403,
                detail="You do not have access to this pipeline.",
            )

    return pipeline


@router.get(
    "/{pipeline_id}/runs",
    response_model=list[PipelineRun],
    summary="Get pipeline runs",
)
async def get_pipeline_runs(
    pipeline_id: str,
    limit: int = Query(20, ge=1, le=100),
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_pipelines_store),
    runs_store: AsyncStoreBackend = Depends(_get_async_runs_store),
    sources_store: AsyncStoreBackend = Depends(get_sources_store),
) -> list[PipelineRun]:
    """Return recent execution runs for a pipeline.

    Non-admin users may only retrieve runs for pipelines in their domain.
    Previously this endpoint had no domain scoping at all (ARCH-0006 / SEC-0009).
    """
    stored_pipeline = await store.get(pipeline_id)
    if not stored_pipeline:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found.")

    # Domain scoping: enforce for non-admin callers before returning any runs.
    if not scope.is_admin:
        pipeline = PipelineRecord.model_validate(stored_pipeline)
        pipeline_domain = await _resolve_pipeline_domain(pipeline, sources_store)
        if not scope.user_domain or pipeline_domain != scope.user_domain:
            raise HTTPException(
                status_code=403,
                detail="You do not have access to this pipeline.",
            )

    # Get runs for this pipeline
    all_runs = await runs_store.load()
    pipeline_runs = [PipelineRun.model_validate(run) for run in all_runs if run.get("pipeline_id") == pipeline_id]

    # Sort by started_at descending (most recent first)
    pipeline_runs.sort(key=lambda r: r.started_at, reverse=True)

    return pipeline_runs[:limit]


@router.post(
    "/{pipeline_id}/trigger",
    response_model=PipelineRun,
    summary="Trigger a pipeline run",
)
@_limiter.limit(get_route_limit("pipelines_trigger", write=True))
async def trigger_pipeline(
    request: Request,
    pipeline_id: str,
    user: dict = Depends(require_role("Contributor", "Admin")),
    store: AsyncStoreBackend = Depends(get_pipelines_store),
    runs_store: AsyncStoreBackend = Depends(_get_async_runs_store),
    sources_store: AsyncStoreBackend = Depends(get_sources_store),
) -> PipelineRun:
    """Manually trigger a pipeline execution.

    Non-admin users may only trigger pipelines belonging to their domain
    (SEC-0002).

    In production, would call the ADF REST API to start a pipeline run:

        POST https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/
             providers/Microsoft.DataFactory/factories/{factory}/
             pipelines/{pipeline}/createRun?api-version=2018-06-01
    """
    stored_pipeline = await store.get(pipeline_id)
    if not stored_pipeline:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found.")

    pipeline = PipelineRecord.model_validate(stored_pipeline)

    # Domain scoping: enforce for non-admin callers (SEC-0002).
    user_roles = user.get("roles", [])
    if "Admin" not in user_roles:
        pipeline_domain = await _resolve_pipeline_domain(pipeline, sources_store)
        user_domain = user.get("domain") or user.get("team")
        if not user_domain or pipeline_domain != user_domain:
            raise HTTPException(
                status_code=403,
                detail="You do not have access to trigger this pipeline.",
            )

    now = datetime.now(timezone.utc)
    run = PipelineRun(
        id=f"run-{uuid.uuid4().hex[:8]}",
        pipeline_id=pipeline_id,
        status=PipelineStatus.RUNNING,
        started_at=now,
    )
    await runs_store.add(run.model_dump())

    # Update pipeline status and last_run_at
    pipeline_updates = {
        "status": PipelineStatus.RUNNING.value,
        "last_run_at": now.isoformat(),
    }
    await store.update(pipeline_id, pipeline_updates)

    # Tamper-evident audit sink (CSA-0016) — triggering a pipeline moves
    # data through the platform and is subject to AU-2/AU-3.
    pipeline_domain = await _resolve_pipeline_domain(pipeline, sources_store)
    audit_logger.emit(
        audit_event_from_request(
            request=request,
            user=user,
            action="pipeline.trigger",
            resource={
                "type": "pipeline",
                "id": pipeline_id,
                "domain": pipeline_domain,
                "source_id": pipeline.source_id,
            },
            outcome="success",
            after={"run_id": run.id, "status": PipelineStatus.RUNNING.value},
        )
    )
    return run
