"""Standalone tests for :mod:`csa_platform.ai_integration.rag.chunker`.

The chunker is the one RAG component with no external deps, so these
tests cover pure logic without mocks.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from csa_platform.ai_integration.rag.chunker import Chunk, DocumentChunker


class TestChunkDataclass:
    def test_default_fields(self) -> None:
        chunk = Chunk(id="a", text="b", source="c")
        assert chunk.metadata == {}
        assert chunk.chunk_index == 0

    def test_explicit_fields(self) -> None:
        chunk = Chunk(id="x", text="y", source="z", metadata={"k": "v"}, chunk_index=5)
        assert chunk.metadata == {"k": "v"}
        assert chunk.chunk_index == 5


class TestDocumentChunker:
    def test_rejects_overlap_gte_size(self) -> None:
        with pytest.raises(ValueError, match="chunk_overlap must be less than chunk_size"):
            DocumentChunker(chunk_size=10, chunk_overlap=10)

    def test_sentence_strategy_default(self) -> None:
        chunker = DocumentChunker(chunk_size=200, min_chunk_length=5)
        chunks = chunker.chunk_text("One. Two. Three.", source="t.txt")
        assert len(chunks) == 1
        assert chunks[0].source == "t.txt"

    def test_paragraph_strategy_splits_on_blank_lines(self) -> None:
        chunker = DocumentChunker(
            chunk_size=10, chunk_overlap=2, min_chunk_length=5, split_strategy="paragraph"
        )
        text = "Paragraph one has text.\n\nParagraph two has text.\n\nParagraph three."
        chunks = chunker.chunk_text(text)
        assert len(chunks) >= 2

    def test_token_strategy_fixed_windows(self) -> None:
        chunker = DocumentChunker(
            chunk_size=5, chunk_overlap=2, min_chunk_length=5, split_strategy="token"
        )
        text = "one two three four five six seven eight nine ten"
        chunks = chunker.chunk_text(text)
        # With step=3 and 10 words we expect at least 3 chunks.
        assert len(chunks) >= 3

    def test_min_chunk_length_filter(self) -> None:
        chunker = DocumentChunker(min_chunk_length=1000)
        chunks = chunker.chunk_text("Tiny.")
        assert chunks == []

    def test_metadata_propagation(self) -> None:
        chunker = DocumentChunker(min_chunk_length=5)
        meta = {"author": "alice", "domain": "finance"}
        chunks = chunker.chunk_text("A long enough sentence here.", source="s", metadata=meta)
        assert chunks[0].metadata["author"] == "alice"
        assert chunks[0].metadata["domain"] == "finance"
        assert chunks[0].metadata["chunk_index"] == 0

    def test_deterministic_id(self) -> None:
        a = DocumentChunker._make_id("path.md", 3)
        b = DocumentChunker._make_id("path.md", 3)
        assert a == b
        assert a == hashlib.sha256(b"path.md:3").hexdigest()[:16]

    def test_chunk_file(self, tmp_path: Path) -> None:
        chunker = DocumentChunker(min_chunk_length=5)
        path = tmp_path / "doc.md"
        path.write_text("A meaningful sentence for ingest.", encoding="utf-8")
        chunks = chunker.chunk_file(path)
        assert chunks[0].metadata["filename"] == "doc.md"
        assert chunks[0].metadata["file_extension"] == ".md"
