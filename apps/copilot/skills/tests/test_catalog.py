"""Tests for :class:`apps.copilot.skills.catalog.SkillCatalog`.

The catalog's role is narrow: hold a name-keyed set of
:class:`SkillSpec` instances, refuse duplicates, and expose
deterministic iteration.  These tests pin that contract.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from apps.copilot.skills.catalog import SHIPPED_SKILLS_DIR, SkillCatalog
from apps.copilot.skills.errors import SkillNotFoundError

FIXTURES = Path(__file__).parent / "fixtures"


def test_from_directory_with_only_valid_yaml(tmp_path: Path) -> None:
    """Loading a directory of valid YAMLs yields a populated catalog."""
    import shutil

    shutil.copy(FIXTURES / "valid_skill.yaml", tmp_path / "valid_skill.yaml")
    catalog = SkillCatalog.from_directory(tmp_path)
    assert len(catalog) == 1
    assert "valid-fixture" in catalog


def test_from_directory_with_invalid_yaml_raises(tmp_path: Path) -> None:
    """An invalid YAML in the directory prevents catalog construction."""
    import shutil

    from apps.copilot.skills.errors import SkillValidationError

    shutil.copy(FIXTURES / "valid_skill.yaml", tmp_path / "valid_skill.yaml")
    shutil.copy(FIXTURES / "invalid_skill.yaml", tmp_path / "invalid_skill.yaml")
    with pytest.raises(SkillValidationError):
        SkillCatalog.from_directory(tmp_path)


def test_empty_catalog() -> None:
    """An empty catalog behaves like a zero-length container."""
    catalog = SkillCatalog()
    assert len(catalog) == 0
    assert catalog.list() == []
    assert list(catalog) == []


def test_get_missing_raises_skill_not_found() -> None:
    """Missing ids raise SkillNotFoundError (also a KeyError)."""
    catalog = SkillCatalog()
    with pytest.raises(SkillNotFoundError):
        catalog.get("nope")
    with pytest.raises(KeyError):
        catalog.get("nope")


def test_register_rejects_duplicate_ids() -> None:
    """Registering the same id twice is a programming error."""
    from apps.copilot.skills.loader import load_skill_spec

    spec = load_skill_spec(FIXTURES / "valid_skill.yaml")
    catalog = SkillCatalog([spec])
    with pytest.raises(ValueError, match="already registered"):
        catalog.register(spec)


def test_contains_is_type_safe() -> None:
    """Non-string lookups through __contains__ must not blow up."""
    catalog = SkillCatalog()
    assert "x" not in catalog
    assert 42 not in catalog
    assert None not in catalog


def test_shipped_catalog_loads() -> None:
    """Every shipped skill must load cleanly (sanity check)."""
    catalog = SkillCatalog.from_shipped()
    assert len(catalog) >= 6
    ids = catalog.ids()
    # Deterministic ordering by id.
    assert ids == sorted(ids)


def test_shipped_catalog_has_each_named_skill() -> None:
    """All six named skills must be present in the shipped catalog."""
    catalog = SkillCatalog.from_shipped()
    for required in [
        "compare-fabric-vs-databricks",
        "explain-migration-palantir",
        "list-adrs",
        "score-deployment-readiness",
        "draft-adr",
        "grounded-corpus-qa",
    ]:
        assert required in catalog, f"shipped catalog missing {required!r}"


def test_shipped_skills_dir_exists() -> None:
    """The shipped skills directory must be shipped with the package."""
    assert SHIPPED_SKILLS_DIR.is_dir()
