"""YAML loader for skill specs (Phase 3).

The loader is the only place that reads YAML off disk.  Its contract is
narrow: *read a file, validate it against* ``_schema.json``, *produce a
frozen* :class:`~apps.copilot.skills.base.SkillSpec`, *or raise a typed
failure*.

Two validation stages run, in order:

1. **Schema validation** — JSON-schema ensures the document is
   syntactically correct.  This gate catches typos in field names,
   wrong types, and missing required fields.
2. **Semantic validation** — Pydantic then enforces cross-field
   invariants: unique step ids, identifier-shaped input names, skill
   id kebab-case, etc.

Callers who hold a :class:`~apps.copilot.tools.registry.ToolRegistry`
at load time can additionally pass it to :func:`load_skill_spec` /
:func:`load_skill_catalog_dir`; the loader will then reject skills
whose declared steps reference tools that are not registered.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator
from jsonschema import ValidationError as JsonSchemaValidationError
from pydantic import ValidationError

from apps.copilot.skills.base import SkillSpec
from apps.copilot.skills.errors import SkillValidationError
from apps.copilot.tools.registry import ToolRegistry

SCHEMA_PATH: Path = Path(__file__).resolve().parent / "skills" / "_schema.json"
"""Absolute path to the JSON-schema that every skill YAML is validated against."""


def _load_schema() -> dict[str, Any]:
    """Load and cache the JSON-schema bundled alongside the shipped skills."""
    if not SCHEMA_PATH.is_file():
        raise SkillValidationError(
            f"Skill JSON-schema missing: {SCHEMA_PATH}",
            source=str(SCHEMA_PATH),
        )
    with SCHEMA_PATH.open("r", encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


_SCHEMA_CACHE: dict[str, Any] | None = None
_VALIDATOR_CACHE: Draft202012Validator | None = None


def _schema() -> dict[str, Any]:
    """Return the cached schema, loading it on first access."""
    global _SCHEMA_CACHE
    if _SCHEMA_CACHE is None:
        _SCHEMA_CACHE = _load_schema()
    return _SCHEMA_CACHE


def _validator() -> Draft202012Validator:
    """Return the cached JSON-schema validator.

    Reuses the validator across calls because constructing one is
    non-trivial (it compiles regex patterns) and the schema is
    immutable for the process lifetime.
    """
    global _VALIDATOR_CACHE
    if _VALIDATOR_CACHE is None:
        _VALIDATOR_CACHE = Draft202012Validator(_schema())
    return _VALIDATOR_CACHE


def _read_yaml(path: Path) -> dict[str, Any]:
    """Safely read *path* and ensure the root is a mapping."""
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except (yaml.YAMLError, OSError) as exc:
        raise SkillValidationError(
            f"Failed to read skill YAML {path}: {exc}",
            source=str(path),
        ) from exc
    if not isinstance(data, dict):
        raise SkillValidationError(
            f"Skill YAML {path} must have a mapping at the root.",
            source=str(path),
        )
    return data


def load_skill_spec(
    path: Path,
    *,
    registry: ToolRegistry | None = None,
    source_label: str | None = None,
) -> SkillSpec:
    """Load one skill YAML at *path* into a frozen :class:`SkillSpec`.

    When *registry* is provided, every ``steps[].tool`` must resolve to
    a registered tool and the effective skill category (derived from
    the tools) must match the declared ``category`` — otherwise a
    :class:`SkillValidationError` is raised.

    The *source_label* overrides the ``source_path`` captured on the
    resulting spec.  When omitted, the path is stored verbatim.
    """
    path = Path(path)
    data = _read_yaml(path)

    # Stage 1: JSON-schema validation.
    errors = list(_validator().iter_errors(data))
    if errors:
        joined = "; ".join(_format_jsonschema_error(e) for e in errors)
        raise SkillValidationError(
            f"Skill YAML {path} failed schema validation: {joined}",
            skill_id=str(data.get("id") or ""),
            source=str(path),
        )

    # Stage 2: Pydantic semantic validation.
    data_with_source = dict(data)
    data_with_source["source_path"] = source_label or str(path)
    try:
        spec = SkillSpec.model_validate(data_with_source)
    except ValidationError as exc:
        raise SkillValidationError(
            f"Skill YAML {path} failed semantic validation: {exc.errors()}",
            skill_id=str(data.get("id") or ""),
            source=str(path),
        ) from exc

    # Stage 3 (optional): Tool-registry cross-check.
    if registry is not None:
        _validate_against_registry(spec, registry)

    return spec


def load_skill_catalog_dir(
    directory: Path,
    *,
    registry: ToolRegistry | None = None,
) -> list[SkillSpec]:
    """Load every ``*.yaml`` skill under *directory* (non-recursive).

    Files whose stem starts with ``_`` (reserved, e.g. ``_schema.json``
    lookalikes) are ignored.  The return list is sorted by skill id so
    catalog iteration order is deterministic.
    """
    directory = Path(directory)
    if not directory.is_dir():
        raise SkillValidationError(
            f"Skill directory {directory} does not exist.",
            source=str(directory),
        )

    specs: list[SkillSpec] = []
    seen_ids: dict[str, str] = {}
    for yaml_path in sorted(directory.glob("*.yaml")):
        if yaml_path.stem.startswith("_"):
            continue
        spec = load_skill_spec(yaml_path, registry=registry)
        if spec.id in seen_ids:
            raise SkillValidationError(
                f"Duplicate skill id {spec.id!r} in {yaml_path} "
                f"(previously loaded from {seen_ids[spec.id]}).",
                skill_id=spec.id,
                source=str(yaml_path),
            )
        seen_ids[spec.id] = str(yaml_path)
        specs.append(spec)

    return sorted(specs, key=lambda s: s.id)


def _validate_against_registry(spec: SkillSpec, registry: ToolRegistry) -> None:
    """Cross-check declared tool names against *registry*.

    When the skill is execute-class, at least one step must reference
    an execute tool — otherwise the declared category is wrong.  When
    the skill is read-class, every step must reference a read tool.
    """
    missing: list[str] = []
    exec_tools: list[str] = []
    for step in spec.steps:
        try:
            tool = registry.get_tool(step.tool)
        except KeyError:
            missing.append(step.tool)
            continue
        if tool.category == "execute":
            exec_tools.append(step.tool)

    if missing:
        raise SkillValidationError(
            f"Skill {spec.id!r} references unknown tools: {sorted(set(missing))}",
            skill_id=spec.id,
            source=spec.source_path,
        )

    if spec.category == "execute" and not exec_tools:
        raise SkillValidationError(
            f"Skill {spec.id!r} is declared category='execute' but has no execute-class tool steps.",
            skill_id=spec.id,
            source=spec.source_path,
        )
    if spec.category == "read" and exec_tools:
        raise SkillValidationError(
            f"Skill {spec.id!r} is declared category='read' but references execute tools: {exec_tools}",
            skill_id=spec.id,
            source=spec.source_path,
        )


def _format_jsonschema_error(err: JsonSchemaValidationError) -> str:
    """Render a :class:`jsonschema.ValidationError` into one line."""
    location = "/".join(str(p) for p in err.absolute_path) or "<root>"
    return f"{location}: {err.message}"


__all__ = [
    "SCHEMA_PATH",
    "load_skill_catalog_dir",
    "load_skill_spec",
]
