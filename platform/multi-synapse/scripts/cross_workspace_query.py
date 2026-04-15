"""Cross-workspace federated query runner for multi-org Synapse.

Enables federated queries across multiple Synapse workspaces by managing
external data sources and executing cross-workspace SQL or Spark queries.

Usage::

    # Run a federated query
    python cross_workspace_query.py query \\
        --workspace synapse-usda \\
        --database gold \\
        --sql "SELECT * FROM ext_dod.orders LIMIT 10"

    # List accessible databases
    python cross_workspace_query.py list-sources \\
        --workspace synapse-usda
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class ExternalDataSource:
    """An external data source definition for cross-workspace queries."""

    name: str
    source_workspace: str
    endpoint: str
    database: str
    credential_name: str = ""
    location: str = ""
    type: str = "SYNAPSE"

    def to_sql(self) -> str:
        """Generate the CREATE EXTERNAL DATA SOURCE T-SQL statement."""
        return (
            f"CREATE EXTERNAL DATA SOURCE [{self.name}]\n"
            f"WITH (\n"
            f"    TYPE = {self.type},\n"
            f"    LOCATION = N'{self.endpoint}',\n"
            f"    DATABASE_NAME = N'{self.database}'"
            f"{f',    CREDENTIAL = [{self.credential_name}]' if self.credential_name else ''}\n"
            f");"
        )


@dataclass
class QueryResult:
    """Result of a federated query execution."""

    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
    execution_time_ms: float = 0.0
    workspace: str = ""
    database: str = ""
    is_error: bool = False
    error_message: str = ""


@dataclass
class AccessibleDatabase:
    """A database accessible from a workspace."""

    name: str
    workspace: str
    type: str = "SQL"
    tables: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Cross-Workspace Query Runner
# ---------------------------------------------------------------------------


class CrossWorkspaceQueryRunner:
    """Execute federated queries across Synapse workspaces.

    Manages external data sources and provides a unified interface for
    cross-workspace SQL queries using Synapse Serverless SQL or
    dedicated SQL pools.

    Args:
        default_workspace: Default workspace endpoint.
        credential: Azure credential for authentication.
    """

    def __init__(
        self,
        default_workspace: str = "",
        credential: Any | None = None,
    ) -> None:
        self.default_workspace = default_workspace
        self._credential = credential
        self._connections: dict[str, Any] = {}

    def _get_connection(self, workspace_endpoint: str, database: str = "master") -> Any:
        """Get or create a pyodbc connection.

        Args:
            workspace_endpoint: Synapse SQL endpoint URL.
            database: Database name to connect to.

        Returns:
            pyodbc connection object.
        """
        cache_key = f"{workspace_endpoint}:{database}"
        if cache_key in self._connections:
            return self._connections[cache_key]

        import pyodbc

        if self._credential is None:
            from azure.identity import DefaultAzureCredential
            self._credential = DefaultAzureCredential()

        # Get access token for SQL
        token = self._credential.get_token("https://database.usgovcloudapi.net/.default")
        token_bytes = token.token.encode("utf-16-le")

        conn_str = (
            f"DRIVER={{ODBC Driver 18 for SQL Server}};"
            f"SERVER={workspace_endpoint};"
            f"DATABASE={database};"
            f"Encrypt=yes;"
            f"TrustServerCertificate=no;"
        )

        # Use access token authentication
        SQL_COPT_SS_ACCESS_TOKEN = 1256
        conn = pyodbc.connect(conn_str, attrs_before={SQL_COPT_SS_ACCESS_TOKEN: token_bytes})
        self._connections[cache_key] = conn

        logger.info("Connected to %s/%s", workspace_endpoint, database)
        return conn

    def create_external_data_source(
        self,
        workspace_endpoint: str,
        database: str,
        source: ExternalDataSource,
    ) -> dict[str, Any]:
        """Create an external data source for cross-workspace querying.

        Args:
            workspace_endpoint: Target workspace SQL endpoint.
            database: Database to create the external data source in.
            source: External data source configuration.

        Returns:
            Result dictionary with status.
        """
        conn = self._get_connection(workspace_endpoint, database)
        cursor = conn.cursor()

        # Check if it already exists
        cursor.execute(
            "SELECT name FROM sys.external_data_sources WHERE name = ?",
            source.name,
        )
        existing = cursor.fetchone()

        if existing:
            logger.info(
                "External data source '%s' already exists in %s/%s",
                source.name,
                workspace_endpoint,
                database,
            )
            return {"name": source.name, "status": "exists"}

        sql = source.to_sql()
        try:
            cursor.execute(sql)
            conn.commit()
            logger.info(
                "Created external data source '%s' -> %s/%s",
                source.name,
                source.endpoint,
                source.database,
            )
            return {"name": source.name, "status": "created"}
        except Exception as exc:
            logger.error("Failed to create external data source: %s", exc)
            return {"name": source.name, "status": "error", "error": str(exc)}

    def run_federated_query(
        self,
        workspace_endpoint: str,
        database: str,
        sql: str,
        parameters: list[Any] | None = None,
    ) -> QueryResult:
        """Execute a SQL query that may span multiple workspaces.

        Args:
            workspace_endpoint: Synapse SQL endpoint.
            database: Database context for the query.
            sql: T-SQL query string.
            parameters: Optional query parameters.

        Returns:
            Query result with columns, rows, and metadata.
        """
        import time

        start = time.monotonic()

        try:
            conn = self._get_connection(workspace_endpoint, database)
            cursor = conn.cursor()

            if parameters:
                cursor.execute(sql, parameters)
            else:
                cursor.execute(sql)

            columns = [desc[0] for desc in cursor.description] if cursor.description else []
            rows = [list(row) for row in cursor.fetchall()]

            elapsed = (time.monotonic() - start) * 1000

            logger.info(
                "Query returned %d rows in %.1fms from %s/%s",
                len(rows),
                elapsed,
                workspace_endpoint,
                database,
            )

            return QueryResult(
                columns=columns,
                rows=rows,
                row_count=len(rows),
                execution_time_ms=elapsed,
                workspace=workspace_endpoint,
                database=database,
            )

        except Exception as exc:
            elapsed = (time.monotonic() - start) * 1000
            logger.error("Query failed after %.1fms: %s", elapsed, exc)
            return QueryResult(
                workspace=workspace_endpoint,
                database=database,
                execution_time_ms=elapsed,
                is_error=True,
                error_message=str(exc),
            )

    def list_accessible_databases(
        self,
        workspace_endpoint: str,
    ) -> list[AccessibleDatabase]:
        """List all databases accessible from a workspace.

        Includes both local databases and databases reachable via
        external data sources.

        Args:
            workspace_endpoint: Synapse SQL endpoint.

        Returns:
            List of accessible database descriptors.
        """
        databases: list[AccessibleDatabase] = []

        # List local databases
        result = self.run_federated_query(
            workspace_endpoint,
            "master",
            "SELECT name, database_id FROM sys.databases WHERE state_desc = 'ONLINE'",
        )

        if not result.is_error:
            for row in result.rows:
                databases.append(AccessibleDatabase(
                    name=row[0],
                    workspace=workspace_endpoint,
                    type="local",
                ))

        # List external data sources from each database
        for db in list(databases):
            if db.name in ("master", "tempdb", "model", "msdb"):
                continue

            ext_result = self.run_federated_query(
                workspace_endpoint,
                db.name,
                "SELECT name, location, type FROM sys.external_data_sources",
            )

            if not ext_result.is_error:
                for row in ext_result.rows:
                    databases.append(AccessibleDatabase(
                        name=f"{db.name}.{row[0]}",
                        workspace=row[1] if row[1] else workspace_endpoint,
                        type="external",
                    ))

        logger.info(
            "Found %d accessible databases from %s",
            len(databases),
            workspace_endpoint,
        )
        return databases

    def close(self) -> None:
        """Close all open connections."""
        for key, conn in self._connections.items():
            try:
                conn.close()
            except Exception:
                pass
        self._connections.clear()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli_query(args: argparse.Namespace) -> None:
    """Handle the 'query' subcommand."""
    runner = CrossWorkspaceQueryRunner()
    result = runner.run_federated_query(
        args.workspace,
        args.database,
        args.sql,
    )

    if result.is_error:
        print(f"ERROR: {result.error_message}", file=sys.stderr)
        sys.exit(1)

    # Print as table
    if result.columns:
        header = " | ".join(f"{c:>15s}" for c in result.columns)
        print(header)
        print("-" * len(header))
        for row in result.rows:
            print(" | ".join(f"{str(v):>15s}" for v in row))

    print(f"\n({result.row_count} rows, {result.execution_time_ms:.1f}ms)")
    runner.close()


def _cli_list_sources(args: argparse.Namespace) -> None:
    """Handle the 'list-sources' subcommand."""
    runner = CrossWorkspaceQueryRunner()
    databases = runner.list_accessible_databases(args.workspace)

    print(f"\nAccessible databases from {args.workspace}:")
    for db in databases:
        print(f"  [{db.type:8s}] {db.name}")

    runner.close()


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box Cross-Workspace Query Runner",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # query
    query_parser = subparsers.add_parser("query", help="Run a federated SQL query")
    query_parser.add_argument("--workspace", required=True, help="Synapse SQL endpoint")
    query_parser.add_argument("--database", default="master", help="Database name")
    query_parser.add_argument("--sql", required=True, help="T-SQL query to execute")
    query_parser.set_defaults(func=_cli_query)

    # list-sources
    list_parser = subparsers.add_parser("list-sources", help="List accessible databases")
    list_parser.add_argument("--workspace", required=True, help="Synapse SQL endpoint")
    list_parser.set_defaults(func=_cli_list_sources)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
