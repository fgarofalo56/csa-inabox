"""Tests for :mod:`apps.copilot.skills.loader` (Phase 3).

These tests lock the two-stage validation behaviour: JSON-schema
first, Pydantic semantic checks second.  We also verify the optional
tool-registry cross-check because shipped skills go through that path.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import BaseModel

from apps.copilot.skills.errors import SkillValidationError
from apps.copilot.skills.loader import (
    SCHEMA_PATH,
    load_skill_catalog_dir,
    load_skill_spec,
)
from apps.copilot.tools.base import ToolCategory
from apps.copilot.tools.registry import ToolRegistry

FIXTURES = Path(__file__).parent / "fixtures"


class _DummyInput(BaseModel):
    query: str = ""


class _DummyOutput(BaseModel):
    echo: str = ""


class _FakeTool:
    """Minimal Tool-protocol compatible fake for registry tests."""

    input_model = _DummyInput
    output_model = _DummyOutput

    def __init__(self, name: str, category: ToolCategory = "read") -> None:
        self.name = name
        self.category = category
        self.description = f"fake-{name}"

    async def __call__(self, input_value: _DummyInput) -> _DummyOutput:
        return _DummyOutput(echo=input_value.query)


def test_schema_file_exists() -> None:
    """The JSON-schema must ship alongside the loader."""
    assert SCHEMA_PATH.is_file()


def test_loads_valid_skill() -> None:
    """A fixture skill should load into a frozen SkillSpec."""
    spec = load_skill_spec(FIXTURES / "valid_skill.yaml")
    assert spec.id == "valid-fixture"
    assert spec.category == "read"
    assert len(spec.steps) == 2
    assert spec.steps[0].tool == "read_repo_file"
    # Frozen: attempting to mutate should raise.
    with pytest.raises(Exception):  # noqa: B017, PT011
        spec.id = "mutated"


def test_rejects_invalid_schema() -> None:
    """Schema violations surface a SkillValidationError, not a raw exception."""
    with pytest.raises(SkillValidationError, match="schema validation"):
        load_skill_spec(FIXTURES / "invalid_skill.yaml")


def test_rejects_missing_file(tmp_path: Path) -> None:
    """Non-existent YAMLs fail fast with SkillValidationError."""
    missing = tmp_path / "does-not-exist.yaml"
    with pytest.raises(SkillValidationError, match="Failed to read skill YAML"):
        load_skill_spec(missing)


def test_rejects_non_mapping_root(tmp_path: Path) -> None:
    """A YAML whose root is not a mapping must be rejected."""
    bad = tmp_path / "scalar.yaml"
    bad.write_text("just a string\n", encoding="utf-8")
    with pytest.raises(SkillValidationError, match="must have a mapping"):
        load_skill_spec(bad)


def test_rejects_duplicate_step_ids(tmp_path: Path) -> None:
    """Pydantic semantic validation enforces unique step ids."""
    bad = tmp_path / "dup.yaml"
    payload: dict[str, Any] = {
        "id": "dup-steps",
        "name": "Duplicate step ids",
        "description": "This skill has duplicate step ids which must be rejected.",
        "category": "read",
        "steps": [
            {"id": "same", "tool": "search_corpus", "input": {}},
            {"id": "same", "tool": "search_corpus", "input": {}},
        ],
    }
    bad.write_text(yaml.safe_dump(payload), encoding="utf-8")
    with pytest.raises(SkillValidationError):
        load_skill_spec(bad)


def test_registry_crosscheck_rejects_unknown_tool(tmp_path: Path) -> None:
    """When a registry is supplied, unknown tool refs are rejected at load time."""
    bad = tmp_path / "ghost.yaml"
    payload: dict[str, Any] = {
        "id": "ghost-tool",
        "name": "Ghost tool skill",
        "description": "References a tool that isn't registered; must fail load.",
        "category": "read",
        "steps": [{"id": "a", "tool": "no-such-tool", "input": {}}],
    }
    bad.write_text(yaml.safe_dump(payload), encoding="utf-8")
    registry = ToolRegistry([_FakeTool("search_corpus")])
    with pytest.raises(SkillValidationError, match="unknown tools"):
        load_skill_spec(bad, registry=registry)


def test_registry_crosscheck_rejects_category_mismatch(tmp_path: Path) -> None:
    """A skill declared category=read cannot reference an execute tool."""
    bad = tmp_path / "mismatch.yaml"
    payload: dict[str, Any] = {
        "id": "cat-mismatch",
        "name": "Category mismatch",
        "description": "Read skill referencing an execute tool should be rejected.",
        "category": "read",
        "steps": [{"id": "x", "tool": "execute_fake", "input": {}}],
    }
    bad.write_text(yaml.safe_dump(payload), encoding="utf-8")
    registry = ToolRegistry([_FakeTool("execute_fake", category="execute")])
    with pytest.raises(SkillValidationError, match="references execute tools"):
        load_skill_spec(bad, registry=registry)


def test_registry_crosscheck_rejects_execute_without_execute_tool(tmp_path: Path) -> None:
    """An execute skill with no execute tool is logically wrong."""
    bad = tmp_path / "fake-exec.yaml"
    payload: dict[str, Any] = {
        "id": "fake-exec",
        "name": "Fake execute",
        "description": "Execute skill with only read tools should be rejected.",
        "category": "execute",
        "steps": [{"id": "x", "tool": "read_fake", "input": {}}],
    }
    bad.write_text(yaml.safe_dump(payload), encoding="utf-8")
    registry = ToolRegistry([_FakeTool("read_fake", category="read")])
    with pytest.raises(SkillValidationError, match="no execute-class"):
        load_skill_spec(bad, registry=registry)


def test_load_catalog_dir_ignores_underscore_files(tmp_path: Path) -> None:
    """Files whose stem starts with '_' (reserved) are skipped."""
    ignored = tmp_path / "_template.yaml"
    ignored.write_text("id: ignored\n", encoding="utf-8")
    kept = tmp_path / "kept.yaml"
    payload: dict[str, Any] = {
        "id": "kept",
        "name": "Kept",
        "description": "Valid fixture kept by the loader.",
        "category": "read",
        "steps": [{"id": "s", "tool": "search_corpus", "input": {}}],
    }
    kept.write_text(yaml.safe_dump(payload), encoding="utf-8")
    specs = load_skill_catalog_dir(tmp_path)
    ids = [s.id for s in specs]
    assert ids == ["kept"]


def test_load_catalog_dir_sorts_by_id(tmp_path: Path) -> None:
    """The returned list must be sorted by skill id for determinism."""
    for sid in ("zebra", "alpha", "mango"):
        (tmp_path / f"{sid}.yaml").write_text(
            yaml.safe_dump(
                {
                    "id": sid,
                    "name": sid,
                    "description": f"Description for fixture {sid} long enough to satisfy.",
                    "category": "read",
                    "steps": [{"id": "s", "tool": "search_corpus", "input": {}}],
                },
            ),
            encoding="utf-8",
        )
    specs = load_skill_catalog_dir(tmp_path)
    assert [s.id for s in specs] == ["alpha", "mango", "zebra"]


def test_load_catalog_dir_rejects_duplicate_ids(tmp_path: Path) -> None:
    """Two YAML files with the same skill id must fail."""
    body: dict[str, Any] = {
        "id": "conflict",
        "name": "Conflict",
        "description": "Duplicate id fixture, will be rejected on the second load.",
        "category": "read",
        "steps": [{"id": "s", "tool": "search_corpus", "input": {}}],
    }
    (tmp_path / "one.yaml").write_text(yaml.safe_dump(body), encoding="utf-8")
    (tmp_path / "two.yaml").write_text(yaml.safe_dump(body), encoding="utf-8")
    with pytest.raises(SkillValidationError, match="Duplicate skill id"):
        load_skill_catalog_dir(tmp_path)


def test_load_catalog_dir_rejects_missing_dir(tmp_path: Path) -> None:
    """A non-existent directory is a load-time failure."""
    missing = tmp_path / "no-such-dir"
    with pytest.raises(SkillValidationError, match="does not exist"):
        load_skill_catalog_dir(missing)
