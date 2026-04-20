"""Shared Pydantic types for the CSA Copilot.

Each type is ``frozen`` so responses are safe to pass across async
boundaries and cannot be mutated by downstream callers — the Copilot API
contract is value-semantic.

All scoring fields use floating-point similarity in ``[0.0, 1.0]``
(mapped from whatever upstream score space the retriever returns).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DocType = Literal[
    "adr",
    "decision",
    "migration",
    "compliance",
    "runbook",
    "example",
    "overview",
    "unknown",
]
"""Coarse document taxonomy applied to every indexed chunk.

``overview`` covers top-level guides (``docs/*.md``, ``README.md``,
``ARCHITECTURE.md``).  ``unknown`` is a fallback for paths the
classifier cannot confidently bucket.
"""


# ---------------------------------------------------------------------------
# Indexer
# ---------------------------------------------------------------------------


class IndexReport(BaseModel):
    """Summary returned by :meth:`apps.copilot.indexer.CorpusIndexer.index`.

    All counts are cumulative across the full run.  ``elapsed_seconds``
    measures wall-clock time between the indexer's start and the
    completion of the last upsert batch.
    """

    files_scanned: int = Field(ge=0, description="Number of files the walker visited.")
    chunks_indexed: int = Field(ge=0, description="Chunks newly upserted into the vector store.")
    chunks_skipped: int = Field(
        ge=0,
        description="Chunks whose content hash was already present (idempotent skip).",
    )
    bytes_embedded: int = Field(
        ge=0,
        description="Total bytes of chunk text submitted to the embedding API.",
    )
    elapsed_seconds: float = Field(
        ge=0.0,
        description="Wall-clock duration of the index run.",
    )
    doc_type_counts: dict[DocType, int] = Field(
        default_factory=dict,
        description="Per-doc-type breakdown of newly indexed chunks.",
    )

    model_config = ConfigDict(frozen=True)


# ---------------------------------------------------------------------------
# Retrieval + Grounding
# ---------------------------------------------------------------------------


class RetrievedChunk(BaseModel):
    """A single chunk returned by the retriever tool.

    ``similarity`` is already clamped to ``[0.0, 1.0]`` by the retriever.
    Upstream may provide a higher-dimensional score (e.g. Azure AI
    Search's ``@search.score``) which the retriever normalises before
    surfacing it here.
    """

    id: str = Field(description="Deterministic chunk id (SHA-256 truncated).")
    source_path: str = Field(description="Repo-relative source document path.")
    text: str = Field(description="Full chunk text.")
    similarity: float = Field(ge=0.0, le=1.0, description="Normalised similarity score.")
    doc_type: DocType = Field(default="unknown", description="Doc taxonomy bucket.")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Free-form metadata.")

    model_config = ConfigDict(frozen=True)


# ---------------------------------------------------------------------------
# Answer + Citation
# ---------------------------------------------------------------------------


class Citation(BaseModel):
    """A single citation attached to an :class:`AnswerResponse`.

    ``id`` is the 1-based marker used in the answer text (``[1]``,
    ``[2]``, ...).  ``source_path`` should be relative to the repo root
    so links are stable across clones.
    """

    id: int = Field(ge=1, description="1-based citation marker used in the answer text.")
    source_path: str = Field(description="Repo-relative path of the cited document.")
    excerpt: str = Field(description="Short excerpt (<=500 chars) from the cited chunk.")
    similarity: float = Field(ge=0.0, le=1.0, description="Retriever similarity score for the cited chunk.")
    chunk_id: str = Field(description="Underlying chunk id (from the vector store).")

    model_config = ConfigDict(frozen=True)


class AnswerResponse(BaseModel):
    """The canonical Copilot response.

    On refusal, ``answer`` contains the refusal message, ``citations``
    is empty, ``refused`` is ``True``, and ``refusal_reason`` explains
    which part of the contract failed (``"no_coverage"``,
    ``"citation_verification_failed"``, ...).
    """

    question: str = Field(description="The original user question.")
    answer: str = Field(description="Generated answer text or refusal message.")
    citations: list[Citation] = Field(
        default_factory=list,
        description="Citations referenced in the answer; empty on refusal.",
    )
    groundedness: float = Field(
        ge=0.0,
        le=1.0,
        description="Max similarity across retrieved chunks used as the groundedness score.",
    )
    refused: bool = Field(default=False, description="True when the refusal contract fired.")
    refusal_reason: str | None = Field(
        default=None,
        description="Machine-readable reason code when refused=True.",
    )

    model_config = ConfigDict(frozen=True)


# ---------------------------------------------------------------------------
# Citation verification
# ---------------------------------------------------------------------------


class CitationVerificationResult(BaseModel):
    """Outcome of post-generation citation verification.

    * ``valid`` — every cited id appears in the retrieved set AND the
      answer text contains the expected ``[n]`` markers.
    * ``missing_markers`` — ids claimed via the citations list that were
      never referenced with a ``[n]`` marker in the answer text.
    * ``fabricated_ids`` — ids in the answer's markers or citation list
      that do not match any retrieved chunk.
    """

    valid: bool = Field(description="True when every cited chunk is grounded and every claim has a marker.")
    missing_markers: list[int] = Field(
        default_factory=list,
        description="Citation ids missing a corresponding [n] marker in the answer text.",
    )
    fabricated_ids: list[int] = Field(
        default_factory=list,
        description="Citation ids that reference chunks not present in the retrieved set.",
    )
    marker_ids_found: list[int] = Field(
        default_factory=list,
        description="The numeric ids parsed from [n] markers in the answer text.",
    )

    model_config = ConfigDict(frozen=True)
