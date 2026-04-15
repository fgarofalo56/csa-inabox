"""Tests for Power BI semantic model generation from Delta tables.

Tests SemanticModelGenerator: type mapping (Databricks -> Power BI),
DAX measure generation, model YAML generation, and PBIP export format.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Bootstrap: add source dir to path and inject mock Databricks SDK modules
# ---------------------------------------------------------------------------
_scripts = str(Path(__file__).resolve().parent.parent / "scripts")
if _scripts not in sys.path:
    sys.path.insert(0, _scripts)

for _m in [
    "databricks",
    "databricks.sdk",
    "databricks.sdk.service",
    "databricks.sdk.service.sql",
    "databricks.sdk.service.iam",
]:
    sys.modules.setdefault(_m, MagicMock())
# ---------------------------------------------------------------------------

import pytest
import yaml
from generate_semantic_model import (
    DeltaColumn,
    DeltaTableInfo,
    SemanticModelGenerator,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _sample_tables() -> list[DeltaTableInfo]:
    """Build sample Delta table metadata for testing."""
    return [
        DeltaTableInfo(
            catalog="finance",
            schema_name="gold",
            name="revenue",
            full_name="finance.gold.revenue",
            columns=[
                DeltaColumn(name="fiscal_year", type="int", comment="Fiscal year"),
                DeltaColumn(name="region", type="string", comment="Region name"),
                DeltaColumn(name="amount", type="decimal(18,2)", comment="Revenue USD"),
                DeltaColumn(name="order_id", type="bigint", comment="Order ID"),
                DeltaColumn(name="_partition_key", type="string", is_partition=True),
            ],
            comment="Annual revenue by region",
        ),
        DeltaTableInfo(
            catalog="finance",
            schema_name="gold",
            name="expenses",
            full_name="finance.gold.expenses",
            columns=[
                DeltaColumn(name="id", type="bigint", comment="Primary key"),
                DeltaColumn(name="cost", type="double", comment="Cost in USD"),
                DeltaColumn(name="category", type="string", comment="Category"),
                DeltaColumn(name="recorded_at", type="timestamp", comment="Record time"),
            ],
            comment="Expense records",
        ),
    ]


@pytest.fixture
def generator():
    """Return a SemanticModelGenerator with mocked client."""
    gen = SemanticModelGenerator(
        workspace_url="https://adb-123.azuredatabricks.net",
        token="test-token",
    )
    gen._client = MagicMock()
    return gen


# ---------------------------------------------------------------------------
# Type mapping tests
# ---------------------------------------------------------------------------


class TestTypeMapping:
    """Test Databricks to Power BI type mapping."""

    def test_string_maps_to_string(self, generator):
        assert generator._map_type("string") == "String"

    def test_int_maps_to_int64(self, generator):
        assert generator._map_type("int") == "Int64"

    def test_bigint_maps_to_int64(self, generator):
        assert generator._map_type("bigint") == "Int64"

    def test_float_maps_to_double(self, generator):
        assert generator._map_type("float") == "Double"

    def test_double_maps_to_double(self, generator):
        assert generator._map_type("double") == "Double"

    def test_decimal_parameterized_maps_to_decimal(self, generator):
        assert generator._map_type("decimal(18,2)") == "Decimal"

    def test_boolean_maps_to_boolean(self, generator):
        assert generator._map_type("boolean") == "Boolean"

    def test_date_maps_to_datetime(self, generator):
        assert generator._map_type("date") == "DateTime"

    def test_timestamp_maps_to_datetime(self, generator):
        assert generator._map_type("timestamp") == "DateTime"

    def test_unknown_type_defaults_to_string(self, generator):
        assert generator._map_type("array<string>") == "String"
        assert generator._map_type("struct<a:int>") == "String"


# ---------------------------------------------------------------------------
# DAX measure generation tests
# ---------------------------------------------------------------------------


class TestGenerateDaxMeasures:
    """Test DAX measure template generation."""

    def test_numeric_aggregation_measures(self, generator):
        tables = _sample_tables()
        measures = generator.generate_dax_measures(tables)

        measure_names = [m.name for m in measures]
        assert "Total amount" in measure_names
        assert "Avg amount" in measure_names

    def test_cost_column_generates_measures(self, generator):
        tables = _sample_tables()
        measures = generator.generate_dax_measures(tables)

        cost_measures = [m for m in measures if "cost" in m.name.lower()]
        assert len(cost_measures) >= 2  # Total cost + Avg cost

    def test_id_column_generates_count_measures(self, generator):
        tables = _sample_tables()
        measures = generator.generate_dax_measures(tables)

        count_measures = [m for m in measures if "Count" in m.name or "Distinct" in m.name]
        assert len(count_measures) >= 2

    def test_dax_expression_format(self, generator):
        tables = _sample_tables()
        measures = generator.generate_dax_measures(tables)

        sum_measure = next(m for m in measures if m.name == "Total amount")
        assert "SUM(" in sum_measure.expression
        assert "'revenue'" in sum_measure.expression
        assert "[amount]" in sum_measure.expression

    def test_empty_tables_no_measures(self, generator):
        measures = generator.generate_dax_measures([])
        assert measures == []


# ---------------------------------------------------------------------------
# Semantic model generation tests
# ---------------------------------------------------------------------------


class TestGenerateModelYaml:
    """Test semantic model YAML definition generation."""

    def test_model_name_default(self, generator):
        tables = _sample_tables()
        model = generator.generate_model_yaml(tables)

        assert model.name == "finance-gold-model"

    def test_model_tables_count(self, generator):
        tables = _sample_tables()
        model = generator.generate_model_yaml(tables)

        assert len(model.tables) == 2

    def test_partition_columns_excluded(self, generator):
        tables = _sample_tables()
        model = generator.generate_model_yaml(tables)

        revenue_table = next(t for t in model.tables if t["name"] == "revenue")
        col_names = [c["name"] for c in revenue_table["columns"]]
        assert "_partition_key" not in col_names

    def test_hidden_columns_flagged(self, generator):
        """Columns starting with _ should be marked as hidden."""
        tables = [
            DeltaTableInfo(
                catalog="c",
                schema_name="s",
                name="t",
                full_name="c.s.t",
                columns=[
                    DeltaColumn(name="_internal", type="string"),
                    DeltaColumn(name="visible", type="string"),
                ],
            ),
        ]
        model = generator.generate_model_yaml(tables)

        cols = model.tables[0]["columns"]
        internal = next(c for c in cols if c["name"] == "_internal")
        visible = next(c for c in cols if c["name"] == "visible")
        assert internal["isHidden"] is True
        assert visible["isHidden"] is False

    def test_empty_tables_returns_empty_model(self, generator):
        model = generator.generate_model_yaml([], model_name="empty")
        assert model.name == "empty"
        assert model.tables == []

    def test_connection_includes_endpoint_id(self, generator):
        tables = _sample_tables()
        model = generator.generate_model_yaml(tables, sql_endpoint_id="ep-001")

        assert "ep-001" in model.connection["httpPath"]

    def test_direct_lake_partition_mode(self, generator):
        tables = _sample_tables()
        model = generator.generate_model_yaml(tables)

        for table in model.tables:
            assert table["partitions"][0]["mode"] == "directLake"


# ---------------------------------------------------------------------------
# PBIP export tests
# ---------------------------------------------------------------------------


class TestExportPbip:
    """Test export to YAML and JSON files."""

    def test_export_creates_yaml_and_json(self, generator, tmp_path):
        tables = _sample_tables()
        model = generator.generate_model_yaml(tables)
        measures = generator.generate_dax_measures(tables)

        files = generator.export_pbip(model, measures, output_path=tmp_path)

        assert "yaml" in files
        assert "json" in files
        assert Path(files["yaml"]).exists()
        assert Path(files["json"]).exists()

    def test_exported_yaml_is_valid(self, generator, tmp_path):
        tables = _sample_tables()
        model = generator.generate_model_yaml(tables, model_name="test-model")

        files = generator.export_pbip(model, output_path=tmp_path)

        with open(files["yaml"]) as f:
            data = yaml.safe_load(f)

        assert data["name"] == "test-model"
        assert len(data["tables"]) == 2

    def test_exported_json_is_valid(self, generator, tmp_path):
        tables = _sample_tables()
        model = generator.generate_model_yaml(tables, model_name="test-model")
        measures = generator.generate_dax_measures(tables)

        files = generator.export_pbip(model, measures, output_path=tmp_path)

        with open(files["json"]) as f:
            data = json.load(f)

        assert data["name"] == "test-model"
        assert len(data["measures"]) > 0
