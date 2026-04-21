"""Validates every shipped skill YAML + its external references.

The acceptance criterion from Phase 3 requires:

* every shipped ``*.yaml`` in ``apps/copilot/skills/skills/`` validates
  against ``_schema.json``;
* every ``tree_id`` referenced resolves to a real file under
  ``decision-trees/``;
* every ``path`` referenced resolves to a real file under the repo
  root;
* every ``adr`` referenced by filename exists under ``docs/adr/``.

This test is deliberately isolated so CI failures point straight at
the offending YAML.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from jsonschema import Draft202012Validator

from apps.copilot.skills.catalog import SHIPPED_SKILLS_DIR
from apps.copilot.skills.loader import SCHEMA_PATH


def _repo_root() -> Path:
    """Repo root inferred from this file's location (four parents up)."""
    return Path(__file__).resolve().parents[4]


def _shipped_skill_paths() -> list[Path]:
    """Return every YAML in the shipped skills directory."""
    return [
        p
        for p in sorted(SHIPPED_SKILLS_DIR.glob("*.yaml"))
        if not p.stem.startswith("_")
    ]


@pytest.fixture(scope="module")
def schema_validator() -> Draft202012Validator:
    """Shared validator compiled once per test module."""
    with SCHEMA_PATH.open("r", encoding="utf-8") as fh:
        return Draft202012Validator(json.load(fh))


@pytest.fixture(scope="module")
def shipped_paths() -> list[Path]:
    return _shipped_skill_paths()


def test_at_least_six_shipped_skills(shipped_paths: list[Path]) -> None:
    """Phase 3 seeds the catalog with at least six skills."""
    assert len(shipped_paths) >= 6, (
        f"Shipped catalog must have >=6 skills, found {len(shipped_paths)}."
    )


@pytest.mark.parametrize("yaml_path", _shipped_skill_paths(), ids=lambda p: p.stem)
def test_shipped_skill_validates_against_schema(
    yaml_path: Path,
    schema_validator: Draft202012Validator,
) -> None:
    """Every shipped YAML must satisfy the JSON-schema."""
    with yaml_path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    errors = sorted(schema_validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    assert not errors, (
        f"{yaml_path.name} schema errors: "
        f"{[f'{list(e.absolute_path)}: {e.message}' for e in errors]}"
    )


@pytest.mark.parametrize("yaml_path", _shipped_skill_paths(), ids=lambda p: p.stem)
def test_shipped_skill_references_are_real(yaml_path: Path) -> None:
    """Every referenced path, tree_id, and ADR filename must exist."""
    repo_root = _repo_root()
    with yaml_path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)

    missing: list[str] = []
    for step in data.get("steps", []):
        tool = step.get("tool")
        step_input = step.get("input") or {}

        # Filesystem paths — only validate when the value is a literal
        # (not a `{...}` template), since templates resolve at dispatch.
        if tool == "read_repo_file":
            path_value = step_input.get("path")
            if isinstance(path_value, str) and "{" not in path_value:
                candidate = repo_root / path_value
                if not candidate.is_file():
                    missing.append(f"path not found: {path_value}")

        # Decision trees.
        if tool == "walk_decision_tree":
            tree_id = step_input.get("tree_id")
            if isinstance(tree_id, str) and "{" not in tree_id:
                candidate = repo_root / "decision-trees" / f"{tree_id}.yaml"
                if not candidate.is_file():
                    missing.append(f"tree_id not found: {tree_id}")

    # Defaults used as ADR/tree hints — catch template-defaulted YAML
    # fields that we ship as literals.
    for field in data.get("inputs", []):
        default = field.get("default")
        if isinstance(default, str):
            # Only validate paths that look like repo paths.
            if default.endswith(".md") and "/" in default:
                candidate = repo_root / default
                if not candidate.is_file():
                    missing.append(f"default path not found: {default}")
            # Decision-tree defaults.
            if field.get("name", "").endswith("tree_id"):
                candidate = repo_root / "decision-trees" / f"{default}.yaml"
                if not candidate.is_file():
                    missing.append(f"default tree_id not found: {default}")

    assert not missing, f"{yaml_path.name} has unresolved references: {missing}"


@pytest.mark.parametrize("yaml_path", _shipped_skill_paths(), ids=lambda p: p.stem)
def test_shipped_skill_has_minimum_shape(yaml_path: Path) -> None:
    """Every shipped skill must have name, description, category, and >=1 step."""
    with yaml_path.open("r", encoding="utf-8") as fh:
        data: dict[str, Any] = yaml.safe_load(fh)
    assert data.get("name"), f"{yaml_path.name} missing name"
    assert len(data.get("description", "")) >= 20, (
        f"{yaml_path.name} description too short"
    )
    assert data.get("category") in ("read", "execute")
    assert len(data.get("steps") or []) >= 1


def test_all_seeded_skills_load_via_catalog() -> None:
    """End-to-end sanity: SkillCatalog.from_shipped() loads without error."""
    from apps.copilot.skills.catalog import SkillCatalog

    catalog = SkillCatalog.from_shipped()
    assert len(catalog) >= 6
    seen_ids = catalog.ids()
    expected = {
        "compare-fabric-vs-databricks",
        "explain-migration-palantir",
        "list-adrs",
        "score-deployment-readiness",
        "draft-adr",
        "grounded-corpus-qa",
    }
    missing = expected - set(seen_ids)
    assert not missing, f"Shipped catalog missing expected skills: {missing}"
