"""Generate Power BI semantic model definitions from Delta tables.

Scans Databricks Unity Catalog for Delta table metadata and generates
Power BI semantic model definitions (YAML/JSON) suitable for Direct
Lake connectivity. Optionally generates DAX measure templates.

Usage::

    python generate_semantic_model.py scan \\
        --workspace-url https://adb-xxx.azuredatabricks.net \\
        --catalog finance \\
        --schema gold

    python generate_semantic_model.py generate \\
        --workspace-url https://adb-xxx.azuredatabricks.net \\
        --catalog finance \\
        --schema gold \\
        --output semantic_model.yaml
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class DeltaColumn:
    """Column metadata from a Delta table in Unity Catalog."""

    name: str
    type: str
    nullable: bool = True
    comment: str = ""
    is_partition: bool = False


@dataclass
class DeltaTableInfo:
    """Metadata about a Delta table in Unity Catalog."""

    catalog: str
    schema_name: str
    name: str
    full_name: str = ""
    table_type: str = "MANAGED"
    data_source_format: str = "DELTA"
    storage_location: str = ""
    columns: list[DeltaColumn] = field(default_factory=list)
    comment: str = ""
    row_count: int | None = None
    size_bytes: int | None = None
    properties: dict[str, str] = field(default_factory=dict)


@dataclass
class DAXMeasure:
    """A DAX measure definition for the semantic model."""

    name: str
    expression: str
    table_name: str
    format_string: str = ""
    description: str = ""


@dataclass
class SemanticModelDefinition:
    """Complete Power BI semantic model definition."""

    name: str
    description: str = ""
    catalog: str = ""
    schema_name: str = ""
    tables: list[dict[str, Any]] = field(default_factory=list)
    relationships: list[dict[str, Any]] = field(default_factory=list)
    measures: list[dict[str, Any]] = field(default_factory=list)
    connection: dict[str, str] = field(default_factory=dict)
    generated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# Semantic Model Generator
# ---------------------------------------------------------------------------


class SemanticModelGenerator:
    """Generate Power BI semantic models from Databricks Unity Catalog.

    Args:
        workspace_url: Databricks workspace URL.
        token: Databricks personal access token or Azure AD token.
    """

    # Databricks -> Power BI type mapping
    _TYPE_MAP: dict[str, str] = {
        "string": "String",
        "int": "Int64",
        "bigint": "Int64",
        "smallint": "Int64",
        "tinyint": "Int64",
        "long": "Int64",
        "float": "Double",
        "double": "Double",
        "decimal": "Decimal",
        "boolean": "Boolean",
        "date": "DateTime",
        "timestamp": "DateTime",
        "binary": "Binary",
    }

    def __init__(
        self,
        workspace_url: str = "",
        token: str = "",
    ) -> None:
        self.workspace_url = workspace_url.rstrip("/")
        self._token = token
        self._client: Any = None

    def _get_client(self) -> Any:
        """Lazily initialize the Databricks workspace client."""
        if self._client is not None:
            return self._client

        from databricks.sdk import WorkspaceClient

        self._client = WorkspaceClient(
            host=self.workspace_url,
            token=self._token if self._token else None,
        )
        return self._client

    def scan_delta_tables(
        self,
        catalog: str,
        schema_name: str,
        include_views: bool = False,
    ) -> list[DeltaTableInfo]:
        """Scan Unity Catalog for Delta tables in a schema.

        Args:
            catalog: Catalog name.
            schema_name: Schema name.
            include_views: Whether to include views.

        Returns:
            List of Delta table metadata.
        """
        client = self._get_client()
        tables: list[DeltaTableInfo] = []

        logger.info("Scanning tables in %s.%s", catalog, schema_name)

        try:
            table_list = client.tables.list(
                catalog_name=catalog,
                schema_name=schema_name,
            )

            for table in table_list:
                if not include_views and table.table_type and "VIEW" in str(table.table_type):
                    continue

                columns: list[DeltaColumn] = []
                if table.columns:
                    for col in table.columns:
                        columns.append(DeltaColumn(
                            name=col.name or "",
                            type=str(col.type_text or col.type_name or "string").lower(),
                            nullable=col.nullable if col.nullable is not None else True,
                            comment=col.comment or "",
                            is_partition=col.partition_index is not None,
                        ))

                info = DeltaTableInfo(
                    catalog=catalog,
                    schema_name=schema_name,
                    name=table.name or "",
                    full_name=f"{catalog}.{schema_name}.{table.name}",
                    table_type=str(table.table_type) if table.table_type else "MANAGED",
                    data_source_format=str(table.data_source_format) if table.data_source_format else "DELTA",
                    storage_location=table.storage_location or "",
                    columns=columns,
                    comment=table.comment or "",
                    properties=dict(table.properties or {}),
                )
                tables.append(info)

        except Exception:
            logger.exception("Failed to scan tables in %s.%s", catalog, schema_name)

        logger.info("Found %d tables in %s.%s", len(tables), catalog, schema_name)
        return tables

    def generate_model_yaml(
        self,
        tables: list[DeltaTableInfo],
        model_name: str = "",
        sql_endpoint_id: str = "",
    ) -> SemanticModelDefinition:
        """Generate a YAML semantic model definition from scanned tables.

        Args:
            tables: List of Delta table metadata.
            model_name: Name for the semantic model.
            sql_endpoint_id: Databricks SQL endpoint ID for Direct Lake.

        Returns:
            Semantic model definition.
        """
        if not tables:
            return SemanticModelDefinition(name=model_name or "empty-model")

        catalog = tables[0].catalog
        schema_name = tables[0].schema_name
        model_name = model_name or f"{catalog}-{schema_name}-model"

        model_tables: list[dict[str, Any]] = []
        for table in tables:
            pbi_columns: list[dict[str, Any]] = []
            for col in table.columns:
                if col.is_partition:
                    continue  # Skip partition columns in semantic model

                pbi_type = self._map_type(col.type)
                pbi_columns.append({
                    "name": col.name,
                    "dataType": pbi_type,
                    "sourceColumn": col.name,
                    "description": col.comment,
                    "isNullable": col.nullable,
                    "isHidden": col.name.startswith("_"),
                })

            model_tables.append({
                "name": table.name,
                "source": table.full_name,
                "description": table.comment,
                "columns": pbi_columns,
                "partitions": [{
                    "name": "DirectLake",
                    "mode": "directLake",
                    "source": {
                        "type": "entity",
                        "entityName": table.full_name,
                    },
                }],
            })

        host = self.workspace_url.replace("https://", "")
        connection = {
            "type": "databricksSql",
            "host": host,
            "httpPath": f"/sql/1.0/warehouses/{sql_endpoint_id}" if sql_endpoint_id else "",
            "catalog": catalog,
            "schema": schema_name,
        }

        model = SemanticModelDefinition(
            name=model_name,
            description=f"Auto-generated Direct Lake model for {catalog}.{schema_name}",
            catalog=catalog,
            schema_name=schema_name,
            tables=model_tables,
            connection=connection,
        )

        logger.info(
            "Generated semantic model '%s' with %d tables",
            model_name,
            len(model_tables),
        )
        return model

    def generate_dax_measures(
        self,
        tables: list[DeltaTableInfo],
    ) -> list[DAXMeasure]:
        """Generate common DAX measure templates from table metadata.

        Inspects column names and types to generate sensible default
        measures (SUM, COUNT, AVERAGE for numeric columns; DISTINCTCOUNT
        for ID columns).

        Args:
            tables: List of Delta table metadata.

        Returns:
            List of DAX measure definitions.
        """
        measures: list[DAXMeasure] = []

        for table in tables:
            for col in table.columns:
                col_lower = col.name.lower()
                col_type = col.type.lower()

                # Numeric aggregation measures
                if col_type in ("int", "bigint", "long", "float", "double", "decimal") or "decimal" in col_type:
                    if any(kw in col_lower for kw in ("amount", "total", "revenue", "cost", "price", "value", "qty", "quantity")):
                        measures.append(DAXMeasure(
                            name=f"Total {col.name}",
                            expression=f'SUM(\'{table.name}\'[{col.name}])',
                            table_name=table.name,
                            format_string="#,##0.00",
                            description=f"Sum of {col.name} from {table.name}",
                        ))
                        measures.append(DAXMeasure(
                            name=f"Avg {col.name}",
                            expression=f'AVERAGE(\'{table.name}\'[{col.name}])',
                            table_name=table.name,
                            format_string="#,##0.00",
                            description=f"Average of {col.name} from {table.name}",
                        ))

                # Count measures for ID columns
                if col_lower.endswith("_id") or col_lower == "id":
                    measures.append(DAXMeasure(
                        name=f"Count {table.name}",
                        expression=f'COUNTROWS(\'{table.name}\')',
                        table_name=table.name,
                        format_string="#,##0",
                        description=f"Row count of {table.name}",
                    ))
                    measures.append(DAXMeasure(
                        name=f"Distinct {col.name}",
                        expression=f'DISTINCTCOUNT(\'{table.name}\'[{col.name}])',
                        table_name=table.name,
                        format_string="#,##0",
                        description=f"Distinct count of {col.name}",
                    ))

        logger.info("Generated %d DAX measures", len(measures))
        return measures

    def export_pbip(
        self,
        model: SemanticModelDefinition,
        measures: list[DAXMeasure] | None = None,
        output_path: str | Path = ".",
    ) -> dict[str, str]:
        """Export the semantic model as YAML and JSON files.

        Args:
            model: Semantic model definition.
            measures: Optional DAX measures to include.
            output_path: Output directory.

        Returns:
            Dictionary with paths of generated files.
        """
        output = Path(output_path)
        output.mkdir(parents=True, exist_ok=True)

        # Add measures to model
        if measures:
            model.measures = [
                {
                    "name": m.name,
                    "expression": m.expression,
                    "tableName": m.table_name,
                    "formatString": m.format_string,
                    "description": m.description,
                }
                for m in measures
            ]

        # Export YAML
        yaml_path = output / f"{model.name}.yaml"
        model_dict = {
            "name": model.name,
            "description": model.description,
            "catalog": model.catalog,
            "schema": model.schema_name,
            "generatedAt": model.generated_at,
            "connection": model.connection,
            "tables": model.tables,
            "relationships": model.relationships,
            "measures": model.measures,
        }
        with open(yaml_path, "w", encoding="utf-8") as f:
            yaml.dump(model_dict, f, default_flow_style=False, sort_keys=False)

        # Export JSON (for Power BI tooling)
        json_path = output / f"{model.name}.json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(model_dict, f, indent=2)

        files = {
            "yaml": str(yaml_path),
            "json": str(json_path),
        }

        logger.info("Exported semantic model to %s", output)
        return files

    def _map_type(self, databricks_type: str) -> str:
        """Map a Databricks column type to Power BI data type."""
        dt = databricks_type.lower().strip()

        # Handle parameterized types like decimal(18,2)
        base_type = dt.split("(")[0]
        return self._TYPE_MAP.get(base_type, "String")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli_scan(args: argparse.Namespace) -> None:
    """Handle 'scan' subcommand."""
    generator = SemanticModelGenerator(
        workspace_url=args.workspace_url,
        token=args.token or "",
    )
    tables = generator.scan_delta_tables(args.catalog, args.schema)

    print(f"\nDelta tables in {args.catalog}.{args.schema}:")
    for t in tables:
        print(f"  {t.full_name:40s}  {t.data_source_format:8s}  {len(t.columns)} columns")


def _cli_generate(args: argparse.Namespace) -> None:
    """Handle 'generate' subcommand."""
    generator = SemanticModelGenerator(
        workspace_url=args.workspace_url,
        token=args.token or "",
    )

    tables = generator.scan_delta_tables(args.catalog, args.schema)
    model = generator.generate_model_yaml(tables, model_name=args.model_name or "")
    measures = generator.generate_dax_measures(tables)

    files = generator.export_pbip(model, measures, output_path=args.output)
    print(f"Generated semantic model:")
    for fmt, path in files.items():
        print(f"  {fmt}: {path}")


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box Semantic Model Generator for Direct Lake",
    )
    parser.add_argument("--workspace-url", required=True, help="Databricks workspace URL")
    parser.add_argument("--token", default="", help="Databricks PAT")
    parser.add_argument("--catalog", required=True, help="Unity Catalog name")
    parser.add_argument("--schema", required=True, help="Schema name")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # scan
    scan_parser = subparsers.add_parser("scan", help="Scan Delta tables")
    scan_parser.set_defaults(func=_cli_scan)

    # generate
    gen_parser = subparsers.add_parser("generate", help="Generate semantic model")
    gen_parser.add_argument("--model-name", default="", help="Model name")
    gen_parser.add_argument("--output", default=".", help="Output directory")
    gen_parser.set_defaults(func=_cli_generate)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
