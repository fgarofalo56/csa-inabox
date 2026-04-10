"""Tests for the data product contract validator."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from governance.contracts.contract_validator import (
    Column,
    Contract,
    ContractValidationError,
    SLA,
    find_contracts,
    load_contract,
    main,
    validate_contract_structure,
    validate_rows_against_contract,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
SALES_ORDERS_CONTRACT = REPO_ROOT / "domains" / "sales" / "data-products" / "orders" / "contract.yaml"


# ---------------------------------------------------------------------------
# load_contract
# ---------------------------------------------------------------------------


def test_load_contract_parses_sales_orders_example() -> None:
    contract = load_contract(SALES_ORDERS_CONTRACT)
    assert contract.name == "sales.orders"
    assert contract.domain == "sales"
    assert "order_sk" in [c.name for c in contract.columns]
    assert contract.primary_key == ["order_sk"]
    assert contract.sla.freshness_minutes == 60
    assert any(r.rule == "expect_column_values_to_be_unique" for r in contract.quality_rules)


def test_load_contract_rejects_wrong_api_version(tmp_path: Path) -> None:
    bad = tmp_path / "contract.yaml"
    bad.write_text(
        "apiVersion: wrong/v1\nkind: DataProductContract\n"
        "metadata: {name: x, domain: x, owner: x, version: '1'}\n"
        "schema: {primary_key: [a], columns: [{name: a, type: string}]}\n"
    )
    with pytest.raises(ContractValidationError, match="apiVersion"):
        load_contract(bad)


def test_load_contract_rejects_wrong_kind(tmp_path: Path) -> None:
    bad = tmp_path / "contract.yaml"
    bad.write_text(
        "apiVersion: csa.microsoft.com/v1\nkind: WrongKind\n"
        "metadata: {name: x, domain: x, owner: x, version: '1'}\n"
        "schema: {primary_key: [a], columns: [{name: a, type: string}]}\n"
    )
    with pytest.raises(ContractValidationError, match="kind"):
        load_contract(bad)


def test_load_contract_requires_metadata(tmp_path: Path) -> None:
    bad = tmp_path / "contract.yaml"
    bad.write_text(
        "apiVersion: csa.microsoft.com/v1\nkind: DataProductContract\n"
        "schema: {primary_key: [a], columns: [{name: a, type: string}]}\n"
    )
    with pytest.raises(ContractValidationError, match="metadata"):
        load_contract(bad)


# ---------------------------------------------------------------------------
# validate_contract_structure
# ---------------------------------------------------------------------------


def _make_contract(
    columns: list[Column],
    primary_key: list[str],
    **kwargs: Any,
) -> Contract:
    return Contract(
        name=kwargs.get("name", "test.product"),
        domain=kwargs.get("domain", "test"),
        owner=kwargs.get("owner", "owner@example.com"),
        version=kwargs.get("version", "1.0.0"),
        description=kwargs.get("description", ""),
        primary_key=primary_key,
        columns=columns,
        sla=kwargs.get("sla", SLA()),
        quality_rules=kwargs.get("quality_rules", []),
    )


def test_validate_structure_accepts_valid_contract() -> None:
    contract = _make_contract(
        columns=[Column(name="id", type="string", nullable=False)],
        primary_key=["id"],
    )
    assert validate_contract_structure(contract) == []


def test_validate_structure_catches_pk_not_in_columns() -> None:
    contract = _make_contract(
        columns=[Column(name="id", type="string")],
        primary_key=["missing_col"],
    )
    errors = validate_contract_structure(contract)
    assert any("primary_key column 'missing_col'" in e for e in errors)


def test_validate_structure_catches_unsupported_type() -> None:
    contract = _make_contract(
        columns=[Column(name="payload", type="bson")],
        primary_key=["payload"],
    )
    errors = validate_contract_structure(contract)
    assert any("unsupported type" in e for e in errors)


def test_validate_structure_accepts_decimal_with_precision() -> None:
    contract = _make_contract(
        columns=[
            Column(name="id", type="string", nullable=False),
            Column(name="amount", type="decimal(18,2)", nullable=False),
        ],
        primary_key=["id"],
    )
    assert validate_contract_structure(contract) == []


def test_validate_structure_catches_allowed_values_on_non_string() -> None:
    contract = _make_contract(
        columns=[
            Column(name="id", type="long", nullable=False, allowed_values=["1", "2"]),
        ],
        primary_key=["id"],
    )
    errors = validate_contract_structure(contract)
    assert any("allowed_values" in e for e in errors)


# ---------------------------------------------------------------------------
# validate_rows_against_contract
# ---------------------------------------------------------------------------


@pytest.fixture
def orders_contract() -> Contract:
    return load_contract(SALES_ORDERS_CONTRACT)


def test_validate_rows_passes_on_clean_batch(orders_contract: Contract) -> None:
    rows = [
        {
            "order_sk": "abc123",
            "order_id": 1,
            "customer_id": 10,
            "order_date": "2026-04-10",
            "total_amount": 42.50,
            "status": "DELIVERED",
            "is_valid": True,
            "validation_errors": "",
        },
    ]
    assert validate_rows_against_contract(orders_contract, rows) == []


def test_validate_rows_rejects_missing_required_column(orders_contract: Contract) -> None:
    rows = [
        {
            # no order_sk
            "order_id": 1,
            "total_amount": 10.0,
            "status": "DELIVERED",
            "is_valid": True,
        },
    ]
    violations = validate_rows_against_contract(orders_contract, rows)
    assert any("order_sk" in v for v in violations)


def test_validate_rows_rejects_bad_status_value(orders_contract: Contract) -> None:
    rows = [
        {
            "order_sk": "abc",
            "order_id": 1,
            "total_amount": 1.0,
            "status": "BOGUS_STATUS",
            "is_valid": True,
            "validation_errors": "",
        },
    ]
    violations = validate_rows_against_contract(orders_contract, rows)
    assert any("BOGUS_STATUS" in v for v in violations)


def test_validate_rows_rejects_wrong_type(orders_contract: Contract) -> None:
    rows = [
        {
            "order_sk": "abc",
            "order_id": "not-a-number",  # should be long
            "total_amount": 1.0,
            "status": "DELIVERED",
            "is_valid": True,
        },
    ]
    violations = validate_rows_against_contract(orders_contract, rows)
    assert any("order_id" in v for v in violations)


def test_validate_rows_allows_null_on_nullable_columns(orders_contract: Contract) -> None:
    rows = [
        {
            "order_sk": "abc",
            "order_id": None,         # nullable in the contract
            "customer_id": None,      # nullable
            "total_amount": 1.0,
            "status": "DELIVERED",
            "is_valid": False,
            "validation_errors": "order_id null; customer_id null",
        },
    ]
    assert validate_rows_against_contract(orders_contract, rows) == []


def test_validate_rows_fail_fast_returns_first_violation(orders_contract: Contract) -> None:
    rows = [
        {"order_sk": None, "order_id": 1, "total_amount": 1.0, "status": "DELIVERED", "is_valid": True},
        {"order_sk": "abc", "order_id": 2, "total_amount": 2.0, "status": "DELIVERED", "is_valid": True},
    ]
    violations = validate_rows_against_contract(orders_contract, rows, fail_fast=True)
    assert len(violations) == 1


# ---------------------------------------------------------------------------
# find_contracts + main CLI
# ---------------------------------------------------------------------------


def test_find_contracts_discovers_sales_orders() -> None:
    found = find_contracts(REPO_ROOT)
    assert SALES_ORDERS_CONTRACT.resolve() in [p.resolve() for p in found]


def test_main_exits_zero_on_valid_contracts(capsys: pytest.CaptureFixture[str]) -> None:
    rc = main(["--repo-root", str(REPO_ROOT), "--ci"])
    assert rc == 0
    captured = capsys.readouterr()
    assert "OK" in captured.out


def test_main_exits_non_zero_on_invalid_contract(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Create a malformed contract under a fake repo layout.
    bad_dir = tmp_path / "domains" / "bad" / "data-products" / "broken"
    bad_dir.mkdir(parents=True)
    (bad_dir / "contract.yaml").write_text(
        "apiVersion: csa.microsoft.com/v1\nkind: DataProductContract\n"
        "metadata: {name: bad, domain: bad, owner: x, version: '1'}\n"
        "schema:\n"
        "  primary_key: [missing_col]\n"
        "  columns: [{name: real_col, type: string}]\n"
    )
    rc = main(["--repo-root", str(tmp_path), "--ci"])
    assert rc == 1
    captured = capsys.readouterr()
    assert "missing_col" in captured.err
