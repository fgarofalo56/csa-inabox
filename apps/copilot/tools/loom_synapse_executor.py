"""Synapse Serverless SQL executor for Loom Data Agents.

Heavyweight: requires pyodbc + the Microsoft ODBC Driver 18 for SQL
Server installed on the host. Imported lazily so the rest of the
copilot stack can run without it.

Auth: AAD access token via DefaultAzureCredential → pyodbc connection
attribute SQL_COPT_SS_ACCESS_TOKEN (Microsoft pattern).
"""

from __future__ import annotations

import logging
import os
import struct
from typing import Any, Awaitable, Callable

from apps.copilot.tools.loom_data_agents import EngineDispatcher

logger = logging.getLogger(__name__)


SQL_COPT_SS_ACCESS_TOKEN = 1256  # pyodbc magic constant


class SynapseServerlessExecutor:
    """Executes T-SQL against a Synapse Serverless SQL pool endpoint
    using the caller's OBO token."""

    def __init__(
        self,
        msal_obo_acquirer: Callable[[str, list[str]], Awaitable[str]],
    ) -> None:
        self.msal = msal_obo_acquirer
        # Heavyweight: lazy import
        try:
            import pyodbc  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "pyodbc is required for SynapseServerlessExecutor. "
                "Install with `pip install pyodbc` plus the Microsoft "
                "ODBC Driver 18 for SQL Server."
            ) from exc

    @staticmethod
    def _build_token_struct(token: str) -> bytes:
        """SQL_COPT_SS_ACCESS_TOKEN expects a `ACCESSTOKEN` struct."""
        token_bytes = bytes(token, "utf-16-le")
        return struct.pack("=i", len(token_bytes)) + token_bytes

    async def execute_sql(
        self,
        synapse_endpoint: str,
        database: str,
        sql: str,
        user_obo_assertion: str,
        max_rows: int = 1000,
    ) -> tuple[list[str], list[list[Any]]]:
        """Execute T-SQL via pyodbc on the Synapse Serverless endpoint.

        Args:
            synapse_endpoint: full FQDN, e.g.,
                `syn-loom-default-eastus2-ondemand.sql.azuresynapse.net`
            database: T-SQL database name (`master` for ad-hoc, or a
                user-created DB)
            sql: the T-SQL statement
            user_obo_assertion: caller's OBO assertion
            max_rows: cap on returned rows
        """
        token = await self.msal(
            user_obo_assertion,
            ["https://database.windows.net/.default"],
        )
        token_struct = self._build_token_struct(token)

        # Import here so the module is importable on systems without pyodbc.
        import pyodbc
        import asyncio

        conn_str = (
            f"DRIVER={{ODBC Driver 18 for SQL Server}};"
            f"SERVER={synapse_endpoint};"
            f"DATABASE={database};"
            "Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;"
        )

        def _run() -> tuple[list[str], list[list[Any]]]:
            with pyodbc.connect(
                conn_str,
                attrs_before={SQL_COPT_SS_ACCESS_TOKEN: token_struct},
            ) as conn:
                with conn.cursor() as cur:
                    cur.execute(sql)
                    cols = [c[0] for c in cur.description]
                    rows = []
                    for i, row in enumerate(cur):
                        if i >= max_rows:
                            break
                        rows.append(list(row))
                    return cols, rows

        # pyodbc is blocking — run in a thread to keep the asyncio loop free
        return await asyncio.to_thread(_run)


class DatabricksOrSynapseDispatcherV2(EngineDispatcher):
    """Updated dispatcher that supports BOTH Databricks SQL AND Synapse
    Serverless via the real executor."""

    def __init__(
        self,
        config: Any,
        msal_obo_acquirer: Callable[[str, list[str]], Awaitable[str]],
    ) -> None:
        from apps.copilot.tools.loom_executors import DatabricksOrSynapseDispatcher
        self._db_dispatcher = DatabricksOrSynapseDispatcher(config, msal_obo_acquirer)
        self._synapse = SynapseServerlessExecutor(msal_obo_acquirer)
        self.config = config

    async def execute_sql(
        self,
        data_source_id: str,
        sql: str,
        user_obo_assertion: str,
        max_rows: int,
    ) -> tuple[list[str], list[list[Any]], str]:
        ds = await self._db_dispatcher._get_data_source(data_source_id)
        if ds["engine"] == "synapse-serverless":
            cols, rows = await self._synapse.execute_sql(
                synapse_endpoint=ds["synapse_endpoint"],
                database=ds.get("synapse_database", "master"),
                sql=sql,
                user_obo_assertion=user_obo_assertion,
                max_rows=max_rows,
            )
            return cols, rows, "synapse-serverless"
        # Fall through to Databricks path
        return await self._db_dispatcher.execute_sql(
            data_source_id, sql, user_obo_assertion, max_rows
        )
