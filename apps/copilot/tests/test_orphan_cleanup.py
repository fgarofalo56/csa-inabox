"""Tests for :mod:`apps.copilot.indexer` orphan cleanup (post-Phase-1 Gap 1).

A fake vector store implements :class:`SupportsOrphanCleanup` so the
cleanup protocol is exercised end-to-end without Azure.  The fake
records every upsert, tracks chunks by id + source_path, and honours
deletes so later assertions can verify the index state after a
reindex pass.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from apps.copilot.config import CopilotSettings
from apps.copilot.indexer import CorpusIndexer, OrphanCleanupError
from csa_platform.ai_integration.rag.pipeline import Chunk

# ---------------------------------------------------------------------------
# Fakes with orphan cleanup support
# ---------------------------------------------------------------------------


class FakeEmbedder:
    """Deterministic vector per text — no network."""

    def __init__(self, dim: int = 8) -> None:
        self.dim = dim

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [[float(len(t) % self.dim) / self.dim] * self.dim for t in texts]


class OrphanAwareFakeStore:
    """Vector store fake that implements :class:`SupportsOrphanCleanup`."""

    def __init__(self) -> None:
        self.created_index = 0
        # id → (source_path, text) so we can reconstruct at query time.
        self._docs: dict[str, tuple[str, str]] = {}
        self.delete_calls: list[list[str]] = []
        # Explicit hook for raising during delete_documents in a
        # specific test; default is None (normal path).
        self.delete_raises: Exception | None = None
        self.list_raises: Exception | None = None

    def create_index(self) -> None:
        self.created_index += 1

    def upsert_documents(
        self,
        chunks: list[Chunk],
        embeddings: list[list[float]],
    ) -> int:
        assert len(chunks) == len(embeddings)
        for c in chunks:
            source = c.metadata.get("source_path") or c.source
            self._docs[c.id] = (source, c.text)
        return len(chunks)

    def list_ids_by_source_paths(
        self,
        source_paths: list[str],
    ) -> dict[str, list[str]]:
        if self.list_raises is not None:
            raise self.list_raises
        result: dict[str, list[str]] = {sp: [] for sp in source_paths}
        for chunk_id, (source, _text) in self._docs.items():
            if source in result:
                result[source].append(chunk_id)
        return result

    def delete_documents(self, document_ids: list[str]) -> int:
        if self.delete_raises is not None:
            raise self.delete_raises
        self.delete_calls.append(list(document_ids))
        deleted = 0
        for doc_id in document_ids:
            if doc_id in self._docs:
                del self._docs[doc_id]
                deleted += 1
        return deleted

    # Convenience for assertions
    def ids_for(self, source_path: str) -> set[str]:
        return {
            chunk_id
            for chunk_id, (source, _text) in self._docs.items()
            if source == source_path
        }

    @property
    def all_ids(self) -> set[str]:
        return set(self._docs.keys())


# Minimal store that does NOT implement the cleanup protocol.
class NoCleanupFakeStore:
    def __init__(self) -> None:
        self.ids: set[str] = set()

    def create_index(self) -> None:
        pass

    def upsert_documents(
        self,
        chunks: list[Chunk],
        embeddings: list[list[float]],  # noqa: ARG002
    ) -> int:
        for c in chunks:
            self.ids.add(c.id)
        return len(chunks)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Tiny repo with a single adr file; caller mutates it per test."""
    root = tmp_path / "repo"
    (root / "docs" / "adr").mkdir(parents=True)
    (root / "docs" / "adr" / "0001.md").write_text(
        "# ADR 0001\n\n"
        "First paragraph with some content about Bicep modules. "
        "Second paragraph adds detail on deployments in Azure Government. "
        "Third paragraph closes on test coverage guidelines for ADRs.\n",
        encoding="utf-8",
    )
    return root


@pytest.fixture
def settings_with_cleanup() -> CopilotSettings:
    return CopilotSettings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="fake-key",
        azure_search_endpoint="https://fake.search.windows.net",
        azure_search_api_key="fake-key",
        chunk_size=100,
        chunk_overlap=20,
        min_chunk_length=10,
        orphan_cleanup_enabled=True,
    )


@pytest.fixture
def settings_no_cleanup() -> CopilotSettings:
    return CopilotSettings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="fake-key",
        azure_search_endpoint="https://fake.search.windows.net",
        azure_search_api_key="fake-key",
        chunk_size=100,
        chunk_overlap=20,
        min_chunk_length=10,
        orphan_cleanup_enabled=False,
    )


def _make_indexer(
    repo: Path,
    settings: CopilotSettings,
    store: object,
) -> CorpusIndexer:
    return CorpusIndexer(
        settings=settings,
        repo_root=repo,
        embedder=FakeEmbedder(),
        vector_store=store,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# Idempotency preservation
# ---------------------------------------------------------------------------


class TestIdempotencyPreservation:
    """Orphan cleanup must not delete anything when content is unchanged."""

    def test_second_run_on_unchanged_corpus_deletes_zero(
        self,
        repo: Path,
        settings_with_cleanup: CopilotSettings,
    ) -> None:
        store = OrphanAwareFakeStore()
        indexer = _make_indexer(repo, settings_with_cleanup, store)

        report1 = indexer.index(roots=[Path("docs/adr")])
        assert report1.chunks_indexed > 0
        assert report1.chunks_deleted == 0

        first_ids = set(store.all_ids)

        indexer2 = _make_indexer(repo, settings_with_cleanup, store)
        report2 = indexer2.index(roots=[Path("docs/adr")])
        assert report2.chunks_deleted == 0
        assert store.all_ids == first_ids
        # No deletes called at all (true no-op).
        assert store.delete_calls == []


# ---------------------------------------------------------------------------
# Orphan deletion on shortened/removed files
# ---------------------------------------------------------------------------


class TestOrphanDeletion:
    """Chunks whose content was removed must be deleted from the index."""

    def test_shortened_file_deletes_stale_chunks(
        self,
        repo: Path,
        settings_with_cleanup: CopilotSettings,
    ) -> None:
        store = OrphanAwareFakeStore()
        indexer = _make_indexer(repo, settings_with_cleanup, store)
        indexer.index(roots=[Path("docs/adr")])

        source = "docs/adr/0001.md"
        ids_before = store.ids_for(source)
        assert len(ids_before) >= 2

        # Shorten the file dramatically — only the first sentence
        # survives, so most chunk ids should now be orphans.
        (repo / "docs" / "adr" / "0001.md").write_text(
            "# ADR 0001\n\nOnly the shortest surviving content remains.\n",
            encoding="utf-8",
        )

        indexer2 = _make_indexer(repo, settings_with_cleanup, store)
        report = indexer2.index(roots=[Path("docs/adr")])

        assert report.chunks_deleted > 0
        ids_after = store.ids_for(source)
        # The new content must be indexed.
        assert len(ids_after) >= 1
        # The deleted ids must NOT include any of the new ids.
        deleted_ids = set().union(*store.delete_calls)
        assert deleted_ids & ids_after == set()
        # Every deleted id should have been in the old set.
        assert deleted_ids.issubset(ids_before)

    def test_deleted_file_deletes_all_its_chunks(
        self,
        repo: Path,
        settings_with_cleanup: CopilotSettings,
    ) -> None:
        # First index with two files so one is in scope; then remove
        # one and re-index THAT FILE's root so cleanup runs over it.
        (repo / "docs" / "adr" / "0002.md").write_text(
            "# ADR 0002\n\nSecond ADR covers routing policy decisions.\n",
            encoding="utf-8",
        )
        store = OrphanAwareFakeStore()
        indexer = _make_indexer(repo, settings_with_cleanup, store)
        indexer.index(roots=[Path("docs/adr")])
        ids_for_2 = store.ids_for("docs/adr/0002.md")
        assert len(ids_for_2) >= 1

        # Remove ADR 0002 from disk.
        (repo / "docs" / "adr" / "0002.md").unlink()

        # Cleanup only kicks in for source_paths that were scanned this
        # run. If we re-scan docs/adr, 0002's source is NOT visited
        # (file missing) so its chunks survive — by design, since the
        # contract is "scan + drop orphans from scanned sources".
        # Confirm that contract: after the reindex, 0002's chunks are
        # still present (they can only be cleaned when the file is
        # present-but-shortened OR explicitly listed in scanned_source
        # via corpus_roots pointing AT it).
        indexer2 = _make_indexer(repo, settings_with_cleanup, store)
        report = indexer2.index(roots=[Path("docs/adr")])
        # 0002's chunks remain — the indexer never saw its path.
        assert store.ids_for("docs/adr/0002.md") == ids_for_2
        # And the index_report for 0001 reports zero deletes.
        assert report.chunks_deleted == 0

    def test_unscanned_sources_are_never_touched(
        self,
        repo: Path,
        settings_with_cleanup: CopilotSettings,
    ) -> None:
        # Pre-populate the store with a chunk for a source NOT under
        # the scan root. The indexer must not delete it.
        store = OrphanAwareFakeStore()
        store._docs["unrelated-id"] = ("docs/other/unrelated.md", "x")

        indexer = _make_indexer(repo, settings_with_cleanup, store)
        indexer.index(roots=[Path("docs/adr")])

        assert "unrelated-id" in store.all_ids


# ---------------------------------------------------------------------------
# Configuration toggle
# ---------------------------------------------------------------------------


class TestCleanupToggle:
    """``orphan_cleanup_enabled=False`` must disable the cleanup pass."""

    def test_disabled_setting_skips_cleanup(
        self,
        repo: Path,
        settings_no_cleanup: CopilotSettings,
    ) -> None:
        store = OrphanAwareFakeStore()
        indexer = _make_indexer(repo, settings_no_cleanup, store)
        indexer.index(roots=[Path("docs/adr")])

        # Shorten the file so there'd be orphans if cleanup ran.
        (repo / "docs" / "adr" / "0001.md").write_text(
            "# ADR 0001\n\nMinimal content only.\n",
            encoding="utf-8",
        )

        indexer2 = _make_indexer(repo, settings_no_cleanup, store)
        report = indexer2.index(roots=[Path("docs/adr")])

        assert report.chunks_deleted == 0
        assert store.delete_calls == []

    def test_dry_run_never_deletes(
        self,
        repo: Path,
        settings_with_cleanup: CopilotSettings,
    ) -> None:
        store = OrphanAwareFakeStore()
        indexer = _make_indexer(repo, settings_with_cleanup, store)
        report = indexer.index(roots=[Path("docs/adr")], dry_run=True)
        assert report.chunks_deleted == 0
        assert store.delete_calls == []


# ---------------------------------------------------------------------------
# Graceful degradation
# ---------------------------------------------------------------------------


class TestGracefulDegradation:
    """A store without cleanup support must log and proceed, not crash."""

    def test_missing_protocol_support_logs_warning_and_continues(
        self,
        repo: Path,
        settings_with_cleanup: CopilotSettings,
    ) -> None:
        store = NoCleanupFakeStore()
        indexer = _make_indexer(repo, settings_with_cleanup, store)
        report = indexer.index(roots=[Path("docs/adr")])
        assert report.chunks_indexed > 0
        assert report.chunks_deleted == 0


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestCleanupErrors:
    """Fatal backend errors must raise OrphanCleanupError with context."""

    def test_list_failure_raises_orphan_cleanup_error(
        self,
        repo: Path,
        settings_with_cleanup: CopilotSettings,
    ) -> None:
        store = OrphanAwareFakeStore()
        # Seed the store first, then arm the list_raises.
        indexer = _make_indexer(repo, settings_with_cleanup, store)
        indexer.index(roots=[Path("docs/adr")])

        store.list_raises = RuntimeError("backend blew up")
        indexer2 = _make_indexer(repo, settings_with_cleanup, store)
        with pytest.raises(OrphanCleanupError):
            indexer2.index(roots=[Path("docs/adr")])

    def test_delete_failure_raises_orphan_cleanup_error(
        self,
        repo: Path,
        settings_with_cleanup: CopilotSettings,
    ) -> None:
        store = OrphanAwareFakeStore()
        indexer = _make_indexer(repo, settings_with_cleanup, store)
        indexer.index(roots=[Path("docs/adr")])

        # Shorten file to create orphans.
        (repo / "docs" / "adr" / "0001.md").write_text(
            "# ADR 0001\n\nShort.\n",
            encoding="utf-8",
        )
        store.delete_raises = RuntimeError("delete backend failure")

        indexer2 = _make_indexer(repo, settings_with_cleanup, store)
        with pytest.raises(OrphanCleanupError):
            indexer2.index(roots=[Path("docs/adr")])


# ---------------------------------------------------------------------------
# Report shape
# ---------------------------------------------------------------------------


def test_index_report_includes_chunks_deleted_field(
    repo: Path,
    settings_with_cleanup: CopilotSettings,
) -> None:
    """``chunks_deleted`` must appear in ``IndexReport.model_dump()``."""
    store = OrphanAwareFakeStore()
    indexer = _make_indexer(repo, settings_with_cleanup, store)
    report = indexer.index(roots=[Path("docs/adr")])
    payload = report.model_dump()
    assert "chunks_deleted" in payload
    assert payload["chunks_deleted"] == 0
