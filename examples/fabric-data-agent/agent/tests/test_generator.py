"""Tests for :mod:`agent.generator`.

Exercises the grounded-answer composer against a mocked LLM client.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

_PKG_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from agent.generator import GeneratedAnswer, Generator, _render_rows  # noqa: E402
from agent.retriever import Citation, RetrievalResult  # noqa: E402


def _citation(sql: str = "SELECT COUNT(*) FROM t") -> Citation:
    return Citation(
        source_type="lakehouse_sql",
        table_or_model="lakehouse.sales.orders",
        columns=["order_id", "total_amount"],
        sql=sql,
    )


def _retrieval(rows: list[dict[str, object]], truncated: bool = False) -> RetrievalResult:
    return RetrievalResult(
        rows=rows,
        citation=_citation(),
        row_count=len(rows),
        truncated=truncated,
    )


def test_render_rows_formats_as_markdown_table() -> None:
    rows = [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]
    rendered = _render_rows(rows)
    assert "| a | b |" in rendered
    assert "| 1 | x |" in rendered
    assert "| 2 | y |" in rendered


def test_render_rows_truncates_long_tables() -> None:
    rows = [{"a": i} for i in range(25)]
    rendered = _render_rows(rows, limit=5)
    assert "(20 more rows omitted)" in rendered


def test_generator_returns_i_dont_know_for_empty_retrieval() -> None:
    llm = MagicMock()
    gen = Generator(llm=llm)
    result = gen.generate(
        "How many orders?",
        _retrieval(rows=[]),
    )
    assert isinstance(result, GeneratedAnswer)
    assert "I don't know" in result.answer
    assert result.row_count == 0
    # LLM must NOT be called when there are no grounding rows.
    llm.complete.assert_not_called()


def test_generator_stitches_citation_to_llm_output() -> None:
    llm = MagicMock()
    llm.complete.return_value = "There are 42 orders."

    gen = Generator(llm=llm, temperature=0.05)
    retrieval = _retrieval(rows=[{"row_count": 42}])
    result = gen.generate("How many orders?", retrieval)

    assert "There are 42 orders." in result.answer
    # Citation block was stitched on the end.
    assert "Source: lakehouse_sql" in result.answer
    assert "SQL: SELECT COUNT(*) FROM t" in result.answer
    assert "Grounding rows: 1" in result.answer
    # LLM was called with the right temperature.
    call = llm.complete.call_args
    assert call.kwargs["temperature"] == 0.05
    assert "grounded analytics" in call.kwargs["system_prompt"].lower()


def test_generator_marks_truncation() -> None:
    llm = MagicMock()
    llm.complete.return_value = "Some answer."
    gen = Generator(llm=llm)
    retrieval = _retrieval(
        rows=[{"a": i} for i in range(500)],
        truncated=True,
    )
    result = gen.generate("How many?", retrieval)
    assert "(truncated)" in result.citation_block


def test_generator_strips_whitespace_from_llm_output() -> None:
    llm = MagicMock()
    llm.complete.return_value = "  \n\nAnswer body.  \n\n"
    gen = Generator(llm=llm)
    result = gen.generate(
        "Q?",
        _retrieval(rows=[{"a": 1}]),
    )
    # Leading whitespace was stripped.
    assert result.answer.startswith("Answer body.")
