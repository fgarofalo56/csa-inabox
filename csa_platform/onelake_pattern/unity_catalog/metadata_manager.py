"""Metadata manager for the Unity Catalog-style metadata layer.

Provides a three-level namespace (catalog.schema.table) for organizing
data assets in ADLS Gen2, tracking schema versions, ownership, tags,
and lineage — replicating Databricks Unity Catalog capabilities on
Azure PaaS.

Usage::

    from unity_catalog.metadata_manager import MetadataManager

    manager = MetadataManager(connection_string="...")

    # Register a catalog hierarchy
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

    # Search for tables
    results = manager.search_tables("revenue", catalog="finance")
"""

from __future__ import annotations

import argparse
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from csa_platform.common.logging import configure_structlog, get_logger

configure_structlog(service="metadata-manager")
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class CatalogEntry:
    """A top-level catalog in the three-level namespace."""

    name: str
    owner: str = ""
    description: str = ""
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    properties: dict[str, str] = field(default_factory=dict)


@dataclass
class SchemaEntry:
    """A schema within a catalog."""

    catalog_name: str
    name: str
    owner: str = ""
    description: str = ""
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    properties: dict[str, str] = field(default_factory=dict)


@dataclass
class ColumnDefinition:
    """Column definition within a table."""

    name: str
    type: str
    description: str = ""
    nullable: bool = True
    partition_key: bool = False
    pii_classification: str | None = None


@dataclass
class TableVersion:
    """A version snapshot of a table's schema."""

    version: int
    columns: list[dict[str, Any]]
    changed_by: str = ""
    change_description: str = ""
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )


@dataclass
class TableEntry:
    """A table registered in the metadata catalog."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    catalog_name: str = ""
    schema_name: str = ""
    name: str = ""
    full_name: str = ""  # catalog.schema.table
    table_type: str = "MANAGED"  # MANAGED, EXTERNAL
    data_source_format: str = "DELTA"
    location: str = ""  # ADLS Gen2 path
    owner: str = ""
    description: str = ""
    columns: list[dict[str, Any]] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    properties: dict[str, str] = field(default_factory=dict)
    schema_version: int = 1
    versions: list[TableVersion] = field(default_factory=list)
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# In-memory store (development / testing)
# ---------------------------------------------------------------------------


class InMemoryMetadataStore:
    """In-memory metadata store for local development and testing."""

    def __init__(self) -> None:
        self.catalogs: dict[str, CatalogEntry] = {}
        self.schemas: dict[str, SchemaEntry] = {}  # key = "catalog.schema"
        self.tables: dict[str, TableEntry] = {}  # key = "catalog.schema.table"

    def upsert_catalog(self, entry: CatalogEntry) -> None:
        self.catalogs[entry.name] = entry

    def get_catalog(self, name: str) -> CatalogEntry | None:
        return self.catalogs.get(name)

    def upsert_schema(self, entry: SchemaEntry) -> None:
        key = f"{entry.catalog_name}.{entry.name}"
        self.schemas[key] = entry

    def get_schema(self, catalog: str, schema: str) -> SchemaEntry | None:
        return self.schemas.get(f"{catalog}.{schema}")

    def upsert_table(self, entry: TableEntry) -> None:
        self.tables[entry.full_name] = entry

    def get_table(self, full_name: str) -> TableEntry | None:
        return self.tables.get(full_name)

    def delete_table(self, full_name: str) -> bool:
        return self.tables.pop(full_name, None) is not None

    def list_tables(
        self,
        catalog: str | None = None,
        schema: str | None = None,
    ) -> list[TableEntry]:
        results = list(self.tables.values())
        if catalog:
            results = [t for t in results if t.catalog_name == catalog]
        if schema:
            results = [t for t in results if t.schema_name == schema]
        return results

    def search_tables(self, query: str, catalog: str | None = None) -> list[TableEntry]:
        q = query.lower()
        results: list[TableEntry] = []
        for table in self.tables.values():
            if catalog and table.catalog_name != catalog:
                continue
            if q in table.name.lower() or q in table.description.lower() or any(q in tag.lower() for tag in table.tags):
                results.append(table)
        return results


# ---------------------------------------------------------------------------
# Metadata Manager
# ---------------------------------------------------------------------------


class MetadataManager:
    """Three-level namespace metadata manager (catalog.schema.table).

    Provides Unity Catalog-style metadata management for ADLS Gen2-based
    data lakes, with schema versioning, ownership tracking, and search.

    Args:
        connection_string: Connection string for the metadata backend
            (Azure SQL, Cosmos DB, or empty for in-memory store).
        backend: Backend type ('memory', 'sql', 'cosmos'). Defaults to
            'memory' for development.
    """

    def __init__(
        self,
        connection_string: str = "",
        backend: str = "memory",
    ) -> None:
        self.connection_string = connection_string
        self.backend = backend
        self._store = InMemoryMetadataStore()

    # -- Catalog operations -------------------------------------------------

    def register_catalog(
        self,
        name: str,
        owner: str = "",
        description: str = "",
        properties: dict[str, str] | None = None,
    ) -> CatalogEntry:
        """Register or update a catalog.

        Args:
            name: Catalog name (lowercase, no dots).
            owner: Owner email or team name.
            description: Human-readable description.
            properties: Optional key-value metadata.

        Returns:
            The registered catalog entry.
        """
        entry = CatalogEntry(
            name=name,
            owner=owner,
            description=description,
            properties=properties or {},
        )
        self._store.upsert_catalog(entry)
        logger.info("catalog.registered", name=name, owner=owner)
        return entry

    def get_catalog(self, name: str) -> CatalogEntry | None:
        """Get a catalog by name."""
        return self._store.get_catalog(name)

    # -- Schema operations --------------------------------------------------

    def register_schema(
        self,
        catalog_name: str,
        schema_name: str,
        owner: str = "",
        description: str = "",
        properties: dict[str, str] | None = None,
    ) -> SchemaEntry:
        """Register or update a schema within a catalog.

        Args:
            catalog_name: Parent catalog name.
            schema_name: Schema name.
            owner: Owner email or team name.
            description: Human-readable description.
            properties: Optional key-value metadata.

        Returns:
            The registered schema entry.

        Raises:
            ValueError: If the parent catalog does not exist.
        """
        catalog = self._store.get_catalog(catalog_name)
        if catalog is None:
            raise ValueError(f"Catalog not found: {catalog_name}")

        entry = SchemaEntry(
            catalog_name=catalog_name,
            name=schema_name,
            owner=owner or catalog.owner,
            description=description,
            properties=properties or {},
        )
        self._store.upsert_schema(entry)
        logger.info("schema.registered", catalog=catalog_name, schema=schema_name)
        return entry

    def get_schema(self, catalog_name: str, schema_name: str) -> SchemaEntry | None:
        """Get a schema by catalog and schema name."""
        return self._store.get_schema(catalog_name, schema_name)

    # -- Table operations ---------------------------------------------------

    def register_table(
        self,
        catalog: str,
        schema_name: str,
        table_name: str,
        location: str,
        columns: list[dict[str, Any]] | None = None,
        owner: str = "",
        description: str = "",
        table_type: str = "MANAGED",
        data_source_format: str = "DELTA",
        tags: list[str] | None = None,
        properties: dict[str, str] | None = None,
    ) -> TableEntry:
        """Register or update a table in the metadata catalog.

        Args:
            catalog: Catalog name.
            schema_name: Schema name.
            table_name: Table name.
            location: ADLS Gen2 path.
            columns: Column definitions.
            owner: Table owner.
            description: Description.
            table_type: MANAGED or EXTERNAL.
            data_source_format: Data format (DELTA, PARQUET, etc.).
            tags: Searchable tags.
            properties: Key-value metadata.

        Returns:
            The registered table entry.

        Raises:
            ValueError: If catalog or schema does not exist.
        """
        schema_entry = self._store.get_schema(catalog, schema_name)
        if schema_entry is None:
            raise ValueError(f"Schema not found: {catalog}.{schema_name}")

        full_name = f"{catalog}.{schema_name}.{table_name}"
        existing = self._store.get_table(full_name)

        if existing:
            # Update existing table
            existing.location = location
            existing.columns = columns or existing.columns
            existing.owner = owner or existing.owner
            existing.description = description or existing.description
            existing.tags = tags if tags is not None else existing.tags
            existing.properties = {**existing.properties, **(properties or {})}
            existing.updated_at = datetime.now(timezone.utc).isoformat()

            # Create a new schema version if columns changed
            if columns and columns != existing.columns:
                existing.schema_version += 1
                existing.versions.append(
                    TableVersion(
                        version=existing.schema_version,
                        columns=columns,
                        change_description="Schema updated",
                    )
                )

            self._store.upsert_table(existing)
            logger.info("table.updated", full_name=full_name, schema_version=existing.schema_version)
            return existing

        # Create new table
        entry = TableEntry(
            catalog_name=catalog,
            schema_name=schema_name,
            name=table_name,
            full_name=full_name,
            table_type=table_type,
            data_source_format=data_source_format,
            location=location,
            owner=owner,
            description=description,
            columns=columns or [],
            tags=tags or [],
            properties=properties or {},
            schema_version=1,
            versions=[
                TableVersion(
                    version=1,
                    columns=columns or [],
                    change_description="Initial registration",
                ),
            ],
        )
        self._store.upsert_table(entry)
        logger.info("table.registered", full_name=full_name)
        return entry

    def list_tables(
        self,
        catalog: str | None = None,
        schema_name: str | None = None,
    ) -> list[TableEntry]:
        """List tables with optional catalog/schema filtering.

        Args:
            catalog: Filter by catalog name.
            schema_name: Filter by schema name.

        Returns:
            List of matching table entries.
        """
        return self._store.list_tables(catalog=catalog, schema=schema_name)

    def get_table_metadata(
        self,
        catalog: str,
        schema_name: str,
        table_name: str,
    ) -> TableEntry | None:
        """Get full metadata for a specific table.

        Args:
            catalog: Catalog name.
            schema_name: Schema name.
            table_name: Table name.

        Returns:
            Table entry or None if not found.
        """
        full_name = f"{catalog}.{schema_name}.{table_name}"
        return self._store.get_table(full_name)

    def search_tables(
        self,
        query: str,
        catalog: str | None = None,
    ) -> list[TableEntry]:
        """Search tables by name, description, or tags.

        Args:
            query: Search query string.
            catalog: Optional catalog filter.

        Returns:
            List of matching table entries.
        """
        return self._store.search_tables(query, catalog=catalog)

    def delete_table(
        self,
        catalog: str,
        schema_name: str,
        table_name: str,
    ) -> bool:
        """Remove a table from the metadata catalog.

        Args:
            catalog: Catalog name.
            schema_name: Schema name.
            table_name: Table name.

        Returns:
            True if the table was found and deleted.
        """
        full_name = f"{catalog}.{schema_name}.{table_name}"
        deleted = self._store.delete_table(full_name)
        if deleted:
            logger.info("table.deleted", full_name=full_name)
        return deleted


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for the metadata manager."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box Unity Catalog Metadata Manager",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # register-catalog
    cat_parser = subparsers.add_parser("register-catalog", help="Register a catalog")
    cat_parser.add_argument("--name", required=True)
    cat_parser.add_argument("--owner", default="")
    cat_parser.add_argument("--description", default="")

    # register-schema
    sch_parser = subparsers.add_parser("register-schema", help="Register a schema")
    sch_parser.add_argument("--catalog", required=True)
    sch_parser.add_argument("--name", required=True)
    sch_parser.add_argument("--owner", default="")

    # register-table
    tbl_parser = subparsers.add_parser("register-table", help="Register a table")
    tbl_parser.add_argument("--catalog", required=True)
    tbl_parser.add_argument("--schema", required=True)
    tbl_parser.add_argument("--name", required=True)
    tbl_parser.add_argument("--location", required=True)
    tbl_parser.add_argument("--owner", default="")

    # list-tables
    list_parser = subparsers.add_parser("list-tables", help="List tables")
    list_parser.add_argument("--catalog", default=None)
    list_parser.add_argument("--schema", default=None)

    # search
    search_parser = subparsers.add_parser("search", help="Search tables")
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--catalog", default=None)

    args = parser.parse_args(argv)

    manager = MetadataManager()

    if args.command == "register-catalog":
        entry = manager.register_catalog(args.name, args.owner, args.description)
        print(f"Catalog registered: {entry.name}")
    elif args.command == "register-schema":
        entry = manager.register_schema(args.catalog, args.name, args.owner)
        print(f"Schema registered: {entry.catalog_name}.{entry.name}")
    elif args.command == "register-table":
        entry = manager.register_table(
            args.catalog,
            args.schema,
            args.name,
            args.location,
            owner=args.owner,
        )
        print(f"Table registered: {entry.full_name}")
    elif args.command == "list-tables":
        tables = manager.list_tables(catalog=args.catalog, schema_name=args.schema)
        for t in tables:
            print(f"  {t.full_name:40s}  {t.data_source_format:8s}  {t.owner}")
    elif args.command == "search":
        results = manager.search_tables(args.query, catalog=args.catalog)
        for t in results:
            print(f"  {t.full_name:40s}  {t.description[:50]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
