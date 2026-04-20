"""Corpus indexer (Phase 0 of CSA-0008).

Walks a configurable set of repo roots, chunks the matched files using
the existing :class:`csa_platform.ai_integration.rag.pipeline.DocumentChunker`,
embeds the chunks with :class:`EmbeddingGenerator`, and upserts them
into :class:`VectorStore` with Copilot-specific metadata.

Idempotency
-----------

Each chunk's id is derived from a SHA-256 hash of its *normalised text*
(``chunk_id = sha256(text.strip())[:24]``).  Re-running the indexer on
unchanged content therefore produces the same ids and Azure AI Search's
upsert is a no-op — the report marks those chunks as
``chunks_skipped``.  A content change yields a new id, so the old
chunks remain in the index until explicitly cleaned up.  (Orphan
cleanup is deferred to a future phase; it requires a scan-and-delete
pass that wasn't in the CSA-0008 scope.)

Metadata attached to every chunk
--------------------------------

* ``source_path``      — repo-relative path of the source file.
* ``doc_type``         — one of the :data:`apps.copilot.models.DocType` values.
* ``title``            — the first ``#`` heading, or the filename stem.
* ``last_modified_utc``— ``os.stat`` mtime, ISO-8601 ``Z``.
* ``chunk_index``      — zero-based position within the source file.
* ``content_hash``     — full SHA-256 of the normalised chunk text.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from apps.copilot.config import CopilotSettings
from apps.copilot.models import DocType, IndexReport
from csa_platform.ai_integration.rag.pipeline import (
    Chunk,
    DocumentChunker,
    EmbeddingGenerator,
    VectorStore,
)
from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Doc type classifier
# ---------------------------------------------------------------------------


_DOC_TYPE_PREFIXES: tuple[tuple[str, DocType], ...] = (
    ("docs/adr", "adr"),
    ("docs/decisions", "decision"),
    ("docs/migrations", "migration"),
    ("docs/compliance", "compliance"),
    ("docs/runbooks", "runbook"),
    ("examples", "example"),
)
"""Longest-prefix-first match table.  ``docs/`` overview files fall
through to the ``overview`` bucket below.  Top-level ``README.md`` and
``ARCHITECTURE.md`` also map to ``overview``.
"""


def infer_doc_type(relative_path: Path | str) -> DocType:
    """Classify *relative_path* into a :data:`DocType` bucket.

    Matching is done on the POSIX-normalised string form so the result
    is identical on Windows and Unix.

    Args:
        relative_path: Path relative to the repo root.  Absolute paths
            are also accepted but the repo-root prefix is not stripped —
            callers should normalise first.

    Returns:
        A :data:`DocType` literal.  ``"unknown"`` is returned for paths
        that match none of the prefixes.
    """
    posix = Path(relative_path).as_posix().lstrip("./")

    for prefix, doc_type in _DOC_TYPE_PREFIXES:
        if posix == prefix or posix.startswith(prefix + "/"):
            return doc_type

    # Top-level overview documents.
    if posix in {"README.md", "ARCHITECTURE.md"}:
        return "overview"
    if posix.startswith("docs/") and "/" not in posix[len("docs/") :]:
        # Flat docs/*.md files are overview guides.
        return "overview"

    return "unknown"


def _extract_title(text: str, fallback: str) -> str:
    """Pull the first Markdown ``#`` heading, else fall back to a stem."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("# ").strip() or fallback
        if stripped:
            # Non-heading non-empty line: no explicit title, use fallback.
            break
    return fallback


# ---------------------------------------------------------------------------
# Vector store protocol (for testability)
# ---------------------------------------------------------------------------


class SupportsUpsert(Protocol):
    """Minimal protocol the indexer needs from a vector store.

    Defined to decouple the indexer from the concrete
    :class:`csa_platform.ai_integration.rag.pipeline.VectorStore` during
    tests — the test suite injects a stub that implements the two
    methods without touching Azure.
    """

    def create_index(self) -> None: ...

    def upsert_documents(self, chunks: list[Chunk], embeddings: list[list[float]]) -> int: ...


class SupportsEmbed(Protocol):
    """Minimal protocol the indexer needs from an embedder."""

    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...


# ---------------------------------------------------------------------------
# Corpus walker
# ---------------------------------------------------------------------------


def iter_corpus_files(
    repo_root: Path,
    roots: Iterable[str],
    extensions: Iterable[str],
) -> Iterable[Path]:
    """Yield every corpus file beneath the configured roots.

    Files are de-duplicated by absolute path, yielded in a stable sorted
    order so the indexer is deterministic across runs.

    Args:
        repo_root: Absolute path to the repository root.
        roots: Repo-relative path fragments.  Each may be a directory
            (recursively walked) or a single file.
        extensions: File extensions to include (case-insensitive,
            include the leading dot, e.g. ``".md"``).
    """
    ext_lower = {e.lower() for e in extensions}
    seen: set[Path] = set()
    collected: list[Path] = []

    for root in roots:
        candidate = (repo_root / root).resolve()
        if not candidate.exists():
            logger.debug("copilot.indexer.root_missing", root=str(candidate))
            continue

        if candidate.is_file():
            if candidate.suffix.lower() in ext_lower and candidate not in seen:
                seen.add(candidate)
                collected.append(candidate)
            continue

        for path in candidate.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in ext_lower:
                continue
            if path in seen:
                continue
            seen.add(path)
            collected.append(path)

    collected.sort()
    yield from collected


# ---------------------------------------------------------------------------
# Corpus indexer
# ---------------------------------------------------------------------------


class CorpusIndexer:
    """Phase 0 orchestrator: walk → chunk → embed → upsert.

    The indexer is designed to be re-run as part of a CI step or a
    scheduled job.  Idempotency is provided by content-addressable
    chunk ids — see the module docstring.
    """

    def __init__(
        self,
        settings: CopilotSettings,
        *,
        repo_root: Path | None = None,
        chunker: DocumentChunker | None = None,
        embedder: SupportsEmbed | None = None,
        vector_store: SupportsUpsert | None = None,
    ) -> None:
        self.settings = settings
        self.repo_root = (repo_root or Path.cwd()).resolve()
        self.chunker = chunker or DocumentChunker(
            chunk_size=settings.chunk_size,
            chunk_overlap=settings.chunk_overlap,
            min_chunk_length=settings.min_chunk_length,
            split_strategy="sentence",
        )
        self.embedder = embedder or self._build_embedder(settings)
        self.vector_store = vector_store or self._build_vector_store(settings)

        # Idempotency cache: chunk ids we have already upserted in this
        # run. Re-chunking the same file multiple times in one run (for
        # whatever reason) must not double-count.
        self._seen_ids: set[str] = set()

    # -- factory helpers -----------------------------------------------------

    @staticmethod
    def _build_embedder(settings: CopilotSettings) -> EmbeddingGenerator:
        """Instantiate the default Azure OpenAI embedder."""
        use_key = bool(settings.azure_openai_api_key) and not settings.azure_openai_use_aad
        return EmbeddingGenerator(
            endpoint=settings.azure_openai_endpoint,
            api_key=settings.azure_openai_api_key if use_key else "",
            deployment=settings.azure_openai_embed_deployment,
            api_version=settings.azure_openai_api_version,
            dimensions=settings.azure_openai_embed_dimensions,
        )

    @staticmethod
    def _build_vector_store(settings: CopilotSettings) -> VectorStore:
        """Instantiate the default Azure AI Search vector store."""
        use_key = bool(settings.azure_search_api_key) and not settings.azure_search_use_aad
        return VectorStore(
            endpoint=settings.azure_search_endpoint,
            api_key=settings.azure_search_api_key if use_key else "",
            index_name=settings.azure_search_index_name,
            embedding_dimensions=settings.azure_openai_embed_dimensions,
        )

    # -- public API ----------------------------------------------------------

    def index(
        self,
        roots: list[Path] | None = None,
        *,
        dry_run: bool = False,
        ensure_index: bool = True,
    ) -> IndexReport:
        """Run the indexer.

        Args:
            roots: Optional override for the configured corpus roots.
                Paths may be absolute or repo-relative.
            dry_run: If ``True``, chunk and embed nothing and skip the
                upsert step.  Useful for validating the walker + doc
                type classifier.
            ensure_index: If ``True`` (default), call
                ``vector_store.create_index()`` before upserting.

        Returns:
            An :class:`IndexReport` summarising the run.
        """
        start = time.perf_counter()

        resolved_roots: list[str] = []
        if roots is None:
            resolved_roots = list(self.settings.corpus_roots)
        else:
            for r in roots:
                as_path = Path(r)
                if as_path.is_absolute():
                    try:
                        resolved_roots.append(str(as_path.relative_to(self.repo_root)))
                    except ValueError:
                        # Outside the repo root: keep the absolute form
                        # so the walker can still visit it.
                        resolved_roots.append(str(as_path))
                else:
                    resolved_roots.append(str(as_path))

        if ensure_index and not dry_run:
            self.vector_store.create_index()

        files_scanned = 0
        chunks_indexed = 0
        chunks_skipped = 0
        bytes_embedded = 0
        doc_type_counts: dict[DocType, int] = {}

        for file_path in iter_corpus_files(
            self.repo_root,
            resolved_roots,
            self.settings.corpus_file_extensions,
        ):
            files_scanned += 1
            try:
                file_chunks = self._build_chunks(file_path)
            except Exception:
                logger.exception(
                    "copilot.indexer.file_read_failed",
                    path=str(file_path),
                )
                continue

            # De-dupe within the run, then within Azure Search by id.
            new_chunks = [c for c in file_chunks if c.id not in self._seen_ids]
            duplicate_skips = len(file_chunks) - len(new_chunks)
            chunks_skipped += duplicate_skips

            if not new_chunks:
                logger.debug(
                    "copilot.indexer.file_no_new_chunks",
                    path=str(file_path),
                    total=len(file_chunks),
                )
                continue

            for c in new_chunks:
                self._seen_ids.add(c.id)

            if dry_run:
                chunks_indexed += len(new_chunks)
                for c in new_chunks:
                    dt: DocType = c.metadata.get("doc_type", "unknown")
                    doc_type_counts[dt] = doc_type_counts.get(dt, 0) + 1
                    bytes_embedded += len(c.text.encode("utf-8"))
                continue

            texts = [c.text for c in new_chunks]
            embeddings = self.embedder.embed_texts(texts)
            uploaded = self.vector_store.upsert_documents(new_chunks, embeddings)

            chunks_indexed += uploaded
            for c, t in zip(new_chunks, texts, strict=True):
                dt2: DocType = c.metadata.get("doc_type", "unknown")
                doc_type_counts[dt2] = doc_type_counts.get(dt2, 0) + 1
                bytes_embedded += len(t.encode("utf-8"))

        elapsed = time.perf_counter() - start
        report = IndexReport(
            files_scanned=files_scanned,
            chunks_indexed=chunks_indexed,
            chunks_skipped=chunks_skipped,
            bytes_embedded=bytes_embedded,
            elapsed_seconds=round(elapsed, 4),
            doc_type_counts=doc_type_counts,
        )
        logger.info(
            "copilot.indexer.completed",
            files=files_scanned,
            indexed=chunks_indexed,
            skipped=chunks_skipped,
            elapsed=elapsed,
            dry_run=dry_run,
        )
        return report

    # -- internals -----------------------------------------------------------

    def _build_chunks(self, file_path: Path) -> list[Chunk]:
        """Read *file_path*, split into chunks, and attach metadata."""
        text = file_path.read_text(encoding="utf-8")
        rel = self._relative_path(file_path)
        doc_type = infer_doc_type(rel)
        title = _extract_title(text, fallback=file_path.stem)

        mtime_iso = _format_mtime_utc(file_path)

        file_metadata: dict[str, Any] = {
            "source_path": rel,
            "doc_type": doc_type,
            "title": title,
            "last_modified_utc": mtime_iso,
        }

        raw_chunks = self.chunker.chunk_text(text, source=rel, metadata=file_metadata)

        # Rewrite ids to be content-addressable so re-indexing unchanged
        # content is a true no-op in Azure AI Search.
        rebuilt: list[Chunk] = []
        for c in raw_chunks:
            content_hash = hashlib.sha256(c.text.strip().encode("utf-8")).hexdigest()
            new_id = content_hash[:24]
            rebuilt.append(
                Chunk(
                    id=new_id,
                    text=c.text,
                    source=rel,
                    metadata={**c.metadata, "content_hash": content_hash},
                    chunk_index=c.chunk_index,
                ),
            )
        return rebuilt

    def _relative_path(self, path: Path) -> str:
        """Return *path* relative to the repo root, POSIX style."""
        try:
            rel = path.resolve().relative_to(self.repo_root)
        except ValueError:
            return path.as_posix()
        return rel.as_posix()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _format_mtime_utc(path: Path) -> str:
    """Return the file mtime as an ISO-8601 UTC string (``...Z``)."""
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")


__all__ = [
    "CorpusIndexer",
    "SupportsEmbed",
    "SupportsUpsert",
    "infer_doc_type",
    "iter_corpus_files",
]
