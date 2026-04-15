"""Pydantic models for the CSA-in-a-Box Data Marketplace.

Defines the domain models for data products, access requests, quality
metrics, and API request/response schemas. These models are used by the
marketplace FastAPI application and stored in Cosmos DB.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator

# ──────────────────────────────────────────────────────────────────────
# Enums
# ──────────────────────────────────────────────────────────────────────


class DataFormat(str, Enum):
    """Supported data product storage formats."""

    DELTA = "delta"
    PARQUET = "parquet"
    CSV = "csv"
    JSON = "json"
    AVRO = "avro"


class AccessLevel(str, Enum):
    """Access levels for data product access requests."""

    READ = "read"
    READ_WRITE = "read_write"
    ADMIN = "admin"


class AccessRequestStatus(str, Enum):
    """Status of a data product access request."""

    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    REVOKED = "revoked"
    EXPIRED = "expired"


class SensitivityLevel(str, Enum):
    """Data sensitivity classification levels."""

    PUBLIC = "public"
    INTERNAL = "internal"
    CONFIDENTIAL = "confidential"
    RESTRICTED = "restricted"


# ──────────────────────────────────────────────────────────────────────
# Schema models
# ──────────────────────────────────────────────────────────────────────


class ColumnSchema(BaseModel):
    """Schema definition for a single column in a data product."""

    name: str = Field(..., description="Column name")
    type: str = Field(..., description="Column data type (string, int, double, etc.)")
    description: str = Field(default="", description="Human-readable column description")
    nullable: bool = Field(default=True, description="Whether the column allows null values")
    pii_classification: str | None = Field(
        default=None,
        description="PII classification (direct_identifier, indirect_identifier, etc.)",
    )
    allowed_values: list[str] | None = Field(
        default=None,
        description="Enumerated allowed values for categorical columns",
    )


class DataProductSchema(BaseModel):
    """Schema definition for a data product."""

    format: DataFormat = Field(default=DataFormat.DELTA, description="Storage format")
    location: str = Field(
        ...,
        description="ADLS Gen2 path (abfss://container@account.dfs.core.windows.net/path/)",
    )
    columns: list[ColumnSchema] = Field(
        default_factory=list,
        description="Column definitions",
    )
    partition_by: list[str] = Field(
        default_factory=list,
        description="Partition columns",
    )
    primary_key: list[str] = Field(
        default_factory=list,
        description="Primary key column(s)",
    )


# ──────────────────────────────────────────────────────────────────────
# SLA models
# ──────────────────────────────────────────────────────────────────────


class SLADefinition(BaseModel):
    """Service Level Agreement for a data product."""

    freshness_minutes: int = Field(
        default=120,
        ge=1,
        description="Maximum acceptable data staleness in minutes",
    )
    availability_percent: float = Field(
        default=99.5,
        ge=0.0,
        le=100.0,
        description="Target availability percentage",
    )
    supported_until: str | None = Field(
        default=None,
        description="Date until which the data product is supported (YYYY-MM-DD)",
    )
    valid_row_ratio: float = Field(
        default=0.95,
        ge=0.0,
        le=1.0,
        description="Minimum ratio of rows passing quality validation",
    )


# ──────────────────────────────────────────────────────────────────────
# Lineage models
# ──────────────────────────────────────────────────────────────────────


class LineageInfo(BaseModel):
    """Data lineage information for a data product."""

    upstream: list[str] = Field(
        default_factory=list,
        description="Upstream data products or sources that feed into this product",
    )
    downstream: list[str] = Field(
        default_factory=list,
        description="Downstream data products that consume this product",
    )
    transformations: list[str] = Field(
        default_factory=list,
        description="Transformation steps (e.g., 'dbt model: orders_cleaned')",
    )


# ──────────────────────────────────────────────────────────────────────
# Quality models
# ──────────────────────────────────────────────────────────────────────


class QualityMetric(BaseModel):
    """A single quality metric measurement for a data product."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    product_id: str = Field(..., alias="productId", description="Data product ID")
    metric_name: str = Field(..., description="Metric name (completeness, freshness, etc.)")
    value: float = Field(..., ge=0.0, le=1.0, description="Metric value (0-1 normalized)")
    measured_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="When the measurement was taken",
    )
    details: dict[str, Any] = Field(
        default_factory=dict,
        description="Additional metric details",
    )

    model_config = {"populate_by_name": True}


class QualityScore(BaseModel):
    """Composite quality score for a data product."""

    overall_score: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Weighted composite quality score (0-1)",
    )
    completeness: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Data completeness (non-null ratio)",
    )
    freshness: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Data freshness (within SLA = 1.0)",
    )
    accuracy: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Validation pass rate",
    )
    consistency: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Cross-domain consistency score",
    )
    uniqueness: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Primary key uniqueness ratio",
    )
    measured_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )

    @classmethod
    def compute(
        cls,
        completeness: float = 0.0,
        freshness: float = 0.0,
        accuracy: float = 0.0,
        consistency: float = 0.0,
        uniqueness: float = 0.0,
    ) -> QualityScore:
        """Compute a weighted quality score from individual dimensions.

        Weights:
            - Completeness: 0.25
            - Freshness: 0.25
            - Accuracy: 0.20
            - Consistency: 0.15
            - Uniqueness: 0.15
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


# ──────────────────────────────────────────────────────────────────────
# Data Product models
# ──────────────────────────────────────────────────────────────────────


class DataProductBase(BaseModel):
    """Base model for creating/updating a data product."""

    name: str = Field(
        ...,
        min_length=1,
        max_length=128,
        description="Data product name",
    )
    domain: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description="Domain that owns this data product",
    )
    owner: str = Field(
        ...,
        description="Owner email or team name",
    )
    description: str = Field(
        default="",
        max_length=2048,
        description="Human-readable description",
    )
    version: str = Field(
        default="1.0.0",
        description="Semantic version of the data product",
    )
    schema_def: DataProductSchema = Field(
        ...,
        alias="schema",
        description="Schema definition",
    )
    sla: SLADefinition = Field(
        default_factory=SLADefinition,
        description="Service level agreement",
    )
    lineage: LineageInfo = Field(
        default_factory=LineageInfo,
        description="Lineage metadata",
    )
    tags: list[str] = Field(
        default_factory=list,
        description="Search tags",
    )
    sensitivity: SensitivityLevel = Field(
        default=SensitivityLevel.INTERNAL,
        description="Data sensitivity classification",
    )

    model_config = {"populate_by_name": True}

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        """Ensure product names use lowercase with hyphens (URL-safe)."""
        import re

        if not re.match(r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$", v) and len(v) > 1:
            raise ValueError(
                "Product name must be lowercase alphanumeric with hyphens (e.g., 'orders', 'sales-metrics')"
            )
        return v


class DataProduct(DataProductBase):
    """Full data product model as stored in Cosmos DB."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    quality_score: QualityScore | None = Field(
        default=None,
        description="Latest quality score",
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )
    last_refreshed_at: datetime | None = Field(
        default=None,
        description="When the data was last refreshed/updated",
    )
    status: str = Field(
        default="active",
        description="Product status (active, deprecated, draft)",
    )
    access_count: int = Field(
        default=0,
        description="Number of approved access grants",
    )


class DataProductSummary(BaseModel):
    """Lightweight data product summary for list responses."""

    id: str
    name: str
    domain: str
    owner: str
    description: str
    version: str
    tags: list[str]
    sensitivity: SensitivityLevel
    quality_score: float | None = None
    status: str = "active"
    last_refreshed_at: datetime | None = None

    @classmethod
    def from_product(cls, product: DataProduct) -> DataProductSummary:
        """Create a summary from a full product."""
        return cls(
            id=product.id,
            name=product.name,
            domain=product.domain,
            owner=product.owner,
            description=product.description,
            version=product.version,
            tags=product.tags,
            sensitivity=product.sensitivity,
            quality_score=(product.quality_score.overall_score if product.quality_score else None),
            status=product.status,
            last_refreshed_at=product.last_refreshed_at,
        )


# ──────────────────────────────────────────────────────────────────────
# Access Request models
# ──────────────────────────────────────────────────────────────────────


class AccessRequestCreate(BaseModel):
    """Request body for creating a new access request."""

    product_id: str = Field(..., alias="productId", description="Target data product ID")
    requester: str = Field(..., description="Requester email or identity")
    requested_role: AccessLevel = Field(
        default=AccessLevel.READ,
        description="Requested access level",
    )
    justification: str = Field(
        ...,
        min_length=10,
        max_length=2048,
        description="Business justification for the access request",
    )
    expires_at: datetime | None = Field(
        default=None,
        description="Requested expiration date for the access grant",
    )

    model_config = {"populate_by_name": True}


class AccessRequest(BaseModel):
    """Full access request model as stored in Cosmos DB."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    product_id: str = Field(..., alias="productId")
    requester: str
    requested_role: AccessLevel
    justification: str
    status: AccessRequestStatus = Field(default=AccessRequestStatus.PENDING)
    reviewer: str | None = Field(default=None, description="Who reviewed the request")
    review_notes: str | None = Field(default=None, description="Reviewer's notes")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
    )
    reviewed_at: datetime | None = None
    expires_at: datetime | None = None

    model_config = {"populate_by_name": True}


class AccessRequestApproval(BaseModel):
    """Request body for approving or denying an access request."""

    reviewer: str = Field(..., description="Reviewer email or identity")
    approved: bool = Field(..., description="Whether to approve the request")
    notes: str = Field(default="", description="Review notes")
    expires_at: datetime | None = Field(
        default=None,
        description="Override expiration date",
    )


# ──────────────────────────────────────────────────────────────────────
# API response models
# ──────────────────────────────────────────────────────────────────────


class PaginatedResponse(BaseModel):
    """Paginated API response wrapper."""

    items: list[Any] = Field(default_factory=list)
    total: int = Field(default=0, description="Total number of items")
    page: int = Field(default=1, ge=1, description="Current page number")
    per_page: int = Field(default=20, ge=1, le=100, description="Items per page")
    has_next: bool = Field(default=False, description="Whether more pages exist")


class QualityHistoryResponse(BaseModel):
    """Response for quality metrics history endpoint."""

    product_id: str
    product_name: str
    metrics: list[QualityMetric]
    current_score: QualityScore | None = None
    trend: str = Field(
        default="stable",
        description="Quality trend (improving, declining, stable)",
    )
