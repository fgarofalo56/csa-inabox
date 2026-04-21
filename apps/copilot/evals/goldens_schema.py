"""JSON-schema validation for golden YAML files.

The authoritative schema lives in ``goldens/_schema.json``.  This
module loads the schema + validates YAML files against it before the
harness tries to build :class:`GoldenExample` instances — schema
failures produce clear, line-numbered error messages rather than
Pydantic's v2 type errors.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

SCHEMA_PATH = Path(__file__).parent / "goldens" / "_schema.json"


class GoldenSchemaError(ValueError):
    """Raised when a golden YAML file fails schema validation."""

    def __init__(self, path: Path | str, issues: list[str]) -> None:
        self.path = str(path)
        self.issues = issues
        joined = "\n  - ".join(issues)
        super().__init__(
            f"Golden YAML failed schema validation: {path}\n  - {joined}",
        )


def _load_schema() -> dict[str, Any]:
    text = SCHEMA_PATH.read_text(encoding="utf-8")
    loaded: dict[str, Any] = json.loads(text)
    return loaded


def validate_goldens_file(path: Path) -> list[dict[str, Any]]:
    """Load *path* and validate against ``_schema.json``.

    Returns the list of golden dicts (pre-Pydantic).  Raises
    :class:`GoldenSchemaError` on validation failure.
    """
    if not path.exists():
        raise GoldenSchemaError(path, [f"File does not exist: {path}"])

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise GoldenSchemaError(path, [f"YAML parse error: {exc}"]) from exc

    issues: list[str] = []
    if not isinstance(raw, dict) or "goldens" not in raw:
        raise GoldenSchemaError(path, ["Top-level key 'goldens' missing"])
    entries = raw["goldens"]
    if not isinstance(entries, list) or not entries:
        raise GoldenSchemaError(
            path, ["'goldens' must be a non-empty list"],
        )

    try:
        import jsonschema
    except ImportError as imp_err:
        # Lightweight fallback validation: check required fields + types
        # so the package remains usable without jsonschema installed.
        for idx, entry in enumerate(entries):
            issues.extend(_fallback_validate(entry, f"goldens[{idx}]"))
        if issues:
            raise GoldenSchemaError(path, issues) from imp_err
        return list(entries)

    schema = _load_schema()
    validator = jsonschema.Draft202012Validator(schema)
    for idx, entry in enumerate(entries):
        for err in validator.iter_errors(entry):
            path_parts = [f"goldens[{idx}]"] + [str(p) for p in err.path]
            issues.append(f"{'.'.join(path_parts)}: {err.message}")

    if issues:
        raise GoldenSchemaError(path, issues)
    return list(entries)


def _fallback_validate(entry: Any, prefix: str) -> list[str]:
    """Minimal schema enforcement when jsonschema is unavailable."""
    errors: list[str] = []
    if not isinstance(entry, dict):
        return [f"{prefix}: must be an object"]
    for req in ("id", "question"):
        if req not in entry:
            errors.append(f"{prefix}.{req}: missing required field")
    if "id" in entry and not isinstance(entry["id"], str):
        errors.append(f"{prefix}.id: must be string")
    if "question" in entry and not isinstance(entry["question"], str):
        errors.append(f"{prefix}.question: must be string")
    if "must_refuse" in entry and not isinstance(entry["must_refuse"], bool):
        errors.append(f"{prefix}.must_refuse: must be boolean")
    for list_field in ("expected_citations", "expected_phrases", "tags"):
        if list_field in entry and not isinstance(entry[list_field], list):
            errors.append(f"{prefix}.{list_field}: must be list")
    return errors


__all__ = [
    "SCHEMA_PATH",
    "GoldenSchemaError",
    "validate_goldens_file",
]
