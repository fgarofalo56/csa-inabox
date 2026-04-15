"""Azure Function: Schema validation service.

HTTP-triggered function that validates a JSON payload against a JSON Schema
or a YAML data contract.  Returns detailed validation errors.

Endpoint: POST /api/validate-schema

Request body::

    {
        "data": { ... },                         // The data to validate
        "schema": { ... },                       // Inline JSON Schema (option A)
        "schema_path": "contracts/orders.yaml"   // Path to YAML contract (option B)
    }

Response::

    {
        "valid": true | false,
        "errors": [
            {
                "path": "$.field",
                "message": "...",
                "validator": "type"
            }
        ],
        "schema_used": "inline | <path>"
    }
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import azure.functions as func
from jsonschema import Draft7Validator

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

app = func.FunctionApp()


# ---------------------------------------------------------------------------
# Schema loading
# ---------------------------------------------------------------------------


def _load_yaml_schema(schema_path: str) -> dict[str, Any]:
    """Load a JSON Schema from a YAML data contract file.

    The YAML file is expected to have a top-level ``schema`` key containing
    a JSON Schema object.  If no ``schema`` key exists, the entire YAML is
    treated as a JSON Schema.

    Args:
        schema_path: Relative path to the YAML contract file.

    Returns:
        Parsed JSON Schema dictionary.

    Raises:
        FileNotFoundError: If the schema file does not exist.
        ValueError: If YAML parsing fails or schema is invalid.
    """
    if yaml is None:
        raise ImportError("PyYAML is required for YAML schema loading")

    # Resolve path relative to function app root or blob storage
    base_dir = os.environ.get("SCHEMA_BASE_DIR", os.path.dirname(__file__))
    full_path = os.path.join(base_dir, schema_path)

    if not os.path.exists(full_path):
        raise FileNotFoundError(f"Schema file not found: {full_path}")

    with open(full_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    if isinstance(raw, dict) and "schema" in raw:
        return raw["schema"]  # type: ignore[no-any-return]
    return raw  # type: ignore[no-any-return]


def _validate_against_contract(data: dict[str, Any], contract: dict[str, Any]) -> list[dict[str, str]]:
    """Validate data against a YAML data contract's column definitions.

    Args:
        data: The data record to validate.
        contract: Parsed YAML contract with a ``schema.columns`` section.

    Returns:
        List of error dictionaries.
    """
    errors: list[dict[str, str]] = []
    schema_section = contract.get("schema", {})
    columns = schema_section.get("columns", [])

    if not columns:
        errors.append(
            {
                "path": "$",
                "message": "Contract has no columns defined",
                "validator": "contract",
            }
        )
        return errors

    column_map = {col["name"]: col for col in columns}

    for col_name, col_spec in column_map.items():
        if not col_spec.get("nullable", True) and col_name not in data:
            errors.append(
                {
                    "path": f"$.{col_name}",
                    "message": f"Required column '{col_name}' is missing",
                    "validator": "required",
                }
            )
        if col_name in data and data[col_name] is not None:
            allowed = col_spec.get("allowed_values")
            if allowed and data[col_name] not in allowed:
                errors.append(
                    {
                        "path": f"$.{col_name}",
                        "message": (f"Value '{data[col_name]}' not in allowed values: {allowed}"),
                        "validator": "enum",
                    }
                )

    return errors


def _validate_data(data: Any, schema: dict[str, Any]) -> list[dict[str, str]]:
    """Validate data against a JSON Schema.

    Args:
        data: The data to validate.
        schema: The JSON Schema.

    Returns:
        List of error dictionaries with ``path``, ``message``, and
        ``validator`` keys.  Empty list if valid.
    """
    validator = Draft7Validator(schema)
    errors: list[dict[str, str]] = []

    for error in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path)):
        path = "$.{}".format(".".join(str(p) for p in error.absolute_path)) if error.absolute_path else "$"
        errors.append(
            {
                "path": path,
                "message": error.message,
                "validator": error.validator,  # type: ignore[arg-type]
            }
        )

    return errors


# ---------------------------------------------------------------------------
# Azure Function entry point
# ---------------------------------------------------------------------------


@app.function_name("validate_schema")
@app.route(route="validate-schema", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def validate_schema(req: func.HttpRequest) -> func.HttpResponse:
    """Validate a JSON payload against a JSON Schema or YAML data contract.

    Accepts a JSON body with ``data`` and either ``schema`` (inline JSON
    Schema), ``schema_path`` (path to a YAML contract file), or ``contract``
    (inline YAML string for a data contract).

    Args:
        req: The HTTP request.

    Returns:
        JSON response with validation result and detailed errors.
    """
    logger.info("Schema validation request received")

    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps(
                {"valid": False, "errors": [{"path": "$", "message": "Invalid JSON body", "validator": "parse"}]}
            ),
            status_code=400,
            mimetype="application/json",
        )

    data = body.get("data")
    inline_schema = body.get("schema")
    schema_path = body.get("schema_path")
    contract_yaml = body.get("contract")

    if data is None:
        return func.HttpResponse(
            json.dumps(
                {
                    "valid": False,
                    "errors": [{"path": "$", "message": "'data' field is required", "validator": "required"}],
                }
            ),
            status_code=400,
            mimetype="application/json",
        )

    if not inline_schema and not schema_path and not contract_yaml:
        return func.HttpResponse(
            json.dumps(
                {
                    "valid": False,
                    "errors": [
                        {
                            "path": "$",
                            "message": "Provide 'schema', 'schema_path', or 'contract'",
                            "validator": "required",
                        }
                    ],
                }
            ),
            status_code=400,
            mimetype="application/json",
        )

    # Determine which schema to use
    schema_used = "inline"
    errors: list[dict[str, str]] = []

    try:
        if inline_schema:
            errors = _validate_data(data, inline_schema)
            schema_used = "inline"
        elif schema_path:
            schema = _load_yaml_schema(schema_path)
            errors = _validate_data(data, schema)
            schema_used = schema_path
        elif contract_yaml:
            if yaml is None:
                raise ImportError("PyYAML is required for contract validation")
            contract = yaml.safe_load(contract_yaml)
            errors = _validate_against_contract(data, contract)
            schema_used = "contract"
    except FileNotFoundError as exc:
        return func.HttpResponse(
            json.dumps({"valid": False, "errors": [{"path": "$", "message": str(exc), "validator": "schema_load"}]}),
            status_code=404,
            mimetype="application/json",
        )
    except Exception as exc:
        return func.HttpResponse(
            json.dumps(
                {
                    "valid": False,
                    "errors": [{"path": "$", "message": f"Schema processing error: {exc}", "validator": "schema_load"}],
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    result = {
        "valid": len(errors) == 0,
        "errors": errors,
        "error_count": len(errors),
        "schema_used": schema_used,
    }

    logger.info(
        "Schema validation complete: valid=%s, errors=%d, schema=%s",
        result["valid"],
        len(errors),
        schema_used,
    )

    return func.HttpResponse(
        json.dumps(result),
        status_code=200,
        mimetype="application/json",
    )
