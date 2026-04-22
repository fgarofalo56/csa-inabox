"""Tests for the portal marketplace models (ARCH-0001 consolidated).

Covers:
- Marketplace Pydantic models (enums, validation, QualityDimensions.compute)
- SLADefinition, LineageInfo, SchemaInfo typed sub-models
- DataProduct backward compatibility with untyped dict inputs

Previously these tests targeted ``csa_platform.data_marketplace.models``
which was deleted in ARCH-0001 Phase 4.  The portal models in
``portal.shared.api.models.marketplace`` are now the canonical surface.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from csa_platform.governance.common.logging import reset_logging_state

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset structlog state between tests."""
    reset_logging_state()
    yield
    reset_logging_state()


# ---------------------------------------------------------------------------
# Enum tests
# ---------------------------------------------------------------------------


class TestEnums:
    """Tests for marketplace enum types."""

    def test_access_level_values(self) -> None:
        from portal.shared.api.models.marketplace import AccessLevel

        assert AccessLevel.READ == "read"
        assert AccessLevel.READ_WRITE == "read_write"
        assert AccessLevel.ADMIN == "admin"

    def test_access_request_status_values(self) -> None:
        from portal.shared.api.models.marketplace import AccessRequestStatus

        assert AccessRequestStatus.PENDING == "pending"
        assert AccessRequestStatus.APPROVED == "approved"
        assert AccessRequestStatus.DENIED == "denied"

    def test_classification_levels(self) -> None:
        from portal.shared.api.models.source import ClassificationLevel

        assert ClassificationLevel.PUBLIC == "public"
        assert ClassificationLevel.INTERNAL == "internal"
        assert ClassificationLevel.CONFIDENTIAL == "confidential"
        assert ClassificationLevel.RESTRICTED == "restricted"


# ---------------------------------------------------------------------------
# QualityDimensions tests
# ---------------------------------------------------------------------------


class TestQualityDimensions:
    """Tests for QualityDimensions.compute class method."""

    def test_compute_weighted_score(self) -> None:
        """compute returns weighted overall score."""
        from portal.shared.api.models.marketplace import QualityDimensions

        score = QualityDimensions.compute(
            completeness=1.0,
            freshness=1.0,
            accuracy=1.0,
            consistency=1.0,
            uniqueness=1.0,
        )
        assert score.overall_score == 1.0

    def test_compute_zeros(self) -> None:
        """compute with all zeros returns 0.0."""
        from portal.shared.api.models.marketplace import QualityDimensions

        score = QualityDimensions.compute()
        assert score.overall_score == 0.0

    def test_compute_partial_scores(self) -> None:
        """compute with partial scores returns correct weighted sum."""
        from portal.shared.api.models.marketplace import QualityDimensions

        score = QualityDimensions.compute(completeness=0.8, freshness=0.6)
        # 0.8 * 0.25 + 0.6 * 0.25 + 0 + 0 + 0 = 0.35
        assert score.overall_score == 0.35


# ---------------------------------------------------------------------------
# SLADefinition / LineageInfo / SchemaInfo tests
# ---------------------------------------------------------------------------


class TestTypedSubModels:
    """Tests for ARCH-0001 Phase 2 typed sub-models."""

    def test_sla_defaults(self) -> None:
        from portal.shared.api.models.marketplace import SLADefinition

        sla = SLADefinition()
        assert sla.freshness_minutes == 120
        assert sla.availability_percent == 99.5
        assert sla.valid_row_ratio == 0.95

    def test_sla_custom_values(self) -> None:
        from portal.shared.api.models.marketplace import SLADefinition

        sla = SLADefinition(freshness_minutes=60, availability_percent=99.9)
        assert sla.freshness_minutes == 60
        assert sla.availability_percent == 99.9

    def test_lineage_info(self) -> None:
        from portal.shared.api.models.marketplace import LineageInfo

        lineage = LineageInfo(
            upstream=["source-a"],
            downstream=["target-b"],
            transformations=["dbt: orders_clean"],
        )
        assert len(lineage.upstream) == 1
        assert lineage.transformations[0] == "dbt: orders_clean"

    def test_lineage_empty_defaults(self) -> None:
        from portal.shared.api.models.marketplace import LineageInfo

        lineage = LineageInfo()
        assert lineage.upstream == []
        assert lineage.downstream == []

    def test_schema_info(self) -> None:
        from portal.shared.api.models.marketplace import SchemaInfo

        si = SchemaInfo(format="delta", location="abfss://gold@datalake/path/")
        assert si.format == "delta"
        assert si.partition_by == []


# ---------------------------------------------------------------------------
# DataProduct model tests
# ---------------------------------------------------------------------------


class TestDataProductModels:
    """Tests for the consolidated DataProduct model."""

    def test_basic_creation(self) -> None:
        from portal.shared.api.models.marketplace import DataProduct

        dp = DataProduct(
            id="dp-1",
            name="Test Product",
            description="A test product",
            domain="finance",
            owner={"name": "Alice", "email": "alice@test.com", "team": "Data"},
        )
        assert dp.id == "dp-1"
        assert dp.quality_score == 0.0
        assert dp.status == "active"
        assert dp.version == "1.0.0"

    def test_with_typed_sla(self) -> None:
        from portal.shared.api.models.marketplace import DataProduct, SLADefinition

        dp = DataProduct(
            id="dp-2",
            name="With SLA",
            description="Product with typed SLA",
            domain="hr",
            owner={"name": "Bob", "email": "bob@test.com", "team": "HR"},
            sla=SLADefinition(freshness_minutes=60),
        )
        assert dp.sla is not None
        assert dp.sla.freshness_minutes == 60

    def test_with_dict_sla_backward_compat(self) -> None:
        """Untyped dict inputs are coerced to SLADefinition via model_validate."""
        from portal.shared.api.models.marketplace import DataProduct

        dp = DataProduct.model_validate({
            "id": "dp-3",
            "name": "Dict SLA",
            "description": "Product with dict SLA",
            "domain": "sales",
            "owner": {"name": "Carlos", "email": "c@test.com", "team": "Sales"},
            "sla": {"freshness_minutes": 30, "availability_percent": 99.0},
        })
        assert dp.sla is not None
        assert dp.sla.freshness_minutes == 30

    def test_with_quality_dimensions(self) -> None:
        from portal.shared.api.models.marketplace import DataProduct, QualityDimensions

        dims = QualityDimensions.compute(completeness=0.95, freshness=0.9)
        dp = DataProduct(
            id="dp-4",
            name="With Dims",
            description="Product with quality dimensions",
            domain="finance",
            owner={"name": "Diana", "email": "d@test.com", "team": "Fin"},
            quality_score=dims.overall_score,
            quality_dimensions=dims,
        )
        assert dp.quality_dimensions is not None
        assert dp.quality_dimensions.overall_score == dp.quality_score

    def test_quality_score_bounds(self) -> None:
        """quality_score must be in [0.0, 1.0]."""
        from portal.shared.api.models.marketplace import DataProduct

        with pytest.raises(ValueError):
            DataProduct(
                id="dp-bad",
                name="Bad Score",
                description="Invalid",
                domain="test",
                owner={"name": "X", "email": "x@t.com", "team": "T"},
                quality_score=1.5,
            )

    def test_serialization_roundtrip(self) -> None:
        """DataProduct survives a dump/validate roundtrip."""
        from portal.shared.api.models.marketplace import (
            DataProduct,
            LineageInfo,
            SLADefinition,
        )

        dp = DataProduct(
            id="dp-rt",
            name="Roundtrip",
            description="Roundtrip test",
            domain="test",
            owner={"name": "RT", "email": "rt@test.com", "team": "QA"},
            sla=SLADefinition(freshness_minutes=15),
            lineage=LineageInfo(upstream=["src-a"]),
        )
        data = dp.model_dump()
        restored = DataProduct.model_validate(data)
        assert restored.sla is not None
        assert restored.sla.freshness_minutes == 15
        assert restored.lineage is not None
        assert restored.lineage.upstream == ["src-a"]


# ---------------------------------------------------------------------------
# QualityMetric tests
# ---------------------------------------------------------------------------


class TestQualityMetric:
    """Tests for the QualityMetric model."""

    def test_basic_creation(self) -> None:
        from portal.shared.api.models.marketplace import QualityMetric

        m = QualityMetric(
            date="2026-04-01",
            quality_score=0.95,
            completeness=0.98,
            freshness_hours=6.0,
            row_count=1_000_000,
        )
        assert m.quality_score == 0.95
        assert m.row_count == 1_000_000


# ---------------------------------------------------------------------------
# AccessRequest tests
# ---------------------------------------------------------------------------


class TestAccessRequest:
    """Tests for access request models."""

    def test_create_request(self) -> None:
        from portal.shared.api.models.marketplace import AccessRequestCreate

        req = AccessRequestCreate(
            data_product_id="dp-1",
            justification="Need data for quarterly report",
        )
        assert req.data_product_id == "dp-1"
        assert req.access_level.value == "read"

    def test_full_access_request(self) -> None:
        from portal.shared.api.models.marketplace import AccessRequest

        req = AccessRequest(
            id="req-1",
            requester_email="user@test.com",
            data_product_id="dp-1",
            justification="Quarterly analysis",
        )
        assert req.status.value == "pending"
        assert req.reviewed_at is None
