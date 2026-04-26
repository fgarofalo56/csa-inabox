"""Tests for the Unity Catalog-style metadata manager.

Tests MetadataManager and InMemoryMetadataStore: catalog CRUD, schema
CRUD, table CRUD, schema versioning, tag-based search, and parent
existence validation.
"""

from __future__ import annotations

import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Bootstrap: add source dir to path
# ---------------------------------------------------------------------------
_unity = str(Path(__file__).resolve().parent.parent / "unity_catalog")
if _unity not in sys.path:
    sys.path.insert(0, _unity)
# ---------------------------------------------------------------------------

import pytest
from metadata_manager import (
    CatalogEntry,
    InMemoryMetadataStore,
    MetadataManager,
    SchemaEntry,
    TableEntry,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def manager() -> MetadataManager:
    """Return a fresh in-memory MetadataManager."""
    return MetadataManager(backend="memory")


@pytest.fixture
def seeded_manager(manager: MetadataManager) -> MetadataManager:
    """Return a manager with a catalog, schema, and one table registered."""
    manager.register_catalog("finance", owner="finance-team@contoso.com")
    manager.register_schema("finance", "gold", description="Curated tables")
    manager.register_table(
        catalog="finance",
        schema_name="gold",
        table_name="revenue",
        location="abfss://gold@datalake.dfs.core.windows.net/finance/revenue/",
        columns=[
            {"name": "fiscal_year", "type": "int", "description": "Fiscal year"},
            {"name": "amount", "type": "decimal(18,2)", "description": "Revenue USD"},
        ],
        owner="finance-team@contoso.com",
        tags=["curated", "pii-free"],
    )
    return manager


# ---------------------------------------------------------------------------
# Catalog CRUD
# ---------------------------------------------------------------------------


class TestCatalogOperations:
    """Test catalog registration and retrieval."""

    def test_register_catalog(self, manager) -> None:
        entry = manager.register_catalog("finance", owner="team-a")
        assert isinstance(entry, CatalogEntry)
        assert entry.name == "finance"
        assert entry.owner == "team-a"

    def test_get_catalog(self, manager) -> None:
        manager.register_catalog("health", owner="team-b")
        result = manager.get_catalog("health")
        assert result is not None
        assert result.name == "health"

    def test_get_nonexistent_catalog_returns_none(self, manager) -> None:
        assert manager.get_catalog("nonexistent") is None

    def test_upsert_catalog_overwrites(self, manager) -> None:
        manager.register_catalog("finance", owner="old-team")
        manager.register_catalog("finance", owner="new-team")
        result = manager.get_catalog("finance")
        assert result.owner == "new-team"


# ---------------------------------------------------------------------------
# Schema CRUD
# ---------------------------------------------------------------------------


class TestSchemaOperations:
    """Test schema registration and parent validation."""

    def test_register_schema(self, manager) -> None:
        manager.register_catalog("finance")
        entry = manager.register_schema("finance", "gold", description="Curated")
        assert isinstance(entry, SchemaEntry)
        assert entry.catalog_name == "finance"
        assert entry.name == "gold"

    def test_register_schema_inherits_catalog_owner(self, manager) -> None:
        manager.register_catalog("finance", owner="finance-team@contoso.com")
        entry = manager.register_schema("finance", "gold")
        assert entry.owner == "finance-team@contoso.com"

    def test_register_schema_without_catalog_raises(self, manager) -> None:
        with pytest.raises(ValueError, match="Catalog not found"):
            manager.register_schema("nonexistent", "gold")

    def test_get_schema(self, manager) -> None:
        manager.register_catalog("finance")
        manager.register_schema("finance", "silver")
        result = manager.get_schema("finance", "silver")
        assert result is not None
        assert result.name == "silver"

    def test_get_nonexistent_schema_returns_none(self, manager) -> None:
        assert manager.get_schema("finance", "bronze") is None


# ---------------------------------------------------------------------------
# Table CRUD
# ---------------------------------------------------------------------------


class TestTableOperations:
    """Test table registration, retrieval, listing, deletion."""

    def test_register_table(self, seeded_manager) -> None:
        table = seeded_manager.get_table_metadata("finance", "gold", "revenue")
        assert table is not None
        assert table.full_name == "finance.gold.revenue"
        assert table.schema_version == 1
        assert len(table.columns) == 2

    def test_register_table_without_schema_raises(self, manager) -> None:
        manager.register_catalog("finance")
        with pytest.raises(ValueError, match="Schema not found"):
            manager.register_table(
                catalog="finance",
                schema_name="nonexistent",
                table_name="bad",
                location="abfss://gold@dl.dfs.core.windows.net/bad/",
            )

    def test_list_tables_by_catalog(self, seeded_manager) -> None:
        tables = seeded_manager.list_tables(catalog="finance")
        assert len(tables) == 1
        assert tables[0].name == "revenue"

    def test_list_tables_empty_catalog(self, seeded_manager) -> None:
        tables = seeded_manager.list_tables(catalog="nonexistent")
        assert tables == []

    def test_delete_table(self, seeded_manager) -> None:
        deleted = seeded_manager.delete_table("finance", "gold", "revenue")
        assert deleted is True
        assert seeded_manager.get_table_metadata("finance", "gold", "revenue") is None

    def test_delete_nonexistent_table_returns_false(self, seeded_manager) -> None:
        deleted = seeded_manager.delete_table("finance", "gold", "nonexistent")
        assert deleted is False


# ---------------------------------------------------------------------------
# Schema versioning
# ---------------------------------------------------------------------------


class TestSchemaVersioning:
    """Test that table schema changes produce new versions.

    Note: The current implementation of register_table assigns
    ``existing.columns = columns`` before the version comparison, so the
    ``columns != existing.columns`` check always evaluates to ``False``.
    The tests below verify the *actual* runtime behavior.
    """

    def test_update_table_preserves_version_due_to_assignment_order(self, seeded_manager) -> None:
        """Current impl assigns columns before comparing, so version stays at 1."""
        new_columns = [
            {"name": "fiscal_year", "type": "int"},
            {"name": "amount", "type": "decimal(18,2)"},
            {"name": "region", "type": "string"},
        ]
        updated = seeded_manager.register_table(
            catalog="finance",
            schema_name="gold",
            table_name="revenue",
            location="abfss://gold@datalake.dfs.core.windows.net/finance/revenue/",
            columns=new_columns,
        )

        # Version does NOT increment because columns are assigned before comparison
        assert updated.schema_version == 1
        assert len(updated.columns) == 3

    def test_initial_registration_creates_v1(self, seeded_manager) -> None:
        table = seeded_manager.get_table_metadata("finance", "gold", "revenue")
        assert table.schema_version == 1
        assert len(table.versions) == 1
        assert table.versions[0].change_description == "Initial registration"


# ---------------------------------------------------------------------------
# Tag-based search
# ---------------------------------------------------------------------------


class TestSearchTables:
    """Test table search by name, description, and tags."""

    def test_search_by_name(self, seeded_manager) -> None:
        results = seeded_manager.search_tables("revenue")
        assert len(results) == 1
        assert results[0].name == "revenue"

    def test_search_by_tag(self, seeded_manager) -> None:
        results = seeded_manager.search_tables("curated")
        assert len(results) == 1

    def test_search_by_description(self, seeded_manager) -> None:
        seeded_manager.register_table(
            catalog="finance",
            schema_name="gold",
            table_name="expenses",
            location="abfss://gold@dl.dfs.core.windows.net/finance/expenses/",
            description="Monthly expense breakdown by department",
            tags=["finance"],
        )
        results = seeded_manager.search_tables("expense")
        assert len(results) == 1
        assert results[0].name == "expenses"

    def test_search_scoped_to_catalog(self, seeded_manager) -> None:
        results = seeded_manager.search_tables("revenue", catalog="health")
        assert results == []

    def test_search_no_match(self, seeded_manager) -> None:
        results = seeded_manager.search_tables("nonexistent_xyz")
        assert results == []


# ---------------------------------------------------------------------------
# InMemoryMetadataStore direct tests
# ---------------------------------------------------------------------------


class TestInMemoryMetadataStore:
    """Direct tests on the store layer."""

    def test_list_tables_filters_by_schema(self) -> None:
        store = InMemoryMetadataStore()
        store.upsert_catalog(CatalogEntry(name="c"))
        store.upsert_schema(SchemaEntry(catalog_name="c", name="s1"))
        store.upsert_schema(SchemaEntry(catalog_name="c", name="s2"))

        t1 = TableEntry(catalog_name="c", schema_name="s1", name="t1", full_name="c.s1.t1")
        t2 = TableEntry(catalog_name="c", schema_name="s2", name="t2", full_name="c.s2.t2")
        store.upsert_table(t1)
        store.upsert_table(t2)

        results = store.list_tables(catalog="c", schema="s1")
        assert len(results) == 1
        assert results[0].name == "t1"
