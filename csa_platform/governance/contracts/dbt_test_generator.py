"""Auto-generate dbt schema.yml tests from data product contracts.

Reads every ``contract.yaml`` under ``domains/*/data-products/`` and
produces a dbt-compatible ``schema.yml`` fragment for each data product,
grouped by domain.  Each domain gets its own generated schema file
placed inside that domain's dbt project so cross-domain model collisions
(e.g. ``sales.orders`` vs ``shared.orders``) are avoided.

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

    # Write / overwrite the auto-generated schema files (one per domain)
    python -m governance.contracts.dbt_test_generator --repo-root . --write

    # Diff-check in CI (exit 1 if any generated file differs from what's on disk)
    python -m governance.contracts.dbt_test_generator --repo-root . --check

The generated YAML files are written to
``domains/<domain>/dbt/models/silver/schema_contract_generated.yml``
and are meant to **complement** -- not replace -- the hand-written
``schema.yml`` in each directory.  The CI ``--check`` mode lets you
catch contract / schema drift early.
"""

from __future__ import annotations

import argparse
import difflib
import sys
from collections import defaultdict
from io import StringIO
from pathlib import Path
from typing import Any

import yaml

from csa_platform.governance.common.logging import configure_structlog, get_logger
from csa_platform.governance.contracts.contract_validator import (
    Contract,
    QualityRule,
    find_contracts,
    load_contract,
)

logger = get_logger(__name__)

# Per-domain output path template, relative to the repo root.
# Each domain gets its own generated schema file to avoid cross-project
# model name collisions (e.g. sales.orders vs shared.orders).
_DOMAIN_OUTPUT_TEMPLATE = "domains/{domain}/dbt/models/silver/schema_contract_generated.yml"


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
            tests.append({"accepted_values": {"values": col.allowed_values}})
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
        has_av = any(isinstance(t, dict) and "accepted_values" in t for t in entries)
        if not has_av and rule.value_set:
            entries.append({"accepted_values": {"values": rule.value_set}})

    elif rule.rule == "expect_column_values_to_be_between":
        # dbt doesn't have a built-in "between" test so we use
        # dbt_utils.expression_is_true as the closest equivalent.
        expr_parts: list[str] = []
        if rule.min_value is not None:
            expr_parts.append(f">= {rule.min_value}")
        if rule.max_value is not None:
            expr_parts.append(f"<= {rule.max_value}")
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


def generate_schema_yml(
    contracts: list[Contract],
    exclude_models: set[str] | None = None,
    existing_models: set[str] | None = None,
) -> str:
    """Render a dbt ``schema.yml`` string from a list of contracts.

    The output is a valid dbt schema file with ``version: 2`` and a
    ``models:`` section containing one entry per contract.

    Models whose names appear in *exclude_models* are silently skipped
    so that hand-written ``schema.yml`` definitions take precedence.

    When *existing_models* is provided, only models whose names appear
    in this set are included — contracts for models that don't have a
    corresponding ``.sql`` file yet are skipped to avoid dbt warnings.
    """
    models: list[dict[str, Any]] = []
    exclude = exclude_models or set()

    for contract in sorted(contracts, key=lambda c: c.name):
        model_name = _model_name_from_contract(contract)
        if model_name in exclude:
            continue
        if existing_models is not None and model_name not in existing_models:
            continue
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
                f"DO NOT EDIT -- regenerate with: "
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


def group_contracts_by_domain(contracts: list[Contract]) -> dict[str, list[Contract]]:
    """Group contracts by their domain name."""
    by_domain: dict[str, list[Contract]] = defaultdict(list)
    for contract in contracts:
        by_domain[contract.domain].append(contract)
    return dict(by_domain)


def output_path_for_domain(repo_root: Path, domain: str) -> Path:
    """Return the generated schema file path for a given domain."""
    return repo_root / _DOMAIN_OUTPUT_TEMPLATE.format(domain=domain)


def _read_handwritten_model_names(repo_root: Path, domain: str) -> set[str]:
    """Return model names already defined in the hand-written schema.yml.

    Models that have hand-written definitions should NOT be regenerated
    by this tool -- the hand-written version takes precedence because it
    typically includes richer column metadata (quality flags, etc.).
    """
    schema_path = repo_root / f"domains/{domain}/dbt/models/silver/schema.yml"
    if not schema_path.exists():
        return set()
    try:
        with open(schema_path) as f:
            raw = yaml.safe_load(f)
        if not raw or "models" not in raw:
            return set()
        return {m["name"] for m in raw["models"] if isinstance(m, dict) and "name" in m}
    except Exception:
        return set()


def _existing_model_names(repo_root: Path, domain: str) -> set[str]:
    """Return the set of dbt model names that have a .sql file on disk.

    Only models with an actual SQL file should appear in the generated
    schema — referencing contract-defined models that haven't been built
    yet produces dbt warnings and can break ``dbt run``/``dbt test``.
    """
    silver_dir = repo_root / f"domains/{domain}/dbt/models/silver"
    if not silver_dir.is_dir():
        return set()
    return {p.stem for p in silver_dir.glob("*.sql")}


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
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--write",
        action="store_true",
        help="Write the generated schema files to disk (one per domain)",
    )
    group.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if any generated file differs from what's on disk (CI mode)",
    )
    args = parser.parse_args(argv)

    configure_structlog(service="csa-dbt-test-generator")
    repo_root = Path(args.repo_root).resolve()

    contract_files = find_contracts(repo_root)
    if not contract_files:
        logger.info("dbt_test_gen.no_contracts_found", repo_root=str(repo_root))
        print("No contracts found -- nothing to generate.", file=sys.stderr)
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

    # Group contracts by domain and generate per-domain schema files.
    by_domain = group_contracts_by_domain(contracts)

    if args.write:
        for domain, domain_contracts in sorted(by_domain.items()):
            exclude = _read_handwritten_model_names(repo_root, domain)
            on_disk_models = _existing_model_names(repo_root, domain)
            generated = generate_schema_yml(domain_contracts, exclude_models=exclude, existing_models=on_disk_models)
            out = output_path_for_domain(repo_root, domain)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(generated, encoding="utf-8")
            logger.info(
                "dbt_test_gen.written",
                domain=domain,
                output=str(out),
                models=len(domain_contracts),
                excluded=len(exclude),
            )
            print(f"[OK] Written {out} ({len(domain_contracts)} model(s), {len(exclude)} excluded)")
        return 0

    if args.check:
        has_drift = False
        for domain, domain_contracts in sorted(by_domain.items()):
            exclude = _read_handwritten_model_names(repo_root, domain)
            on_disk_models = _existing_model_names(repo_root, domain)
            generated = generate_schema_yml(domain_contracts, exclude_models=exclude, existing_models=on_disk_models)
            out = output_path_for_domain(repo_root, domain)
            if not out.exists():
                print(
                    f"[FAIL] {out} does not exist.  Run with --write to create it.",
                    file=sys.stderr,
                )
                has_drift = True
                continue
            existing = out.read_text(encoding="utf-8")
            if existing == generated:
                print(f"[OK] {out} is up to date")
            else:
                diff = difflib.unified_diff(
                    existing.splitlines(keepends=True),
                    generated.splitlines(keepends=True),
                    fromfile=f"{out} (on disk)",
                    tofile=f"{out} (generated)",
                )
                sys.stderr.writelines(diff)
                print(
                    f"\n[FAIL] {out} is out of date.  Run with --write to regenerate.",
                    file=sys.stderr,
                )
                has_drift = True
        return 1 if has_drift else 0

    # Default: preview to stdout
    for domain, domain_contracts in sorted(by_domain.items()):
        exclude = _read_handwritten_model_names(repo_root, domain)
        on_disk_models = _existing_model_names(repo_root, domain)
        print(f"\n# === Domain: {domain} ===")
        print(generate_schema_yml(domain_contracts, exclude_models=exclude, existing_models=on_disk_models))
    return 0


if __name__ == "__main__":
    sys.exit(main())
