"""Orchestrator — wires :class:`Retriever` and :class:`Generator` together.

The agent is strictly read-class (enforced by :func:`_assert_read_only`
in :mod:`retriever`).  It has one public method :meth:`ask` which:

  1. Looks up the requested table in its registered ``table_registry``.
  2. Calls the retriever.
  3. Calls the generator with the retrieved rows.
  4. Returns a :class:`AgentResponse` with the final answer and the
     audit trail (SQL, citation, row count).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .config import FabricAgentSettings
from .generator import GeneratedAnswer, Generator, LLMClient
from .retriever import Citation, Retriever, UnsafeSQLError


@dataclass
class TableBinding:
    """Registered lakehouse table the agent may query."""

    table: str
    columns: list[str]
    description: str = ""


@dataclass
class AgentResponse:
    question: str
    answer: str
    citation: Citation | None
    row_count: int
    sql: str = ""
    error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class FabricDataAgent:
    """Read-only Q&A agent grounded on Fabric lakehouse tables.

    Args:
        settings: :class:`FabricAgentSettings` instance.
        llm: :class:`LLMClient` (Azure OpenAI or mock).
        table_registry: ``{alias: TableBinding}`` mapping — the ``ask``
            call must resolve the question to one of these aliases.
        retriever: Optional :class:`Retriever` override (tests).
        generator: Optional :class:`Generator` override (tests).
    """

    def __init__(
        self,
        *,
        settings: FabricAgentSettings,
        llm: LLMClient,
        table_registry: dict[str, TableBinding],
        retriever: Retriever | None = None,
        generator: Generator | None = None,
    ) -> None:
        self._settings = settings
        self._llm = llm
        self._registry = table_registry
        self._retriever = retriever or Retriever(settings)
        self._generator = generator or Generator(
            llm,
            temperature=settings.llm_temperature,
        )

    def ask(
        self,
        question: str,
        *,
        table_alias: str,
    ) -> AgentResponse:
        """Answer ``question`` grounded on the registered ``table_alias``."""
        binding = self._registry.get(table_alias)
        if binding is None:
            return AgentResponse(
                question=question,
                answer=f"Unknown table alias: {table_alias}",
                citation=None,
                row_count=0,
                error="unknown_table_alias",
            )

        try:
            retrieval = self._retriever.retrieve(
                question,
                table=binding.table,
                columns=binding.columns,
            )
        except UnsafeSQLError as exc:
            return AgentResponse(
                question=question,
                answer="Refused: generated SQL failed the read-only guard.",
                citation=None,
                row_count=0,
                error=f"unsafe_sql:{exc}",
            )
        except RuntimeError as exc:
            return AgentResponse(
                question=question,
                answer="Fabric client is not configured for this environment.",
                citation=None,
                row_count=0,
                error=f"fabric_unavailable:{exc}",
            )

        generated: GeneratedAnswer = self._generator.generate(question, retrieval)
        return AgentResponse(
            question=question,
            answer=generated.answer,
            citation=retrieval.citation,
            row_count=retrieval.row_count,
            sql=retrieval.citation.sql,
            extra={
                "raw_llm_output": generated.raw_llm_output,
                "truncated": retrieval.truncated,
            },
        )


__all__ = [
    "AgentResponse",
    "FabricDataAgent",
    "TableBinding",
]
