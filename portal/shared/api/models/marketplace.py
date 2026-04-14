"""
Pydantic models for the data marketplace.

Mirrors the TypeScript ``DataProduct``, ``QualityMetric``, and dashboard
types from ``portal/react-webapp/src/types/index.ts``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field

from .source import ClassificationLevel, OwnerInfo, SchemaDefinition


class DataProduct(BaseModel):
    """A published data product in the marketplace."""

    id: str
    name: str
    description: str
    domain: str
    owner: OwnerInfo
    classification: ClassificationLevel = ClassificationLevel.INTERNAL
    quality_score: float = 0.0
    freshness_hours: float = 24.0
    completeness: float = 0.0
    availability: float = 0.0
    tags: dict[str, str] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    schema_def: SchemaDefinition | None = Field(None, alias="schema")
    sample_queries: list[str] | None = None
    documentation_url: str | None = None

    model_config = {"populate_by_name": True}


class QualityMetric(BaseModel):
    """Point-in-time quality measurement for a data product."""

    date: str  # ISO date string (YYYY-MM-DD)
    quality_score: float
    completeness: float
    freshness_hours: float
    row_count: int


class AccessLevel(str, Enum):
    """Access levels for data product requests."""

    READ = "read"
    READ_WRITE = "read_write"
    ADMIN = "admin"


class AccessRequestStatus(str, Enum):
    """Lifecycle status of an access request."""

    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    REVOKED = "revoked"
    EXPIRED = "expired"


class AccessRequestCreate(BaseModel):
    """Payload to create a new access request."""

    data_product_id: str
    justification: str
    access_level: AccessLevel = AccessLevel.READ
    duration_days: int = 90


class AccessRequest(BaseModel):
    """Full access request record."""

    id: str
    requester_email: str
    data_product_id: str
    justification: str
    access_level: AccessLevel = AccessLevel.READ
    duration_days: int = 90
    status: AccessRequestStatus = AccessRequestStatus.PENDING
    requested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    review_notes: str | None = None
    expires_at: datetime | None = None


# ── Dashboard / Stats Models ────────────────────────────────────────────────


class PlatformStats(BaseModel):
    """Platform-wide statistics shown on the dashboard."""

    registered_sources: int = 0
    active_pipelines: int = 0
    data_products: int = 0
    pending_access_requests: int = 0
    total_data_volume_gb: float = 0.0
    last_24h_pipeline_runs: int = 0
    avg_quality_score: float = 0.0


class DomainStatus(str, Enum):
    """Health status of a data domain."""

    HEALTHY = "healthy"
    WARNING = "warning"
    CRITICAL = "critical"


class DomainOverview(BaseModel):
    """Per-domain summary for the domain overview dashboard."""

    name: str
    source_count: int = 0
    pipeline_count: int = 0
    data_product_count: int = 0
    avg_quality_score: float = 0.0
    status: DomainStatus = DomainStatus.HEALTHY
