"""Concrete engine executors for Loom Data Agents (PRP-09).

Each executor implements an interface from `loom_data_agents.py` and
talks to one of the underlying engines via its native SDK using the
caller's OBO token.

These run in the copilot's hosting process (Function App or Container
App), so the OBO assertion can be exchanged via the colocated MSAL
client without any cross-service hop.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Awaitable, Callable

import httpx

from apps.copilot.tools.loom_data_agents import (
    ADXExecutor,
    DataAgentsConfigStore,
    EngineDispatcher,
    XMLAExecutor,
)

logger = logging.getLogger(__name__)


# =====================================================================
# Engine dispatcher — Databricks SQL Warehouse OR Synapse Serverless
# =====================================================================


class DatabricksOrSynapseDispatcher(EngineDispatcher):
    """Routes each query to the engine registered for the data source.

    Routing rules:
        - data_source.engine == 'databricks-sql' → Databricks SQL Warehouse
        - data_source.engine == 'synapse-serverless' → Synapse SQL endpoint
        - data_source.engine == 'fabric-sql' → not supported in v1 (raise)
    """

    def __init__(
        self,
        config: DataAgentsConfigStore,
        msal_obo_acquirer: Callable[[str, list[str]], Awaitable[str]],
    ) -> None:
        self.config = config
        self.msal = msal_obo_acquirer

    async def execute_sql(
        self,
        data_source_id: str,
        sql: str,
        user_obo_assertion: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]], str]:
        # Lookup engine routing
        ds = await self._get_data_source(data_source_id)
        if ds["engine"] == "databricks-sql":
            return await self._execute_databricks(ds, sql, user_obo_assertion, max_rows)
        if ds["engine"] == "synapse-serverless":
            return await self._execute_synapse(ds, sql, user_obo_assertion, max_rows)
        raise ValueError(f"Unsupported engine: {ds['engine']}")

    async def _get_data_source(self, data_source_id: str) -> dict[str, Any]:
        # In real impl, read from Cosmos workspace-registry.items
        # For the scaffold, derive from env vars.
        engine = os.environ.get("LOOM_DEFAULT_ENGINE", "databricks-sql")
        return {
            "id": data_source_id,
            "engine": engine,
            "host": os.environ.get("LOOM_DATABRICKS_HOST", "https://adb-example.azuredatabricks.net"),
            "warehouse_id": os.environ.get("LOOM_DATABRICKS_WAREHOUSE_ID", ""),
            "synapse_endpoint": os.environ.get("LOOM_SYNAPSE_ENDPOINT", ""),
            "catalog": os.environ.get("LOOM_DATABRICKS_CATALOG", "main"),
            "schema": os.environ.get("LOOM_DATABRICKS_SCHEMA", "default"),
        }

    async def _execute_databricks(
        self,
        ds: dict[str, Any],
        sql: str,
        user_obo: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]], str]:
        # Acquire token scoped to Databricks workspace
        token = await self.msal(user_obo, ["2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default"])

        async with httpx.AsyncClient(timeout=60) as client:
            # Submit statement
            res = await client.post(
                f"{ds['host']}/api/2.0/sql/statements",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={
                    "warehouse_id": ds["warehouse_id"],
                    "statement": sql,
                    "catalog": ds.get("catalog"),
                    "schema": ds.get("schema"),
                    "format": "JSON_ARRAY",
                    "disposition": "INLINE",
                    "row_limit": max_rows,
                    "wait_timeout": "30s",
                },
            )
            res.raise_for_status()
            data = res.json()
            statement_id = data["statement_id"]

            # Poll if still PENDING / RUNNING
            for _ in range(40):
                status = data.get("status", {}).get("state")
                if status in ("SUCCEEDED", "FAILED", "CANCELED"):
                    break
                await asyncio.sleep(0.5)
                poll = await client.get(
                    f"{ds['host']}/api/2.0/sql/statements/{statement_id}",
                    headers={"Authorization": f"Bearer {token}"},
                )
                poll.raise_for_status()
                data = poll.json()

        if data.get("status", {}).get("state") != "SUCCEEDED":
            err = data.get("status", {}).get("error", {}).get("message", "unknown")
            raise RuntimeError(f"Databricks SQL failed: {err}")

        manifest = data.get("manifest", {})
        result = data.get("result", {})
        columns = [c["name"] for c in manifest.get("schema", {}).get("columns", [])]
        rows = result.get("data_array", [])
        return columns, rows, "databricks-sql"

    async def _execute_synapse(
        self,
        ds: dict[str, Any],
        sql: str,
        user_obo: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]], str]:
        # Synapse Serverless uses TDS over port 1433; we need pyodbc or
        # pymssql with AAD token. The pattern is well-documented but
        # heavyweight to import here. For the scaffold, define the
        # contract; production wires pyodbc with `ActiveDirectoryAccessToken`.
        token = await self.msal(user_obo, ["https://database.windows.net/.default"])
        # NOTE: real implementation lives in a dedicated module that
        # imports pyodbc only when needed (heavyweight native dep).
        # For now, raise a clear error so test environments can mock.
        raise NotImplementedError(
            "Synapse Serverless executor requires pyodbc — see PRP-09 §3.2 for production wiring. "
            "Use the test fixture in tests/loom_data_agents/conftest.py for unit tests."
        )


# =====================================================================
# XMLA executor for Power BI semantic models
# =====================================================================


class PowerBIRestXMLAExecutor(XMLAExecutor):
    """Executes DAX via Power BI REST `executeQueries` endpoint.

    Note: `executeQueries` is the public REST surface; for very large
    result sets, the ADOMD.NET client via pythonnet is faster but adds
    a heavyweight .NET dependency. We default to REST.
    """

    def __init__(
        self,
        msal_obo_acquirer: Callable[[str, list[str]], Awaitable[str]],
        powerbi_endpoint: str | None = None,
    ) -> None:
        self.msal = msal_obo_acquirer
        self.endpoint = powerbi_endpoint or os.environ.get(
            "POWERBI_ENDPOINT", "https://api.powerbi.com"
        )

    async def execute_dax(
        self,
        semantic_model_id: str,
        dax: str,
        user_obo_assertion: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]]]:
        token = await self.msal(
            user_obo_assertion, ["https://analysis.windows.net/powerbi/api/.default"]
        )
        async with httpx.AsyncClient(timeout=60) as client:
            res = await client.post(
                f"{self.endpoint}/v1.0/myorg/datasets/{semantic_model_id}/executeQueries",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={
                    "queries": [{"query": dax}],
                    "serializerSettings": {"includeNulls": True},
                },
            )
            res.raise_for_status()
            data = res.json()

        # Power BI returns one table per query; we expect one query
        tables = data.get("results", [{}])[0].get("tables", [])
        if not tables:
            return [], []
        rows = tables[0].get("rows", [])
        columns = list(rows[0].keys()) if rows else []
        row_values = [[r.get(c) for c in columns] for r in rows[:max_rows]]
        return columns, row_values



# Sovereign Kusto host suffixes. A bare cluster name is resolved against the
# first (Commercial); a fully-qualified name must sit under one of these.
_KUSTO_SUFFIXES = ("kusto.windows.net", "kusto.usgovcloudapi.net")

# A single DNS label: what ADX actually permits for a cluster name.
_KUSTO_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$")


def _resolve_kusto_host(cluster: str) -> str:
    """Resolve an ADX cluster identifier to a validated hostname.

    Accepts either a bare cluster name (``mycluster`` -> Commercial) or a
    fully-qualified host already under a known Kusto suffix (``mycluster.
    usgovvirginia.kusto.usgovcloudapi.net``), and returns the host to use for
    BOTH the token audience and the request URL.

    Two bugs motivate the validation. The value reaches here from a data-agent
    configuration and was interpolated straight into
    ``f"https://{cluster}.kusto.windows.net/v1/rest/query"``, so a value like
    ``evil.test/x?a=`` produced ``https://evil.test/x?a=.kusto.windows.net/...``
    — an SSRF that carries a user on-behalf-of token to an attacker host. And
    the sovereign check was ``".usgovcloudapi.net" in cluster``, a substring of
    the whole identifier rather than a DNS-label match.

    Raises ValueError on anything not clearly an ADX cluster — failing closed,
    because a host we cannot classify must not receive an OBO token.
    """
    c = (cluster or "").strip().lower().rstrip(".")
    if not c or "/" in c or "\\" in c or ":" in c or "?" in c or "#" in c or "@" in c:
        raise ValueError(f"invalid ADX cluster identifier: {cluster!r}")

    for suffix in _KUSTO_SUFFIXES:
        if c == suffix:
            break  # the bare suffix is not a cluster
        if c.endswith("." + suffix):
            labels = c[: -(len(suffix) + 1)].split(".")
            if labels and all(_KUSTO_NAME_RE.match(l) for l in labels):
                return c
            raise ValueError(f"invalid ADX cluster identifier: {cluster!r}")

    # Bare name -> Commercial, matching the historical default.
    if _KUSTO_NAME_RE.match(c):
        return f"{c}.{_KUSTO_SUFFIXES[0]}"
    raise ValueError(f"invalid ADX cluster identifier: {cluster!r}")


# =====================================================================
# ADX (Kusto) executor
# =====================================================================


class KustoADXExecutor(ADXExecutor):
    """Executes KQL against an ADX cluster + database using the
    azure-kusto-data SDK with on-behalf-of token."""

    def __init__(
        self,
        msal_obo_acquirer: Callable[[str, list[str]], Awaitable[str]],
    ) -> None:
        self.msal = msal_obo_acquirer

    async def execute_kql(
        self,
        cluster: str,
        database: str,
        kql: str,
        user_obo_assertion: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]]]:
        # Resolve the cluster to ONE host and derive both the token audience and
        # the request URL from it. Previously these were derived independently:
        # the Gov branch rewrote `scope` but `url` stayed
        # f"https://{cluster}.kusto.windows.net/..." — so a Gov cluster produced
        # `mycluster.<...>.usgovcloudapi.net.kusto.windows.net`, a host that does
        # not exist. The Gov path could never have worked.
        host = _resolve_kusto_host(cluster)
        scope = f"https://{host}/.default"
        token = await self.msal(user_obo_assertion, [scope])

        # Use the v1/rest/query REST endpoint (cleaner than ingesting
        # the azure-kusto-data SDK as a hard dep here).
        url = f"https://{host}/v1/rest/query"
        # Append `| take N` if caller didn't include a limit
        if "| take " not in kql and "| limit " not in kql and "| top " not in kql:
            kql = f"{kql.rstrip(';')} | take {max_rows}"

        async with httpx.AsyncClient(timeout=60) as client:
            res = await client.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"db": database, "csl": kql},
            )
            res.raise_for_status()
            data = res.json()

        # Find the PrimaryResult table
        tables = data.get("Tables", [])
        primary = next((t for t in tables if t.get("TableName") == "Table_0"), tables[0] if tables else None)
        if not primary:
            return [], []
        columns = [c["ColumnName"] for c in primary.get("Columns", [])]
        rows = primary.get("Rows", [])
        return columns, rows


# =====================================================================
# Cosmos DB-backed config store
# =====================================================================


class CosmosDataAgentsConfigStore(DataAgentsConfigStore):
    """Loads per-agent configuration from the Cosmos DB
    `data-agents-config` database."""

    def __init__(self, cosmos_client: Any, database_name: str = "data-agents-config") -> None:
        self.cosmos = cosmos_client
        self.database_name = database_name

    async def get_schema(self, data_source_id: str) -> str:
        container = self.cosmos.database(self.database_name).container("schemas")
        try:
            item = await container.read_item(item=data_source_id, partition_key=data_source_id)
            return item.get("schema_text", "")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Schema not found for %s: %s", data_source_id, exc)
            return "(no schema registered — Data Agent should ask the user to register the source)"

    async def get_examples(self, source_id: str, kind: str) -> list[dict[str, str]]:
        container = self.cosmos.database(self.database_name).container("example-queries")
        query = "SELECT * FROM c WHERE c.sourceId = @sid AND c.kind = @kind"
        params = [{"name": "@sid", "value": source_id}, {"name": "@kind", "value": kind}]
        items = []
        async for item in container.query_items(query=query, parameters=params):
            items.append(item)
        return [{"question": i["question"], "query": i["query"]} for i in items]

    async def get_verified_answers(self, source_id: str) -> list[dict[str, str]]:
        container = self.cosmos.database(self.database_name).container("verified-answers")
        query = "SELECT * FROM c WHERE c.sourceId = @sid"
        params = [{"name": "@sid", "value": source_id}]
        items = []
        async for item in container.query_items(query=query, parameters=params):
            items.append(item)
        return [{"question": i["question"], "query": i["query"]} for i in items]

    async def get_tmdl(self, semantic_model_id: str) -> str:
        container = self.cosmos.database(self.database_name).container("schemas")
        try:
            item = await container.read_item(
                item=f"semantic-model:{semantic_model_id}", partition_key=semantic_model_id
            )
            return item.get("tmdl", "")
        except Exception:  # noqa: BLE001
            return ""

    async def get_kql_schema(self, source_id: str) -> str:
        return await self.get_schema(source_id)
