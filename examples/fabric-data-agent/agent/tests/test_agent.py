"""End-to-end tests for :class:`FabricDataAgent`.

Wires :class:`Retriever` (mocked Fabric client) + :class:`Generator`
(mocked LLM) behind the orchestrator and verifies:

  * Happy path returns a grounded answer + audit trail.
  * Unknown table alias returns a typed error.
  * Unsafe SQL is caught and reported without calling the LLM.
  * Zero-row retrieval results in "I don't know".
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

_PKG_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from agent.agent import AgentResponse, FabricDataAgent, TableBinding  # noqa: E402
from agent.config import FabricAgentSettings  # noqa: E402
from agent.generator import Generator  # noqa: E402
from agent.retriever import Retriever  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _settings() -> FabricAgentSettings:
    return FabricAgentSettings(
        workspace_id="ws-1",
        lakehouse_id="lh-1",
        max_rows=100,
    )


def _registry() -> dict[str, TableBinding]:
    return {
        "orders": TableBinding(
            table="lakehouse.sales.orders",
            columns=["order_id", "total_amount", "customer"],
            description="One row per sales order",
        ),
        "products": TableBinding(
            table="lakehouse.catalog.products",
            columns=["sku", "name", "price"],
        ),
    }


def _build_agent(
    *,
    fabric_rows: list[dict[str, object]],
    llm_text: str = "There are 42 orders.",
) -> tuple[FabricDataAgent, MagicMock, MagicMock]:
    fabric_client = MagicMock()
    fabric_client.execute_sql.return_value = fabric_rows

    llm = MagicMock()
    llm.complete.return_value = llm_text

    settings = _settings()
    retriever = Retriever(settings, client=fabric_client)
    generator = Generator(llm=llm, temperature=settings.llm_temperature)

    agent = FabricDataAgent(
        settings=settings,
        llm=llm,
        table_registry=_registry(),
        retriever=retriever,
        generator=generator,
    )
    return agent, fabric_client, llm


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_returns_grounded_answer() -> None:
    agent, fabric_client, llm = _build_agent(
        fabric_rows=[{"row_count": 42}],
        llm_text="There are 42 orders.",
    )
    result = agent.ask(
        "How many orders are there?",
        table_alias="orders",
    )
    assert isinstance(result, AgentResponse)
    assert result.error is None
    assert result.row_count == 1
    assert "42" in result.answer
    assert result.citation is not None
    assert result.citation.table_or_model == "lakehouse.sales.orders"
    assert "COUNT(*)" in result.sql
    # Fabric + LLM were both called exactly once.
    fabric_client.execute_sql.assert_called_once()
    llm.complete.assert_called_once()


def test_top_n_question_generates_order_by() -> None:
    agent, _client, _llm = _build_agent(
        fabric_rows=[
            {"order_id": 1, "total_amount": 900, "customer": "acme"},
            {"order_id": 2, "total_amount": 850, "customer": "globex"},
        ],
    )
    result = agent.ask(
        "Show me the top 2 orders by total_amount",
        table_alias="orders",
    )
    assert result.error is None
    assert "ORDER BY total_amount DESC" in result.sql
    assert "LIMIT 2" in result.sql


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_unknown_table_alias_returns_error() -> None:
    agent, fabric_client, llm = _build_agent(fabric_rows=[])
    result = agent.ask(
        "How many users?",
        table_alias="users",  # not in registry
    )
    assert result.error == "unknown_table_alias"
    assert "Unknown table alias" in result.answer
    fabric_client.execute_sql.assert_not_called()
    llm.complete.assert_not_called()


def test_zero_rows_yields_i_dont_know() -> None:
    agent, fabric_client, llm = _build_agent(fabric_rows=[])
    result = agent.ask(
        "How many orders were over $1B?",
        table_alias="orders",
    )
    assert result.error is None
    # Fabric was called (we have to retrieve to know it's empty).
    fabric_client.execute_sql.assert_called_once()
    # LLM was NOT called — deterministic "I don't know".
    llm.complete.assert_not_called()
    assert "I don't know" in result.answer


def test_fabric_client_missing_raises_typed_error() -> None:
    """Without a client and without config, the agent reports ``fabric_unavailable``."""
    settings = FabricAgentSettings()  # empty env
    llm = MagicMock()
    agent = FabricDataAgent(
        settings=settings,
        llm=llm,
        table_registry=_registry(),
    )
    result = agent.ask(
        "How many?",
        table_alias="orders",
    )
    assert result.error is not None
    assert result.error.startswith("fabric_unavailable")
    llm.complete.assert_not_called()


def test_unsafe_sql_is_caught_without_hitting_llm() -> None:
    """Force the generator to emit a DELETE; verify the agent reports it."""
    agent, fabric_client, llm = _build_agent(fabric_rows=[{"x": 1}])

    # Patch the module-level generate_sql to return a mutation.
    from agent import retriever as retriever_mod

    original = retriever_mod.generate_sql
    retriever_mod.generate_sql = lambda *a, **kw: "DELETE FROM t"  # type: ignore[assignment]
    try:
        result = agent.ask(
            "Clean up",
            table_alias="orders",
        )
    finally:
        retriever_mod.generate_sql = original  # type: ignore[assignment]

    assert result.error is not None
    assert result.error.startswith("unsafe_sql")
    fabric_client.execute_sql.assert_not_called()
    llm.complete.assert_not_called()
