"""Tests for CSA-0099 section_anchor capture + CSA-0097 chunker dispatch.

Covers:

* Markdown heading → ``Chunk.section_anchor`` and ``Citation.section_anchor``.
* PDF fixture → chunks carry ``Page N`` anchors.
* DOCX fixture → chunks carry ``Heading: <name>`` anchors.
* ``AnswerResponse.to_dict`` surfaces ``section_anchor`` when set and
  omits the key when unset.
"""

from __future__ import annotations

from pathlib import Path

from csa_platform.ai_integration.rag.chunker import (
    Chunk,
    DocumentChunker,
    _slugify_heading,
)
from csa_platform.ai_integration.rag.models import AnswerResponse, Citation

FIXTURES = Path(__file__).parent / "fixtures"


class TestSlugifyHeading:
    def test_basic_heading(self) -> None:
        assert _slugify_heading("Setup") == "#setup"

    def test_multiword_heading(self) -> None:
        assert _slugify_heading("Getting Started") == "#getting-started"

    def test_strips_punctuation(self) -> None:
        assert _slugify_heading("What's New?") == "#whats-new"

    def test_empty_heading_returns_empty(self) -> None:
        assert _slugify_heading("   ") == ""


class TestMarkdownChunkerAnchors:
    def test_captures_anchor_from_h1_when_extension_is_md(self) -> None:
        chunker = DocumentChunker(chunk_size=200, min_chunk_length=5)
        text = (
            "# Introduction\n"
            "Introduction paragraph with enough text to survive min_chunk_length.\n"
            "\n"
            "## Setup\n"
            "Setup paragraph with enough text to survive the min_chunk_length filter.\n"
        )
        chunks = chunker.chunk_text(text, source="docs/guide.md")
        anchors = {c.section_anchor for c in chunks}
        # Both an intro (#introduction) and a setup (#setup) anchor should
        # appear — at least one chunk each.
        assert "#introduction" in anchors or "#setup" in anchors

    def test_no_anchor_for_non_markdown_source(self) -> None:
        chunker = DocumentChunker(chunk_size=200, min_chunk_length=5)
        text = "# Heading\n\nSome text without markdown extension."
        chunks = chunker.chunk_text(text, source="docs/plain.txt")
        for c in chunks:
            assert c.section_anchor is None

    def test_explicit_is_markdown_flag_forces_detection(self) -> None:
        chunker = DocumentChunker(chunk_size=200, min_chunk_length=5)
        text = "# Overview\n\nParagraph with enough text here to count."
        chunks = chunker.chunk_text(
            text, source="docs/plain.txt", is_markdown=True
        )
        assert any(c.section_anchor == "#overview" for c in chunks)

    def test_chunk_metadata_reflects_anchor(self) -> None:
        chunker = DocumentChunker(chunk_size=200, min_chunk_length=5)
        text = "# Overview\n\nParagraph with enough text here to count."
        chunks = chunker.chunk_text(text, source="docs/g.md")
        assert chunks[0].metadata.get("section_anchor") == "#overview"

    def test_chunk_file_markdown_carries_anchor(self, tmp_path: Path) -> None:
        path = tmp_path / "guide.md"
        path.write_text(
            "# Setup\n\nSetup paragraph with enough text to survive.",
            encoding="utf-8",
        )
        chunker = DocumentChunker(min_chunk_length=5)
        chunks = chunker.chunk_file(path)
        assert chunks
        assert chunks[0].section_anchor == "#setup"


class TestPdfChunkerIntegration:
    def test_chunk_file_pdf_emits_page_anchors(self) -> None:
        chunker = DocumentChunker(chunk_size=400, chunk_overlap=20, min_chunk_length=5)
        chunks = chunker.chunk_file(FIXTURES / "sample.pdf")
        assert chunks
        anchors = {c.section_anchor for c in chunks}
        assert "Page 1" in anchors or "Page 2" in anchors
        # All chunks should carry a non-None anchor when sourced from PDF.
        assert all(c.section_anchor is not None for c in chunks)

    def test_pdf_chunks_share_file_source(self) -> None:
        chunker = DocumentChunker(chunk_size=400, chunk_overlap=20, min_chunk_length=5)
        chunks = chunker.chunk_file(FIXTURES / "sample.pdf")
        sources = {c.source for c in chunks}
        # Segment suffix should be stripped — source is the file path.
        assert all(str(FIXTURES / "sample.pdf") == s for s in sources)

    def test_pdf_chunk_indices_are_contiguous(self) -> None:
        chunker = DocumentChunker(chunk_size=400, chunk_overlap=20, min_chunk_length=5)
        chunks = chunker.chunk_file(FIXTURES / "sample.pdf")
        assert [c.chunk_index for c in chunks] == list(range(len(chunks)))


class TestDocxChunkerIntegration:
    def test_chunk_file_docx_emits_heading_anchors(self) -> None:
        chunker = DocumentChunker(chunk_size=400, chunk_overlap=20, min_chunk_length=5)
        chunks = chunker.chunk_file(FIXTURES / "sample.docx")
        assert chunks
        anchors = {c.section_anchor for c in chunks}
        # Should surface at least one heading anchor from the fixture.
        assert any(a and a.startswith("Heading: ") for a in anchors)

    def test_docx_chunks_share_file_source(self) -> None:
        chunker = DocumentChunker(chunk_size=400, chunk_overlap=20, min_chunk_length=5)
        chunks = chunker.chunk_file(FIXTURES / "sample.docx")
        sources = {c.source for c in chunks}
        assert all(str(FIXTURES / "sample.docx") == s for s in sources)


class TestCitationAnchor:
    def test_citation_accepts_section_anchor(self) -> None:
        cite = Citation(
            id="c1",
            source="docs/a.md",
            score=0.9,
            section_anchor="#setup",
        )
        assert cite.section_anchor == "#setup"

    def test_citation_default_is_none(self) -> None:
        cite = Citation(id="c1", source="docs/a.md", score=0.9)
        assert cite.section_anchor is None

    def test_citation_is_frozen(self) -> None:
        cite = Citation(id="c1", source="docs/a.md", score=0.9)
        import pytest

        with pytest.raises((TypeError, ValueError)):
            cite.section_anchor = "#mutated"

    def test_to_dict_includes_anchor_when_set(self) -> None:
        resp = AnswerResponse(
            answer="a",
            sources=[
                Citation(
                    id="c1",
                    source="docs/a.md",
                    score=0.9,
                    section_anchor="#setup",
                )
            ],
        )
        payload = resp.to_dict()
        assert payload["sources"][0]["section_anchor"] == "#setup"

    def test_to_dict_omits_anchor_when_unset(self) -> None:
        resp = AnswerResponse(
            answer="a",
            sources=[Citation(id="c1", source="docs/a.md", score=0.9)],
        )
        payload = resp.to_dict()
        assert "section_anchor" not in payload["sources"][0]


class TestChunkDataclassAnchor:
    def test_default_is_none(self) -> None:
        c = Chunk(id="x", text="y", source="z")
        assert c.section_anchor is None

    def test_explicit_anchor(self) -> None:
        c = Chunk(id="x", text="y", source="z", section_anchor="#intro")
        assert c.section_anchor == "#intro"
