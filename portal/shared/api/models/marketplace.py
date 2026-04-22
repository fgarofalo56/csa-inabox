"""
Pydantic models for the data marketplace.

Mirrors the TypeScript ``DataProduct``, ``QualityMetric``, and dashboard
types from ``portal/react-webapp/src/types/index.ts``.

**ARCH-0001 consolidation status (2026-04-21):**

- Phase 1 (complete): Added optional enrichment fields.
- Phase 2 (complete): Replaced untyped ``dict[str, Any]`` with validated
  Pydantic sub-models (``SLADefinition``, ``LineageInfo``, ``SchemaInfo``).
- Phase 3 (complete): Added ``QualityDimensions`` for per-dimension
  quality breakdowns alongside the flat ``quality_score`` ratio.
- Phase 4 (complete): Standalone ``csa_platform.data_marketplace`` API
  deleted — this module is now the canonical marketplace model surface.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from .source import ClassificationLevel, OwnerInfo, SchemaDefinition


# ── ARCH-0001 Phase 2: Typed sub-models ────────────────────────────────────
# Replaces Phase 1's untyped ``dict[str, Any]`` with validated Pydantic
# models.  These mirror the richer platform models from
# ``csa_platform.data_marketplace.models.data_product`` but are defined
# here so the portal has no import dependency on the platform package.
# The TypeScript counterparts live in ``portal/shared/contracts/types.ts``.


class SLADefinition(BaseModel):
    """Service Level Agreement for a data product."""

    freshness_minutes: int = Field(default=120, ge=1, description="Maximum acceptable data staleness in minutes")
    availability_percent: float = Field(default=99.5, ge=0.0, le=100.0, description="Target availability percentage")
    valid_row_ratio: float = Field(default=0.95, ge=0.0, le=1.0, description="Minimum ratio of rows passing validation")
    supported_until: str | None = Field(default=None, description="Date until which the product is supported (YYYY-MM-DD)")


class LineageInfo(BaseModel):
    """Data lineage information for a data product."""

    upstream: list[str] = Field(default_factory=list, description="Upstream data sources")
    downstream: list[str] = Field(default_factory=list, description="Downstream consumers")
    transformations: list[str] = Field(default_factory=list, description="Transformation steps")


class SchemaInfo(BaseModel):
    """Storage schema snapshot for a data product."""

    format: str = Field(default="delta", description="Storage format (delta, parquet, csv, json, avro)")
    location: str = Field(default="", description="ADLS Gen2 path")
    columns: list[dict[str, Any]] = Field(default_factory=list, description="Column definitions")
    partition_by: list[str] = Field(default_factory=list, description="Partition columns")


class QualityDimensions(BaseModel):
    """Dimensioned quality score — ARCH-0001 Phase 3.

    Provides per-dimension breakdowns alongside the flat ``quality_score``
    ratio.  The weighted ``overall_score`` should equal the parent
    ``DataProduct.quality_score`` when populated; consumers that only read
    the flat float are unaffected.
    """

    overall_score: float = Field(ge=0.0, le=1.0, description="Weighted composite quality score (0-1)")
    completeness: float = Field(default=0.0, ge=0.0, le=1.0)
    freshness: float = Field(default=0.0, ge=0.0, le=1.0)
    accuracy: float = Field(default=0.0, ge=0.0, le=1.0)
    consistency: float = Field(default=0.0, ge=0.0, le=1.0)
    uniqueness: float = Field(default=0.0, ge=0.0, le=1.0)
    measured_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @classmethod
    def compute(
        cls,
        completeness: float = 0.0,
        freshness: float = 0.0,
        accuracy: float = 0.0,
        consistency: float = 0.0,
        uniqueness: float = 0.0,
    ) -> QualityDimensions:
        """Compute a weighted quality score from individual dimensions.

        Weights: completeness 0.25, freshness 0.25, accuracy 0.20,
        consistency 0.15, uniqueness 0.15.
        """
        overall = completeness * 0.25 + freshness * 0.25 + accuracy * 0.20 + consistency * 0.15 + uniqueness * 0.15
        return cls(
            overall_score=round(overall, 4),
            completeness=completeness,
            freshness=freshness,
            accuracy=accuracy,
            consistency=consistency,
            uniqueness=uniqueness,
        )


class DataProduct(BaseModel):
    """A published data product in the marketplace.

    Core fields (id … documentation_url) are unchanged from the original
    contract.  ARCH-0001 Phase 2 replaces the untyped enrichment dicts
    with validated Pydantic models (``SLADefinition``, ``LineageInfo``,
    ``SchemaInfo``).  Phase 3 adds ``quality_dimensions`` for per-dimension
    quality breakdowns alongside the flat ``quality_score`` ratio.
    """

    id: str
    name: str
    description: str
    domain: str
    owner: OwnerInfo
    classification: ClassificationLevel = ClassificationLevel.INTERNAL
    # CSA-0003: quality_score is a 0.0-1.0 ratio, matching completeness /
    # availability and the React QualityBadge contract under
    # portal/react-webapp.  Do not switch back to a 0-100 scale without
    # updating every consumer (Pydantic bounds, seed data, stats router,
    # CLI formatters, PowerApps flow, frontend badge).
    quality_score: float = Field(default=0.0, ge=0.0, le=1.0)
    freshness_hours: float = 24.0
    completeness: float = Field(default=0.0, ge=0.0, le=1.0)
    availability: float = Field(default=0.0, ge=0.0, le=1.0)
    tags: dict[str, str] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    schema_def: SchemaDefinition | None = Field(None, alias="schema")
    sample_queries: list[str] | None = None
    documentation_url: str | None = None

    # ── ARCH-0001 Phase 1+2: enrichment fields ─────────────────────────
    version: str = "1.0.0"
    status: str = "active"
    sla: SLADefinition | None = Field(default=None, description="Service Level Agreement contract")
    lineage: LineageInfo | None = Field(default=None, description="Upstream / downstream lineage graph")
    schema_info: SchemaInfo | None = Field(default=None, description="Storage schema snapshot")

    # ── ARCH-0001 Phase 3: dimensioned quality ─────────────────────────
    quality_dimensions: QualityDimensions | None = Field(
        default=None,
        description=(
            "Per-dimension quality breakdown.  When present, "
            "overall_score should equal quality_score."
        ),
    )

    model_config = {"populate_by_name": True}


class QualityMetric(BaseModel):
    """Point-in-time quality measurement for a data product.

    ``quality_score`` and ``completeness`` are 0.0-1.0 ratios (CSA-0003).
    """

    date: date
    quality_score: float = Field(ge=0.0, le=1.0)
    completeness: float = Field(ge=0.0, le=1.0)
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
    """Platform-wide statistics shown on the dashboard.

    ``avg_quality_score`` is a 0.0-1.0 ratio (CSA-0003).
    """

    registered_sources: int = 0
    active_pipelines: int = 0
    data_products: int = 0
    pending_access_requests: int = 0
    total_data_volume_gb: float = 0.0
    last_24h_pipeline_runs: int = 0
    avg_quality_score: float = Field(default=0.0, ge=0.0, le=1.0)


class DomainStatus(str, Enum):
    """Health status of a data domain."""

    HEALTHY = "healthy"
    WARNING = "warning"
    CRITICAL = "critical"


class DomainOverview(BaseModel):
    """Per-domain summary for the domain overview dashboard.

    ``avg_quality_score`` is a 0.0-1.0 ratio (CSA-0003).
    """

    name: str
    source_count: int = 0
    pipeline_count: int = 0
    data_product_count: int = 0
    avg_quality_score: float = Field(default=0.0, ge=0.0, le=1.0)
    status: DomainStatus = DomainStatus.HEALTHY
