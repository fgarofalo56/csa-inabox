"""Tests for :mod:`apps.copilot.indexer` (Phase 0).

Every test runs against a fully in-memory fake embedder and vector
store — there are NO Azure calls.  The fakes implement the
:class:`SupportsEmbed` / :class:`SupportsUpsert` protocols.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from apps.copilot.config import CopilotSettings
from apps.copilot.indexer import (
    CorpusIndexer,
    infer_doc_type,
    iter_corpus_files,
)
from csa_platform.ai_integration.rag.pipeline import Chunk

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeEmbedder:
    """Returns a deterministic vector per text (no external I/O)."""

    def __init__(self, dim: int = 8) -> None:
        self.dim = dim
        self.calls: list[list[str]] = []

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [[float(len(t) % self.dim) / self.dim] * self.dim for t in texts]


class FakeVectorStore:
    """Tracks upserts in-memory.  No Azure."""

    def __init__(self) -> None:
        self.created_index = 0
        self.upserts: list[list[Chunk]] = []
        self.ids: set[str] = set()

    def create_index(self) -> None:
        self.created_index += 1

    def upsert_documents(self, chunks: list[Chunk], embeddings: list[list[float]]) -> int:
        assert len(chunks) == len(embeddings)
        self.upserts.append(list(chunks))
        for c in chunks:
            self.ids.add(c.id)
        return len(chunks)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_repo(tmp_path: Path) -> Path:
    """Create a tiny fake repo with docs/, examples/, and top-level files."""
    repo = tmp_path / "repo"
    (repo / "docs" / "adr").mkdir(parents=True)
    (repo / "docs" / "runbooks").mkdir(parents=True)
    (repo / "examples" / "usda").mkdir(parents=True)

    (repo / "docs" / "ARCHITECTURE.md").write_text(
        "# Architecture\n\n"
        "CSA-in-a-Box provides Fabric-parity services on Azure PaaS. "
        "It is deployable in both Government and Commercial clouds.\n",
        encoding="utf-8",
    )
    (repo / "docs" / "adr" / "0001-use-bicep.md").write_text(
        "# ADR 0001: Use Bicep\n\n"
        "We adopt Bicep over ARM JSON for readability. Modules are shared across domains.\n",
        encoding="utf-8",
    )
    (repo / "docs" / "runbooks" / "rotate-secrets.md").write_text(
        "# Rotate Secrets\n\n"
        "Rotate Key Vault secrets monthly. Use the secretRotation Azure Function.\n",
        encoding="utf-8",
    )
    (repo / "examples" / "usda" / "README.md").write_text(
        "# USDA Crop Yield Example\n\nDemonstrates the NOAA ingest pipeline.\n",
        encoding="utf-8",
    )
    (repo / "README.md").write_text(
        "# Top-level README\n\nHigh-level project intro.\n",
        encoding="utf-8",
    )
    # Non-markdown file that should be excluded by default extensions.
    (repo / "docs" / "diagram.png").write_bytes(b"binary-garbage")

    return repo


@pytest.fixture
def base_settings() -> CopilotSettings:
    """Minimal settings for offline tests."""
    return CopilotSettings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="fake-key",
        azure_search_endpoint="https://fake.search.windows.net",
        azure_search_api_key="fake-key",
        chunk_size=200,
        chunk_overlap=40,
        min_chunk_length=10,
    )


# ---------------------------------------------------------------------------
# infer_doc_type
# ---------------------------------------------------------------------------


class TestInferDocType:
    """The doc-type classifier is trivial but load-bearing."""

    @pytest.mark.parametrize(
        ("path", "expected"),
        [
            ("docs/adr/0001-use-bicep.md", "adr"),
            ("docs/adr/nested/0003-foo.md", "adr"),
            ("docs/decisions/2024-01-cost.md", "decision"),
            ("docs/migrations/0002-move-to-fabric.md", "migration"),
            ("docs/compliance/fedramp.md", "compliance"),
            ("docs/runbooks/rotate-secrets.md", "runbook"),
            ("examples/usda/README.md", "example"),
            ("examples/README.md", "example"),
            ("docs/ARCHITECTURE.md", "overview"),
            ("README.md", "overview"),
            ("ARCHITECTURE.md", "overview"),
            ("csa_platform/governance/something.md", "unknown"),
        ],
    )
    def test_classification(self, path: str, expected: str) -> None:
        assert infer_doc_type(path) == expected


# ---------------------------------------------------------------------------
# iter_corpus_files
# ---------------------------------------------------------------------------


class TestIterCorpusFiles:
    """The walker must be deterministic and respect extensions."""

    def test_walks_directories_recursively(self, sample_repo: Path) -> None:
        files = list(iter_corpus_files(sample_repo, ["docs", "examples"], [".md"]))
        names = {f.name for f in files}
        assert "ARCHITECTURE.md" in names
        assert "0001-use-bicep.md" in names
        assert "rotate-secrets.md" in names
        assert "README.md" in names  # in examples/usda/

    def test_excludes_non_matching_extensions(self, sample_repo: Path) -> None:
        files = list(iter_corpus_files(sample_repo, ["docs"], [".md"]))
        assert not any(f.name.endswith(".png") for f in files)

    def test_dedupes_overlapping_roots(self, sample_repo: Path) -> None:
        # docs and docs/adr both include the ADR file — walker must return it once.
        files = list(iter_corpus_files(sample_repo, ["docs", "docs/adr"], [".md"]))
        adr_paths = [f for f in files if f.name == "0001-use-bicep.md"]
        assert len(adr_paths) == 1

    def test_accepts_single_file_root(self, sample_repo: Path) -> None:
        files = list(iter_corpus_files(sample_repo, ["README.md"], [".md"]))
        assert len(files) == 1
        assert files[0].name == "README.md"

    def test_missing_root_is_skipped_silently(self, sample_repo: Path) -> None:
        files = list(
            iter_corpus_files(sample_repo, ["does/not/exist", "docs/adr"], [".md"]),
        )
        assert all(f.exists() for f in files)
        assert any(f.name == "0001-use-bicep.md" for f in files)


# ---------------------------------------------------------------------------
# CorpusIndexer.index
# ---------------------------------------------------------------------------


class TestCorpusIndexer:
    """Full indexer behaviour under mocked Azure."""

    def _make_indexer(
        self,
        sample_repo: Path,
        settings: CopilotSettings,
    ) -> tuple[CorpusIndexer, FakeEmbedder, FakeVectorStore]:
        embedder = FakeEmbedder()
        store = FakeVectorStore()
        indexer = CorpusIndexer(
            settings=settings,
            repo_root=sample_repo,
            embedder=embedder,
            vector_store=store,
        )
        return indexer, embedder, store

    def test_indexes_all_configured_roots(
        self,
        sample_repo: Path,
        base_settings: CopilotSettings,
    ) -> None:
        indexer, embedder, store = self._make_indexer(sample_repo, base_settings)

        report = indexer.index(
            roots=[Path("docs"), Path("examples"), Path("README.md")],
        )

        assert report.files_scanned >= 4
        assert report.chunks_indexed > 0
        assert report.chunks_skipped == 0
        assert report.bytes_embedded > 0
        assert report.elapsed_seconds >= 0.0
        assert store.created_index == 1
        assert len(embedder.calls) >= 1

        # Doc-type counts should cover the buckets we wrote into.
        assert report.doc_type_counts.get("adr", 0) >= 1
        assert report.doc_type_counts.get("runbook", 0) >= 1
        assert report.doc_type_counts.get("example", 0) >= 1
        assert report.doc_type_counts.get("overview", 0) >= 1

    def test_is_idempotent_on_second_run(
        self,
        sample_repo: Path,
        base_settings: CopilotSettings,
    ) -> None:
        # Two separate indexer instances sharing the same vector store.
        embedder = FakeEmbedder()
        store = FakeVectorStore()

        first = CorpusIndexer(
            settings=base_settings,
            repo_root=sample_repo,
            embedder=embedder,
            vector_store=store,
        )
        report_one = first.index(roots=[Path("docs")])
        ids_first = set(store.ids)

        # A fresh indexer (new in-memory dedupe cache) must still
        # produce identical ids for identical content.
        embedder_two = FakeEmbedder()
        second = CorpusIndexer(
            settings=base_settings,
            repo_root=sample_repo,
            embedder=embedder_two,
            vector_store=store,
        )
        report_two = second.index(roots=[Path("docs")])
        ids_second = set(store.ids)

        # Same set of ids (idempotent content addressing).
        assert ids_first == ids_second

        # Both reports saw the same files.
        assert report_one.files_scanned == report_two.files_scanned

    def test_dry_run_skips_embedder_and_upsert(
        self,
        sample_repo: Path,
        base_settings: CopilotSettings,
    ) -> None:
        indexer, embedder, store = self._make_indexer(sample_repo, base_settings)
        report = indexer.index(roots=[Path("docs")], dry_run=True)
        assert report.chunks_indexed > 0  # chunked in memory
        assert embedder.calls == []
        assert store.upserts == []
        assert store.created_index == 0

    def test_file_read_failure_is_logged_and_skipped(
        self,
        sample_repo: Path,
        base_settings: CopilotSettings,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        indexer, _embedder, _store = self._make_indexer(sample_repo, base_settings)

        original_read = Path.read_text

        def _boom(self: Path, *args: Any, **kwargs: Any) -> str:
            if self.name == "0001-use-bicep.md":
                raise OSError("simulated read error")
            return original_read(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", _boom)
        report = indexer.index(roots=[Path("docs")])
        # Other files still indexed.
        assert report.files_scanned >= 1
        assert report.chunks_indexed > 0

    def test_attaches_doc_metadata_to_chunks(
        self,
        sample_repo: Path,
        base_settings: CopilotSettings,
    ) -> None:
        indexer, _embedder, store = self._make_indexer(sample_repo, base_settings)
        indexer.index(roots=[Path("docs/adr")])

        assert store.upserts, "expected at least one upsert batch"
        chunk = store.upserts[0][0]
        assert chunk.metadata["source_path"].endswith("0001-use-bicep.md")
        assert chunk.metadata["doc_type"] == "adr"
        assert chunk.metadata["title"].startswith("ADR 0001")
        assert "last_modified_utc" in chunk.metadata
        assert "content_hash" in chunk.metadata
        # Content-addressable id derives from content_hash (24-char prefix).
        assert chunk.id == chunk.metadata["content_hash"][:24]
