"""Regression tests for CSA-0026: Cosmos SQL injection via sample_size.

The ``_detect_cosmos_schema`` method interpolates ``sample_size`` into a
Cosmos SQL TOP clause. Cosmos does not accept parameters for TOP, so we
instead strict-validate the value as a bounded integer. These tests pin
that contract.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure csa_platform is importable when running the test standalone
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from csa_platform.metadata_framework.generator.pipeline_generator import (
    PipelineGenerator,
    SchemaDetectionError,
)


@pytest.fixture
def generator() -> PipelineGenerator:
    return PipelineGenerator()


@pytest.mark.parametrize(
    "bad_value",
    [
        "100; DROP DATABASE c --",  # injection attempt
        "100 OR 1=1",
        "abc",
        "",
        None,
        [100],
        {"value": 100},
    ],
)
def test_sample_size_rejects_non_integer(generator: PipelineGenerator, bad_value: object) -> None:
    """Non-integer sample_size must be rejected before any SQL is built."""
    source_config = {
        "endpoint": "https://example.documents.azure.us:443/",
        "database": "mydb",
        "container": "mycontainer",
        "sample_size": bad_value,
    }
    with pytest.raises(SchemaDetectionError):
        generator._detect_cosmos_schema(source_config)


@pytest.mark.parametrize("bad_value", [0, -1, 10_001, 99_999])
def test_sample_size_rejects_out_of_range(generator: PipelineGenerator, bad_value: int) -> None:
    """sample_size outside [1, 10_000] must be rejected."""
    source_config = {
        "endpoint": "https://example.documents.azure.us:443/",
        "database": "mydb",
        "container": "mycontainer",
        "sample_size": bad_value,
    }
    with pytest.raises(SchemaDetectionError, match="between 1 and 10000"):
        generator._detect_cosmos_schema(source_config)


def test_missing_required_fields_raises(generator: PipelineGenerator) -> None:
    """Missing endpoint/database/container still surface a clear error."""
    with pytest.raises(SchemaDetectionError, match="required for Cosmos DB"):
        generator._detect_cosmos_schema({"sample_size": 100})
