"""Tests for the :class:`PromptRegistry`."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.copilot.prompts import (
    PromptHashMismatchError,
    PromptNotFoundError,
    PromptRegistry,
    PromptRegistryError,
    PromptSpec,
    default_registry,
)
from apps.copilot.prompts.registry import _compute_hash


@pytest.fixture
def tmp_templates(tmp_path: Path) -> Path:
    """Create a temporary templates directory + empty hashes file."""
    tdir = tmp_path / "templates"
    tdir.mkdir()
    (tmp_path / "_hashes.json").write_text("{}", encoding="utf-8")
    return tmp_path


def _write_template(
    dir_: Path,
    name: str,
    *,
    fm_id: str,
    version: str,
    body: str,
    description: str = "test",
) -> Path:
    path = dir_ / f"{name}.md"
    path.write_text(
        f"---\nid: {fm_id}\nversion: {version}\ndescription: {description}\n---\n{body}",
        encoding="utf-8",
    )
    return path


class TestShippedTemplates:
    """Regression-safety checks for the prompts that actually ship."""

    def test_registry_loads_shipped_templates(self) -> None:
        registry = PromptRegistry()
        registry.load()
        ids = {spec.id for spec in registry.all()}
        assert {"ground_and_cite", "refusal_off_scope", "conversation_summarizer"} <= ids

    def test_verify_all_hashes_passes_for_shipped_snapshot(self) -> None:
        registry = PromptRegistry()
        registry.load()
        # Must not raise — the snapshot is in sync with the templates.
        registry.verify_all_hashes()

    def test_to_log_dict_shape(self) -> None:
        spec = default_registry().get("ground_and_cite")
        log = spec.to_log_dict()
        assert set(log) == {"prompt_id", "prompt_version", "prompt_content_hash"}
        assert log["prompt_id"] == "ground_and_cite"
        assert log["prompt_version"] == "v1"
        assert len(log["prompt_content_hash"]) == 64  # sha256 hex


class TestRegistryLoading:
    def test_load_is_idempotent(self, tmp_templates: Path) -> None:
        _write_template(
            tmp_templates / "templates",
            "foo_v1",
            fm_id="foo",
            version="v1",
            body="hello",
        )
        registry = PromptRegistry(
            templates_dir=tmp_templates / "templates",
            hashes_file=tmp_templates / "_hashes.json",
        )
        registry.load()
        registry.load()  # second call is a no-op
        assert len(registry.all()) == 1

    def test_missing_templates_dir_raises(self, tmp_path: Path) -> None:
        registry = PromptRegistry(
            templates_dir=tmp_path / "doesnotexist",
            hashes_file=tmp_path / "_hashes.json",
        )
        with pytest.raises(PromptRegistryError, match="does not exist"):
            registry.load()

    def test_empty_templates_dir_raises(self, tmp_templates: Path) -> None:
        registry = PromptRegistry(
            templates_dir=tmp_templates / "templates",
            hashes_file=tmp_templates / "_hashes.json",
        )
        with pytest.raises(PromptRegistryError, match="No \\*\\.md templates"):
            registry.load()

    def test_missing_frontmatter_raises(self, tmp_templates: Path) -> None:
        tdir = tmp_templates / "templates"
        (tdir / "bad.md").write_text("no frontmatter here", encoding="utf-8")
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        with pytest.raises(PromptRegistryError, match="frontmatter"):
            registry.load()

    def test_duplicate_id_raises(self, tmp_templates: Path) -> None:
        tdir = tmp_templates / "templates"
        _write_template(tdir, "a_v1", fm_id="dup", version="v1", body="A")
        _write_template(tdir, "b_v1", fm_id="dup", version="v1", body="B")
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        with pytest.raises(PromptRegistryError, match="Duplicate prompt id"):
            registry.load()

    def test_missing_required_frontmatter_field(self, tmp_templates: Path) -> None:
        tdir = tmp_templates / "templates"
        (tdir / "c.md").write_text(
            "---\nid: foo\n---\nbody\n", encoding="utf-8",
        )
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        with pytest.raises(PromptRegistryError, match="missing required field"):
            registry.load()


class TestRegistryGet:
    def test_get_returns_spec(self) -> None:
        registry = default_registry()
        spec = registry.get("ground_and_cite")
        assert isinstance(spec, PromptSpec)
        assert spec.id == "ground_and_cite"
        assert spec.body.startswith("You are the CSA-in-a-Box Copilot.")
        assert spec.content_hash == _compute_hash(spec.body)

    def test_get_raises_promptnotfound(self) -> None:
        registry = default_registry()
        with pytest.raises(PromptNotFoundError):
            registry.get("doesnotexist")

    def test_all_returns_sorted(self) -> None:
        registry = default_registry()
        specs = registry.all()
        ids = [s.id for s in specs]
        assert ids == sorted(ids)


class TestHashVerification:
    def test_verify_raises_on_drift(self, tmp_templates: Path) -> None:
        tdir = tmp_templates / "templates"
        _write_template(tdir, "x_v1", fm_id="x", version="v1", body="original")
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        registry.write_snapshot()  # snapshot "original"

        # Now edit the template (simulate a silent edit).
        _write_template(tdir, "x_v1", fm_id="x", version="v1", body="edited")
        registry2 = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        with pytest.raises(PromptHashMismatchError):
            registry2.verify_all_hashes()

    def test_verify_raises_on_version_bump_without_snapshot_update(
        self, tmp_templates: Path,
    ) -> None:
        tdir = tmp_templates / "templates"
        _write_template(tdir, "y_v1", fm_id="y", version="v1", body="hello")
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        registry.write_snapshot()

        # Bump version to v2 in the template (but update body too).
        (tdir / "y_v1.md").unlink()
        _write_template(tdir, "y_v2", fm_id="y", version="v2", body="world")
        registry2 = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        with pytest.raises(PromptHashMismatchError):
            registry2.verify_all_hashes()

    def test_verify_raises_on_new_template_missing_from_snapshot(
        self, tmp_templates: Path,
    ) -> None:
        tdir = tmp_templates / "templates"
        _write_template(tdir, "a_v1", fm_id="a", version="v1", body="aaa")
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        registry.write_snapshot()
        _write_template(tdir, "b_v1", fm_id="b", version="v1", body="bbb")

        registry2 = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        with pytest.raises(PromptHashMismatchError):
            registry2.verify_all_hashes()

    def test_missing_snapshot_raises(self, tmp_templates: Path) -> None:
        tdir = tmp_templates / "templates"
        _write_template(tdir, "a_v1", fm_id="a", version="v1", body="aaa")
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "does_not_exist.json",
        )
        with pytest.raises(PromptRegistryError, match="snapshot file missing"):
            registry.verify_all_hashes()

    def test_malformed_snapshot_raises(self, tmp_templates: Path) -> None:
        tdir = tmp_templates / "templates"
        _write_template(tdir, "a_v1", fm_id="a", version="v1", body="aaa")
        (tmp_templates / "_hashes.json").write_text("{bad json", encoding="utf-8")
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        with pytest.raises(PromptRegistryError, match="Malformed"):
            registry.verify_all_hashes()


class TestContentHashNormalisation:
    def test_crlf_lf_produce_same_hash(self) -> None:
        lf = "line one\nline two\n"
        crlf = "line one\r\nline two\r\n"
        assert _compute_hash(lf) == _compute_hash(crlf)

    def test_trailing_whitespace_stripped(self) -> None:
        a = "body\n"
        b = "body\n\n\n\n"
        assert _compute_hash(a) == _compute_hash(b)


class TestWriteSnapshot:
    def test_write_snapshot_roundtrip(self, tmp_templates: Path) -> None:
        tdir = tmp_templates / "templates"
        _write_template(tdir, "x_v1", fm_id="x", version="v1", body="BODY")
        registry = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        registry.write_snapshot()
        data = json.loads((tmp_templates / "_hashes.json").read_text(encoding="utf-8"))
        assert "x" in data
        assert data["x"]["version"] == "v1"
        # Second registry loading from scratch against the snapshot passes.
        registry2 = PromptRegistry(
            templates_dir=tdir, hashes_file=tmp_templates / "_hashes.json",
        )
        registry2.verify_all_hashes()
