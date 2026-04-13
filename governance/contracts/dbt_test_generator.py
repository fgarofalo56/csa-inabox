"""Auto-generate dbt schema.yml tests from data product contracts.

Reads every ``contract.yaml`` under ``domains/*/data-products/`` and
produces a dbt-compatible ``schema.yml`` fragment for each data product.
The generated tests map contract quality rules to native dbt test
primitives:

    +-------------------------------------------------+---------------------------+
    | contract.yaml rule                              | dbt test                  |
    +=================================================+===========================+
    | ``expect_column_values_to_not_be_null``         | ``not_null``              |
    | ``expect_column_values_to_be_unique``           | ``unique``                |
    | ``expect_column_values_to_be_in_set``           | ``accepted_values``       |
    | ``expect_column_values_to_be_between``          | ``dbt_utils.expression_is_true`` |
    | column-level ``nullable: false``                | ``not_null``              |
    | column-level ``allowed_values``                 | ``accepted_values``       |
    +-------------------------------------------------+---------------------------+

Usage::

    # Preview what would be generated (stdout)
    python -m governance.contracts.dbt_test_generator --repo-root .

    # Write / overwrite the auto-generated schema file
    python -m governance.contracts.dbt_test_generator --repo-root . --write

    # Diff-check in CI (exit 1 if the generated file differs from what's on disk)
    python -m governance.contracts.dbt_test_generator --repo-root . --check

The generated YAML is written to
``domains/shared/dbt/models/silver/schema_contract_generated.yml`` and
is meant to **complement** — not replace — the hand-written
``schema.yml`` in the same directory.  The CI ``--check`` mode lets you
catch contract / schema drift early.
"""

from __future__ import annotations

import argparse
import difflib
import sys
from io import StringIO
from pathlib import Path
from typing import Any

import yaml

from governance.common.logging import configure_structlog, get_logger
from governance.contracts.contract_validator import (
    Contract,
    QualityRule,
    find_contracts,
    load_contract,
)

logger = get_logger(__name__)

# Where the generated schema file lives, relative to the repo root.
_DEFAULT_OUTPUT = Path("domains/shared/dbt/models/silver/schema_contract_generated.yml")


# ---- Rule-to-dbt mapping ---------------------------------------------------


def _build_column_tests(contract: Contract) -> dict[str, list[Any]]:
    """Return a mapping of column-name -> list of dbt test entries.

    Sources of tests:
    1. ``nullable: false`` on a column  -> ``not_null``
    2. ``allowed_values`` on a column   -> ``accepted_values``
    3. Explicit ``quality_rules`` entries in the contract
    """
    col_tests: dict[str, list[Any]] = {}

    # 1. Implicit tests from column definitions
    for col in contract.columns:
        tests: list[Any] = []
        if not col.nullable:
            tests.append("not_null")
        if col.allowed_values:
            tests.append(
                {"accepted_values": {"values": col.allowed_values}}
            )
        if tests:
            col_tests[col.name] = tests

    # 2. Explicit quality_rules
    for rule in contract.quality_rules:
        _apply_quality_rule(rule, col_tests)

    return col_tests


def _apply_quality_rule(
    rule: QualityRule,
    col_tests: dict[str, list[Any]],
) -> None:
    """Map a single quality rule to a dbt test entry."""
    if not rule.column:
        return

    entries = col_tests.setdefault(rule.column, [])

    if rule.rule == "expect_column_values_to_not_be_null":
        if "not_null" not in entries:
            entries.append("not_null")

    elif rule.rule == "expect_column_values_to_be_unique":
        if "unique" not in entries:
            entries.append("unique")

    elif rule.rule == "expect_column_values_to_be_in_set":
        # Avoid duplicating an accepted_values test that might already
        # be there from the column-level allowed_values.
        has_av = any(
            isinstance(t, dict) and "accepted_values" in t for t in entries
        )
        if not has_av and rule.value_set:
            entries.append(
                {"accepted_values": {"values": rule.value_set}}
            )

    elif rule.rule == "expect_column_values_to_be_between":
        # dbt doesn't have a built-in "between" test so we use
        # dbt_utils.expression_is_true as the closest equivalent.
        expr_parts: list[str] = []
        if rule.min_value is not None:
            expr_parts.append(f"{rule.column} >= {rule.min_value}")
        if rule.max_value is not None:
            expr_parts.append(f"{rule.column} <= {rule.max_value}")
        if expr_parts:
            test_entry: dict[str, Any] = {
                "dbt_utils.expression_is_true": {
                    "expression": " AND ".join(expr_parts),
                },
            }
            if rule.mostly is not None:
                test_entry["dbt_utils.expression_is_true"]["config"] = {
                    "severity": "warn",
                }
            entries.append(test_entry)


def _model_name_from_contract(contract: Contract) -> str:
    """Derive the expected dbt model name for a contract.

    Convention: the Silver model for ``<domain>.<product>`` is named
    ``slv_<product>``  (e.g. ``sales.orders`` -> ``slv_orders``).

    Multi-segment product names are joined with underscores to avoid
    collisions (e.g. ``sales.ecommerce.orders`` -> ``slv_ecommerce_orders``).
    """
    parts = contract.name.split(".")
    product = "_".join(parts[1:]) if len(parts) > 1 else parts[0]
    return f"slv_{product}"


# ---- YAML generation -------------------------------------------------------


def generate_schema_yml(contracts: list[Contract]) -> str:
    """Render a dbt ``schema.yml`` string from a list of contracts.

    The output is a valid dbt schema file with ``version: 2`` and a
    ``models:`` section containing one entry per contract.
    """
    models: list[dict[str, Any]] = []

    for contract in sorted(contracts, key=lambda c: c.name):
        model_name = _model_name_from_contract(contract)
        col_tests = _build_column_tests(contract)

        columns: list[dict[str, Any]] = []
        for col in contract.columns:
            col_entry: dict[str, Any] = {
                "name": col.name,
                "description": col.description or f"Auto-generated from contract {contract.name}",
            }
            if col.name in col_tests:
                col_entry["tests"] = col_tests[col.name]
            columns.append(col_entry)

        model_entry: dict[str, Any] = {
            "name": model_name,
            "description": (
                f"Auto-generated dbt tests from data contract "
                f"{contract.name!r} v{contract.version}. "
                f"DO NOT EDIT — regenerate with: "
                f"python -m governance.contracts.dbt_test_generator --write"
            ),
            "columns": columns,
        }
        models.append(model_entry)

    schema: dict[str, Any] = {
        "version": 2,
        "models": models,
    }

    # Use a custom representer so that:
    # - multi-line strings use literal style
    # - lists use flow style for short entries (accepted_values)
    buf = StringIO()
    yaml.dump(
        schema,
        buf,
        default_flow_style=False,
        sort_keys=False,
        allow_unicode=True,
        width=120,
    )
    header = (
        "# =======================================================================\n"
        "# AUTO-GENERATED from data product contracts.  DO NOT EDIT.\n"
        "#\n"
        "# Regenerate:  python -m governance.contracts.dbt_test_generator --write\n"
        "# Check drift: python -m governance.contracts.dbt_test_generator --check\n"
        "# =======================================================================\n\n"
    )
    return header + buf.getvalue()


# ---- CLI entry-point -------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Generate dbt schema.yml tests from data product contracts",
    )
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Repository root (default: cwd)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help=f"Output path relative to repo root (default: {_DEFAULT_OUTPUT})",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--write",
        action="store_true",
        help="Write the generated schema file to disk",
    )
    group.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the generated file differs from what's on disk (CI mode)",
    )
    args = parser.parse_args(argv)

    configure_structlog(service="csa-dbt-test-generator")
    repo_root = Path(args.repo_root).resolve()
    output_path = repo_root / (args.output or _DEFAULT_OUTPUT)

    contract_files = find_contracts(repo_root)
    if not contract_files:
        logger.info("dbt_test_gen.no_contracts_found", repo_root=str(repo_root))
        print("No contracts found — nothing to generate.", file=sys.stderr)
        return 0

    contracts: list[Contract] = []
    for path in contract_files:
        try:
            contracts.append(load_contract(path))
            logger.info(
                "dbt_test_gen.loaded_contract",
                contract=contracts[-1].name,
                path=str(path),
            )
        except Exception as exc:
            logger.error(
                "dbt_test_gen.load_error",
                path=str(path),
                error=str(exc),
            )
            print(f"ERROR loading {path}: {exc}", file=sys.stderr)
            return 1

    generated = generate_schema_yml(contracts)

    if args.write:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(generated, encoding="utf-8")
        logger.info(
            "dbt_test_gen.written",
            output=str(output_path),
            models=len(contracts),
        )
        print(f"[OK] Written {output_path} ({len(contracts)} model(s))")
        return 0

    if args.check:
        if not output_path.exists():
            print(
                f"[FAIL] {output_path} does not exist.  "
                f"Run with --write to create it.",
                file=sys.stderr,
            )
            return 1
        existing = output_path.read_text(encoding="utf-8")
        if existing == generated:
            print(f"[OK] {output_path} is up to date")
            return 0
        diff = difflib.unified_diff(
            existing.splitlines(keepends=True),
            generated.splitlines(keepends=True),
            fromfile=f"{output_path} (on disk)",
            tofile=f"{output_path} (generated)",
        )
        sys.stderr.writelines(diff)
        print(
            f"\n[FAIL] {output_path} is out of date.  "
            f"Run with --write to regenerate.",
            file=sys.stderr,
        )
        return 1

    # Default: preview to stdout
    print(generated)
    return 0


if __name__ == "__main__":
    sys.exit(main())
