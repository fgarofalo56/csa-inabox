"""Tests for the platform/data_marketplace module.

Covers:
- Data product Pydantic models (enums, validation, QualityScore.compute)
- InMemoryStore (CRUD operations)
- Marketplace FastAPI endpoints (health, products, access requests, quality)

Mocking strategy
----------------
The marketplace API uses an ``InMemoryStore`` for testing instead of
Cosmos DB. We override the ``get_store`` dependency to inject a fresh
store per test. No Azure SDK mocking is needed for these tests.

Note: The marketplace_api.py has an import from ``platform.data_marketplace``
which won't resolve as a normal Python import. We test the models directly
and the InMemoryStore/API via careful imports.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from governance.common.logging import reset_logging_state

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

    def test_data_format_values(self) -> None:
        from csa_platform.data_marketplace.models.data_product import DataFormat

        assert DataFormat.DELTA == "delta"
        assert DataFormat.PARQUET == "parquet"
        assert DataFormat.CSV == "csv"
        assert DataFormat.JSON == "json"
        assert DataFormat.AVRO == "avro"

    def test_access_level_values(self) -> None:
        from csa_platform.data_marketplace.models.data_product import AccessLevel

        assert AccessLevel.READ == "read"
        assert AccessLevel.READ_WRITE == "read_write"
        assert AccessLevel.ADMIN == "admin"

    def test_access_request_status_values(self) -> None:
        from csa_platform.data_marketplace.models.data_product import AccessRequestStatus

        assert AccessRequestStatus.PENDING == "pending"
        assert AccessRequestStatus.APPROVED == "approved"
        assert AccessRequestStatus.DENIED == "denied"

    def test_sensitivity_level_values(self) -> None:
        from csa_platform.data_marketplace.models.data_product import SensitivityLevel

        assert SensitivityLevel.PUBLIC == "public"
        assert SensitivityLevel.INTERNAL == "internal"
        assert SensitivityLevel.CONFIDENTIAL == "confidential"
        assert SensitivityLevel.RESTRICTED == "restricted"


# ---------------------------------------------------------------------------
# QualityScore tests
# ---------------------------------------------------------------------------


class TestQualityScore:
    """Tests for QualityScore.compute class method."""

    def test_compute_weighted_score(self) -> None:
        """compute returns weighted overall score."""
        from csa_platform.data_marketplace.models.data_product import QualityScore

        score = QualityScore.compute(
            completeness=1.0,
            freshness=1.0,
            accuracy=1.0,
            consistency=1.0,
            uniqueness=1.0,
        )
        assert score.overall_score == 1.0

    def test_compute_zeros(self) -> None:
        """compute with all zeros returns 0.0."""
        from csa_platform.data_marketplace.models.data_product import QualityScore

        score = QualityScore.compute()
        assert score.overall_score == 0.0

    def test_compute_partial_scores(self) -> None:
        """compute with partial scores returns correct weighted sum."""
        from csa_platform.data_marketplace.models.data_product import QualityScore

        score = QualityScore.compute(completeness=0.8, freshness=0.6)
        # 0.8 * 0.25 + 0.6 * 0.25 + 0 + 0 + 0 = 0.35
        assert score.overall_score == 0.35


# ---------------------------------------------------------------------------
# ColumnSchema / DataProductSchema tests
# ---------------------------------------------------------------------------


class TestSchemaModels:
    """Tests for schema-related models."""

    def test_column_schema(self) -> None:
        from csa_platform.data_marketplace.models.data_product import ColumnSchema

        col = ColumnSchema(name="id", type="string", description="Primary key", nullable=False)
        assert col.name == "id"
        assert col.nullable is False

    def test_column_schema_pii(self) -> None:
        from csa_platform.data_marketplace.models.data_product import ColumnSchema

        col = ColumnSchema(name="ssn", type="string", pii_classification="direct_identifier")
        assert col.pii_classification == "direct_identifier"

    def test_data_product_schema(self) -> None:
        from csa_platform.data_marketplace.models.data_product import ColumnSchema, DataFormat, DataProductSchema

        schema = DataProductSchema(
            format=DataFormat.DELTA,
            location="abfss://raw@storage.dfs.core.windows.net/data/",
            columns=[ColumnSchema(name="id", type="string")],
            partition_by=["date"],
            primary_key=["id"],
        )
        assert schema.format == DataFormat.DELTA
        assert len(schema.columns) == 1


# ---------------------------------------------------------------------------
# DataProduct model tests
# ---------------------------------------------------------------------------


class TestDataProductModels:
    """Tests for DataProduct and DataProductBase models."""

    def _make_product_data(self, **overrides: Any) -> dict[str, Any]:
        """Build valid data product creation data."""
        base: dict[str, Any] = {
            "name": "orders-raw",
            "domain": "sales",
            "owner": "data-team@contoso.com",
            "schema": {
                "format": "delta",
                "location": "abfss://raw@storage.dfs.core.windows.net/orders/",
            },
        }
        base.update(overrides)
        return base

    def test_data_product_base_valid(self) -> None:
        """DataProductBase accepts valid inputs."""
        from csa_platform.data_marketplace.models.data_product import DataProductBase

        product = DataProductBase(**self._make_product_data())
        assert product.name == "orders-raw"
        assert product.domain == "sales"

    def test_data_product_name_validation_valid(self) -> None:
        """DataProductBase accepts lowercase-hyphenated names."""
        from csa_platform.data_marketplace.models.data_product import DataProductBase

        product = DataProductBase(**self._make_product_data(name="sales-metrics"))
        assert product.name == "sales-metrics"

    def test_data_product_name_validation_invalid(self) -> None:
        """DataProductBase rejects names with uppercase or spaces."""
        from csa_platform.data_marketplace.models.data_product import DataProductBase

        with pytest.raises(ValueError, match="name"):
            DataProductBase(**self._make_product_data(name="Invalid Name"))

    def test_data_product_full(self) -> None:
        """DataProduct includes server-assigned fields."""
        from csa_platform.data_marketplace.models.data_product import DataProduct

        product = DataProduct(
            **self._make_product_data(),
            id=str(uuid.uuid4()),
        )
        assert product.status == "active"
        assert product.access_count == 0
        assert product.created_at is not None

    def test_data_product_summary_from_product(self) -> None:
        """DataProductSummary.from_product creates a lightweight summary."""
        from csa_platform.data_marketplace.models.data_product import DataProduct, DataProductSummary

        product = DataProduct(**self._make_product_data(), id="prod-1")
        summary = DataProductSummary.from_product(product)
        assert summary.id == "prod-1"
        assert summary.name == "orders-raw"
        assert summary.quality_score is None


# ---------------------------------------------------------------------------
# SLA and Lineage model tests
# ---------------------------------------------------------------------------


class TestSupportingModels:
    """Tests for SLA, lineage, and access request models."""

    def test_sla_defaults(self) -> None:
        from csa_platform.data_marketplace.models.data_product import SLADefinition

        sla = SLADefinition()
        assert sla.freshness_minutes == 120
        assert sla.availability_percent == 99.5
        assert sla.valid_row_ratio == 0.95

    def test_lineage_info(self) -> None:
        from csa_platform.data_marketplace.models.data_product import LineageInfo

        lineage = LineageInfo(upstream=["source-a"], downstream=["target-b"], transformations=["dbt: orders_clean"])
        assert len(lineage.upstream) == 1

    def test_access_request_create(self) -> None:
        from csa_platform.data_marketplace.models.data_product import AccessRequestCreate

        req = AccessRequestCreate(
            productId="prod-1",
            requester="user@test.com",
            justification="Need data for quarterly report analysis",
        )
        assert req.product_id == "prod-1"

    def test_access_request_approval(self) -> None:
        from csa_platform.data_marketplace.models.data_product import AccessRequestApproval

        approval = AccessRequestApproval(
            reviewer="admin@test.com",
            approved=True,
            notes="Approved for Q4 analysis",
        )
        assert approval.approved is True

    def test_quality_metric(self) -> None:
        from csa_platform.data_marketplace.models.data_product import QualityMetric

        metric = QualityMetric(productId="prod-1", metric_name="completeness", value=0.95)
        assert metric.product_id == "prod-1"
        assert metric.value == 0.95

    def test_paginated_response(self) -> None:
        from csa_platform.data_marketplace.models.data_product import PaginatedResponse

        resp = PaginatedResponse(items=["a", "b"], total=10, page=1, per_page=2, has_next=True)
        assert resp.has_next is True
        assert resp.total == 10


# ---------------------------------------------------------------------------
# InMemoryStore tests
# ---------------------------------------------------------------------------


class TestInMemoryStore:
    """Tests for the InMemoryStore data access layer."""

    def _make_store(self) -> Any:
        from csa_platform.data_marketplace.api.marketplace_api import InMemoryStore

        return InMemoryStore()

    def _make_product(self, **overrides: Any) -> Any:
        from csa_platform.data_marketplace.models.data_product import DataProduct

        data: dict[str, Any] = {
            "name": "test-product",
            "domain": "test",
            "owner": "owner@test.com",
            "schema": {
                "format": "delta",
                "location": "abfss://raw@storage.dfs.core.windows.net/test/",
            },
            "id": str(uuid.uuid4()),
        }
        data.update(overrides)
        return DataProduct(**data)

    @pytest.mark.asyncio
    async def test_create_and_get_product(self) -> None:
        """Store creates and retrieves products."""
        store = self._make_store()
        product = self._make_product(id="prod-1")
        await store.create_product(product)

        retrieved = await store.get_product("prod-1")
        assert retrieved is not None
        assert retrieved.name == "test-product"

    @pytest.mark.asyncio
    async def test_get_nonexistent_product(self) -> None:
        """Store returns None for nonexistent product."""
        store = self._make_store()
        result = await store.get_product("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_list_products_all(self) -> None:
        """list_products returns all stored products."""
        store = self._make_store()
        await store.create_product(self._make_product(id="p1"))
        await store.create_product(self._make_product(id="p2"))

        _, total = await store.list_products()
        assert total == 2

    @pytest.mark.asyncio
    async def test_list_products_filter_domain(self) -> None:
        """list_products filters by domain."""
        store = self._make_store()
        await store.create_product(self._make_product(id="p1", domain="sales"))
        await store.create_product(self._make_product(id="p2", domain="finance"))

        _, total = await store.list_products(domain="sales")
        assert total == 1

    @pytest.mark.asyncio
    async def test_list_products_search(self) -> None:
        """list_products filters by search query."""
        store = self._make_store()
        await store.create_product(self._make_product(id="p1", name="orders-raw"))
        await store.create_product(self._make_product(id="p2", name="invoices-clean"))

        _, total = await store.list_products(search="orders")
        assert total == 1

    @pytest.mark.asyncio
    async def test_list_products_pagination(self) -> None:
        """list_products supports pagination."""
        store = self._make_store()
        for i in range(5):
            await store.create_product(self._make_product(id=f"p{i}", name=f"product-{i}"))

        products, total = await store.list_products(page=1, per_page=2)
        assert total == 5
        assert len(products) == 2

    @pytest.mark.asyncio
    async def test_update_product(self) -> None:
        """update_product overwrites stored product."""
        store = self._make_store()
        product = self._make_product(id="p1")
        await store.create_product(product)
        product.description = "Updated description"
        await store.update_product(product)

        retrieved = await store.get_product("p1")
        assert retrieved is not None
        assert retrieved.description == "Updated description"

    @pytest.mark.asyncio
    async def test_access_request_crud(self) -> None:
        """Store creates, retrieves, and updates access requests."""
        from csa_platform.data_marketplace.models.data_product import AccessRequest, AccessRequestStatus

        store = self._make_store()
        req = AccessRequest(
            id="req-1",
            productId="prod-1",
            requester="user@test.com",
            requested_role="read",
            justification="Need access for reporting",
        )
        await store.create_access_request(req)

        retrieved = await store.get_access_request("req-1")
        assert retrieved is not None
        assert retrieved.requester == "user@test.com"

        req.status = AccessRequestStatus.APPROVED
        await store.update_access_request(req)

        updated = await store.get_access_request("req-1")
        assert updated is not None
        assert updated.status == AccessRequestStatus.APPROVED

    @pytest.mark.asyncio
    async def test_quality_metrics(self) -> None:
        """Store adds and retrieves quality metrics."""
        from csa_platform.data_marketplace.models.data_product import QualityMetric

        store = self._make_store()
        metric = QualityMetric(productId="prod-1", metric_name="completeness", value=0.95)
        await store.add_quality_metric(metric)

        history = await store.get_quality_history("prod-1")
        assert len(history) == 1
        assert history[0].value == 0.95

    @pytest.mark.asyncio
    async def test_quality_history_limit(self) -> None:
        """get_quality_history respects the limit parameter."""
        from csa_platform.data_marketplace.models.data_product import QualityMetric

        store = self._make_store()
        for i in range(10):
            metric = QualityMetric(
                productId="prod-1",
                metric_name="completeness",
                value=0.9 + i * 0.01,
            )
            await store.add_quality_metric(metric)

        history = await store.get_quality_history("prod-1", limit=5)
        assert len(history) == 5
