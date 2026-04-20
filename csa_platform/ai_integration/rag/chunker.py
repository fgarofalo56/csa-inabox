"""Document chunking for the RAG pipeline (CSA-0133).

Pure-logic component — no Azure SDKs, no network I/O.  The
:class:`Chunk` dataclass intentionally stays a mutable dataclass
(not a frozen Pydantic model) because upstream tests construct and
mutate chunks directly.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


@dataclass
class Chunk:
    """A single chunk of text extracted from a document."""

    id: str
    text: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)
    chunk_index: int = 0


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
        self, text: str, source: str = "", metadata: dict[str, Any] | None = None
    ) -> list[Chunk]:
        """Split *text* into :class:`Chunk` objects with deterministic IDs."""
        metadata = metadata or {}
        segments = self._split(text)
        chunks = self._merge_segments(segments)
        result: list[Chunk] = []
        for idx, chunk_text in enumerate(chunks):
            if len(chunk_text.strip()) < self.min_chunk_length:
                continue
            result.append(
                Chunk(
                    id=self._make_id(source, idx),
                    text=chunk_text.strip(),
                    source=source,
                    metadata={**metadata, "chunk_index": idx},
                    chunk_index=idx,
                )
            )
        return result

    def chunk_file(self, path: Path, metadata: dict[str, Any] | None = None) -> list[Chunk]:
        """Read *path* and chunk its contents, attaching file metadata."""
        text = path.read_text(encoding="utf-8")
        file_meta = {"filename": path.name, "file_extension": path.suffix, **(metadata or {})}
        return self.chunk_text(text, source=str(path), metadata=file_meta)

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


__all__ = ["Chunk", "DocumentChunker"]
