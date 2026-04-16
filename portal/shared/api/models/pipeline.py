"""
Pydantic models for pipeline management.

Mirrors the TypeScript ``PipelineRecord`` / ``PipelineRun`` types in
``portal/react-webapp/src/types/index.ts``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field


class PipelineStatus(str, Enum):
    """Pipeline execution status."""

    CREATED = "created"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    WAITING = "waiting"


class PipelineType(str, Enum):
    """Pipeline template type."""

    BATCH_COPY = "batch_copy"
    INCREMENTAL = "incremental"
    CDC = "cdc"
    STREAMING = "streaming"
    API_INGESTION = "api_ingestion"
    QUALITY_CHECK = "quality_check"


class PipelineRecord(BaseModel):
    """Pipeline record stored in the registry."""

    id: str
    name: str
    source_id: str
    pipeline_type: PipelineType
    status: PipelineStatus = PipelineStatus.CREATED
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_run_at: datetime | None = None
    schedule_cron: str | None = None
    adf_pipeline_id: str | None = None
    domain: str | None = None


class PipelineRun(BaseModel):
    """A single pipeline run / execution record."""

    id: str
    pipeline_id: str
    status: PipelineStatus
    started_at: datetime
    ended_at: datetime | None = None
    rows_read: int | None = None
    rows_written: int | None = None
    error_message: str | None = None
    duration_seconds: int | None = None
