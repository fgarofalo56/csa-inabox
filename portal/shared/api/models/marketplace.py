"""
Pydantic models for the data marketplace.

Mirrors the TypeScript ``DataProduct``, ``QualityMetric``, and dashboard
types from ``portal/react-webapp/src/types/index.ts``.

Phase 1 of ARCH-0001 adds optional enrichment fields (sla, lineage,
schema_info, version, status) that mirror the richer platform model in
``csa_platform.data_marketplace.models.data_product``.  All new fields
default to ``None`` / sensible literals so existing data and the
React-frontend API contract are fully backward-compatible.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from .source import ClassificationLevel, OwnerInfo, SchemaDefinition


class DataProduct(BaseModel):
    """A published data product in the marketplace.

    Core fields (id … documentation_url) are unchanged from the original
    contract.  The optional enrichment fields added in ARCH-0001 Phase 1
    (sla, lineage, schema_info, version, status) are surfaced by the API
    when present; consumers that do not yet read them are unaffected.
    """

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

    # ── ARCH-0001 Phase 1: enrichment fields ────────────────────────────
    # Mirrors csa_platform.data_marketplace.models.data_product but kept
    # as plain dicts so we avoid a hard dependency on the platform package
    # until Phase 2 introduces the shared model library.

    version: str = "1.0.0"
    status: str = "active"
    sla: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Service Level Agreement snapshot. "
            "Expected keys: freshness_minutes (int), "
            "availability_percent (float), valid_row_ratio (float)."
        ),
    )
    lineage: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Lineage metadata snapshot. "
            "Expected keys: upstream (list[str]), downstream (list[str]), "
            "transformations (list[str])."
        ),
    )
    schema_info: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Schema metadata snapshot. "
            "Expected keys: format (str), location (str), "
            "columns (list[dict]), partition_by (list[str])."
        ),
    )

    model_config = {"populate_by_name": True}


class QualityMetric(BaseModel):
    """Point-in-time quality measurement for a data product."""

    date: date
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
