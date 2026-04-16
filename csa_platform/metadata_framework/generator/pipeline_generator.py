"""Pipeline Generator for CSA-in-a-Box Metadata-Driven Framework.

This module generates Azure Data Factory pipelines from metadata definitions.
It validates source registrations against JSON Schema, selects appropriate
pipeline templates, and outputs deployable ARM/Bicep templates.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from jsonschema import ValidationError, validate  # type: ignore[import-untyped]

from governance.common.logging import configure_structlog, get_logger

# Configure structured logging
configure_structlog(service="metadata-framework-pipeline-generator")
logger = get_logger(__name__)


@dataclass
class PipelineGenerationResult:
    """Result of pipeline generation operation."""

    pipeline_id: str
    pipeline_name: str
    template_type: str
    arm_template: dict[str, Any]
    bicep_template: str | None = None
    parameters_file: dict[str, Any] | None = None
    deployment_config: dict[str, Any] | None = None


@dataclass
class SourceDetectionResult:
    """Result of automatic schema detection."""

    tables: list[dict[str, Any]]
    estimated_row_counts: dict[str, int]
    primary_keys: dict[str, list[str]]
    data_types: dict[str, dict[str, str]]
    recommended_watermark_columns: dict[str, list[str]]


class SchemaDetectionError(Exception):
    """Raised when schema detection fails."""


class PipelineGenerationError(Exception):
    """Raised when pipeline generation fails."""


def _infer_column_type(values: list[str]) -> str:
    """Infer column type from a sample of string values."""
    if not values:
        return "string"

    # Try integer
    try:
        for v in values[:100]:
            int(v)
        return "integer"
    except (ValueError, TypeError):
        pass

    # Try float
    try:
        for v in values[:100]:
            float(v)
        return "float"
    except (ValueError, TypeError):
        pass

    # Try boolean
    bool_values = {"true", "false", "yes", "no", "1", "0"}
    if all(v.lower() in bool_values for v in values[:100]):
        return "boolean"

    # Try datetime (ISO format)
    from datetime import datetime as dt

    try:
        for v in values[:20]:
            dt.fromisoformat(v.replace("Z", "+00:00"))
        return "datetime"
    except (ValueError, TypeError):
        pass

    return "string"


class PipelineGenerator:
    """Generates ADF pipelines from metadata source registrations.

    This is the core engine that takes a source registration (YAML/JSON),
    validates it against the schema, selects the appropriate template,
    and generates a complete ADF pipeline definition with ARM templates.
    """

    def __init__(
        self,
        template_directory: Path | None = None,
        schema_directory: Path | None = None,
        output_directory: Path | None = None,
        debug: bool = False,
    ) -> None:
        """Initialize the pipeline generator.

        Args:
            template_directory: Path to ADF pipeline templates
            schema_directory: Path to JSON schemas
            output_directory: Path for generated outputs
            debug: Enable debug logging and validation
        """
        self.debug = debug

        # Set default paths relative to this module
        framework_root = Path(__file__).parent.parent
        self.template_directory = template_directory or framework_root / "templates"
        self.schema_directory = schema_directory or framework_root / "schema"
        self.output_directory = output_directory or framework_root / "output"

        # Ensure output directory exists
        self.output_directory.mkdir(parents=True, exist_ok=True)

        # Load JSON schemas
        self._load_schemas()

        # Template mapping
        self.template_mapping = {
            ("sql_server", "full"): "adf_batch_copy.json",
            ("sql_server", "incremental"): "adf_incremental.json",
            ("sql_server", "cdc"): "adf_cdc.json",
            ("azure_sql", "full"): "adf_batch_copy.json",
            ("azure_sql", "incremental"): "adf_incremental.json",
            ("azure_sql", "cdc"): "adf_cdc.json",
            ("cosmos_db", "full"): "adf_batch_copy.json",
            ("cosmos_db", "incremental"): "adf_incremental.json",
            ("cosmos_db", "cdc"): "adf_cdc.json",
            ("rest_api", "full"): "adf_api_ingestion.json",
            ("rest_api", "incremental"): "adf_api_ingestion.json",
            ("file_drop", "full"): "adf_batch_copy.json",
            ("file_drop", "incremental"): "adf_incremental.json",
            ("blob_storage", "full"): "adf_batch_copy.json",
            ("blob_storage", "incremental"): "adf_incremental.json",
            ("event_hub", "streaming"): "adf_streaming.json",
            ("kafka", "streaming"): "adf_streaming.json",
            ("s3", "full"): "adf_batch_copy.json",
            ("s3", "incremental"): "adf_incremental.json",
            ("oracle", "full"): "adf_batch_copy.json",
            ("oracle", "incremental"): "adf_incremental.json",
            ("oracle", "cdc"): "adf_cdc.json",
            ("mysql", "full"): "adf_batch_copy.json",
            ("mysql", "incremental"): "adf_incremental.json",
            ("mysql", "cdc"): "adf_cdc.json",
            ("postgres", "full"): "adf_batch_copy.json",
            ("postgres", "incremental"): "adf_incremental.json",
            ("postgres", "cdc"): "adf_cdc.json",
            ("sharepoint", "full"): "adf_batch_copy.json",
            ("sharepoint", "incremental"): "adf_incremental.json",
            ("dynamics365", "full"): "adf_api_ingestion.json",
            ("dynamics365", "incremental"): "adf_api_ingestion.json",
        }

        logger.info(
            "Pipeline generator initialized",
            template_dir=str(self.template_directory),
            schema_dir=str(self.schema_directory),
            output_dir=str(self.output_directory),
        )

    def _load_schemas(self) -> None:
        """Load JSON schemas for validation."""
        try:
            # Load source registration schema
            source_schema_path = self.schema_directory / "source_registration.json"
            with open(source_schema_path, encoding="utf-8") as f:
                self.source_schema = json.load(f)

            # Load pipeline template schema
            pipeline_schema_path = self.schema_directory / "pipeline_template.json"
            with open(pipeline_schema_path, encoding="utf-8") as f:
                self.pipeline_schema = json.load(f)

            logger.info("JSON schemas loaded successfully")

        except FileNotFoundError as e:
            raise PipelineGenerationError(f"Schema file not found: {e}") from e
        except json.JSONDecodeError as e:
            raise PipelineGenerationError(f"Invalid JSON in schema file: {e}") from e

    def validate_source_registration(self, source_config: dict[str, Any]) -> None:
        """Validate source registration against JSON schema.

        Args:
            source_config: Source registration dictionary

        Raises:
            PipelineGenerationError: If validation fails
        """
        try:
            validate(instance=source_config, schema=self.source_schema)
            logger.info("Source registration validation passed", source_id=source_config.get("source_id"))

        except ValidationError as e:
            logger.error("Source registration validation failed", error=str(e), schema_path=list(e.absolute_path))
            raise PipelineGenerationError(f"Schema validation failed: {e.message}") from e

    def detect_source_schema(
        self, source_config: dict[str, Any], connection_test: bool = True
    ) -> SourceDetectionResult:
        """Automatically detect schema from the source system.

        Args:
            source_config: Source configuration
            connection_test: Whether to test connection before detection

        Returns:
            SourceDetectionResult with detected schema information

        Raises:
            SchemaDetectionError: If schema detection fails
        """
        _ = connection_test  # Accepted but unused for now
        source_type = source_config["source_type"]
        logger.info("Starting schema detection", source_type=source_type, source_id=source_config.get("source_id"))

        try:
            if source_type in ["sql_server", "azure_sql", "oracle", "mysql", "postgres"]:
                return self._detect_database_schema(source_config)
            if source_type == "rest_api":
                return self._detect_api_schema(source_config)
            if source_type == "cosmos_db":
                return self._detect_cosmos_schema(source_config)
            if source_type in ["file_drop", "blob_storage", "s3"]:
                return self._detect_file_schema(source_config)
            if source_type in ["event_hub", "kafka"]:
                return self._detect_stream_schema(source_config)
            raise SchemaDetectionError(f"Schema detection not implemented for {source_type}")

        except Exception as e:
            logger.exception("Schema detection failed", source_type=source_type)
            raise SchemaDetectionError(f"Schema detection failed: {e}") from e

    def _detect_database_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema by querying INFORMATION_SCHEMA from a relational database."""
        import pyodbc  # type: ignore[import-not-found]

        conn_str = source_config.get("connection_string", "")
        schema_name = source_config.get("schema", "dbo")

        if not conn_str:
            host = source_config.get("host", "localhost")
            port = source_config.get("port", 1433)
            database = source_config.get("database", "master")
            driver = source_config.get("driver", "{ODBC Driver 18 for SQL Server}")
            # Build connection string — use trusted connection or credentials
            if source_config.get("use_managed_identity", False):
                conn_str = f"Driver={driver};Server={host},{port};Database={database};Authentication=ActiveDirectoryMsi"
            else:
                username = source_config.get("username", "")
                password_ref = source_config.get("password_secret", "")
                conn_str = f"Driver={driver};Server={host},{port};Database={database};UID={username};PWD={password_ref}"

        logger.info("Connecting to database for schema detection", schema=schema_name)

        tables: list[dict[str, Any]] = []
        estimated_row_counts: dict[str, int] = {}
        primary_keys: dict[str, list[str]] = {}
        data_types: dict[str, dict[str, str]] = {}
        watermark_columns: dict[str, list[str]] = {}

        try:
            with pyodbc.connect(conn_str, timeout=30) as conn:
                cursor = conn.cursor()

                # Get all tables in schema
                cursor.execute("""
                    SELECT TABLE_NAME
                    FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
                    ORDER BY TABLE_NAME
                """, schema_name)
                table_names = [row.TABLE_NAME for row in cursor.fetchall()]

                for table_name in table_names:
                    # Get columns
                    cursor.execute("""
                        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE,
                               CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
                               COLUMN_DEFAULT
                        FROM INFORMATION_SCHEMA.COLUMNS
                        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                        ORDER BY ORDINAL_POSITION
                    """, schema_name, table_name)

                    columns = []
                    table_types: dict[str, str] = {}
                    potential_watermarks: list[str] = []

                    for col in cursor.fetchall():
                        col_info: dict[str, Any] = {
                            "name": col.COLUMN_NAME,
                            "type": col.DATA_TYPE,
                            "nullable": col.IS_NULLABLE == "YES",
                        }
                        if col.CHARACTER_MAXIMUM_LENGTH:
                            col_info["max_length"] = col.CHARACTER_MAXIMUM_LENGTH
                        if col.NUMERIC_PRECISION:
                            col_info["precision"] = col.NUMERIC_PRECISION
                            col_info["scale"] = col.NUMERIC_SCALE or 0
                        columns.append(col_info)
                        table_types[col.COLUMN_NAME] = col.DATA_TYPE

                        # Identify watermark candidates (datetime/timestamp columns)
                        if col.DATA_TYPE in ("datetime", "datetime2", "timestamp", "datetimeoffset", "date"):
                            potential_watermarks.append(col.COLUMN_NAME)

                    # Get primary keys
                    cursor.execute("""
                        SELECT c.COLUMN_NAME
                        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                        JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE c
                          ON tc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
                        WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
                          AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                        ORDER BY c.ORDINAL_POSITION
                    """, schema_name, table_name)
                    pk_cols = [row.COLUMN_NAME for row in cursor.fetchall()]

                    # Mark PK columns
                    for col in columns:
                        col["is_primary_key"] = col["name"] in pk_cols

                    # Estimated row count (from sys.partitions for speed)
                    try:
                        cursor.execute("""
                            SELECT SUM(p.rows) AS row_count
                            FROM sys.partitions p
                            JOIN sys.tables t ON p.object_id = t.object_id
                            JOIN sys.schemas s ON t.schema_id = s.schema_id
                            WHERE s.name = ? AND t.name = ? AND p.index_id IN (0, 1)
                        """, schema_name, table_name)
                        row = cursor.fetchone()
                        estimated_row_counts[table_name] = int(row.row_count) if row and row.row_count else 0
                    except Exception:
                        logger.warning("row_count.estimation_failed", table=table_name)
                        estimated_row_counts[table_name] = -1  # Unknown

                    tables.append({"table_name": table_name, "schema": schema_name, "columns": columns})
                    if pk_cols:
                        primary_keys[table_name] = pk_cols
                    data_types[table_name] = table_types
                    if potential_watermarks:
                        watermark_columns[table_name] = potential_watermarks

            logger.info("Schema detection complete", tables_found=len(tables))

        except pyodbc.Error as exc:
            logger.error("Database connection failed", error=str(exc))
            raise SchemaDetectionError(f"Database connection failed: {exc}") from exc

        return SourceDetectionResult(
            tables=tables,
            estimated_row_counts=estimated_row_counts,
            primary_keys=primary_keys,
            data_types=data_types,
            recommended_watermark_columns=watermark_columns,
        )

    def _detect_api_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema by sampling a REST API endpoint response."""
        import requests

        api_url = source_config.get("api_url", "")
        auth_method = source_config.get("authentication_method", "none")
        headers: dict[str, str] = source_config.get("headers", {})

        if not api_url:
            raise SchemaDetectionError("api_url is required for REST API schema detection")

        # Add authentication
        if auth_method == "api_key":
            key_header = source_config.get("api_key_header", "X-API-Key")
            key_value = source_config.get("api_key", "")
            headers[key_header] = key_value
        elif auth_method == "bearer":
            token = source_config.get("bearer_token", "")
            headers["Authorization"] = f"Bearer {token}"

        logger.info("Sampling API endpoint for schema detection", url=api_url)

        try:
            response = requests.get(api_url, headers=headers, timeout=30)
            response.raise_for_status()
            data = response.json()
        except requests.RequestException as exc:
            raise SchemaDetectionError(f"API request failed: {exc}") from exc
        except ValueError as exc:
            raise SchemaDetectionError(f"Response is not valid JSON: {exc}") from exc

        # Infer schema from response
        def infer_columns(sample: dict[str, Any]) -> list[dict[str, Any]]:
            columns = []
            for key, value in sample.items():
                col_type = type(value).__name__
                type_map = {
                    "str": "string",
                    "int": "integer",
                    "float": "float",
                    "bool": "boolean",
                    "NoneType": "string",
                    "list": "array",
                    "dict": "object",
                }
                columns.append({
                    "name": key,
                    "type": type_map.get(col_type, "string"),
                    "nullable": value is None,
                })
            return columns

        # Handle different response shapes
        if isinstance(data, list) and len(data) > 0:
            sample = data[0] if isinstance(data[0], dict) else {"value": data[0]}
            columns = infer_columns(sample)
            estimated_count = len(data)
        elif isinstance(data, dict):
            # Check common pagination patterns
            columns = None
            estimated_count = 1
            for key in ("results", "data", "items", "value", "records"):
                if key in data and isinstance(data[key], list) and len(data[key]) > 0:
                    sample = data[key][0] if isinstance(data[key][0], dict) else {"value": data[key][0]}
                    columns = infer_columns(sample)
                    _raw_count = data.get("total", data.get("count", len(data[key])))
                    estimated_count = int(_raw_count) if _raw_count is not None else len(data[key])
                    break
            if columns is None:
                columns = infer_columns(data)
        else:
            raise SchemaDetectionError("Cannot infer schema from empty or non-JSON response")

        table_name = source_config.get("entity_name", "api_response")

        return SourceDetectionResult(
            tables=[{"table_name": table_name, "columns": columns}],
            estimated_row_counts={table_name: estimated_count},
            primary_keys={},
            data_types={table_name: {c["name"]: c["type"] for c in (columns or [])}},
            recommended_watermark_columns={},
        )

    def _detect_cosmos_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema by sampling documents from a Cosmos DB container."""
        from azure.cosmos import CosmosClient
        from azure.identity import DefaultAzureCredential

        endpoint = source_config.get("endpoint", "")
        database_name = source_config.get("database", "")
        container_name = source_config.get("container", "")
        sample_size = source_config.get("sample_size", 100)

        if not all([endpoint, database_name, container_name]):
            raise SchemaDetectionError("endpoint, database, and container are required for Cosmos DB schema detection")

        logger.info("Sampling Cosmos DB for schema detection",
                    endpoint=endpoint, database=database_name, container=container_name)

        try:
            # Prefer Managed Identity, fall back to key
            if source_config.get("account_key"):
                client = CosmosClient(endpoint, credential=source_config["account_key"])
            else:
                client = CosmosClient(endpoint, credential=DefaultAzureCredential())

            database = client.get_database_client(database_name)
            container = database.get_container_client(container_name)

            # Sample documents
            query = f"SELECT TOP {sample_size} * FROM c"
            documents = list(container.query_items(query=query, enable_cross_partition_query=True))
        except Exception as exc:
            raise SchemaDetectionError(f"Cosmos DB connection failed: {exc}") from exc

        if not documents:
            return SourceDetectionResult(
                tables=[{"table_name": container_name, "columns": []}],
                estimated_row_counts={container_name: 0},
                primary_keys={container_name: ["id"]},
                data_types={},
                recommended_watermark_columns={},
            )

        # Merge schemas across sampled documents
        all_fields: dict[str, set[str]] = {}
        for doc in documents:
            for key, value in doc.items():
                if key.startswith("_"):  # Skip Cosmos system properties
                    continue
                col_type = type(value).__name__
                if key not in all_fields:
                    all_fields[key] = set()
                all_fields[key].add(col_type)

        type_map = {"str": "string", "int": "integer", "float": "float", "bool": "boolean",
                     "NoneType": "string", "list": "array", "dict": "object"}

        columns = []
        cosmos_data_types: dict[str, str] = {}
        watermark_candidates: list[str] = []

        for field_name, types in all_fields.items():
            # Pick the most common non-null type
            dominant_type = next((t for t in types if t != "NoneType"), "string")
            mapped_type = type_map.get(dominant_type, "string")
            nullable = "NoneType" in types or len([d for d in documents if field_name not in d]) > 0

            columns.append({
                "name": field_name,
                "type": mapped_type,
                "nullable": nullable,
            })
            cosmos_data_types[field_name] = mapped_type

            # Identify potential watermarks
            if field_name.lower() in ("createdat", "created_at", "modifiedat", "modified_at",
                                       "timestamp", "_ts", "updated_at"):
                watermark_candidates.append(field_name)

        return SourceDetectionResult(
            tables=[{"table_name": container_name, "columns": columns}],
            estimated_row_counts={container_name: len(documents)},  # Approximation from sample
            primary_keys={container_name: ["id"]},
            data_types={container_name: cosmos_data_types},
            recommended_watermark_columns={container_name: watermark_candidates} if watermark_candidates else {},
        )

    def _detect_file_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema by sampling files from blob storage or local filesystem."""
        import io

        file_path = source_config.get("file_path", "")
        file_format = source_config.get("format", "").lower()
        container = source_config.get("container", "")
        storage_account = source_config.get("storage_account", "")

        logger.info("Detecting file schema", path=file_path, format=file_format)

        # Read sample data
        if storage_account and container:
            # Azure Blob Storage
            from azure.identity import DefaultAzureCredential
            from azure.storage.blob import BlobServiceClient

            try:
                blob_url = f"https://{storage_account}.blob.core.windows.net"
                blob_client = BlobServiceClient(blob_url, credential=DefaultAzureCredential())
                blob = blob_client.get_blob_client(container=container, blob=file_path)
                # Download first 10MB for sampling
                download = blob.download_blob(max_concurrency=1, length=10 * 1024 * 1024)
                raw_data = download.readall()
            except Exception as exc:
                raise SchemaDetectionError(f"Failed to read blob: {exc}") from exc
        elif file_path:
            try:
                with open(file_path, "rb") as f:
                    raw_data = f.read(10 * 1024 * 1024)
            except OSError as exc:
                raise SchemaDetectionError(f"Failed to read file: {exc}") from exc
        else:
            raise SchemaDetectionError("Either file_path or storage_account+container is required")

        # Auto-detect format from extension if not specified
        if not file_format:
            if file_path.endswith(".parquet"):
                file_format = "parquet"
            elif file_path.endswith(".csv"):
                file_format = "csv"
            elif file_path.endswith((".json", ".jsonl")):
                file_format = "json"
            else:
                file_format = "csv"  # Default assumption

        columns: list[dict[str, Any]] = []
        row_count = 0

        if file_format == "parquet":
            try:
                import pyarrow.parquet as pq  # type: ignore[import-untyped]

                table = pq.read_table(io.BytesIO(raw_data))
                schema = table.schema
                columns = [
                    {"name": pq_field.name, "type": str(pq_field.type), "nullable": pq_field.nullable}
                    for pq_field in schema
                ]
                row_count = table.num_rows
            except ImportError:
                raise SchemaDetectionError("pyarrow is required for Parquet schema detection") from None
            except Exception as exc:
                raise SchemaDetectionError(f"Failed to parse Parquet: {exc}") from exc

        elif file_format == "csv":
            import csv as csv_module

            reader = csv_module.reader(io.StringIO(raw_data.decode("utf-8", errors="replace")))
            header = next(reader, None)
            if not header:
                raise SchemaDetectionError("CSV file is empty or has no header")

            # Sample rows to infer types
            sample_rows = []
            for i, row in enumerate(reader):
                sample_rows.append(row)
                if i >= 999:
                    break
            row_count = len(sample_rows)

            for col_idx, col_name in enumerate(header):
                # Infer type from sample values
                col_values = [r[col_idx] for r in sample_rows if col_idx < len(r) and r[col_idx].strip()]
                inferred_type = _infer_column_type(col_values)
                has_nulls = any(col_idx >= len(r) or not r[col_idx].strip() for r in sample_rows)
                columns.append({"name": col_name.strip(), "type": inferred_type, "nullable": has_nulls})

        elif file_format == "json":
            import json as json_module

            try:
                text = raw_data.decode("utf-8")
                # Try JSONL first
                lines = text.strip().split("\n")
                if len(lines) > 1:
                    records = [json_module.loads(line) for line in lines[:1000] if line.strip()]
                else:
                    data = json_module.loads(text)
                    records = data if isinstance(data, list) else [data]
            except (ValueError, json_module.JSONDecodeError) as exc:
                raise SchemaDetectionError(f"Failed to parse JSON: {exc}") from exc

            if records and isinstance(records[0], dict):
                all_keys: dict[str, set[str]] = {}
                for rec in records:
                    for k, v in rec.items():
                        if k not in all_keys:
                            all_keys[k] = set()
                        all_keys[k].add(type(v).__name__)

                file_type_map = {"str": "string", "int": "integer", "float": "float",
                                 "bool": "boolean", "NoneType": "string"}
                columns = [
                    {
                        "name": k,
                        "type": file_type_map.get(next(iter(v - {"NoneType"}), "str"), "string"),
                        "nullable": "NoneType" in v,
                    }
                    for k, v in all_keys.items()
                ]
                row_count = len(records)

        table_name = source_config.get(
            "entity_name", file_path.split("/")[-1].split(".")[0] if file_path else "file_data"
        )

        return SourceDetectionResult(
            tables=[{"table_name": table_name, "columns": columns}],
            estimated_row_counts={table_name: row_count},
            primary_keys={},
            data_types={table_name: {c["name"]: c["type"] for c in columns}},
            recommended_watermark_columns={},
        )

    def _detect_stream_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema by consuming sample events from Event Hub or Kafka."""

        source_type = source_config.get("source_type", "event_hub")

        if source_type == "event_hub":
            from azure.eventhub import EventHubConsumerClient
            from azure.identity import DefaultAzureCredential

            namespace = source_config.get("event_hub_namespace", "")
            hub_name = source_config.get("event_hub_name", "")
            consumer_group = source_config.get("consumer_group", "$Default")
            sample_count = source_config.get("sample_size", 50)

            if not all([namespace, hub_name]):
                raise SchemaDetectionError("event_hub_namespace and event_hub_name are required")

            logger.info("Sampling Event Hub for schema detection",
                        namespace=namespace, hub=hub_name)

            samples: list[dict[str, Any]] = []

            def on_event(_partition_context, event):
                if event and len(samples) < sample_count:
                    try:
                        body = event.body_as_json()
                        if isinstance(body, dict):
                            samples.append(body)
                    except (ValueError, TypeError):
                        pass  # Skip non-JSON events
                if len(samples) >= sample_count:
                    raise StopIteration  # Signal to stop

            try:
                fqns = f"{namespace}.servicebus.windows.net"
                client = EventHubConsumerClient(
                    fully_qualified_namespace=fqns,
                    eventhub_name=hub_name,
                    consumer_group=consumer_group,
                    credential=DefaultAzureCredential(),
                )
                with client, contextlib.suppress(StopIteration):
                    client.receive(on_event=on_event, starting_position="-1", max_wait_time=10)
            except Exception as exc:
                raise SchemaDetectionError(f"Event Hub connection failed: {exc}") from exc

            if not samples:
                return SourceDetectionResult(
                    tables=[{"table_name": hub_name, "columns": []}],
                    estimated_row_counts={},
                    primary_keys={},
                    data_types={},
                    recommended_watermark_columns={hub_name: ["enqueuedTime"]},
                )

            # Merge schemas from samples
            all_fields: dict[str, set[str]] = {}
            for sample in samples:
                for key, value in sample.items():
                    if key not in all_fields:
                        all_fields[key] = set()
                    all_fields[key].add(type(value).__name__)

            type_map = {"str": "string", "int": "integer", "float": "float", "bool": "boolean",
                         "NoneType": "string", "list": "array", "dict": "object"}

            columns: list[dict[str, Any]] = [
                {"name": k, "type": type_map.get(next(iter(v - {"NoneType"}), "str"), "string"),
                 "nullable": "NoneType" in v or len([s for s in samples if k not in s]) > 0}
                for k, v in all_fields.items()
            ]

            return SourceDetectionResult(
                tables=[{"table_name": hub_name, "columns": columns}],
                estimated_row_counts={hub_name: len(samples)},
                primary_keys={},
                data_types={hub_name: {c["name"]: c["type"] for c in columns}},
                recommended_watermark_columns={hub_name: ["enqueuedTime", "timestamp"]},
            )

        raise SchemaDetectionError(f"Stream schema detection not yet implemented for {source_type}")

    def select_template(self, source_type: str, ingestion_mode: str) -> str:
        """Select appropriate pipeline template.

        Args:
            source_type: Type of data source
            ingestion_mode: Ingestion mode (full, incremental, cdc, streaming)

        Returns:
            Template filename

        Raises:
            PipelineGenerationError: If no template exists for the combination
        """
        template_key = (source_type, ingestion_mode)

        if template_key not in self.template_mapping:
            available_combinations = list(self.template_mapping.keys())
            raise PipelineGenerationError(
                f"No template available for {source_type} with {ingestion_mode} mode. "
                f"Available combinations: {available_combinations}"
            )

        template_name = self.template_mapping[template_key]
        logger.info("Template selected", source_type=source_type, ingestion_mode=ingestion_mode, template=template_name)

        return template_name

    def generate_pipeline_name(self, source_config: dict[str, Any]) -> str:
        """Generate a unique pipeline name from source configuration.

        Args:
            source_config: Source configuration

        Returns:
            Generated pipeline name
        """
        source_name = source_config["source_name"]
        ingestion_mode = source_config["ingestion"]["mode"]

        # Clean source name for pipeline naming
        clean_name = "".join(c for c in source_name if c.isalnum() or c in "- _").strip()
        clean_name = clean_name.replace(" ", "_").replace("-", "_").lower()

        pipeline_name = f"pl_{clean_name}_{ingestion_mode}"

        # Ensure name is valid for ADF (max 260 chars, alphanumeric + underscores)
        if len(pipeline_name) > 240:  # Leave room for suffix
            pipeline_name = pipeline_name[:240]

        return pipeline_name

    def load_template(self, template_name: str) -> dict[str, Any]:
        """Load ARM template from file.

        Args:
            template_name: Name of template file

        Returns:
            ARM template as dictionary

        Raises:
            PipelineGenerationError: If template cannot be loaded
        """
        template_path = self.template_directory / template_name

        try:
            with open(template_path, encoding="utf-8") as f:
                template: dict[str, Any] = json.load(f)

            logger.info("Template loaded", template=template_name)
            return template

        except FileNotFoundError as e:
            raise PipelineGenerationError(f"Template not found: {template_path}") from e
        except json.JSONDecodeError as e:
            raise PipelineGenerationError(f"Invalid JSON in template: {e}") from e

    def customize_template(self, template: dict[str, Any], source_config: dict[str, Any]) -> dict[str, Any]:
        """Customize template with source-specific parameters.

        Args:
            template: ARM template
            source_config: Source configuration

        Returns:
            Customized ARM template
        """
        # Clone template to avoid modifying original
        customized: dict[str, Any] = json.loads(json.dumps(template))

        # Update parameters with source-specific values
        pipeline_name = self.generate_pipeline_name(source_config)

        # Common parameters
        if "parameters" not in customized:
            customized["parameters"] = {}

        customized["parameters"].update({"pipelineName": {"type": "string", "defaultValue": pipeline_name}})

        # Add source-specific parameters based on source type
        source_type = source_config["source_type"]

        if source_type in ["sql_server", "azure_sql", "oracle", "mysql", "postgres"]:
            self._customize_database_template(customized, source_config)
        elif source_type == "rest_api":
            self._customize_api_template(customized, source_config)
        elif source_type in ["event_hub", "kafka"]:
            self._customize_streaming_template(customized, source_config)

        logger.info("Template customized", pipeline_name=pipeline_name, source_type=source_type)

        return customized

    def _customize_database_template(self, template: dict[str, Any], source_config: dict[str, Any]) -> None:
        """Customize template for database sources."""
        connection = source_config["connection"]
        ingestion = source_config["ingestion"]

        # Add database-specific parameters
        template["parameters"].update(
            {
                "serverName": {"type": "string", "defaultValue": connection["server"]},
                "databaseName": {"type": "string", "defaultValue": connection["database"]},
            }
        )

        # Add watermark parameter for incremental loads
        if ingestion["mode"] == "incremental":
            template["parameters"]["watermarkColumnName"] = {
                "type": "string",
                "defaultValue": ingestion["watermark_column"],
            }

    def _customize_api_template(self, template: dict[str, Any], source_config: dict[str, Any]) -> None:
        """Customize template for API sources."""
        connection = source_config["connection"]

        template["parameters"].update({"apiBaseUrl": {"type": "string", "defaultValue": connection["base_url"]}})

        # Add pagination parameters if specified
        if "pagination" in connection:
            pagination = connection["pagination"]
            template["parameters"].update(
                {
                    "paginationType": {"type": "string", "defaultValue": pagination.get("type", "none")},
                    "pageSize": {"type": "int", "defaultValue": pagination.get("page_size", 100)},
                }
            )

    def _customize_streaming_template(self, template: dict[str, Any], source_config: dict[str, Any]) -> None:
        """Customize template for streaming sources."""
        connection = source_config["connection"]

        template["parameters"].update(
            {
                "eventHubName": {"type": "string", "defaultValue": connection["name"]},
                "consumerGroup": {"type": "string", "defaultValue": connection.get("consumer_group", "$Default")},
            }
        )

    def generate_parameters_file(
        self, source_config: dict[str, Any], deployment_environment: str = "development"
    ) -> dict[str, Any]:
        """Generate ARM template parameters file.

        Args:
            source_config: Source configuration
            deployment_environment: Target environment

        Returns:
            Parameters file content
        """
        parameters: dict[str, Any] = {
            "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
            "contentVersion": "1.0.0.0",
            "parameters": {
                "dataFactoryName": {"value": f"adf-csa-{deployment_environment}"},
                "pipelineName": {"value": self.generate_pipeline_name(source_config)},
            },
        }

        # Add environment-specific parameters
        target = source_config["target"]
        parameters["parameters"].update(
            {
                "containerName": {"value": target["container"]},
                "folderPath": {"value": target.get("path_pattern", "{source_name}/{table_name}")},
            }
        )

        return parameters

    def generate_bicep_template(self, arm_template: dict[str, Any]) -> str:
        """Convert ARM template to Bicep format.

        Args:
            arm_template: ARM template

        Returns:
            Bicep template as string
        """
        # This is a simplified conversion - in practice, you'd use bicep CLI
        # or a proper ARM-to-Bicep converter
        bicep_lines = [
            "// Generated Bicep template for CSA-in-a-Box metadata framework",
            "",
            "targetScope = 'resourceGroup'",
            "",
            "// Parameters",
        ]

        # Convert parameters
        if "parameters" in arm_template:
            for param_name, param_def in arm_template["parameters"].items():
                param_type = param_def.get("type", "string")
                default_value = param_def.get("defaultValue", "")
                description = param_def.get("metadata", {}).get("description", "")

                bicep_lines.append(f"@description('{description}')")
                if default_value:
                    bicep_lines.append(f"param {param_name} {param_type} = '{default_value}'")
                else:
                    bicep_lines.append(f"param {param_name} {param_type}")
                bicep_lines.append("")

        # Add resource definition (simplified)
        bicep_lines.extend(
            [
                "// Resources",
                "resource dataFactory 'Microsoft.DataFactory/factories@2018-06-01' existing = {",
                "  name: dataFactoryName",
                "}",
                "",
                "resource pipeline 'Microsoft.DataFactory/factories/pipelines@2018-06-01' = {",
                "  parent: dataFactory",
                "  name: pipelineName",
                "  properties: {",
                "    // Pipeline definition would go here",
                "  }",
                "}",
            ]
        )

        return "\n".join(bicep_lines)

    def generate_from_config(
        self, source_config: dict[str, Any], output_format: str = "arm", deployment_environment: str = "development"
    ) -> PipelineGenerationResult:
        """Generate pipeline from source configuration.

        Args:
            source_config: Source registration dictionary
            output_format: Output format ('arm', 'bicep', or 'both')
            deployment_environment: Target deployment environment

        Returns:
            PipelineGenerationResult with generated artifacts

        Raises:
            PipelineGenerationError: If generation fails
        """
        try:
            # Validate source configuration
            self.validate_source_registration(source_config)

            # Select appropriate template
            source_type = source_config["source_type"]
            ingestion_mode = source_config["ingestion"]["mode"]
            template_name = self.select_template(source_type, ingestion_mode)

            # Load and customize template
            template = self.load_template(template_name)
            customized_template = self.customize_template(template, source_config)

            # Generate pipeline name and ID
            pipeline_name = self.generate_pipeline_name(source_config)
            pipeline_id = str(uuid.uuid4())

            # Generate parameters file
            parameters_file = self.generate_parameters_file(source_config, deployment_environment)

            # Generate Bicep if requested
            bicep_template = None
            if output_format in ("bicep", "both"):
                bicep_template = self.generate_bicep_template(customized_template)

            # Create deployment configuration
            deployment_config = {
                "resource_group": f"rg-data-platform-{deployment_environment}",
                "data_factory": f"adf-csa-{deployment_environment}",
                "environment": deployment_environment,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source_id": source_config["source_id"],
                "pipeline_type": template_name.replace(".json", ""),
            }

            logger.info(
                "Pipeline generation completed",
                pipeline_id=pipeline_id,
                pipeline_name=pipeline_name,
                template_type=template_name,
                output_format=output_format,
            )

            return PipelineGenerationResult(
                pipeline_id=pipeline_id,
                pipeline_name=pipeline_name,
                template_type=template_name,
                arm_template=customized_template,
                bicep_template=bicep_template,
                parameters_file=parameters_file,
                deployment_config=deployment_config,
            )

        except Exception as e:
            logger.exception("Pipeline generation failed")
            raise PipelineGenerationError(f"Failed to generate pipeline: {e}") from e

    def generate_from_file(
        self, source_file: str | Path, output_format: str = "arm", deployment_environment: str = "development"
    ) -> PipelineGenerationResult:
        """Generate pipeline from source registration file.

        Args:
            source_file: Path to source registration YAML/JSON file
            output_format: Output format ('arm', 'bicep', or 'both')
            deployment_environment: Target deployment environment

        Returns:
            PipelineGenerationResult with generated artifacts
        """
        source_path = Path(source_file)

        try:
            # Load source configuration
            with open(source_path, encoding="utf-8") as f:
                if source_path.suffix.lower() in (".yaml", ".yml"):
                    source_config = yaml.safe_load(f)
                else:
                    source_config = json.load(f)

            logger.info("Source configuration loaded", file=str(source_path), source_id=source_config.get("source_id"))

            return self.generate_from_config(source_config, output_format, deployment_environment)

        except FileNotFoundError as e:
            raise PipelineGenerationError(f"Source file not found: {source_path}") from e
        except (yaml.YAMLError, json.JSONDecodeError) as e:
            raise PipelineGenerationError(f"Invalid source file format: {e}") from e

    def save_generated_artifacts(
        self, result: PipelineGenerationResult, output_directory: Path | None = None
    ) -> dict[str, Path]:
        """Save generated pipeline artifacts to files.

        Args:
            result: Pipeline generation result
            output_directory: Override default output directory

        Returns:
            Dictionary mapping artifact type to file path
        """
        output_dir = output_directory or self.output_directory
        output_dir.mkdir(parents=True, exist_ok=True)

        saved_files = {}
        base_name = result.pipeline_name

        # Save ARM template
        arm_path = output_dir / f"{base_name}.json"
        with open(arm_path, "w", encoding="utf-8") as f:
            json.dump(result.arm_template, f, indent=2)
        saved_files["arm_template"] = arm_path

        # Save Bicep template if available
        if result.bicep_template:
            bicep_path = output_dir / f"{base_name}.bicep"
            with open(bicep_path, "w", encoding="utf-8") as f:
                f.write(result.bicep_template)
            saved_files["bicep_template"] = bicep_path

        # Save parameters file
        if result.parameters_file:
            params_path = output_dir / f"{base_name}.parameters.json"
            with open(params_path, "w", encoding="utf-8") as f:
                json.dump(result.parameters_file, f, indent=2)
            saved_files["parameters_file"] = params_path

        # Save deployment config
        if result.deployment_config:
            config_path = output_dir / f"{base_name}.deployment.json"
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(result.deployment_config, f, indent=2)
            saved_files["deployment_config"] = config_path

        logger.info(
            "Generated artifacts saved",
            pipeline_name=result.pipeline_name,
            output_directory=str(output_dir),
            files=list(saved_files.keys()),
        )

        return saved_files

    def validate_generated_pipeline(self, result: PipelineGenerationResult) -> list[str]:
        """Validate generated pipeline against schema and best practices.

        Args:
            result: Pipeline generation result

        Returns:
            List of validation warnings/errors (empty if valid)
        """
        warnings = []

        # Basic ARM template validation
        arm_template = result.arm_template

        if "resources" not in arm_template:
            warnings.append("ARM template missing resources section")

        if "parameters" not in arm_template:
            warnings.append("ARM template missing parameters section")

        # Pipeline-specific validations would go here
        # For example: check for required activities, validate dependencies, etc.

        return warnings


if __name__ == "__main__":
    """CLI interface for pipeline generation."""
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Generate ADF pipelines from metadata source registrations")
    parser.add_argument("source_file", help="Path to source registration YAML/JSON file")
    parser.add_argument("--output-dir", type=Path, help="Output directory for generated files")
    parser.add_argument("--format", choices=["arm", "bicep", "both"], default="arm", help="Output format")
    parser.add_argument("--environment", default="development", help="Target deployment environment")
    parser.add_argument(
        "--validate-only", action="store_true", help="Only validate source registration, don't generate"
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")

    args = parser.parse_args()

    try:
        generator = PipelineGenerator(output_directory=args.output_dir, debug=args.debug)

        if args.validate_only:
            # Load and validate only
            source_path = Path(args.source_file)
            with open(source_path, encoding="utf-8") as f:
                if source_path.suffix.lower() in (".yaml", ".yml"):
                    source_config = yaml.safe_load(f)
                else:
                    source_config = json.load(f)

            generator.validate_source_registration(source_config)
            print("✅ Source registration is valid")

        else:
            # Generate pipeline
            result = generator.generate_from_file(args.source_file, args.format, args.environment)

            # Save artifacts
            saved_files = generator.save_generated_artifacts(result)

            # Validate generated pipeline
            warnings = generator.validate_generated_pipeline(result)
            if warnings:
                print("⚠️ Generated pipeline has warnings:")
                for warning in warnings:
                    print(f"  - {warning}")

            print(f"✅ Pipeline generated successfully: {result.pipeline_name}")
            print(f"📁 Output files saved to: {generator.output_directory}")
            for artifact_type, file_path in saved_files.items():
                print(f"  - {artifact_type}: {file_path.name}")

    except (PipelineGenerationError, SchemaDetectionError) as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ Unexpected error: {e}", file=sys.stderr)
        if args.debug:
            import traceback

            traceback.print_exc()
        sys.exit(1)
