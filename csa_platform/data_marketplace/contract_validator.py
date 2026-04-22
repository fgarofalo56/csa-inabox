"""
Data product contract validation for CSA-in-a-Box.

Validates YAML contract files for data products, ensuring required fields
are present, values are valid, and the contract meets CSA platform standards.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import yaml
from pydantic import ValidationError, BaseModel, Field


@dataclass
class ValidationResult:
    """Result of contract validation."""

    is_valid: bool
    errors: list[str]
    warnings: list[str]

    @classmethod
    def success(cls, warnings: list[str] | None = None) -> ValidationResult:
        """Create a successful validation result."""
        return cls(is_valid=True, errors=[], warnings=warnings or [])

    @classmethod
    def failure(cls, errors: list[str], warnings: list[str] | None = None) -> ValidationResult:
        """Create a failed validation result."""
        return cls(is_valid=False, errors=errors, warnings=warnings or [])


class OwnerInfo(BaseModel):
    """Owner information for a data product."""

    name: str = Field(min_length=1, max_length=100)
    email: str = Field(pattern=r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
    team: str = Field(min_length=1, max_length=100)


class ColumnInfo(BaseModel):
    """Column definition for a data schema."""

    name: str = Field(min_length=1, max_length=64)
    type: str = Field(min_length=1)  # string, integer, float, boolean, timestamp, etc.
    description: str = Field(default="", max_length=500)
    nullable: bool = Field(default=True)


class SchemaInfo(BaseModel):
    """Schema information for a data product."""

    format: str = Field(default="delta", pattern=r'^(delta|parquet|csv|json|avro)$')
    location: str = Field(min_length=1)
    columns: list[ColumnInfo] = Field(default_factory=list)
    partition_by: list[str] = Field(default_factory=list)


class SLAInfo(BaseModel):
    """Service Level Agreement for a data product."""

    freshness_minutes: int = Field(ge=1, le=43200)  # 1 minute to 30 days
    availability_percent: float = Field(ge=50.0, le=100.0)
    valid_row_ratio: float = Field(ge=0.0, le=1.0)
    supported_until: str | None = Field(default=None, pattern=r'^\d{4}-\d{2}-\d{2}$')


class QualityThresholds(BaseModel):
    """Quality thresholds for a data product."""

    completeness: float = Field(ge=0.0, le=1.0)
    accuracy: float = Field(ge=0.0, le=1.0)
    timeliness: float = Field(ge=0.0, le=1.0)
    consistency: float = Field(ge=0.0, le=1.0)


class LineageInfo(BaseModel):
    """Lineage information for a data product."""

    upstream: list[str] = Field(default_factory=list)
    downstream: list[str] = Field(default_factory=list)
    transformations: list[str] = Field(default_factory=list)


class DataProductContract(BaseModel):
    """Data product contract schema for validation."""

    name: str = Field(min_length=1, max_length=100)
    domain: str = Field(min_length=1, max_length=50)
    description: str = Field(min_length=10, max_length=1000)
    version: str = Field(pattern=r'^\d+\.\d+\.\d+$')

    owner: OwnerInfo
    schema_info: SchemaInfo = Field(..., alias='schema')
    sla: SLAInfo

    classification: str = Field(pattern=r'^(public|internal|confidential|restricted)$')
    tags: dict[str, str] = Field(default_factory=dict)
    documentation_url: str = Field(default="", max_length=500)
    sample_queries: list[str] = Field(default_factory=list)

    quality_thresholds: QualityThresholds
    lineage: LineageInfo

    model_config = {"populate_by_name": True}


def validate_contract(path: str) -> ValidationResult:
    """
    Validate a data product contract file.

    Args:
        path: Path to the YAML contract file

    Returns:
        ValidationResult with validation status, errors, and warnings
    """
    errors: list[str] = []
    warnings: list[str] = []

    # Load and parse YAML
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()

        if not content.strip():
            return ValidationResult.failure(["Contract file is empty"])

        data = yaml.safe_load(content)
        if not isinstance(data, dict):
            return ValidationResult.failure(["Contract must be a YAML object/dictionary"])

    except FileNotFoundError:
        return ValidationResult.failure([f"Contract file not found: {path}"])
    except yaml.YAMLError as e:
        return ValidationResult.failure([f"Invalid YAML: {e}"])
    except Exception as e:
        return ValidationResult.failure([f"Error reading contract file: {e}"])

    # Validate required top-level fields
    required_fields = ['name', 'domain', 'description', 'version', 'owner', 'schema', 'sla', 'classification']
    for field in required_fields:
        if field not in data or not data[field]:
            errors.append(f"Missing required field: {field}")

    if errors:
        return ValidationResult.failure(errors, warnings)

    # Validate using Pydantic model
    try:
        contract = DataProductContract.model_validate(data)
    except ValidationError as e:
        for error in e.errors():
            field_path = '.'.join(str(loc) for loc in error['loc'])
            errors.append(f"Field '{field_path}': {error['msg']}")
        return ValidationResult.failure(errors, warnings)

    # Additional business rules validation

    # Validate domain is a known domain
    known_domains = {
        'finance', 'healthcare', 'environmental', 'manufacturing', 'human-resources',
        'marketing', 'supply-chain', 'operations', 'engineering', 'research'
    }
    if contract.domain not in known_domains:
        warnings.append(f"Unknown domain '{contract.domain}'. Known domains: {', '.join(sorted(known_domains))}")

    # Validate ADLS Gen2 location
    adls_pattern = r'^abfss://[a-z0-9-]+@[a-z0-9]+\.dfs\.core\.windows\.net/.*/$'
    if not re.match(adls_pattern, contract.schema_info.location):
        errors.append(
            f"Schema location must be a valid ADLS Gen2 path (abfss://container@storage.dfs.core.windows.net/path/). "
            f"Got: {contract.schema_info.location}"
        )

    # Validate supported_until date is in the future
    if contract.sla.supported_until:
        try:
            support_date = datetime.strptime(contract.sla.supported_until, '%Y-%m-%d')
            if support_date.date() <= datetime.now().date():
                warnings.append("Support date is in the past or today")
        except ValueError:
            errors.append(f"Invalid supported_until date format: {contract.sla.supported_until}")

    # Validate SLA thresholds are reasonable
    if contract.sla.freshness_minutes > 10080:  # > 1 week
        warnings.append(f"Freshness SLA is very relaxed: {contract.sla.freshness_minutes} minutes")

    if contract.sla.availability_percent < 95.0:
        warnings.append(f"Availability SLA is below 95%: {contract.sla.availability_percent}%")

    # Validate quality thresholds
    if contract.quality_thresholds.completeness < 0.8:
        warnings.append(f"Completeness threshold is below 80%: {contract.quality_thresholds.completeness}")

    if contract.quality_thresholds.accuracy < 0.8:
        warnings.append(f"Accuracy threshold is below 80%: {contract.quality_thresholds.accuracy}")

    # Validate schema columns
    if not contract.schema_info.columns:
        warnings.append("No schema columns defined")

    column_names = [col.name for col in contract.schema_info.columns]
    if len(column_names) != len(set(column_names)):
        errors.append("Duplicate column names found in schema")

    # Validate partition columns exist in schema
    if contract.schema_info.partition_by:
        for partition_col in contract.schema_info.partition_by:
            if partition_col not in column_names:
                errors.append(f"Partition column '{partition_col}' not found in schema columns")

    # Validate tags
    if len(contract.tags) > 20:
        warnings.append(f"Many tags defined ({len(contract.tags)}). Consider consolidating.")

    for key, value in contract.tags.items():
        if len(key) > 50:
            warnings.append(f"Tag key is very long: '{key[:50]}...'")
        if len(value) > 100:
            warnings.append(f"Tag value is very long for key '{key}': '{value[:50]}...'")

    # Validate sample queries
    if not contract.sample_queries:
        warnings.append("No sample queries provided")
    elif len(contract.sample_queries) > 10:
        warnings.append(f"Many sample queries ({len(contract.sample_queries)}). Consider reducing to most important ones.")

    # Return result
    if errors:
        return ValidationResult.failure(errors, warnings)
    else:
        return ValidationResult.success(warnings)


def validate_contract_dict(data: dict[str, Any]) -> ValidationResult:
    """
    Validate a data product contract from a dictionary.

    Args:
        data: Contract data as a dictionary

    Returns:
        ValidationResult with validation status, errors, and warnings
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(data, dict):
        return ValidationResult.failure(["Contract must be a dictionary"])

    # Validate required top-level fields
    required_fields = ['name', 'domain', 'description', 'version', 'owner', 'schema', 'sla', 'classification']
    for field in required_fields:
        if field not in data or not data[field]:
            errors.append(f"Missing required field: {field}")

    if errors:
        return ValidationResult.failure(errors, warnings)

    # Validate using Pydantic model
    try:
        DataProductContract.model_validate(data)
    except ValidationError as e:
        for error in e.errors():
            field_path = '.'.join(str(loc) for loc in error['loc'])
            errors.append(f"Field '{field_path}': {error['msg']}")
        return ValidationResult.failure(errors, warnings)

    if errors:
        return ValidationResult.failure(errors, warnings)
    else:
        return ValidationResult.success(warnings)