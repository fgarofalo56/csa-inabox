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

from fastapi import APIRouter, Depends, HTTPException, Query

from ..models.pipeline import PipelineRecord, PipelineRun, PipelineStatus, PipelineType
from ..persistence import SqliteStore
from ..services.auth import get_current_user, require_role

logger = logging.getLogger(__name__)
router = APIRouter()

# ── SQLite persistence ──────────────────────────────────────────────────
_pipelines_store = SqliteStore("pipelines.json")
_runs_store = SqliteStore("pipeline_runs.json")


def seed_demo_pipelines() -> None:
    """Populate realistic demo pipelines once at startup."""
    if _pipelines_store.count() > 0:
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
        _pipelines_store.add(p.model_dump())

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
        _runs_store.add(run.model_dump())


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
    _user: dict = Depends(get_current_user),
) -> list[PipelineRecord]:
    """Return all pipelines, optionally filtered by source or status."""
    results = [PipelineRecord.model_validate(item) for item in _pipelines_store.load()]

    # Domain scoping: non-admin users can only see their domain's pipelines
    user_roles = _user.get("roles", [])
    user_domain = _user.get("domain") or _user.get("team")
    if "Admin" not in user_roles and user_domain:
        results = [p for p in results if p.domain == user_domain]

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
    _user: dict = Depends(get_current_user),
) -> PipelineRecord:
    """Return a single pipeline by ID."""
    stored_pipeline = _pipelines_store.get(pipeline_id)
    if not stored_pipeline:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found.")
    return PipelineRecord.model_validate(stored_pipeline)


@router.get(
    "/{pipeline_id}/runs",
    response_model=list[PipelineRun],
    summary="Get pipeline runs",
)
async def get_pipeline_runs(
    pipeline_id: str,
    limit: int = Query(20, ge=1, le=100),
    _user: dict = Depends(get_current_user),
) -> list[PipelineRun]:
    """Return recent execution runs for a pipeline."""
    # Check if pipeline exists
    if not _pipelines_store.get(pipeline_id):
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found.")

    # Get runs for this pipeline
    all_runs = _runs_store.load()
    pipeline_runs = [PipelineRun.model_validate(run) for run in all_runs if run.get("pipeline_id") == pipeline_id]

    # Sort by started_at descending (most recent first)
    pipeline_runs.sort(key=lambda r: r.started_at, reverse=True)

    return pipeline_runs[:limit]


@router.post(
    "/{pipeline_id}/trigger",
    response_model=PipelineRun,
    summary="Trigger a pipeline run",
)
async def trigger_pipeline(
    pipeline_id: str,
    _user: dict = Depends(require_role("Contributor", "Admin")),
) -> PipelineRun:
    """Manually trigger a pipeline execution.

    In production, would call the ADF REST API to start a pipeline run:

        POST https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/
             providers/Microsoft.DataFactory/factories/{factory}/
             pipelines/{pipeline}/createRun?api-version=2018-06-01
    """
    stored_pipeline = _pipelines_store.get(pipeline_id)
    if not stored_pipeline:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found.")

    now = datetime.now(timezone.utc)
    run = PipelineRun(
        id=f"run-{uuid.uuid4().hex[:8]}",
        pipeline_id=pipeline_id,
        status=PipelineStatus.RUNNING,
        started_at=now,
    )
    _runs_store.add(run.model_dump())

    # Update pipeline status and last_run_at
    pipeline_updates = {
        "status": PipelineStatus.RUNNING.value,
        "last_run_at": now.isoformat(),
    }
    _pipelines_store.update(pipeline_id, pipeline_updates)

    logger.info("Triggered pipeline run", extra={"pipeline_id": pipeline_id, "run_id": run.id})
    return run
