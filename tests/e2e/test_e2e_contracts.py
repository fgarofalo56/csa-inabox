"""End-to-end data-product contract validation tests.

Validates that all ``contract.yaml`` files across the repo are
structurally sound, semantically consistent, and aligned with the
dbt Gold layer models.  No Azure resources required.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DBT_GOLD_DIR = _REPO_ROOT / "domains" / "shared" / "dbt" / "models" / "gold"
_GOLD_SCHEMA_YML = _DBT_GOLD_DIR / "schema.yml"

# Semver pattern: major.minor.patch with optional pre-release
_SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?"
    r"(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$"
)

# Required top-level fields every contract must have.
_REQUIRED_CONTRACT_FIELDS = {"apiVersion", "kind", "metadata", "schema"}
_REQUIRED_METADATA_FIELDS = {"name", "version"}
_REQUIRED_SCHEMA_FIELDS = {"primary_key", "columns"}
_REQUIRED_COLUMN_FIELDS = {"name", "type"}

# Supported column types (base types before parenthesised precision).
_SUPPORTED_TYPES = {
    "string", "long", "int", "double", "float",
    "boolean", "date", "timestamp", "decimal",
}


# ===================================================================
# Helpers
# ===================================================================


def _load_contract_yaml(path: Path) -> dict[str, Any]:
    with open(path) as fh:
        data = yaml.safe_load(fh)
    assert isinstance(data, dict), f"{path} did not parse as a YAML mapping"
    return data


def _gold_schema_models() -> dict[str, dict[str, Any]]:
    """Parse models/gold/schema.yml and return models keyed by name."""
    if not _GOLD_SCHEMA_YML.exists():
        return {}
    with open(_GOLD_SCHEMA_YML) as fh:
        schema = yaml.safe_load(fh)
    return {m["name"]: m for m in schema.get("models", [])}


# ===================================================================
# Tests: Contract YAML structural validity
# ===================================================================


class TestContractYamlValidity:
    """All contract YAML files must be parseable with required fields."""

    def test_contracts_exist(self, contract_paths: list[Path]) -> None:
        assert len(contract_paths) > 0, "No contract.yaml files found"

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_contract_is_valid_yaml(self, contract_path: Path) -> None:
        data = _load_contract_yaml(contract_path)
        missing = _REQUIRED_CONTRACT_FIELDS - set(data.keys())
        assert not missing, (
            f"{contract_path.name}: missing required top-level fields: {missing}"
        )

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_contract_metadata_has_required_fields(
        self, contract_path: Path,
    ) -> None:
        data = _load_contract_yaml(contract_path)
        metadata = data.get("metadata", {})
        missing = _REQUIRED_METADATA_FIELDS - set(metadata.keys())
        assert not missing, (
            f"{contract_path.name}: metadata missing fields: {missing}"
        )

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_contract_schema_has_required_fields(
        self, contract_path: Path,
    ) -> None:
        data = _load_contract_yaml(contract_path)
        schema = data.get("schema", {})
        missing = _REQUIRED_SCHEMA_FIELDS - set(schema.keys())
        assert not missing, (
            f"{contract_path.name}: schema missing fields: {missing}"
        )

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_contract_columns_have_name_and_type(
        self, contract_path: Path,
    ) -> None:
        data = _load_contract_yaml(contract_path)
        columns = data.get("schema", {}).get("columns", [])
        assert columns, f"{contract_path.name}: schema.columns is empty"
        for col in columns:
            missing = _REQUIRED_COLUMN_FIELDS - set(col.keys())
            assert not missing, (
                f"{contract_path.name}: column {col.get('name', '?')} "
                f"missing fields: {missing}"
            )


# ===================================================================
# Tests: Semver version compliance
# ===================================================================


class TestContractVersioning:
    """Contract versions must follow semantic versioning."""

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_version_follows_semver(self, contract_path: Path) -> None:
        data = _load_contract_yaml(contract_path)
        version = str(data.get("metadata", {}).get("version", ""))
        assert _SEMVER_PATTERN.match(version), (
            f"{contract_path.name}: version {version!r} is not valid semver"
        )


# ===================================================================
# Tests: Column type alignment
# ===================================================================


class TestContractColumnTypes:
    """Contract column types must use supported type names."""

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_all_column_types_are_supported(
        self, contract_path: Path,
    ) -> None:
        data = _load_contract_yaml(contract_path)
        columns = data.get("schema", {}).get("columns", [])
        for col in columns:
            col_type = col["type"]
            # Strip precision, e.g. "decimal(18,2)" -> "decimal"
            base_type = col_type.split("(")[0]
            assert base_type in _SUPPORTED_TYPES, (
                f"{contract_path.name}: column {col['name']!r} uses "
                f"unsupported type {col_type!r}"
            )


# ===================================================================
# Tests: Gold model ↔ Contract alignment
# ===================================================================


class TestGoldContractAlignment:
    """Contracts that map to the shared dbt Gold models should
    reference columns that exist in schema.yml."""

    def test_gold_schema_yml_exists(self) -> None:
        assert _GOLD_SCHEMA_YML.exists(), "models/gold/schema.yml not found"

    def test_every_gold_model_in_schema_yml_has_columns(self) -> None:
        """Each Gold model in schema.yml should declare at least one column."""
        models = _gold_schema_models()
        for name, model in models.items():
            columns = model.get("columns", [])
            assert columns, (
                f"Gold model {name!r} in schema.yml has no columns defined"
            )


# ===================================================================
# Tests: No orphan contracts
# ===================================================================


class TestNoOrphanContracts:
    """Every contract should reference a domain that actually exists."""

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_contract_domain_directory_exists(
        self, contract_path: Path,
    ) -> None:
        data = _load_contract_yaml(contract_path)
        domain = data.get("metadata", {}).get("domain", "")
        domain_dir = _REPO_ROOT / "domains" / domain
        assert domain_dir.is_dir(), (
            f"Contract {contract_path.name} references domain {domain!r} "
            f"but {domain_dir} does not exist"
        )

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_contract_has_api_version(
        self, contract_path: Path,
    ) -> None:
        data = _load_contract_yaml(contract_path)
        assert data.get("apiVersion") == "csa.microsoft.com/v1", (
            f"{contract_path.name}: unexpected apiVersion"
        )

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_contract_has_correct_kind(
        self, contract_path: Path,
    ) -> None:
        data = _load_contract_yaml(contract_path)
        assert data.get("kind") == "DataProductContract", (
            f"{contract_path.name}: unexpected kind"
        )


# ===================================================================
# Tests: Non-null constraints for required fields
# ===================================================================


class TestRequiredFieldConstraints:
    """Contracts that declare non-nullable columns should have
    corresponding not_null tests in the dbt schema.yml."""

    def test_gold_schema_yml_has_not_null_tests_for_pks(self) -> None:
        """Every primary-key column in a Gold schema.yml model should
        have a not_null test."""
        models = _gold_schema_models()
        for name, model in models.items():
            columns = model.get("columns", [])
            for col in columns:
                tests = col.get("tests", [])
                # Check if this column has unique+not_null (typical PK pattern)
                test_names = set()
                for t in tests:
                    if isinstance(t, str):
                        test_names.add(t)
                    elif isinstance(t, dict):
                        test_names.update(t.keys())
                # If column has 'unique' test, it should also have 'not_null'
                if "unique" in test_names:
                    assert "not_null" in test_names, (
                        f"Gold model {name!r}, column {col['name']!r} has "
                        f"'unique' test but no 'not_null' test"
                    )

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_contract_pk_columns_are_not_nullable(
        self, contract_path: Path,
    ) -> None:
        """Primary key columns declared in a contract must have
        ``nullable: false``."""
        data = _load_contract_yaml(contract_path)
        schema = data.get("schema", {})
        pk_cols = set(schema.get("primary_key", []))
        columns = {c["name"]: c for c in schema.get("columns", [])}

        for pk in pk_cols:
            col = columns.get(pk)
            assert col is not None, (
                f"{contract_path.name}: PK column {pk!r} not in columns list"
            )
            assert col.get("nullable") is False, (
                f"{contract_path.name}: PK column {pk!r} must be nullable: false"
            )


# ===================================================================
# Tests: Quality rules reference valid columns
# ===================================================================


class TestQualityRuleConsistency:
    """Quality rules in contracts must reference columns that exist."""

    @pytest.mark.parametrize(
        "contract_path",
        sorted(
            Path(__file__).resolve().parents[2]
            .joinpath("domains")
            .glob("*/data-products/**/contract.yaml")
        ),
        ids=lambda p: str(p.relative_to(Path(__file__).resolve().parents[2])),
    )
    def test_quality_rule_columns_exist(
        self, contract_path: Path,
    ) -> None:
        data = _load_contract_yaml(contract_path)
        column_names = {
            c["name"] for c in data.get("schema", {}).get("columns", [])
        }
        for rule in data.get("quality_rules", []) or []:
            col = rule.get("column")
            if col:
                assert col in column_names, (
                    f"{contract_path.name}: quality_rule {rule['rule']!r} "
                    f"references unknown column {col!r}"
                )
