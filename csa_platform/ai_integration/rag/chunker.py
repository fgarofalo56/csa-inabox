"""Document chunking for the RAG pipeline (CSA-0133).

Pure-logic component — no Azure SDKs, no network I/O.  The
:class:`Chunk` dataclass intentionally stays a mutable dataclass
(not a frozen Pydantic model) because upstream tests construct and
mutate chunks directly.

CSA-0097 extends the file-dispatch path with PDF and DOCX loaders
(see :mod:`.loaders`).  CSA-0099 adds optional ``section_anchor``
capture so citations can point at (for example) a Markdown ``#setup``
heading or a PDF ``Page 3``.  The anchor is derived per-segment at
chunk time — for Markdown this is the nearest preceding heading, for
PDF/DOCX this is the structural boundary emitted by the loader
(``Page N``, ``Heading: ...``).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Markdown heading anchor helpers (CSA-0099)
# ---------------------------------------------------------------------------

_MD_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$", re.MULTILINE)
_ANCHOR_SANITIZE_RE = re.compile(r"[^a-z0-9\-_]+")


def _slugify_heading(text: str) -> str:
    """Produce a GitHub-style ``#anchor`` slug for a Markdown heading."""
    lowered = text.strip().lower()
    # Collapse whitespace to single hyphens, drop non-alnum except ``-``/``_``.
    collapsed = re.sub(r"\s+", "-", lowered)
    sanitized = _ANCHOR_SANITIZE_RE.sub("", collapsed)
    return f"#{sanitized}" if sanitized else ""


@dataclass
class Chunk:
    """A single chunk of text extracted from a document.

    ``section_anchor`` is optional and identifies a sub-document region
    (e.g. ``#setup`` for a Markdown H2 or ``Page 3`` for a PDF page).
    Consumers that want file:section citations should surface it via
    :attr:`csa_platform.ai_integration.rag.models.Citation.section_anchor`.
    """

    id: str
    text: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)
    chunk_index: int = 0
    section_anchor: str | None = None


class DocumentChunker:
    """Split documents into overlapping chunks for embedding.

    Args:
        chunk_size: Target characters per chunk.
        chunk_overlap: Overlap characters between consecutive chunks.
        min_chunk_length: Minimum character length to retain a chunk.
        split_strategy: ``"sentence"``, ``"paragraph"``, or ``"token"``.
    """

    _SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
    _PARAGRAPH_RE = re.compile(r"\n\s*\n")

    def __init__(
        self,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        min_chunk_length: int = 50,
        split_strategy: str = "sentence",
    ) -> None:
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be less than chunk_size")
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.min_chunk_length = min_chunk_length
        self.split_strategy = split_strategy

    # -- public API ---------------------------------------------------------

    def chunk_text(
        self,
        text: str,
        source: str = "",
        metadata: dict[str, Any] | None = None,
        *,
        is_markdown: bool | None = None,
    ) -> list[Chunk]:
        """Split *text* into :class:`Chunk` objects with deterministic IDs.

        When *is_markdown* is ``True`` (or auto-detected from ``source``'s
        ``.md`` / ``.markdown`` extension) the chunker captures the nearest
        preceding heading as :attr:`Chunk.section_anchor` so downstream
        citations can point at ``file.md#setup`` style anchors (CSA-0099).
        """
        metadata = metadata or {}
        segments = self._split(text)
        chunks = self._merge_segments(segments)

        # Build a (char-offset -> anchor) table for Markdown inputs so we
        # can attribute each chunk to its enclosing heading without another
        # full-text scan per chunk.
        anchors = self._build_markdown_anchor_index(text, source, is_markdown)

        result: list[Chunk] = []
        for idx, chunk_text in enumerate(chunks):
            stripped = chunk_text.strip()
            if len(stripped) < self.min_chunk_length:
                continue
            anchor = self._anchor_for_chunk(text, stripped, anchors)
            # Prefer an explicit metadata-supplied anchor (PDF/DOCX loaders
            # pass it via ``metadata['section_anchor']``) so loader-emitted
            # structure wins over post-hoc detection.
            loader_anchor = metadata.get("section_anchor")
            effective_anchor = loader_anchor if loader_anchor else anchor
            chunk_metadata: dict[str, Any] = {**metadata, "chunk_index": idx}
            if effective_anchor:
                chunk_metadata["section_anchor"] = effective_anchor
            result.append(
                Chunk(
                    id=self._make_id(source, idx),
                    text=stripped,
                    source=source,
                    metadata=chunk_metadata,
                    chunk_index=idx,
                    section_anchor=effective_anchor or None,
                )
            )
        return result

    def chunk_file(self, path: Path, metadata: dict[str, Any] | None = None) -> list[Chunk]:
        """Read *path* and chunk its contents, attaching file metadata.

        Dispatches to the PDF / DOCX loaders in :mod:`.loaders` based on
        the file extension (CSA-0097).  When neither matches, falls back
        to UTF-8 text read + :meth:`chunk_text` with markdown-anchor
        detection enabled for ``.md`` / ``.markdown`` files.
        """
        suffix = path.suffix.lower()
        file_meta: dict[str, Any] = {
            "filename": path.name,
            "file_extension": path.suffix,
            **(metadata or {}),
        }

        if suffix == ".pdf":
            from .loaders import load_pdf

            return self._chunks_from_loader_segments(
                load_pdf(path), source=str(path), metadata=file_meta
            )
        if suffix in {".docx"}:
            from .loaders import load_docx

            return self._chunks_from_loader_segments(
                load_docx(path), source=str(path), metadata=file_meta
            )

        text = path.read_text(encoding="utf-8")
        is_markdown = suffix in {".md", ".markdown"}
        return self.chunk_text(
            text, source=str(path), metadata=file_meta, is_markdown=is_markdown
        )

    def _chunks_from_loader_segments(
        self,
        segments: list[tuple[str, str | None]],
        *,
        source: str,
        metadata: dict[str, Any],
    ) -> list[Chunk]:
        """Build chunks from loader-emitted ``(text, section_anchor)`` pairs.

        Each loader segment (a PDF page or DOCX heading section) is run
        through :meth:`chunk_text` so chunk sizing matches the Markdown
        path; ``section_anchor`` is carried into every resulting chunk
        via the metadata hand-off recognised by :meth:`chunk_text`.
        """
        all_chunks: list[Chunk] = []
        for segment_idx, (segment_text, anchor) in enumerate(segments):
            if not segment_text.strip():
                continue
            segment_meta = dict(metadata)
            if anchor:
                segment_meta["section_anchor"] = anchor
            chunks = self.chunk_text(
                segment_text,
                source=f"{source}#seg{segment_idx}",
                metadata=segment_meta,
                is_markdown=False,
            )
            # Rewrite id + source so the segment-level identity collapses back
            # onto the file-level source, but keep the segment-unique index.
            for c in chunks:
                c.source = source
                c.metadata["chunk_index"] = len(all_chunks)
                c.chunk_index = len(all_chunks)
                c.id = self._make_id(source, len(all_chunks))
                all_chunks.append(c)
        return all_chunks

    # -- internals ----------------------------------------------------------

    def _split(self, text: str) -> list[str]:
        if self.split_strategy == "paragraph":
            return [p.strip() for p in self._PARAGRAPH_RE.split(text) if p.strip()]
        if self.split_strategy == "sentence":
            return [s.strip() for s in self._SENTENCE_RE.split(text) if s.strip()]
        return text.split()  # token

    def _merge_segments(self, segments: list[str]) -> list[str]:
        if self.split_strategy == "token":
            return self._merge_tokens(segments)
        return self._merge_text_segments(segments)

    def _merge_text_segments(self, segments: list[str]) -> list[str]:
        chunks: list[str] = []
        current: list[str] = []
        current_len = 0

        for segment in segments:
            seg_len = len(segment)
            if current_len + seg_len > self.chunk_size and current:
                chunks.append(" ".join(current))
                # Walk backwards to keep overlap within the configured budget.
                overlap_parts: list[str] = []
                overlap_len = 0
                for prev_seg in reversed(current):
                    if overlap_len + len(prev_seg) > self.chunk_overlap:
                        break
                    overlap_parts.insert(0, prev_seg)
                    overlap_len += len(prev_seg)
                current = overlap_parts
                current_len = overlap_len
            current.append(segment)
            current_len += seg_len

        if current:
            chunks.append(" ".join(current))
        return chunks

    def _merge_tokens(self, words: list[str]) -> list[str]:
        chunks: list[str] = []
        step = max(1, self.chunk_size - self.chunk_overlap)
        for i in range(0, len(words), step):
            chunks.append(" ".join(words[i : i + self.chunk_size]))
        return chunks

    @staticmethod
    def _make_id(source: str, index: int) -> str:
        """Deterministic SHA-256-truncated chunk ID from source + index."""
        return hashlib.sha256(f"{source}:{index}".encode()).hexdigest()[:16]

    # -- markdown anchor detection (CSA-0099) -------------------------------

    @staticmethod
    def _build_markdown_anchor_index(
        text: str, source: str, is_markdown: bool | None
    ) -> list[tuple[int, str]] | None:
        """Return a sorted list of ``(char_offset, anchor)`` boundaries.

        ``None`` is returned when the input is not Markdown — callers
        should then skip per-chunk anchor attribution.  ``is_markdown``
        takes precedence over the ``source`` heuristic so tests and
        programmatic callers can force-enable/disable detection.
        """
        if is_markdown is False:
            return None
        if is_markdown is None:
            lowered = source.lower()
            if not lowered.endswith((".md", ".markdown")):
                return None
        boundaries: list[tuple[int, str]] = []
        for match in _MD_HEADING_RE.finditer(text):
            slug = _slugify_heading(match.group(2))
            if slug:
                boundaries.append((match.start(), slug))
        return boundaries

    @staticmethod
    def _anchor_for_chunk(
        source_text: str, chunk_text: str, anchors: list[tuple[int, str]] | None
    ) -> str:
        """Return the most recent anchor at or before *chunk_text*'s offset."""
        if not anchors:
            return ""
        offset = source_text.find(chunk_text[:80]) if chunk_text else -1
        if offset < 0:
            return ""
        selected = ""
        for start, anchor in anchors:
            if start <= offset:
                selected = anchor
            else:
                break
        return selected


__all__ = ["Chunk", "DocumentChunker"]
