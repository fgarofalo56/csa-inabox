"""
Data Query Plugin for Semantic Kernel

This plugin provides semantic kernel functions for querying data sources
including SQL via Synapse Serverless and KQL via Azure Data Explorer.
"""

import logging

import pandas as pd
import pyodbc
from azure.identity import DefaultAzureCredential
from azure.kusto.data import ClientRequestProperties, KustoClient, KustoConnectionStringBuilder
from azure.kusto.data.exceptions import KustoServiceError
from semantic_kernel.functions import kernel_function

logger = logging.getLogger(__name__)


class DataQueryPlugin:
    """Plugin for querying data sources using SQL and KQL."""

    def __init__(
        self,
        synapse_endpoint: str | None = None,
        adx_cluster_uri: str | None = None,
        credential: DefaultAzureCredential | None = None
    ):
        """
        Initialize the Data Query Plugin.

        Args:
            synapse_endpoint: Synapse serverless SQL endpoint
            adx_cluster_uri: Azure Data Explorer cluster URI
            credential: Azure credential for authentication
        """
        self.synapse_endpoint = synapse_endpoint
        self.adx_cluster_uri = adx_cluster_uri
        self.credential = credential or DefaultAzureCredential()
        self._kusto_client: KustoClient | None = None

    @property
    def kusto_client(self) -> KustoClient | None:
        """Get or create Kusto client."""
        if self._kusto_client is None and self.adx_cluster_uri:
            try:
                kcsb = KustoConnectionStringBuilder.with_azure_service_principal_authentication(
                    self.adx_cluster_uri,
                    self.credential
                )
                self._kusto_client = KustoClient(kcsb)
            except Exception as e:
                logger.error(f"Failed to create Kusto client: {e!s}")
                return None
        return self._kusto_client

    @kernel_function(
        description="Execute SQL query against Synapse serverless SQL pool",
        name="query_sql"
    )
    def query_sql(self, query: str, database: str = "master") -> str:
        """
        Execute SQL query against Synapse serverless SQL pool.

        Args:
            query: SQL query to execute
            database: Target database name

        Returns:
            Query results as JSON string or error message
        """
        try:
            if not self.synapse_endpoint:
                return "Error: Synapse endpoint not configured"

            # Create connection string for Synapse serverless
            connection_string = (
                f"Driver={{ODBC Driver 18 for SQL Server}};"
                f"Server={self.synapse_endpoint};"
                f"Database={database};"
                f"Authentication=ActiveDirectoryMSI;"
                f"Encrypt=yes;"
                f"TrustServerCertificate=no;"
                f"Connection Timeout=30;"
            )

            logger.info(f"Executing SQL query against database: {database}")
            logger.debug(f"Query: {query[:200]}...")

            with pyodbc.connect(connection_string) as conn:
                df = pd.read_sql(query, conn)

                if df.empty:
                    return "Query executed successfully but returned no results."

                # Convert to JSON with limited rows for response
                if len(df) > 100:
                    result_summary = f"Query returned {len(df)} rows. Showing first 100 rows."
                    df_limited = df.head(100)
                else:
                    result_summary = f"Query returned {len(df)} rows."
                    df_limited = df

                result = {
                    "summary": result_summary,
                    "columns": df_limited.columns.tolist(),
                    "data": df_limited.to_dict('records'),
                    "total_rows": len(df)
                }

                return str(result)

        except Exception as e:
            error_msg = f"SQL query execution failed: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Execute KQL query against Azure Data Explorer cluster",
        name="query_kql"
    )
    def query_kql(self, query: str, cluster: str, database: str) -> str:
        """
        Execute KQL query against Azure Data Explorer cluster.

        Args:
            query: KQL query to execute
            cluster: ADX cluster name
            database: Target database name

        Returns:
            Query results as JSON string or error message
        """
        try:
            if not self.kusto_client:
                return "Error: Kusto client not configured"

            logger.info(f"Executing KQL query against cluster: {cluster}, database: {database}")
            logger.debug(f"Query: {query[:200]}...")

            # Create request properties for query
            request_properties = ClientRequestProperties()
            request_properties.set_option(ClientRequestProperties.results_defer_partial_query_failures_option_name, False)

            # Execute query
            response = self.kusto_client.execute(database, query, request_properties)

            # Convert response to DataFrame
            df = response.primary_results[0].to_dataframe()

            if df.empty:
                return "Query executed successfully but returned no results."

            # Convert to JSON with limited rows for response
            if len(df) > 100:
                result_summary = f"Query returned {len(df)} rows. Showing first 100 rows."
                df_limited = df.head(100)
            else:
                result_summary = f"Query returned {len(df)} rows."
                df_limited = df

            result = {
                "summary": result_summary,
                "columns": df_limited.columns.tolist(),
                "data": df_limited.to_dict('records'),
                "total_rows": len(df)
            }

            return str(result)

        except KustoServiceError as e:
            error_msg = f"KQL query execution failed: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"
        except Exception as e:
            error_msg = f"Unexpected error during KQL query: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="List available tables in a database",
        name="list_tables"
    )
    def list_tables(self, database: str, source_type: str = "sql") -> str:
        """
        List available tables in a database.

        Args:
            database: Database name to query
            source_type: Type of data source ('sql' for Synapse, 'kql' for ADX)

        Returns:
            List of tables as JSON string or error message
        """
        try:
            if source_type.lower() == "sql":
                if not self.synapse_endpoint:
                    return "Error: Synapse endpoint not configured"

                query = """
                SELECT
                    TABLE_SCHEMA as schema_name,
                    TABLE_NAME as table_name,
                    TABLE_TYPE as table_type
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
                ORDER BY TABLE_SCHEMA, TABLE_NAME
                """
                return self.query_sql(query, database)

            if source_type.lower() == "kql":
                if not self.kusto_client:
                    return "Error: Kusto client not configured"

                query = ".show tables"
                return self.query_kql(query, "", database)

            return f"Error: Unsupported source type: {source_type}"

        except Exception as e:
            error_msg = f"Failed to list tables: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Get schema information for a specific table",
        name="describe_table"
    )
    def describe_table(self, table: str, database: str, source_type: str = "sql") -> str:
        """
        Get schema information for a specific table.

        Args:
            table: Table name to describe
            database: Database name
            source_type: Type of data source ('sql' for Synapse, 'kql' for ADX)

        Returns:
            Table schema information as JSON string or error message
        """
        try:
            if source_type.lower() == "sql":
                if not self.synapse_endpoint:
                    return "Error: Synapse endpoint not configured"

                # Parse schema and table name
                if '.' in table:
                    schema_name, table_name = table.split('.', 1)
                else:
                    schema_name = 'dbo'
                    table_name = table

                query = f"""
                SELECT
                    COLUMN_NAME as column_name,
                    DATA_TYPE as data_type,
                    IS_NULLABLE as is_nullable,
                    COLUMN_DEFAULT as default_value,
                    CHARACTER_MAXIMUM_LENGTH as max_length,
                    NUMERIC_PRECISION as precision,
                    NUMERIC_SCALE as scale
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = '{schema_name}'
                  AND TABLE_NAME = '{table_name}'
                ORDER BY ORDINAL_POSITION
                """
                return self.query_sql(query, database)

            if source_type.lower() == "kql":
                if not self.kusto_client:
                    return "Error: Kusto client not configured"

                query = f".show table {table} schema as json"
                return self.query_kql(query, "", database)

            return f"Error: Unsupported source type: {source_type}"

        except Exception as e:
            error_msg = f"Failed to describe table {table}: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"

    @kernel_function(
        description="Get sample data from a table",
        name="sample_table_data"
    )
    def sample_table_data(self, table: str, database: str, rows: int = 10, source_type: str = "sql") -> str:
        """
        Get sample data from a table.

        Args:
            table: Table name to sample
            database: Database name
            rows: Number of sample rows to return
            source_type: Type of data source ('sql' for Synapse, 'kql' for ADX)

        Returns:
            Sample data as JSON string or error message
        """
        try:
            if source_type.lower() == "sql":
                query = f"SELECT TOP {rows} * FROM {table}"
                return self.query_sql(query, database)

            if source_type.lower() == "kql":
                query = f"{table} | take {rows}"
                return self.query_kql(query, "", database)

            return f"Error: Unsupported source type: {source_type}"

        except Exception as e:
            error_msg = f"Failed to sample table {table}: {e!s}"
            logger.error(error_msg)
            return f"Error: {error_msg}"
