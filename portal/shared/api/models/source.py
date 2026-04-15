"""
Pydantic models for data source registration and management.

These models mirror the TypeScript types defined in
``portal/react-webapp/src/types/index.ts`` so that the React frontend
and FastAPI backend share the same data contract.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

# ── Enumerations ─────────────────────────────────────────────────────────────


class SourceType(str, Enum):
    """Supported data source types — matches frontend ``SourceType``."""

    AZURE_SQL = "azure_sql"
    SYNAPSE = "synapse"
    COSMOS_DB = "cosmos_db"
    ADLS_GEN2 = "adls_gen2"
    BLOB_STORAGE = "blob_storage"
    DATABRICKS = "databricks"
    POSTGRESQL = "postgresql"
    MYSQL = "mysql"
    ORACLE = "oracle"
    REST_API = "rest_api"
    ODATA = "odata"
    SFTP = "sftp"
    SHAREPOINT = "sharepoint"
    EVENT_HUB = "event_hub"
    IOT_HUB = "iot_hub"
    KAFKA = "kafka"


class IngestionMode(str, Enum):
    """Data ingestion modes."""

    FULL = "full"
    INCREMENTAL = "incremental"
    CDC = "cdc"
    STREAMING = "streaming"


class ClassificationLevel(str, Enum):
    """Data classification levels (Commercial + Gov)."""

    PUBLIC = "public"
    INTERNAL = "internal"
    CONFIDENTIAL = "confidential"
    RESTRICTED = "restricted"
    CUI = "cui"
    FOUO = "fouo"


class TargetFormat(str, Enum):
    """Target storage format."""

    DELTA = "delta"
    PARQUET = "parquet"
    CSV = "csv"
    JSON = "json"


class SourceStatus(str, Enum):
    """Source lifecycle status."""

    DRAFT = "draft"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    PROVISIONING = "provisioning"
    ACTIVE = "active"
    PAUSED = "paused"
    DECOMMISSIONED = "decommissioned"
    ERROR = "error"


# ── Embedded Value Objects ───────────────────────────────────────────────────


class ConnectionConfig(BaseModel):
    """Connection configuration — fields vary by source type."""

    host: str | None = None
    port: int | None = None
    database: str | None = None
    schema_name: str | None = Field(None, alias="schema")
    container: str | None = None
    path: str | None = None
    api_url: str | None = None
    authentication_method: str | None = None
    key_vault_secret_name: str | None = Field(
        None,
        description="Azure Key Vault secret name for credentials.",
    )

    model_config = {"populate_by_name": True}


class ColumnDefinition(BaseModel):
    """A single column / field definition."""

    name: str
    data_type: str
    nullable: bool = True
    description: str | None = None
    is_pii: bool = False
    classification: str | None = None


class SchemaDefinition(BaseModel):
    """Schema definition for a data source."""

    columns: list[ColumnDefinition] = Field(default_factory=list)
    primary_key: list[str] | None = None
    partition_columns: list[str] | None = None
    watermark_column: str | None = None


class IngestionConfig(BaseModel):
    """Ingestion configuration."""

    mode: IngestionMode = IngestionMode.FULL
    schedule_cron: str | None = Field(
        None,
        description="Cron expression for scheduled ingestion.",
        examples=["0 */6 * * *"],
    )
    batch_size: int | None = None
    parallelism: int | None = None
    max_retry_count: int | None = None
    timeout_minutes: int | None = None


class QualityRule(BaseModel):
    """Data quality rule definition."""

    rule_name: str
    rule_type: str  # not_null | unique | range | regex | custom_sql | freshness | completeness
    column: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    severity: str = "warning"  # warning | error | critical


class DataProductConfig(BaseModel):
    """Data product publishing configuration."""

    name: str
    description: str
    domain: str
    sla_freshness_hours: float = 24.0
    sla_completeness: float = 0.98
    sla_availability: float = 0.995


class TargetConfig(BaseModel):
    """Target storage configuration."""

    landing_zone: str = "dlz-default"
    container: str = "bronze"
    path_pattern: str = "{domain}/{source_name}/{year}/{month}/{day}"
    format: TargetFormat = TargetFormat.DELTA
    partition_by: list[str] | None = None


class OwnerInfo(BaseModel):
    """Data source owner information."""

    name: str
    email: str
    team: str
    cost_center: str | None = None


# ── Request / Response Models ────────────────────────────────────────────────


class SourceRegistration(BaseModel):
    """Complete data source registration request — the create payload."""

    name: str = Field(..., min_length=1, max_length=128)
    description: str = ""
    source_type: SourceType
    domain: str
    classification: ClassificationLevel = ClassificationLevel.INTERNAL
    connection: ConnectionConfig
    schema_def: SchemaDefinition | None = Field(None, alias="schema")
    ingestion: IngestionConfig = Field(default_factory=IngestionConfig)
    quality_rules: list[QualityRule] = Field(default_factory=list)
    data_product: DataProductConfig | None = None
    target: TargetConfig = Field(default_factory=TargetConfig)
    owner: OwnerInfo
    tags: dict[str, str] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class SourceRecord(SourceRegistration):
    """Full source record including system-managed fields."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: SourceStatus = SourceStatus.DRAFT
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    provisioned_at: datetime | None = None
    pipeline_id: str | None = None
    purview_scan_id: str | None = None
