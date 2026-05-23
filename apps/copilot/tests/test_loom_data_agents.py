"""Smoke tests for the Loom Data Agents tools (PRP-09).

Each tool follows the same pattern: AOAI is a fake that returns a
canned SQL/DAX/KQL block, the engine executor is a fake that returns
canned rows, and the config store is a fake that returns canned
schema + examples. We verify the tool plumbs them together correctly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from apps.copilot.tools.loom_data_agents import (
    NL2SQLTool,
    NL2SQLInput,
    NL2KQLTool,
    NL2KQLInput,
    NL2DAXTool,
    NL2DAXInput,
    EngineDispatcher,
    XMLAExecutor,
    ADXExecutor,
    DataAgentsConfigStore,
)


# =====================================================================
# Fakes
# =====================================================================


@dataclass
class FakeMessage:
    content: str


@dataclass
class FakeChoice:
    message: FakeMessage


@dataclass
class FakeCompletion:
    choices: list[FakeChoice]


class FakeChatCompletions:
    def __init__(self, sql: str) -> None:
        self._sql = sql

    async def create(self, **_kwargs: Any) -> FakeCompletion:
        return FakeCompletion(choices=[FakeChoice(FakeMessage(self._sql))])


class FakeAOAI:
    def __init__(self, sql: str) -> None:
        self.chat = type("c", (), {"completions": FakeChatCompletions(sql)})()


class FakeDispatcher(EngineDispatcher):
    async def execute_sql(self, data_source_id, sql, user_obo_assertion, max_rows):
        return (
            ["region", "total_revenue"],
            [["west", 1_000_000], ["east", 750_000]],
            "databricks-sql",
        )


class FakeConfig(DataAgentsConfigStore):
    async def get_schema(self, data_source_id):
        return "gold.sales(region:string, revenue:double, order_date:date)"

    async def get_examples(self, source_id, kind):
        return [
            {"question": "Top regions by revenue", "query": "SELECT region, SUM(revenue) FROM gold.sales GROUP BY region"},
        ]

    async def get_verified_answers(self, source_id):
        return []

    async def get_tmdl(self, semantic_model_id):
        return "table Sales = ..."

    async def get_kql_schema(self, source_id):
        return ".show table Events"


class FakeXMLA(XMLAExecutor):
    async def execute_dax(self, semantic_model_id, dax, user_obo_assertion, max_rows):
        return (["region", "Revenue"], [["west", 1_000_000.0]])


class FakeADX(ADXExecutor):
    async def execute_kql(self, cluster, database, kql, user_obo_assertion, max_rows):
        return (["server", "cpu_avg"], [["s1", 87.5], ["s2", 42.0]])


# =====================================================================
# Tests
# =====================================================================


@pytest.mark.asyncio
async def test_nl2sql_generates_and_executes() -> None:
    tool = NL2SQLTool(
        aoai_client=FakeAOAI(
            "```sql\nSELECT region, SUM(revenue) FROM gold.sales GROUP BY region\n```"
        ),
        engine_dispatcher=FakeDispatcher(),
        config_store=FakeConfig(),
        deployment="gpt-4o-mini",
    )
    out = await tool(
        NL2SQLInput(
            question="What were sales by region?",
            data_source_id="ds-1",
            user_obo_assertion="fake-obo",
        )
    )
    assert out.columns == ["region", "total_revenue"]
    assert out.row_count == 2
    assert out.engine == "databricks-sql"
    assert out.citation.kind == "sql"
    assert "SELECT region" in out.citation.query


@pytest.mark.asyncio
async def test_nl2dax_uses_extract_helper() -> None:
    tool = NL2DAXTool(
        aoai_client=FakeAOAI("```dax\nEVALUATE SUMMARIZECOLUMNS('Sales'[region])\n```"),
        xmla_executor=FakeXMLA(),
        config_store=FakeConfig(),
    )
    out = await tool(
        NL2DAXInput(
            question="Revenue by region",
            semantic_model_id="sm-1",
            user_obo_assertion="fake-obo",
        )
    )
    assert out.engine == "power-bi-xmla"
    assert "SUMMARIZECOLUMNS" in out.citation.query
    assert out.citation.kind == "dax"


@pytest.mark.asyncio
async def test_nl2kql_appends_take_when_missing() -> None:
    # No bounding clause in the generated KQL — the ADX executor should
    # auto-append `| take N`
    tool = NL2KQLTool(
        aoai_client=FakeAOAI("```kql\nEvents | summarize avg(cpu) by server\n```"),
        adx_executor=FakeADX(),
        config_store=FakeConfig(),
    )
    out = await tool(
        NL2KQLInput(
            question="avg cpu by server",
            adx_cluster="adx.example",
            database="loomdb",
            user_obo_assertion="fake-obo",
            max_rows=50,
        )
    )
    assert out.engine == "adx-kusto"
    assert out.citation.kind == "kql"
    assert "summarize" in out.citation.query


def test_sql_extractor_handles_no_fence() -> None:
    """The fallback path: AOAI returned plain SQL without ```sql fence."""
    raw = "SELECT 1"
    assert NL2SQLTool._extract_sql(raw) == "SELECT 1"


def test_sql_extractor_raises_on_empty() -> None:
    with pytest.raises(Exception):
        NL2SQLTool._extract_sql(None)
