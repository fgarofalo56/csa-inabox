"""Tests for the dbt test auto-generator."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from csa_platform.governance.contracts.contract_validator import load_contract
from csa_platform.governance.contracts.dbt_test_generator import (
    generate_schema_yml,
    group_contracts_by_domain,
    main,
    output_path_for_domain,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SALES_ORDERS_CONTRACT = REPO_ROOT / "domains" / "sales" / "data-products" / "orders" / "contract.yaml"


# ---------------------------------------------------------------------------
# generate_schema_yml
# ---------------------------------------------------------------------------


def test_generates_valid_yaml_from_sales_orders_contract() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    output = generate_schema_yml([contract])
    parsed = yaml.safe_load(output)
    assert parsed["version"] == 2
    assert len(parsed["models"]) == 1
    model = parsed["models"][0]
    assert model["name"] == "slv_orders"


def test_generated_model_has_not_null_for_non_nullable_columns() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    output = generate_schema_yml([contract])
    parsed = yaml.safe_load(output)
    model = parsed["models"][0]
    col_map = {c["name"]: c for c in model["columns"]}

    # order_sk is nullable=false in the contract
    order_sk = col_map["order_sk"]
    assert "not_null" in order_sk["tests"]


def test_generated_model_has_unique_from_quality_rule() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    output = generate_schema_yml([contract])
    parsed = yaml.safe_load(output)
    model = parsed["models"][0]
    col_map = {c["name"]: c for c in model["columns"]}

    # expect_column_values_to_be_unique on order_sk
    order_sk = col_map["order_sk"]
    assert "unique" in order_sk["tests"]


def test_generated_model_has_accepted_values_for_status() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    output = generate_schema_yml([contract])
    parsed = yaml.safe_load(output)
    model = parsed["models"][0]
    col_map = {c["name"]: c for c in model["columns"]}

    status = col_map["status"]
    av_tests = [t for t in status["tests"] if isinstance(t, dict) and "accepted_values" in t]
    assert len(av_tests) >= 1
    assert "DELIVERED" in av_tests[0]["accepted_values"]["values"]


def test_generated_model_has_expression_is_true_for_between_rule() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    output = generate_schema_yml([contract])
    parsed = yaml.safe_load(output)
    model = parsed["models"][0]
    col_map = {c["name"]: c for c in model["columns"]}

    total_amount = col_map["total_amount"]
    expr_tests = [
        t for t in total_amount.get("tests", []) if isinstance(t, dict) and "dbt_utils.expression_is_true" in t
    ]
    assert len(expr_tests) >= 1
    assert ">= 0" in expr_tests[0]["dbt_utils.expression_is_true"]["expression"]


def test_generated_model_description_mentions_auto_generated() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    output = generate_schema_yml([contract])
    parsed = yaml.safe_load(output)
    model = parsed["models"][0]
    assert "Auto-generated" in model["description"]


def test_header_contains_regeneration_instructions() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    output = generate_schema_yml([contract])
    assert "AUTO-GENERATED" in output
    assert "--write" in output
    assert "--check" in output


def test_exclude_models_filters_out_specified_names() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    output = generate_schema_yml([contract], exclude_models={"slv_orders"})
    parsed = yaml.safe_load(output)
    assert len(parsed["models"]) == 0


# ---------------------------------------------------------------------------
# group_contracts_by_domain
# ---------------------------------------------------------------------------


def test_group_contracts_by_domain_separates_correctly() -> None:
    contracts = []
    for domain_dir in (REPO_ROOT / "domains").iterdir():
        contract_dir = domain_dir / "data-products"
        if not contract_dir.exists():
            continue
        for product_dir in contract_dir.iterdir():
            contract_path = product_dir / "contract.yaml"
            if contract_path.exists():
                contracts.append(load_contract(contract_path))

    by_domain = group_contracts_by_domain(contracts)
    # We know there are at least shared, sales, finance, inventory
    assert "shared" in by_domain
    assert "sales" in by_domain
    assert len(by_domain) >= 4


# ---------------------------------------------------------------------------
# output_path_for_domain
# ---------------------------------------------------------------------------


def test_output_path_for_domain_uses_correct_template() -> None:
    path = output_path_for_domain(Path("/repo"), "sales")
    assert str(path).replace("\\", "/") == "/repo/domains/sales/dbt/models/silver/schema_contract_generated.yml"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_main_preview_mode_prints_yaml(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["--repo-root", str(REPO_ROOT)])
    assert rc == 0
    captured = capsys.readouterr()
    assert "version: 2" in captured.out
    assert "slv_orders" in captured.out


def test_main_write_creates_per_domain_files(tmp_path: Path) -> None:
    # Create a fake repo layout with the sales/orders contract
    domains_dir = tmp_path / "domains" / "sales" / "data-products" / "orders"
    domains_dir.mkdir(parents=True)

    # Create a stub SQL file so the generator recognises the model as existing
    silver_dir = tmp_path / "domains" / "sales" / "dbt" / "models" / "silver"
    silver_dir.mkdir(parents=True)
    (silver_dir / "slv_orders.sql").write_text("SELECT 1")

    # Copy the real contract
    import shutil

    shutil.copy(SALES_ORDERS_CONTRACT, domains_dir / "contract.yaml")

    rc = main(["--repo-root", str(tmp_path), "--write"])
    assert rc == 0

    # The sales contract has domain=sales, so output goes to sales/dbt/
    generated_file = tmp_path / "domains" / "sales" / "dbt" / "models" / "silver" / "schema_contract_generated.yml"
    assert generated_file.exists()
    content = generated_file.read_text()
    assert "slv_orders" in content


def test_main_check_passes_when_up_to_date(tmp_path: Path) -> None:
    # Create repo layout and generate the file first
    domains_dir = tmp_path / "domains" / "sales" / "data-products" / "orders"
    domains_dir.mkdir(parents=True)

    silver_dir = tmp_path / "domains" / "sales" / "dbt" / "models" / "silver"
    silver_dir.mkdir(parents=True)
    (silver_dir / "slv_orders.sql").write_text("SELECT 1")

    import shutil

    shutil.copy(SALES_ORDERS_CONTRACT, domains_dir / "contract.yaml")

    # Write first
    assert main(["--repo-root", str(tmp_path), "--write"]) == 0

    # Then check -- should pass
    assert main(["--repo-root", str(tmp_path), "--check"]) == 0


def test_main_check_fails_when_out_of_date(tmp_path: Path) -> None:
    domains_dir = tmp_path / "domains" / "sales" / "data-products" / "orders"
    domains_dir.mkdir(parents=True)

    silver_dir = tmp_path / "domains" / "sales" / "dbt" / "models" / "silver"
    silver_dir.mkdir(parents=True)
    (silver_dir / "slv_orders.sql").write_text("SELECT 1")

    import shutil

    shutil.copy(SALES_ORDERS_CONTRACT, domains_dir / "contract.yaml")

    # Write the correct generated file first
    assert main(["--repo-root", str(tmp_path), "--write"]) == 0

    # Now tamper with it
    output_file = tmp_path / "domains" / "sales" / "dbt" / "models" / "silver" / "schema_contract_generated.yml"
    output_file.write_text("old content\n")

    # Check should fail
    assert main(["--repo-root", str(tmp_path), "--check"]) == 1


def test_main_exits_zero_when_no_contracts_found(tmp_path: Path) -> None:
    # Empty repo layout
    (tmp_path / "domains").mkdir()
    rc = main(["--repo-root", str(tmp_path)])
    assert rc == 0
