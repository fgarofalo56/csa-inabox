"""Shared Pydantic types for the CSA Copilot.

Each type is ``frozen`` so responses are safe to pass across async
boundaries and cannot be mutated by downstream callers — the Copilot API
contract is value-semantic.

All scoring fields use floating-point similarity in ``[0.0, 1.0]``
(mapped from whatever upstream score space the retriever returns).
"""

from __future__ import annotations

from typing import Any, Literal, Union

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
    chunks_deleted: int = Field(
        default=0,
        ge=0,
        description=(
            "Orphan chunks deleted during cleanup — chunks previously indexed "
            "under a source_path scanned during this run whose id is NOT in "
            "the newly-emitted id set. Always 0 when orphan cleanup is "
            "disabled or when ``dry_run=True``."
        ),
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
    reranker_score: float | None = Field(
        default=None,
        ge=0.0,
        le=4.0,
        description=(
            "Azure AI Search semantic reranker score (0-4 range). "
            "Populated only when the semantic reranker path was used "
            "and the underlying ``@search.reranker_score`` was surfaced."
        ),
    )

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


# --- Streaming (post-Phase-1) ---


AnswerChunkKind = Literal["status", "token", "citation", "done"]
"""Discriminant for :class:`AnswerChunk`.

* ``status`` — a string describing a lifecycle event (e.g.
  ``retrieve-start``, ``retrieve-complete``, ``coverage-gate-pass``,
  ``generate-start``, ``refused:no_coverage``).  The payload is the
  status string.
* ``token`` — an LLM delta.  The payload is the token string (may be
  multiple characters for SDKs that batch).
* ``citation`` — a verified :class:`Citation` emitted after generation
  completes.  One event per citation.
* ``done`` — the terminal event.  The payload is the final
  :class:`AnswerResponse` (same DTO as the blocking path).
"""


AnswerChunkPayload = Union[str, Citation, "AnswerResponse"]
"""Type alias for the polymorphic payload carried by :class:`AnswerChunk`."""


class AnswerChunk(BaseModel):
    """One event emitted by :meth:`CopilotAgent.ask_stream`.

    The stream is consumed with ``async for`` and always terminates
    with exactly one ``done`` event carrying the final
    :class:`AnswerResponse`.  Refusals produce one ``status`` event
    whose payload starts with ``refused:`` followed by the refusal
    reason, then a ``done`` event.
    """

    kind: AnswerChunkKind = Field(description="Discriminant for the event type.")
    payload: AnswerChunkPayload = Field(
        description=(
            "Event payload. String for status/token events; "
            "Citation for citation events; AnswerResponse for done."
        ),
    )

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=False)


# --- Multi-turn conversation (post-Phase-1) ---


class ConversationTurn(BaseModel):
    """A single question/answer pair in a multi-turn conversation.

    Stored in the :class:`ConversationStore` so subsequent turns can
    retrieve with awareness of prior context.  Frozen so downstream
    consumers never mutate stored history.
    """

    turn_index: int = Field(ge=0, description="Zero-based position in the conversation.")
    question: str = Field(description="The user question for this turn.")
    answer: str = Field(description="The agent's answer text (empty on refusal).")
    refused: bool = Field(default=False, description="True if the turn was refused.")
    refusal_reason: str | None = Field(
        default=None,
        description="Reason code when refused=True; None otherwise.",
    )
    approx_tokens: int = Field(
        default=0,
        ge=0,
        description=(
            "Rough token count for the turn (question + answer). Used by "
            "the history trimmer to respect ``conversation_max_history_tokens``."
        ),
    )

    model_config = ConfigDict(frozen=True)


class ConversationHandle(BaseModel):
    """Opaque handle returned by :meth:`CopilotAgent.start_conversation`.

    Callers treat it as opaque — the only supported operation is to
    pass it back to :meth:`CopilotAgent.ask_in_conversation`.  The id
    is a UUID4 string so it is stable across serialisation boundaries
    (e.g. when a CLI REPL rehydrates after a ``/reset``).
    """

    conversation_id: str = Field(
        description="Opaque UUID4 conversation identifier.",
        min_length=1,
    )

    model_config = ConfigDict(frozen=True)


# Rebuild AnswerChunk model so forward-referenced AnswerResponse
# in the payload union is fully resolved.
AnswerChunk.model_rebuild()
