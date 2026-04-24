"""Tests for ``csa_platform.ai_integration.graphrag.document_loader``.

These exercise the pure-Python loaders (text, markdown, JSON) — no
Azure dependencies. The previously-untested ``DocumentLoader`` had
~575 LOC with zero tests; these smoke tests pin the supported file
formats and the dataclass contract so future regressions surface in
CI.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from csa_platform.ai_integration.graphrag.document_loader import (
    Document,
    DocumentLoader,
)

# ── Document dataclass ────────────────────────────────────────────────────


class TestDocument:
    def test_to_text_includes_title_and_source(self) -> None:
        doc = Document(title="My Doc", content="hello world", source="/tmp/x.md")
        text = doc.to_text()
        assert "# My Doc" in text
        assert "Source: /tmp/x.md" in text
        assert "hello world" in text

    def test_metadata_defaults_to_empty_dict(self) -> None:
        doc = Document(title="t", content="c", source="s")
        assert doc.metadata == {}


# ── DocumentLoader ────────────────────────────────────────────────────────


@pytest.fixture
def loader(monkeypatch: pytest.MonkeyPatch) -> DocumentLoader:
    """Loader with credential acquisition stubbed out (no Azure calls)."""

    class _FakeCred:
        pass

    monkeypatch.setattr(
        "csa_platform.ai_integration.graphrag.document_loader.DefaultAzureCredential",
        lambda: _FakeCred(),
    )
    return DocumentLoader()


class TestLoadDirectory:
    def test_raises_on_missing_directory(
        self, loader: DocumentLoader, tmp_path: Path
    ) -> None:
        with pytest.raises(FileNotFoundError):
            loader.load_directory(tmp_path / "does-not-exist")

    def test_loads_markdown_and_text_files(
        self, loader: DocumentLoader, tmp_path: Path
    ) -> None:
        (tmp_path / "a.md").write_text("# Hello\n\nbody", encoding="utf-8")
        (tmp_path / "b.txt").write_text("plain", encoding="utf-8")
        (tmp_path / "c.bin").write_bytes(b"\x00\x01")  # ignored
        docs = loader.load_directory(tmp_path, formats=["md", "txt"])
        titles = sorted(d.title for d in docs)
        assert titles == ["a", "b"]
        assert all("format" in d.metadata for d in docs)

    def test_recursive_flag(self, loader: DocumentLoader, tmp_path: Path) -> None:
        (tmp_path / "top.md").write_text("top", encoding="utf-8")
        sub = tmp_path / "nested"
        sub.mkdir()
        (sub / "deep.md").write_text("deep", encoding="utf-8")

        flat = loader.load_directory(tmp_path, formats=["md"], recursive=False)
        assert {d.title for d in flat} == {"top"}

        deep = loader.load_directory(tmp_path, formats=["md"], recursive=True)
        assert {d.title for d in deep} == {"top", "deep"}

    def test_unsupported_format_is_skipped_with_warning(
        self, loader: DocumentLoader, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        (tmp_path / "a.md").write_text("hello", encoding="utf-8")
        docs = loader.load_directory(tmp_path, formats=["md", "doesnotexist"])
        assert any("Unsupported format" in r.message for r in caplog.records)
        assert len(docs) == 1


class TestJSONLoading:
    def test_array_of_objects_becomes_one_doc_each(
        self, loader: DocumentLoader, tmp_path: Path
    ) -> None:
        payload = [
            {"title": "T1", "content": "C1"},
            {"title": "T2", "content": "C2"},
        ]
        (tmp_path / "data.json").write_text(json.dumps(payload), encoding="utf-8")
        docs = loader.load_directory(tmp_path, formats=["json"])
        assert sorted(d.title for d in docs) == ["T1", "T2"]
        assert all(d.metadata["format"] == "json" for d in docs)

    def test_object_becomes_single_doc(
        self, loader: DocumentLoader, tmp_path: Path
    ) -> None:
        (tmp_path / "x.json").write_text(
            json.dumps({"title": "Solo", "text": "body"}),
            encoding="utf-8",
        )
        docs = loader.load_directory(tmp_path, formats=["json"])
        assert len(docs) == 1
        assert docs[0].title == "Solo"
        assert docs[0].content == "body"

    def test_invalid_json_yields_no_documents(
        self, loader: DocumentLoader, tmp_path: Path
    ) -> None:
        (tmp_path / "bad.json").write_text("{not json", encoding="utf-8")
        docs = loader.load_directory(tmp_path, formats=["json"])
        assert docs == []
