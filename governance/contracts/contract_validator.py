"""Data product contract validator.

Reads ``contract.yaml`` files declared under ``domains/<domain>/data-products/
<product>/contract.yaml`` and enforces them in two places:

- **CI time** via ``python -m governance.contracts.contract_validator --ci``
  which walks the repo, loads every contract, and fails the build if any
  contract is structurally invalid or internally inconsistent (e.g. the
  primary key references a column that isn't declared).
- **Runtime ingestion** via :func:`validate_rows_against_contract`, which
  checks a batch of incoming rows (pandas DataFrame or list-of-dicts)
  against the declared schema, type rules, nullability, and allowed
  values, returning a list of human-readable violations so the ingestion
  pipeline can route bad data to a quarantine table.

The contract format is documented in
``domains/sales/data-products/orders/contract.yaml`` — the canonical
example — and in the README of each data-product directory.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from governance.common.logging import configure_structlog, get_logger

logger = get_logger(__name__)

_CONTRACT_API_VERSION = "csa.microsoft.com/v1"
_CONTRACT_KIND = "DataProductContract"

# Supported column types.  Extend this set as new warehouses / file
# formats are onboarded; the keys map to a predicate that validates a
# single Python value.
_TYPE_VALIDATORS: dict[str, Any] = {
    "string": lambda v: isinstance(v, str),
    "long": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "double": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "float": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "date": lambda v: isinstance(v, str)
        and bool(re.match(r"^\d{4}-\d{2}-\d{2}$", v)),
    "timestamp": lambda v: isinstance(v, str)
        and bool(re.match(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}", v)),
}


class ContractValidationError(Exception):
    """Raised when a contract is structurally invalid."""


@dataclass
class Column:
    name: str
    type: str
    nullable: bool = True
    description: str = ""
    allowed_values: list[str] = field(default_factory=list)


@dataclass
class QualityRule:
    rule: str
    column: str | None = None
    value_set: list[Any] = field(default_factory=list)
    min_value: Any = None
    max_value: Any = None
    mostly: float | None = None


@dataclass
class SLA:
    freshness_minutes: int | None = None
    valid_row_ratio: float | None = None
    supported_until: str | None = None


@dataclass
class Contract:
    name: str
    domain: str
    owner: str
    version: str
    description: str
    primary_key: list[str]
    columns: list[Column]
    sla: SLA
    quality_rules: list[QualityRule]
    source_path: Path | None = None

    @property
    def columns_by_name(self) -> dict[str, Column]:
        return {c.name: c for c in self.columns}


def _require(mapping: Mapping[str, Any], key: str, path: Path | str) -> Any:
    if key not in mapping or mapping[key] is None:
        raise ContractValidationError(f"{path}: missing required field {key!r}")
    return mapping[key]


def load_contract(path: Path | str) -> Contract:
    """Load a contract YAML file into a :class:`Contract` dataclass.

    Raises :class:`ContractValidationError` if the file is missing
    required top-level fields or uses an unsupported apiVersion/kind.
    Pure structural checks only — call
    :func:`validate_contract_structure` for deeper checks.
    """
    path = Path(path)
    with open(path) as f:
        raw = yaml.safe_load(f)

    if not isinstance(raw, dict):
        raise ContractValidationError(f"{path}: contract must be a YAML mapping")

    api_version = raw.get("apiVersion")
    if api_version != _CONTRACT_API_VERSION:
        raise ContractValidationError(
            f"{path}: apiVersion must be {_CONTRACT_API_VERSION!r}, got {api_version!r}",
        )
    kind = raw.get("kind")
    if kind != _CONTRACT_KIND:
        raise ContractValidationError(
            f"{path}: kind must be {_CONTRACT_KIND!r}, got {kind!r}",
        )

    metadata = _require(raw, "metadata", path)
    schema = _require(raw, "schema", path)
    sla_raw = raw.get("sla", {}) or {}
    rules_raw = raw.get("quality_rules", []) or []

    columns = [
        Column(
            name=_require(c, "name", path),
            type=_require(c, "type", path),
            nullable=bool(c.get("nullable", True)),
            description=str(c.get("description", "")),
            allowed_values=list(c.get("allowed_values", []) or []),
        )
        for c in _require(schema, "columns", path)
    ]

    return Contract(
        name=str(_require(metadata, "name", path)),
        domain=str(_require(metadata, "domain", path)),
        owner=str(_require(metadata, "owner", path)),
        version=str(_require(metadata, "version", path)),
        description=str(metadata.get("description", "")),
        primary_key=list(_require(schema, "primary_key", path)),
        columns=columns,
        sla=SLA(
            freshness_minutes=sla_raw.get("freshness_minutes"),
            valid_row_ratio=sla_raw.get("valid_row_ratio"),
            supported_until=sla_raw.get("supported_until"),
        ),
        quality_rules=[
            QualityRule(
                rule=_require(r, "rule", path),
                column=r.get("column"),
                value_set=list(r.get("value_set", []) or []),
                min_value=r.get("min_value"),
                max_value=r.get("max_value"),
                mostly=r.get("mostly"),
            )
            for r in rules_raw
        ],
        source_path=path,
    )


def validate_contract_structure(contract: Contract) -> list[str]:
    """Check a loaded contract for internal consistency.

    Returns a list of error messages — empty when the contract is
    valid.  Pure structural checks, not data checks:

    - Primary key columns must exist in ``schema.columns``.
    - Every column's ``type`` must be a supported type.
    - Every quality rule's ``column`` must exist in ``schema.columns``.
    - Allowed-values columns must be strings (so the allowed list
      actually constrains real values).
    - ``valid_row_ratio`` must be in [0, 1].
    """
    errors: list[str] = []
    column_names = {c.name for c in contract.columns}

    for pk in contract.primary_key:
        if pk not in column_names:
            errors.append(
                f"{contract.name}: primary_key column {pk!r} is not declared in schema.columns",
            )

    for col in contract.columns:
        base_type = col.type.split("(")[0]  # handle decimal(18,2)
        if base_type not in _TYPE_VALIDATORS and base_type != "decimal":
            errors.append(
                f"{contract.name}: column {col.name!r} has unsupported type {col.type!r}",
            )
        if col.allowed_values and base_type != "string":
            errors.append(
                f"{contract.name}: column {col.name!r} has allowed_values but type is {col.type!r} (must be string)",
            )

    for rule in contract.quality_rules:
        if rule.column and rule.column not in column_names:
            errors.append(
                f"{contract.name}: quality_rule {rule.rule!r} references "
                f"unknown column {rule.column!r}",
            )
        if rule.mostly is not None and not (0.0 <= rule.mostly <= 1.0):
            errors.append(
                f"{contract.name}: quality_rule {rule.rule!r} has mostly={rule.mostly!r} "
                "outside [0, 1]",
            )

    if contract.sla.valid_row_ratio is not None and not (
        0.0 <= contract.sla.valid_row_ratio <= 1.0
    ):
        errors.append(
            f"{contract.name}: sla.valid_row_ratio={contract.sla.valid_row_ratio!r} outside [0, 1]",
        )

    return errors


def _validate_value(value: Any, col: Column) -> str | None:
    """Return a human-readable error string if ``value`` violates ``col``, else None."""
    if value is None:
        if col.nullable:
            return None
        return f"column {col.name!r} is not nullable but value is null"

    base_type = col.type.split("(")[0]
    if base_type == "decimal":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return f"column {col.name!r} expects decimal, got {type(value).__name__}"
    else:
        validator = _TYPE_VALIDATORS.get(base_type)
        if validator is None:
            return f"column {col.name!r} has unsupported type {col.type!r}"
        if not validator(value):
            return (
                f"column {col.name!r} expects {col.type}, got {type(value).__name__}"
            )

    if col.allowed_values and value not in col.allowed_values:
        return (
            f"column {col.name!r} value {value!r} not in allowed_values "
            f"{col.allowed_values}"
        )

    return None


def validate_rows_against_contract(
    contract: Contract,
    rows: Iterable[Mapping[str, Any]],
    *,
    fail_fast: bool = False,
) -> list[str]:
    """Validate a batch of rows against ``contract``.

    Returns a list of violation strings (``"row 42: <details>"``).
    Empty list means the batch passes.  When ``fail_fast`` is True the
    function returns as soon as the first violation is found.
    """
    violations: list[str] = []
    columns_by_name = contract.columns_by_name

    for idx, row in enumerate(rows):
        # Missing required columns
        for col in contract.columns:
            if col.name not in row and not col.nullable:
                violations.append(
                    f"row {idx}: missing required column {col.name!r}"
                )
                if fail_fast:
                    return violations

        # Type + nullability + allowed-values per declared column
        for col_name, value in row.items():
            col_def = columns_by_name.get(col_name)
            if col_def is None:
                # Extra columns are allowed — the contract only forbids
                # missing ones, not unknown ones, so downstream
                # backwards compatibility stays loose.
                continue
            error = _validate_value(value, col_def)
            if error:
                violations.append(f"row {idx}: {error}")
                if fail_fast:
                    return violations

    return violations


def find_contracts(repo_root: Path) -> list[Path]:
    """Recursively find every ``contract.yaml`` under ``domains/*/data-products/``."""
    return sorted((repo_root / "domains").glob("*/data-products/**/contract.yaml"))


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.  Walks the repo, validates every contract, returns non-zero on failure."""
    parser = argparse.ArgumentParser(description="CSA-in-a-Box data contract validator")
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Repository root (default: cwd)",
    )
    parser.add_argument(
        "--ci",
        action="store_true",
        help="Exit non-zero if any contract is invalid (for CI use)",
    )
    parser.add_argument(
        "contract_paths",
        nargs="*",
        help="Specific contract file(s) to validate.  When empty, walks the repo.",
    )
    args = parser.parse_args(argv)

    configure_structlog(service="csa-contract-validator")
    repo_root = Path(args.repo_root).resolve()

    if args.contract_paths:
        contract_files = [Path(p) for p in args.contract_paths]
    else:
        contract_files = find_contracts(repo_root)

    if not contract_files:
        logger.info("contracts.none_found", repo_root=str(repo_root))
        return 0

    all_errors: list[str] = []
    for path in contract_files:
        try:
            contract = load_contract(path)
        except ContractValidationError as e:
            all_errors.append(str(e))
            continue
        except (yaml.YAMLError, OSError) as e:
            all_errors.append(f"{path}: {e}")
            continue
        errors = validate_contract_structure(contract)
        if errors:
            all_errors.extend(errors)
            logger.warning(
                "contract.invalid",
                contract=contract.name,
                path=str(path),
                errors=errors,
            )
        else:
            logger.info(
                "contract.valid",
                contract=contract.name,
                path=str(path),
                columns=len(contract.columns),
                quality_rules=len(contract.quality_rules),
            )

    if all_errors:
        print(f"\n[FAIL] {len(all_errors)} contract error(s):", file=sys.stderr)
        for err in all_errors:
            print(f"  - {err}", file=sys.stderr)
        return 1 if args.ci else 0  # Non-CI: warn but don't fail (interactive use)

    print(f"[OK] {len(contract_files)} contract(s) valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
