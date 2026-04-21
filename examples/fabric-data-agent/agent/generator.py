"""Grounded answer generator.

Given a question + :class:`RetrievalResult`, compose a grounded natural-
language answer that cites the source table/columns and is constrained
to the retrieved rows.  The LLM client is injected so tests can stub it.

Design notes
------------
* The *rendering* is deterministic: we always prepend a citation line
  and the row count so the structural invariants are testable.
* The LLM is asked to produce only the "body" of the answer; the
  citation block is stitched on by code after the LLM call.
* When the retrieval is empty, the generator short-circuits to "I don't
  know — no grounding rows were returned" rather than hallucinating.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from .retriever import RetrievalResult

# ---------------------------------------------------------------------------
# LLM protocol
# ---------------------------------------------------------------------------


class LLMClient(Protocol):
    """Minimal LLM client surface — compatible with Azure OpenAI chat."""

    def complete(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        max_tokens: int,
    ) -> str:  # pragma: no cover - interface
        ...


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------


@dataclass
class GeneratedAnswer:
    answer: str
    citation_block: str
    raw_llm_output: str
    row_count: int
    extra: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a grounded analytics assistant.
Answer ONLY using the rows provided.
Never invent numbers, dates, categories, or columns.
If the rows do not answer the question, reply exactly: "I don't know."
Keep the answer concise (1-3 sentences).
Do NOT include a citation or a row count — those are appended by the system."""


def _render_rows(rows: list[dict[str, Any]], *, limit: int = 10) -> str:
    """Render rows as a pipe-delimited table for the LLM prompt."""
    if not rows:
        return "(no rows)"
    cols = list(rows[0].keys())
    header = "| " + " | ".join(cols) + " |"
    sep = "|" + "|".join(["---"] * len(cols)) + "|"
    body_lines: list[str] = []
    for row in rows[:limit]:
        body_lines.append("| " + " | ".join(str(row.get(c, "")) for c in cols) + " |")
    if len(rows) > limit:
        body_lines.append(f"| ...({len(rows) - limit} more rows omitted) |")
    return "\n".join([header, sep, *body_lines])


def _build_user_prompt(question: str, rows: list[dict[str, Any]]) -> str:
    table = _render_rows(rows, limit=10)
    return (
        f"Question: {question}\n\n"
        f"Grounding rows:\n{table}\n\n"
        "Write the answer."
    )


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------


class Generator:
    """Compose a grounded natural-language answer.

    Args:
        llm: Any object implementing :class:`LLMClient`.
        temperature: Sampling temperature forwarded to the LLM.
        max_tokens: Max output tokens.
    """

    def __init__(
        self,
        llm: LLMClient,
        *,
        temperature: float = 0.1,
        max_tokens: int = 300,
    ) -> None:
        self._llm = llm
        self._temperature = temperature
        self._max_tokens = max_tokens

    def generate(
        self,
        question: str,
        retrieval: RetrievalResult,
    ) -> GeneratedAnswer:
        """Produce a grounded answer from the retrieval rows."""
        if retrieval.row_count == 0:
            citation_block = self._render_citation_block(retrieval, row_count=0)
            return GeneratedAnswer(
                answer="I don't know — no grounding rows were returned.",
                citation_block=citation_block,
                raw_llm_output="",
                row_count=0,
            )

        raw = self._llm.complete(
            system_prompt=_SYSTEM_PROMPT,
            user_prompt=_build_user_prompt(question, retrieval.rows),
            temperature=self._temperature,
            max_tokens=self._max_tokens,
        )
        body = raw.strip()

        citation_block = self._render_citation_block(
            retrieval,
            row_count=retrieval.row_count,
        )
        # Always stitch the citation onto the end so structure is fixed.
        final = f"{body}\n\n{citation_block}".strip()
        return GeneratedAnswer(
            answer=final,
            citation_block=citation_block,
            raw_llm_output=raw,
            row_count=retrieval.row_count,
        )

    @staticmethod
    def _render_citation_block(
        retrieval: RetrievalResult,
        *,
        row_count: int,
    ) -> str:
        c = retrieval.citation
        cols = ", ".join(c.columns)
        truncated_note = " (truncated)" if retrieval.truncated else ""
        return (
            f"Source: {c.source_type} → {c.table_or_model}\n"
            f"Columns: {cols}\n"
            f"SQL: {c.sql}\n"
            f"Grounding rows: {row_count}{truncated_note}"
        )


__all__ = [
    "GeneratedAnswer",
    "Generator",
    "LLMClient",
]
