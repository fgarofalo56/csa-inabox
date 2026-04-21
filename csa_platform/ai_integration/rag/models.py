"""Shared DTOs for the RAG pipeline (CSA-0133).

All models are ``frozen`` so responses are safe across async
boundaries (routers, background workers, caches).  These types form
the public contract for
:class:`csa_platform.ai_integration.rag.service.RAGService`.

These are *distinct* from the similarly-named types in
:mod:`apps.copilot.models`, which add refusal semantics and
citation-verification state. Callers that need the refusal contract
should layer :class:`apps.copilot.agent.CopilotAgent` on top of
:class:`RAGService`.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Citation(BaseModel):
    """A citation attached to a RAG :class:`AnswerResponse`.

    ``section_anchor`` is optional (CSA-0099) and identifies the
    sub-document region that the cited chunk belongs to — for Markdown
    this is a GitHub-style ``#heading-slug``, for PDFs it is ``Page N``,
    and for DOCX files it is ``Heading: <title>``.  When unset the
    citation still renders (file-level), but clients that want
    file:section links should surface it when present.
    """

    id: str = Field(description="Underlying chunk id in the vector store.")
    source: str = Field(description="Source path or URL of the cited chunk.")
    score: float = Field(description="Retriever similarity score (unnormalised).")
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Free-form metadata attached to the chunk at ingest time.",
    )
    section_anchor: str | None = Field(
        default=None,
        description=(
            "Optional sub-document anchor for file:section citations. "
            "Markdown: '#heading-slug'; PDF: 'Page N'; DOCX: 'Heading: <name>'."
        ),
    )

    model_config = ConfigDict(frozen=True)


class ContextChunk(BaseModel):
    """A single context chunk included in the prompt sent to the LLM."""

    text: str = Field(description="Full chunk text as retrieved from the index.")
    source: str = Field(description="Source path or URL.")
    score: float = Field(description="Retriever similarity score.")

    model_config = ConfigDict(frozen=True)


class AnswerResponse(BaseModel):
    """Structured form of the legacy ``RAGPipeline.query`` dict."""

    answer: str = Field(description="LLM-generated answer text.")
    sources: list[Citation] = Field(
        default_factory=list,
        description="One entry per retrieved chunk that influenced the answer.",
    )
    context_chunks: list[ContextChunk] = Field(
        default_factory=list,
        description="The exact chunks concatenated into the user-side prompt.",
    )

    model_config = ConfigDict(frozen=True)

    def to_dict(self) -> dict[str, Any]:
        """Legacy ``{answer, sources, context_chunks}`` dict for pre-split callers.

        ``section_anchor`` (CSA-0099) is included in the source dict
        only when set, so existing consumers that do not expect the
        field continue to see the same shape they did before.
        """
        sources: list[dict[str, Any]] = []
        for c in self.sources:
            entry: dict[str, Any] = {
                "id": c.id,
                "source": c.source,
                "score": c.score,
                "metadata": dict(c.metadata),
            }
            if c.section_anchor is not None:
                entry["section_anchor"] = c.section_anchor
            sources.append(entry)
        return {
            "answer": self.answer,
            "sources": sources,
            "context_chunks": [
                {"text": c.text, "source": c.source, "score": c.score}
                for c in self.context_chunks
            ],
        }


class IndexReport(BaseModel):
    """Summary returned by :meth:`RAGService.ingest`."""

    files_scanned: int = Field(ge=0, description="Files visited during the ingest walk.")
    chunks_stored: int = Field(ge=0, description="Total chunks upserted into the vector store.")
    dry_run: bool = Field(default=False, description="True when ingest was run without writing.")

    model_config = ConfigDict(frozen=True)


__all__ = [
    "AnswerResponse",
    "Citation",
    "ContextChunk",
    "IndexReport",
]
