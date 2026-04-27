"""Smoke tests for the fabric-e2e example.

Validates the structure on disk so a CI run can quickly catch:
- TMDL files missing or malformed
- Contracts missing or invalid
- Sample data CSVs present + parseable
- Bicep + deploy.sh present + executable
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent


def test_required_top_level_files_exist():
    expected = ["README.md", "ARCHITECTURE.md"]
    for name in expected:
        assert (ROOT / name).exists(), f"Missing {name}"


def test_pbip_definition_is_valid_json():
    pbism = ROOT / "semantic-model" / "retail-sales.SemanticModel" / "definition.pbism"
    assert pbism.exists(), "PBIP definition.pbism missing"
    with open(pbism, encoding="utf-8") as f:
        data = json.load(f)
    assert "version" in data


def test_diagram_layout_is_valid_json():
    layout = ROOT / "semantic-model" / "retail-sales.SemanticModel" / "diagramLayout.json"
    assert layout.exists()
    with open(layout, encoding="utf-8") as f:
        data = json.load(f)
    assert "diagrams" in data and len(data["diagrams"]) > 0


def test_all_4_tmdl_tables_present():
    tables_dir = ROOT / "semantic-model" / "retail-sales.SemanticModel" / "definition" / "tables"
    expected = {"DimCustomer.tmdl", "DimProduct.tmdl", "DimDate.tmdl", "FactSales.tmdl"}
    actual = {f.name for f in tables_dir.glob("*.tmdl")}
    assert expected.issubset(actual), f"Missing TMDL tables: {expected - actual}"


def test_relationships_tmdl_defines_all_4_relationships():
    rel = (ROOT / "semantic-model" / "retail-sales.SemanticModel" / "definition" / "relationships.tmdl").read_text(encoding="utf-8")
    rel_count = len(re.findall(r"^relationship\s+\w+", rel, re.MULTILINE))
    assert rel_count == 4, f"Expected 4 relationships, found {rel_count}"


def test_factsales_tmdl_uses_directlake():
    tmdl = (ROOT / "semantic-model" / "retail-sales.SemanticModel" / "definition" / "tables" / "FactSales.tmdl").read_text(encoding="utf-8")
    assert "mode: directLake" in tmdl, "FactSales is not in Direct Lake mode"


def test_factsales_has_core_measures():
    tmdl = (ROOT / "semantic-model" / "retail-sales.SemanticModel" / "definition" / "tables" / "FactSales.tmdl").read_text(encoding="utf-8")
    expected_measures = ["Total Sales", "Total Margin", "Margin %", "Order Count", "Sales YTD", "Sales YoY %"]
    for m in expected_measures:
        assert f"measure '{m}'" in tmdl, f"Missing measure: {m}"


def test_dimdate_marked_as_date_table():
    tmdl = (ROOT / "semantic-model" / "retail-sales.SemanticModel" / "definition" / "tables" / "DimDate.tmdl").read_text(encoding="utf-8")
    assert "dataCategory: Time" in tmdl


def test_4_contracts_exist():
    contracts_dir = ROOT / "contracts"
    expected = {"dim_customer.yaml", "dim_product.yaml", "dim_date.yaml", "fact_sales.yaml"}
    actual = {f.name for f in contracts_dir.glob("*.yaml")}
    assert actual == expected


def test_contracts_pass_validator():
    """Each contract validates against the platform schema."""
    from csa_platform.governance.contracts.contract_validator import (
        load_contract,
        validate_contract_structure,
    )

    contracts_dir = ROOT / "contracts"
    for f in contracts_dir.glob("*.yaml"):
        c = load_contract(str(f))
        errors = validate_contract_structure(c)
        assert errors == [], f"{f.name} structure errors: {errors}"


@pytest.mark.parametrize("filename,expected_min_rows", [
    ("customers.csv", 1000),
    ("products.csv", 500),
    ("sales.csv", 50000),
])
def test_sample_data_csv_shape(filename: str, expected_min_rows: int):
    p = ROOT / "sample_data" / filename
    assert p.exists(), f"Missing sample data: {filename}"
    with open(p, encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        assert len(header) >= 4, f"Too few columns in {filename}"
        rows = sum(1 for _ in reader)
        assert rows >= expected_min_rows, f"{filename} has {rows} rows, expected ≥ {expected_min_rows}"


def test_deploy_files_present():
    assert (ROOT / "deploy" / "bicep" / "main.bicep").exists()
    assert (ROOT / "deploy" / "fabric" / "deploy.sh").exists()


def test_dbt_project_present_and_loads():
    import yaml

    p = ROOT / "dbt" / "dbt_project.yml"
    assert p.exists()
    data = yaml.safe_load(open(p, encoding="utf-8"))
    assert data["name"] == "fabric_e2e"
    assert "bronze" in data["models"]["fabric_e2e"]
    assert "silver" in data["models"]["fabric_e2e"]
    assert "gold" in data["models"]["fabric_e2e"]


def test_dbt_has_4_gold_models():
    gold = ROOT / "dbt" / "models" / "gold"
    expected = {"dim_customer.sql", "dim_product.sql", "dim_date.sql", "fact_sales.sql"}
    actual = {f.name for f in gold.glob("*.sql")}
    assert expected.issubset(actual)
