"""Data product contract validation — reads contract.yaml files and
enforces them at CI time and runtime ingestion.

Also provides a dbt test generator (``dbt_test_generator``) that
auto-creates schema.yml tests from contract definitions, and a pipeline
enforcer (``pipeline_enforcer``) for runtime quarantine routing."""

from governance.contracts.contract_validator import (
    Column,
    Contract,
    ContractValidationError,
    load_contract,
    validate_contract_structure,
    validate_rows_against_contract,
)
from governance.contracts.dbt_test_generator import generate_schema_yml
from governance.contracts.pipeline_enforcer import (
    ContractEnforcer,
    QuarantineRecord,
)

__all__ = [
    "Column",
    "Contract",
    "ContractEnforcer",
    "ContractValidationError",
    "QuarantineRecord",
    "generate_schema_yml",
    "load_contract",
    "validate_contract_structure",
    "validate_rows_against_contract",
]
