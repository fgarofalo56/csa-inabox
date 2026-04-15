"""Package init for portal API models.

Re-exports all public model classes so consumers can do::

    from portal.shared.api.models import SourceRecord, PipelineRecord, ...
"""

from .marketplace import (
    AccessLevel,
    AccessRequest,
    AccessRequestCreate,
    AccessRequestStatus,
    DataProduct,
    DomainOverview,
    DomainStatus,
    PlatformStats,
    QualityMetric,
)
from .pipeline import PipelineRecord, PipelineRun, PipelineStatus, PipelineType
from .source import (
    ClassificationLevel,
    ColumnDefinition,
    ConnectionConfig,
    DataProductConfig,
    IngestionConfig,
    IngestionMode,
    OwnerInfo,
    QualityRule,
    SchemaDefinition,
    SourceRecord,
    SourceRegistration,
    SourceStatus,
    SourceType,
    TargetConfig,
    TargetFormat,
)

__all__ = [
    # Marketplace / Access
    "AccessLevel",
    "AccessRequest",
    "AccessRequestCreate",
    "AccessRequestStatus",
    # Source
    "ClassificationLevel",
    "ColumnDefinition",
    "ConnectionConfig",
    "DataProduct",
    "DataProductConfig",
    "DomainOverview",
    "DomainStatus",
    "IngestionConfig",
    "IngestionMode",
    "OwnerInfo",
    # Pipeline
    "PipelineRecord",
    "PipelineRun",
    "PipelineStatus",
    "PipelineType",
    "PlatformStats",
    "QualityMetric",
    "QualityRule",
    "SchemaDefinition",
    "SourceRecord",
    "SourceRegistration",
    "SourceStatus",
    "SourceType",
    "TargetConfig",
    "TargetFormat",
]
