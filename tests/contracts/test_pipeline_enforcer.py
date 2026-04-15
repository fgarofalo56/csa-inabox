"""Tests for the pipeline contract enforcer."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from governance.contracts.contract_validator import (
    SLA,
    Column,
    Contract,
    load_contract,
)
from governance.contracts.pipeline_enforcer import (
    ContractEnforcer,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SALES_ORDERS_CONTRACT = (
    REPO_ROOT / "domains" / "sales" / "data-products" / "orders" / "contract.yaml"
)


def _make_contract(**kwargs: Any) -> Contract:
    defaults: dict[str, Any] = {
        "name": "test.product",
        "domain": "test",
        "owner": "owner@example.com",
        "version": "1.0.0",
        "description": "",
        "primary_key": ["id"],
        "columns": [
            Column(name="id", type="string", nullable=False),
            Column(name="value", type="long", nullable=True),
        ],
        "sla": SLA(valid_row_ratio=0.9),
        "quality_rules": [],
    }
    defaults.update(kwargs)
    return Contract(**defaults)


@pytest.fixture
def simple_contract() -> Contract:
    return _make_contract()


@pytest.fixture
def orders_contract() -> Contract:
    return load_contract(SALES_ORDERS_CONTRACT)


# ---------------------------------------------------------------------------
# Basic enforcement
# ---------------------------------------------------------------------------


def test_enforce_returns_all_clean_for_valid_batch(simple_contract: Contract) -> None:
    enforcer = ContractEnforcer(simple_contract)
    rows = [{"id": "a", "value": 1}, {"id": "b", "value": 2}]
    result = enforcer.enforce(rows)
    assert result.clean_count == 2
    assert result.quarantine_count == 0
    assert result.clean_ratio == 1.0


def test_enforce_quarantines_invalid_rows(simple_contract: Contract) -> None:
    enforcer = ContractEnforcer(simple_contract)
    rows = [
        {"id": "a", "value": 1},         # valid
        {"value": 2},                      # missing required 'id'
        {"id": "c", "value": "oops"},      # wrong type for 'value'
    ]
    result = enforcer.enforce(rows)
    assert result.clean_count == 1
    assert result.quarantine_count == 2
    assert len(result.quarantined) == 2


def test_enforce_quarantine_records_have_correct_metadata(simple_contract: Contract) -> None:
    enforcer = ContractEnforcer(simple_contract)
    rows = [{"value": 1}]  # missing 'id'
    result = enforcer.enforce(rows)
    assert len(result.quarantined) == 1
    qr = result.quarantined[0]
    assert qr.contract_name == "test.product"
    assert qr.contract_version == "1.0.0"
    assert qr.row_index == 0
    assert "id" in str(qr.violations)


def test_enforce_empty_batch_returns_empty_result(simple_contract: Contract) -> None:
    enforcer = ContractEnforcer(simple_contract)
    result = enforcer.enforce([])
    assert result.total_rows == 0
    assert result.clean_count == 0
    assert result.quarantine_count == 0
    assert result.clean_ratio == 1.0


# ---------------------------------------------------------------------------
# SLA checking
# ---------------------------------------------------------------------------


def test_enforce_detects_sla_breach(simple_contract: Contract) -> None:
    """When more rows fail than the SLA allows, the result reflects it."""
    enforcer = ContractEnforcer(simple_contract)
    # SLA is 0.9; send 10 rows where 2 fail (80% clean < 90% SLA)
    rows = [
        {"id": str(i), "value": i} for i in range(8)
    ] + [
        {"value": 100},  # missing id
        {"value": 200},  # missing id
    ]
    result = enforcer.enforce(rows)
    assert result.clean_ratio < simple_contract.sla.valid_row_ratio  # type: ignore[operator]
    assert result.clean_count == 8
    assert result.quarantine_count == 2


# ---------------------------------------------------------------------------
# Quarantine file persistence
# ---------------------------------------------------------------------------


def test_enforce_writes_quarantine_file(simple_contract: Contract, tmp_path: Path) -> None:
    enforcer = ContractEnforcer(simple_contract, quarantine_path=tmp_path / "quarantine")
    rows = [{"value": 1}]  # missing 'id'
    result = enforcer.enforce(rows)
    assert result.quarantine_count == 1

    quarantine_dir = tmp_path / "quarantine"
    assert quarantine_dir.exists()
    files = list(quarantine_dir.glob("*.jsonl"))
    assert len(files) == 1

    import json
    lines = files[0].read_text().strip().split("\n")
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["contract_name"] == "test.product"
    assert "violations" in record


def test_enforce_no_quarantine_file_when_all_clean(
    simple_contract: Contract,
    tmp_path: Path,
) -> None:
    enforcer = ContractEnforcer(simple_contract, quarantine_path=tmp_path / "quarantine")
    rows = [{"id": "a", "value": 1}]
    result = enforcer.enforce(rows)
    assert result.quarantine_count == 0

    quarantine_dir = tmp_path / "quarantine"
    # Directory should not be created when there's nothing to quarantine
    assert not quarantine_dir.exists()


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------


def test_enforce_decorator_passes_only_clean_rows(simple_contract: Contract) -> None:
    enforcer = ContractEnforcer(simple_contract)
    received: list[list[dict[str, Any]]] = []

    @enforcer.enforce_decorator
    def process(rows: list[dict[str, Any]]) -> str:
        received.append(rows)
        return "done"

    result = process([
        {"id": "a", "value": 1},
        {"value": 2},  # missing id
        {"id": "c", "value": 3},
    ])
    assert result == "done"
    assert len(received) == 1
    assert len(received[0]) == 2  # only the 2 valid rows
    assert all("id" in r for r in received[0])


# ---------------------------------------------------------------------------
# Integration with real sales.orders contract
# ---------------------------------------------------------------------------


def test_enforce_against_real_contract_clean_batch(orders_contract: Contract) -> None:
    enforcer = ContractEnforcer(orders_contract)
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
    result = enforcer.enforce(rows)
    assert result.clean_count == 1
    assert result.quarantine_count == 0


def test_enforce_against_real_contract_mixed_batch(orders_contract: Contract) -> None:
    enforcer = ContractEnforcer(orders_contract)
    rows = [
        {  # valid
            "order_sk": "abc123",
            "order_id": 1,
            "total_amount": 42.50,
            "status": "DELIVERED",
            "is_valid": True,
            "validation_errors": "",
        },
        {  # invalid: bad status
            "order_sk": "def456",
            "order_id": 2,
            "total_amount": 10.0,
            "status": "NONEXISTENT",
            "is_valid": True,
            "validation_errors": "",
        },
        {  # invalid: missing non-nullable order_sk
            "order_id": 3,
            "total_amount": 5.0,
            "status": "PENDING",
            "is_valid": True,
            "validation_errors": "",
        },
    ]
    result = enforcer.enforce(rows)
    assert result.clean_count == 1
    assert result.quarantine_count == 2
