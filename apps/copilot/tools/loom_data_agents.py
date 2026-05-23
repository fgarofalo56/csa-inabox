"""Loom Data Agents tools (PRP-09).

Read-class tools that extend the copilot agent with Fabric Data Agents
parity:

* :class:`NL2SQLTool` — natural language → SQL against a registered
  lakehouse / warehouse. Executes via Databricks SQL Warehouse
  (Commercial / GCC) or Synapse Serverless (Gov-H / IL5) using the
  caller's OBO token.
* :class:`NL2DAXTool` — natural language → DAX against a Power BI
  semantic model. Executes via XMLA endpoint.
* :class:`NL2KQLTool` — natural language → KQL against an ADX cluster
  / database.
* :class:`GraphSearchTool` — Microsoft Graph search (people / files /
  mail) using OBO.
* :class:`CustomSearchTool` — Azure AI Search index search for
  unstructured grounding.

All five are *read-class* (no confirmation token required) because the
caller's Entra identity gates access at the engine layer — RLS / CLS
/ object-level security applies naturally. Per-agent configuration
(instructions, example queries, sensitivity policy) lives in Cosmos
DB and is loaded by the orchestrator before invoking the tool.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.tools.base import ToolCategory, ToolInvocationError

logger = logging.getLogger(__name__)


# =====================================================================
# Shared types
# =====================================================================


class QueryCitation(BaseModel):
    """Generated query + execution metadata returned to the agent."""

    kind: Literal["sql", "dax", "kql", "graph", "doc"]
    source: str = Field(description="Logical source: lakehouse name, model name, cluster.db, etc.")
    query: str = Field(description="The generated query text, for transparency.")
    preview: str = Field(description="Short human-readable preview, used in citations.")

    model_config = ConfigDict(frozen=True)


class QueryResultRow(BaseModel):
    """Generic row representation. Columns by position to keep the
    shape consistent across engines."""

    values: list[Any]
    model_config = ConfigDict(frozen=True)


class QueryResult(BaseModel):
    """Common return shape for nl2X tools."""

    columns: list[str]
    rows: list[QueryResultRow]
    row_count: int
    execution_ms: int
    engine: str
    citation: QueryCitation
    model_config = ConfigDict(frozen=True)


# =====================================================================
# NL2SQL
# =====================================================================


class NL2SQLInput(BaseModel):
    question: str = Field(min_length=1, description="User question.")
    data_source_id: str = Field(description="Registered data source ID (lakehouse or warehouse).")
    user_obo_assertion: str = Field(description="Caller's OBO assertion for token exchange.")
    max_rows: int = Field(default=100, ge=1, le=10_000)
    model_config = ConfigDict(frozen=True)


class NL2SQLOutput(QueryResult):
    pass


class NL2SQLTool:
    """Generate and execute SQL against a registered lakehouse or warehouse.

    Implementation flow:
        1. Load schema for the data source from UC (Commercial) or
           Purview / Synapse (Gov).
        2. Load few-shot example Q→SQL pairs from Cosmos DB
           data-agents-config.example-queries (keyed by agent id +
           data source).
        3. Call AOAI with system prompt + grounding.
        4. Exchange caller's OBO assertion for an access token scoped
           to the engine.
        5. Execute under that token (RLS / CLS applies).
        6. Return rows + generated SQL as citation.
    """

    name = "loom_nl2sql"
    category: ToolCategory = "read"
    input_model = NL2SQLInput
    output_model = NL2SQLOutput
    requires_confirmation = False

    def __init__(
        self,
        aoai_client: Any,
        engine_dispatcher: "EngineDispatcher",
        config_store: "DataAgentsConfigStore",
        deployment: str | None = None,
    ) -> None:
        self.aoai = aoai_client
        self.engine = engine_dispatcher
        self.config = config_store
        self.deployment = deployment or os.environ.get("AOAI_CHAT_DEPLOYMENT", "gpt-4o")

    async def __call__(self, input_value: NL2SQLInput) -> NL2SQLOutput:
        # 1. Load schema + few-shot examples
        schema = await self.config.get_schema(input_value.data_source_id)
        examples = await self.config.get_examples(input_value.data_source_id, "sql")

        # 2. Generate SQL via AOAI
        system_prompt = self._build_system_prompt(schema, examples)
        completion = await self.aoai.chat.completions.create(
            model=self.deployment,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": input_value.question},
            ],
            temperature=0,
            max_tokens=512,
        )
        generated_sql = self._extract_sql(completion.choices[0].message.content)

        # 3. Execute under caller's identity
        start = time.monotonic()
        try:
            columns, rows, engine = await self.engine.execute_sql(
                data_source_id=input_value.data_source_id,
                sql=generated_sql,
                user_obo_assertion=input_value.user_obo_assertion,
                max_rows=input_value.max_rows,
            )
        except Exception as exc:  # noqa: BLE001
            raise ToolInvocationError(f"SQL execution failed: {exc}") from exc
        execution_ms = int((time.monotonic() - start) * 1000)

        return NL2SQLOutput(
            columns=columns,
            rows=[QueryResultRow(values=r) for r in rows],
            row_count=len(rows),
            execution_ms=execution_ms,
            engine=engine,
            citation=QueryCitation(
                kind="sql",
                source=input_value.data_source_id,
                query=generated_sql,
                preview=generated_sql[:240],
            ),
        )

    def _build_system_prompt(self, schema: str, examples: list[dict[str, str]]) -> str:
        example_block = "\n\n".join(
            f"Q: {e['question']}\nSQL: {e['query']}" for e in examples[:8]
        )
        return (
            "You are a SQL generator for the CSA Loom Data Agents runtime.\n"
            "Generate a SINGLE well-formed SQL statement that answers the user's question.\n"
            "Rules:\n"
            "- SELECT only — never write DDL/DML.\n"
            "- Use only tables and columns from the provided schema.\n"
            "- Always include a LIMIT clause unless the user explicitly asks for an aggregate that returns one row.\n"
            "- Prefer fully-qualified table names: schema.table.\n"
            "- Return the SQL inside a single ```sql ... ``` code fence with no commentary.\n"
            "\n"
            f"=== Schema ===\n{schema}\n\n"
            f"=== Example Q/SQL pairs ===\n{example_block}\n"
        )

    @staticmethod
    def _extract_sql(content: str | None) -> str:
        if not content:
            raise ToolInvocationError("AOAI returned empty content")
        if "```sql" in content:
            block = content.split("```sql", 1)[1]
            return block.split("```", 1)[0].strip()
        if "```" in content:
            block = content.split("```", 1)[1]
            return block.split("```", 1)[0].strip()
        return content.strip()


# =====================================================================
# NL2DAX
# =====================================================================


class NL2DAXInput(BaseModel):
    question: str = Field(min_length=1)
    semantic_model_id: str = Field(description="Power BI semantic model object ID.")
    user_obo_assertion: str
    max_rows: int = Field(default=100, ge=1, le=10_000)
    model_config = ConfigDict(frozen=True)


class NL2DAXOutput(QueryResult):
    pass


class NL2DAXTool:
    """Generate and execute DAX against a Power BI semantic model.

    Honest gap: NL2DAX accuracy is materially less mature than NL2SQL.
    The system prompt flags this and asks the model to err on the side
    of returning a clarifying question when the question is ambiguous.
    """

    name = "loom_nl2dax"
    category: ToolCategory = "read"
    input_model = NL2DAXInput
    output_model = NL2DAXOutput
    requires_confirmation = False

    def __init__(
        self,
        aoai_client: Any,
        xmla_executor: "XMLAExecutor",
        config_store: "DataAgentsConfigStore",
        deployment: str | None = None,
    ) -> None:
        self.aoai = aoai_client
        self.xmla = xmla_executor
        self.config = config_store
        self.deployment = deployment or os.environ.get("AOAI_CHAT_DEPLOYMENT", "gpt-4o")

    async def __call__(self, input_value: NL2DAXInput) -> NL2DAXOutput:
        tmdl = await self.config.get_tmdl(input_value.semantic_model_id)
        examples = await self.config.get_examples(input_value.semantic_model_id, "dax")
        verified = await self.config.get_verified_answers(input_value.semantic_model_id)

        system_prompt = self._build_system_prompt(tmdl, examples, verified)
        completion = await self.aoai.chat.completions.create(
            model=self.deployment,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": input_value.question},
            ],
            temperature=0,
            max_tokens=512,
        )
        generated_dax = NL2SQLTool._extract_sql(completion.choices[0].message.content)

        start = time.monotonic()
        try:
            columns, rows = await self.xmla.execute_dax(
                semantic_model_id=input_value.semantic_model_id,
                dax=generated_dax,
                user_obo_assertion=input_value.user_obo_assertion,
                max_rows=input_value.max_rows,
            )
        except Exception as exc:  # noqa: BLE001
            raise ToolInvocationError(f"DAX execution failed: {exc}") from exc
        execution_ms = int((time.monotonic() - start) * 1000)

        return NL2DAXOutput(
            columns=columns,
            rows=[QueryResultRow(values=r) for r in rows],
            row_count=len(rows),
            execution_ms=execution_ms,
            engine="power-bi-xmla",
            citation=QueryCitation(
                kind="dax",
                source=input_value.semantic_model_id,
                query=generated_dax,
                preview=generated_dax[:240],
            ),
        )

    @staticmethod
    def _build_system_prompt(
        tmdl: str, examples: list[dict[str, str]], verified: list[dict[str, str]]
    ) -> str:
        example_block = "\n\n".join(f"Q: {e['question']}\nDAX: {e['query']}" for e in examples[:8])
        verified_block = "\n\n".join(
            f"Q: {v['question']}\nDAX (verified): {v['query']}" for v in verified[:5]
        )
        return (
            "You are a DAX generator for the CSA Loom Data Agents runtime.\n"
            "Generate a SINGLE EVALUATE DAX query that answers the user's question.\n"
            "Important:\n"
            "- NL2DAX accuracy is bounded; if the question is ambiguous, ask one short clarifying question instead of guessing.\n"
            "- Prefer the verified answers below when the question is similar.\n"
            "- Use measures over raw column aggregation when measures exist.\n"
            "- Return the DAX inside a single ```dax ... ``` code fence.\n"
            "\n"
            f"=== Semantic model (TMDL) ===\n{tmdl}\n\n"
            f"=== Verified Q/DAX ===\n{verified_block}\n\n"
            f"=== Example Q/DAX ===\n{example_block}\n"
        )


# =====================================================================
# NL2KQL
# =====================================================================


class NL2KQLInput(BaseModel):
    question: str = Field(min_length=1)
    adx_cluster: str = Field(description="ADX cluster name (without https://).")
    database: str
    user_obo_assertion: str
    max_rows: int = Field(default=1000, ge=1, le=100_000)
    model_config = ConfigDict(frozen=True)


class NL2KQLOutput(QueryResult):
    pass


class NL2KQLTool:
    """Generate and execute KQL against an ADX database.

    KQL is the most learnable of the three target languages, so NL2KQL
    accuracy is generally high. Fabric's KQL UDFs are not yet available
    in OSS Kusto; we generate raw KQL only and document the gap.
    """

    name = "loom_nl2kql"
    category: ToolCategory = "read"
    input_model = NL2KQLInput
    output_model = NL2KQLOutput
    requires_confirmation = False

    def __init__(
        self,
        aoai_client: Any,
        adx_executor: "ADXExecutor",
        config_store: "DataAgentsConfigStore",
        deployment: str | None = None,
    ) -> None:
        self.aoai = aoai_client
        self.adx = adx_executor
        self.config = config_store
        self.deployment = deployment or os.environ.get("AOAI_CHAT_DEPLOYMENT", "gpt-4o")

    async def __call__(self, input_value: NL2KQLInput) -> NL2KQLOutput:
        source_id = f"{input_value.adx_cluster}/{input_value.database}"
        schema = await self.config.get_kql_schema(source_id)
        examples = await self.config.get_examples(source_id, "kql")

        system_prompt = (
            "You are a KQL generator for the CSA Loom Data Agents runtime.\n"
            "Generate a SINGLE Kusto query that answers the user's question.\n"
            "Rules:\n"
            "- Time filters: prefer ago(7d) over absolute ranges when the user says 'last week'.\n"
            "- Always include `| take N` when no aggregation is present.\n"
            "- Return the KQL inside a single ```kql ... ``` code fence.\n"
            "\n"
            f"=== Tables ===\n{schema}\n\n"
            f"=== Example Q/KQL ===\n"
            + "\n\n".join(f"Q: {e['question']}\nKQL: {e['query']}" for e in examples[:8])
        )
        completion = await self.aoai.chat.completions.create(
            model=self.deployment,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": input_value.question},
            ],
            temperature=0,
            max_tokens=512,
        )
        generated_kql = NL2SQLTool._extract_sql(completion.choices[0].message.content)

        start = time.monotonic()
        try:
            columns, rows = await self.adx.execute_kql(
                cluster=input_value.adx_cluster,
                database=input_value.database,
                kql=generated_kql,
                user_obo_assertion=input_value.user_obo_assertion,
                max_rows=input_value.max_rows,
            )
        except Exception as exc:  # noqa: BLE001
            raise ToolInvocationError(f"KQL execution failed: {exc}") from exc
        execution_ms = int((time.monotonic() - start) * 1000)

        return NL2KQLOutput(
            columns=columns,
            rows=[QueryResultRow(values=r) for r in rows],
            row_count=len(rows),
            execution_ms=execution_ms,
            engine="adx-kusto",
            citation=QueryCitation(
                kind="kql",
                source=source_id,
                query=generated_kql,
                preview=generated_kql[:240],
            ),
        )


# =====================================================================
# Graph search + custom search
# =====================================================================


class GraphSearchInput(BaseModel):
    query: str
    user_obo_assertion: str
    entity_types: list[Literal["person", "message", "driveItem", "event"]] = Field(
        default_factory=lambda: ["driveItem"]
    )
    max_results: int = Field(default=10, ge=1, le=50)
    model_config = ConfigDict(frozen=True)


class GraphEntity(BaseModel):
    id: str
    kind: str
    title: str
    snippet: str
    url: str | None = None
    model_config = ConfigDict(frozen=True)


class GraphSearchOutput(BaseModel):
    results: list[GraphEntity]
    model_config = ConfigDict(frozen=True)


class GraphSearchTool:
    """Microsoft Graph search via OBO."""

    name = "loom_graph_search"
    category: ToolCategory = "read"
    input_model = GraphSearchInput
    output_model = GraphSearchOutput
    requires_confirmation = False

    def __init__(self, msal_obo_acquirer: Any, graph_endpoint: str | None = None) -> None:
        self.msal = msal_obo_acquirer
        self.endpoint = graph_endpoint or os.environ.get(
            "GRAPH_ENDPOINT", "https://graph.microsoft.com"
        )

    async def __call__(self, input_value: GraphSearchInput) -> GraphSearchOutput:
        token = await self.msal(
            input_value.user_obo_assertion, [f"{self.endpoint}/.default"]
        )
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                f"{self.endpoint}/v1.0/search/query",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={
                    "requests": [
                        {
                            "entityTypes": input_value.entity_types,
                            "query": {"queryString": input_value.query},
                            "size": input_value.max_results,
                        }
                    ]
                },
            )
            res.raise_for_status()
            data = res.json()

        entities: list[GraphEntity] = []
        for resp in data.get("value", []):
            for hits in resp.get("hitsContainers", []):
                for hit in hits.get("hits", []):
                    resource = hit.get("resource", {})
                    entities.append(
                        GraphEntity(
                            id=hit.get("hitId", ""),
                            kind=hit.get("contentSource", "unknown"),
                            title=resource.get("name") or resource.get("subject") or "(no title)",
                            snippet=hit.get("summary", ""),
                            url=resource.get("webUrl"),
                        )
                    )
        return GraphSearchOutput(results=entities)


class CustomSearchInput(BaseModel):
    query: str
    search_index: str = Field(description="Azure AI Search index name.")
    user_obo_assertion: str
    max_results: int = Field(default=10, ge=1, le=50)
    model_config = ConfigDict(frozen=True)


class CustomSearchHit(BaseModel):
    id: str
    title: str
    content: str
    score: float
    metadata: dict[str, Any] = Field(default_factory=dict)
    model_config = ConfigDict(frozen=True)


class CustomSearchOutput(BaseModel):
    hits: list[CustomSearchHit]
    model_config = ConfigDict(frozen=True)


class CustomSearchTool:
    """Search a customer-supplied Azure AI Search index for unstructured grounding."""

    name = "loom_custom_search"
    category: ToolCategory = "read"
    input_model = CustomSearchInput
    output_model = CustomSearchOutput
    requires_confirmation = False

    def __init__(self, search_endpoint_base: str, msal_obo_acquirer: Any) -> None:
        self.base = search_endpoint_base.rstrip("/")
        self.msal = msal_obo_acquirer

    async def __call__(self, input_value: CustomSearchInput) -> CustomSearchOutput:
        token = await self.msal(input_value.user_obo_assertion, ["https://search.azure.com/.default"])
        url = f"{self.base}/indexes/{input_value.search_index}/docs/search?api-version=2024-07-01"
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={
                    "search": input_value.query,
                    "top": input_value.max_results,
                    "queryType": "semantic",
                    "semanticConfiguration": "default",
                    "captions": "extractive",
                },
            )
            res.raise_for_status()
            data = res.json()

        hits: list[CustomSearchHit] = []
        for hit in data.get("value", []):
            hits.append(
                CustomSearchHit(
                    id=str(hit.get("id") or hit.get("@search.score", "")),
                    title=hit.get("title", "(no title)"),
                    content=hit.get("content", ""),
                    score=float(hit.get("@search.score", 0.0)),
                    metadata={k: v for k, v in hit.items() if not k.startswith("@") and k not in {"id", "title", "content"}},
                )
            )
        return CustomSearchOutput(hits=hits)


# =====================================================================
# Engine executors — interfaces only; concrete impls injected at runtime
# =====================================================================


class EngineDispatcher:
    """Selects Databricks SQL Warehouse OR Synapse Serverless per boundary
    and executes SQL under the caller's OBO token. The DLZ registration
    in Cosmos DB carries the engine routing."""

    async def execute_sql(
        self,
        data_source_id: str,
        sql: str,
        user_obo_assertion: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]], str]:
        raise NotImplementedError("Inject a concrete EngineDispatcher")


class XMLAExecutor:
    """Executes DAX against a Power BI Premium semantic model via the
    XMLA endpoint. Uses the Microsoft.AnalysisServices ADOMD.NET client
    via pythonnet OR the REST `executeQueries` API (preview)."""

    async def execute_dax(
        self,
        semantic_model_id: str,
        dax: str,
        user_obo_assertion: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]]]:
        raise NotImplementedError("Inject a concrete XMLAExecutor")


class ADXExecutor:
    """Executes KQL against an ADX cluster + database. Uses the
    azure-kusto-data Python SDK with on-behalf-of token."""

    async def execute_kql(
        self,
        cluster: str,
        database: str,
        kql: str,
        user_obo_assertion: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]]]:
        raise NotImplementedError("Inject a concrete ADXExecutor")


class DataAgentsConfigStore:
    """Loads per-data-source schema + few-shot examples + verified
    answers + TMDL from Cosmos DB data-agents-config database."""

    async def get_schema(self, data_source_id: str) -> str:
        raise NotImplementedError

    async def get_examples(self, source_id: str, kind: str) -> list[dict[str, str]]:
        raise NotImplementedError

    async def get_verified_answers(self, source_id: str) -> list[dict[str, str]]:
        raise NotImplementedError

    async def get_tmdl(self, semantic_model_id: str) -> str:
        raise NotImplementedError

    async def get_kql_schema(self, source_id: str) -> str:
        raise NotImplementedError
