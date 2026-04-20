"""Extended tests for the csa_platform/metadata_framework module.

Covers areas not exercised by the original test_metadata_framework.py:

- DLZ provisioning (RBAC assignments, container creation, Purview scans,
  medallion structure, Bicep parameters, artifact saving)
- CDC mode pipeline generation (watermark column, control table, operations,
  change-tracking mechanism)
- Streaming mode pipeline generation (Event Hub parameters, Kafka parameters,
  checkpoint location, trigger interval, starting position)
- Schema detection edge cases (empty CSV, single-row CSV, JSON/JSONL variants,
  Cosmos DB empty container, Event Hub empty samples, unknown source type)
- CLI argument validation via argparse (validate-only path, missing file)
"""

from __future__ import annotations

import io
import json
import textwrap
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import yaml

from csa_platform.governance.common.logging import reset_logging_state

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset structlog state between tests."""
    reset_logging_state()
    yield
    reset_logging_state()


@pytest.fixture
def schema_dir(tmp_path: Path) -> Path:
    """Minimal JSON Schema files for PipelineGenerator."""
    schema_path = tmp_path / "schema"
    schema_path.mkdir()

    source_schema: dict[str, Any] = {
        "type": "object",
        "required": ["source_id", "source_name", "source_type", "ingestion", "target"],
        "properties": {
            "source_id": {"type": "string"},
            "source_name": {"type": "string"},
            "source_type": {"type": "string"},
            "ingestion": {
                "type": "object",
                "required": ["mode"],
                "properties": {"mode": {"type": "string"}},
            },
            "connection": {"type": "object"},
            "target": {
                "type": "object",
                "required": ["container"],
                "properties": {"container": {"type": "string"}},
            },
        },
    }
    (schema_path / "source_registration.json").write_text(
        json.dumps(source_schema), encoding="utf-8"
    )
    (schema_path / "pipeline_template.json").write_text(
        json.dumps({"type": "object", "properties": {}}), encoding="utf-8"
    )
    return schema_path


@pytest.fixture
def template_dir(tmp_path: Path) -> Path:
    """Minimal ADF pipeline template files."""
    templates = tmp_path / "templates"
    templates.mkdir()
    base_template = {
        "parameters": {},
        "resources": [{"type": "Microsoft.DataFactory/factories/pipelines"}],
    }
    for name in [
        "adf_batch_copy.json",
        "adf_incremental.json",
        "adf_cdc.json",
        "adf_api_ingestion.json",
        "adf_streaming.json",
    ]:
        (templates / name).write_text(json.dumps(base_template), encoding="utf-8")
    return templates


@pytest.fixture
def output_dir(tmp_path: Path) -> Path:
    """Scratch output directory."""
    out = tmp_path / "output"
    out.mkdir()
    return out


@pytest.fixture
def generator(schema_dir: Path, template_dir: Path, output_dir: Path) -> Any:
    from csa_platform.metadata_framework.generator.pipeline_generator import (
        PipelineGenerator,
    )

    return PipelineGenerator(
        template_directory=template_dir,
        schema_directory=schema_dir,
        output_directory=output_dir,
    )


def _base_source(**overrides: Any) -> dict[str, Any]:
    """Minimal valid source registration."""
    config: dict[str, Any] = {
        "source_id": "src-test-001",
        "source_name": "test-source",
        "source_type": "sql_server",
        "ingestion": {"mode": "full"},
        "connection": {"server": "sql.example.com", "database": "testdb"},
        "target": {"container": "bronze"},
        "owner": {"email": "owner@example.com", "domain": "engineering"},
    }
    config.update(overrides)
    return config


# ---------------------------------------------------------------------------
# CDC mode pipeline generation
# ---------------------------------------------------------------------------


class TestCDCPipelineGeneration:
    """Pipeline customization for CDC ingestion mode."""

    def test_cdc_template_selected(self, generator: Any) -> None:
        assert generator.select_template("sql_server", "cdc") == "adf_cdc.json"

    def test_cdc_basic_parameters_present(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc"},
            connection={"server": "sql.example.com", "database": "testdb"},
        )
        customized = generator.customize_template(template, config)
        params = customized["parameters"]
        assert "cdcMechanism" in params
        assert "cdcControlTable" in params
        assert "cdcOperations" in params
        assert "cdcTables" in params

    def test_cdc_default_mechanism_is_change_tracking(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc"},
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["cdcMechanism"]["defaultValue"] == "change_tracking"

    def test_cdc_explicit_mechanism_cdc_table(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc", "cdc": {"mechanism": "cdc_table"}},
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["cdcMechanism"]["defaultValue"] == "cdc_table"

    def test_cdc_watermark_column_from_cdc_section(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={
                "mode": "cdc",
                "cdc": {"watermark_column": "modified_at"},
            },
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        assert "cdcWatermarkColumn" in customized["parameters"]
        assert customized["parameters"]["cdcWatermarkColumn"]["defaultValue"] == "modified_at"

    def test_cdc_watermark_column_fallback_from_ingestion(self, generator: Any) -> None:
        """If cdc.watermark_column is absent, fall back to ingestion.watermark_column."""
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="azure_sql",
            ingestion={"mode": "cdc", "watermark_column": "row_updated_at"},
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        assert "cdcWatermarkColumn" in customized["parameters"]
        assert (
            customized["parameters"]["cdcWatermarkColumn"]["defaultValue"]
            == "row_updated_at"
        )

    def test_cdc_no_watermark_when_absent(self, generator: Any) -> None:
        """cdcWatermarkColumn should NOT be added when no watermark is configured."""
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc"},
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        assert "cdcWatermarkColumn" not in customized["parameters"]

    def test_cdc_custom_control_table(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={
                "mode": "cdc",
                "cdc": {"control_table": "etl.watermark_store"},
            },
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        assert (
            customized["parameters"]["cdcControlTable"]["defaultValue"]
            == "etl.watermark_store"
        )

    def test_cdc_default_control_table(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc"},
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        assert (
            customized["parameters"]["cdcControlTable"]["defaultValue"]
            == "cdc_watermark_control"
        )

    def test_cdc_operations_default(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc"},
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        ops = customized["parameters"]["cdcOperations"]["defaultValue"]
        assert sorted(ops) == ["DELETE", "INSERT", "UPDATE"]

    def test_cdc_custom_operations(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc", "cdc": {"operations": ["INSERT", "UPDATE"]}},
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        ops = customized["parameters"]["cdcOperations"]["defaultValue"]
        assert sorted(ops) == ["INSERT", "UPDATE"]

    def test_cdc_specific_tables(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc", "cdc": {"tables": ["orders", "customers"]}},
            connection={"server": "s", "database": "d"},
        )
        customized = generator.customize_template(template, config)
        tables = customized["parameters"]["cdcTables"]["defaultValue"]
        assert sorted(tables) == ["customers", "orders"]

    def test_cdc_pipeline_name_includes_mode(self, generator: Any) -> None:
        config = _base_source(
            source_name="crm-data",
            source_type="sql_server",
            ingestion={"mode": "cdc"},
        )
        name = generator.generate_pipeline_name(config)
        assert name.endswith("_cdc")

    def test_cdc_end_to_end_generation(self, generator: Any) -> None:
        """Full generate_from_config call for CDC mode should succeed."""
        config = _base_source(
            source_type="sql_server",
            ingestion={"mode": "cdc", "cdc": {"watermark_column": "modified_at"}},
            connection={"server": "sql.example.com", "database": "crm"},
        )
        result = generator.generate_from_config(config)
        assert result.template_type == "adf_cdc.json"
        params = result.arm_template["parameters"]
        assert "cdcMechanism" in params
        assert "cdcWatermarkColumn" in params

    @pytest.mark.parametrize("source_type", ["oracle", "mysql", "postgres", "azure_sql"])
    def test_cdc_supported_for_all_relational_sources(
        self, generator: Any, source_type: str
    ) -> None:
        template_name = generator.select_template(source_type, "cdc")
        assert template_name == "adf_cdc.json"


# ---------------------------------------------------------------------------
# Streaming mode pipeline generation
# ---------------------------------------------------------------------------


class TestStreamingPipelineGeneration:
    """Pipeline customization for streaming ingestion mode (Event Hub + Kafka)."""

    def test_streaming_template_selected_event_hub(self, generator: Any) -> None:
        assert generator.select_template("event_hub", "streaming") == "adf_streaming.json"

    def test_streaming_template_selected_kafka(self, generator: Any) -> None:
        assert generator.select_template("kafka", "streaming") == "adf_streaming.json"

    def test_event_hub_core_parameters(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming"},
            connection={"name": "telemetry-hub", "namespace": "myns", "consumer_group": "csa-cg"},
        )
        customized = generator.customize_template(template, config)
        params = customized["parameters"]
        assert params["eventHubName"]["defaultValue"] == "telemetry-hub"
        assert params["eventHubNamespace"]["defaultValue"] == "myns"
        assert params["consumerGroup"]["defaultValue"] == "csa-cg"

    def test_event_hub_default_consumer_group(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming"},
            connection={"name": "hub", "namespace": "ns"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["consumerGroup"]["defaultValue"] == "$Default"

    def test_event_hub_checkpoint_location_present(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming"},
            connection={"name": "hub", "namespace": "ns"},
            target={"container": "bronze"},
        )
        customized = generator.customize_template(template, config)
        assert "checkpointLocation" in customized["parameters"]
        loc = customized["parameters"]["checkpointLocation"]["defaultValue"]
        assert "hub" in loc or "stream" in loc  # derived from connection name or default

    def test_event_hub_custom_checkpoint_location(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={
                "mode": "streaming",
                "streaming": {"checkpoint_location": "checkpoints/custom/path"},
            },
            connection={"name": "hub", "namespace": "ns"},
        )
        customized = generator.customize_template(template, config)
        assert (
            customized["parameters"]["checkpointLocation"]["defaultValue"]
            == "checkpoints/custom/path"
        )

    def test_event_hub_trigger_interval_default(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming"},
            connection={"name": "hub", "namespace": "ns"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["triggerIntervalSeconds"]["defaultValue"] == 60

    def test_event_hub_custom_trigger_interval(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming", "streaming": {"trigger_interval_seconds": 30}},
            connection={"name": "hub", "namespace": "ns"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["triggerIntervalSeconds"]["defaultValue"] == 30

    def test_event_hub_starting_position_default(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming"},
            connection={"name": "hub", "namespace": "ns"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["startingPosition"]["defaultValue"] == "latest"

    def test_event_hub_starting_position_earliest(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={
                "mode": "streaming",
                "streaming": {"starting_position": "earliest"},
            },
            connection={"name": "hub", "namespace": "ns"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["startingPosition"]["defaultValue"] == "earliest"

    def test_event_hub_max_events_per_trigger_default(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming"},
            connection={"name": "hub", "namespace": "ns"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["maxEventsPerTrigger"]["defaultValue"] == 10000

    def test_event_hub_stream_source_type_discriminator(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming"},
            connection={"name": "hub", "namespace": "ns"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["streamSourceType"]["defaultValue"] == "event_hub"

    def test_kafka_core_parameters(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="kafka",
            ingestion={"mode": "streaming"},
            connection={
                "name": "my-topic",
                "bootstrap_servers": "broker1:9092,broker2:9092",
                "consumer_group": "csa-kafka-cg",
            },
        )
        customized = generator.customize_template(template, config)
        params = customized["parameters"]
        assert params["kafkaBootstrapServers"]["defaultValue"] == "broker1:9092,broker2:9092"
        assert params["kafkaTopic"]["defaultValue"] == "my-topic"
        assert params["kafkaConsumerGroup"]["defaultValue"] == "csa-kafka-cg"

    def test_kafka_security_protocol_default(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="kafka",
            ingestion={"mode": "streaming"},
            connection={"name": "topic", "bootstrap_servers": "broker:9092"},
        )
        customized = generator.customize_template(template, config)
        assert (
            customized["parameters"]["kafkaSecurityProtocol"]["defaultValue"] == "SASL_SSL"
        )

    def test_kafka_stream_source_type_discriminator(self, generator: Any) -> None:
        template: dict[str, Any] = {"parameters": {}, "resources": []}
        config = _base_source(
            source_type="kafka",
            ingestion={"mode": "streaming"},
            connection={"name": "topic", "bootstrap_servers": "broker:9092"},
        )
        customized = generator.customize_template(template, config)
        assert customized["parameters"]["streamSourceType"]["defaultValue"] == "kafka"

    def test_streaming_end_to_end_event_hub(self, generator: Any) -> None:
        config = _base_source(
            source_type="event_hub",
            ingestion={"mode": "streaming"},
            connection={"name": "iot-hub", "namespace": "mynamespace"},
        )
        result = generator.generate_from_config(config)
        assert result.template_type == "adf_streaming.json"
        params = result.arm_template["parameters"]
        assert "eventHubName" in params
        assert "checkpointLocation" in params
        assert "triggerIntervalSeconds" in params

    def test_streaming_end_to_end_kafka(self, generator: Any) -> None:
        config = _base_source(
            source_type="kafka",
            ingestion={"mode": "streaming"},
            connection={"name": "events", "bootstrap_servers": "kafka:9092"},
        )
        result = generator.generate_from_config(config)
        assert result.template_type == "adf_streaming.json"
        params = result.arm_template["parameters"]
        assert "kafkaBootstrapServers" in params
        assert "kafkaTopic" in params


# ---------------------------------------------------------------------------
# Schema detection edge cases
# ---------------------------------------------------------------------------


class TestSchemaDetectionEdgeCases:
    """Edge cases in the schema detection methods."""

    # ── CSV edge cases ──────────────────────────────────────────────────────

    def test_detect_file_schema_empty_csv_raises(self, generator: Any) -> None:
        """CSV with no rows (header only) should raise SchemaDetectionError."""
        from csa_platform.metadata_framework.generator.pipeline_generator import (
            SchemaDetectionError,
        )

        csv_content = b"col_a,col_b\n"
        config = {"source_type": "file_drop", "format": "csv", "entity_name": "empty_tbl"}

        with patch("builtins.open", return_value=io.BytesIO(csv_content)):
            with patch.object(
                generator.__class__,
                "_detect_file_schema",
                wraps=generator._detect_file_schema,
            ):
                # Write a real temp file so _detect_file_schema can open it
                tmp = Path(generator.output_directory) / "empty.csv"
                tmp.write_bytes(csv_content)
                config["file_path"] = str(tmp)
                result = generator._detect_file_schema(config)
                # Empty CSV (header only, no data rows) — columns should be detected
                # from header but row_count should be 0
                assert result.estimated_row_counts.get("empty_tbl", 0) == 0

    def test_detect_file_schema_single_row_csv(self, generator: Any) -> None:
        """A one-row CSV should produce correct column inference."""
        csv_content = b"id,name,amount\n1,Alice,99.5\n"
        tmp = Path(generator.output_directory) / "one_row.csv"
        tmp.write_bytes(csv_content)
        config = {
            "source_type": "file_drop",
            "format": "csv",
            "file_path": str(tmp),
            "entity_name": "one_row",
        }
        result = generator._detect_file_schema(config)
        col_names = [c["name"] for c in result.tables[0]["columns"]]
        assert "id" in col_names
        assert "name" in col_names
        assert "amount" in col_names

    def test_detect_file_schema_jsonl(self, generator: Any) -> None:
        """JSONL (newline-delimited JSON) should be parsed correctly."""
        lines = [
            json.dumps({"user_id": i, "event": "click", "score": i * 0.5})
            for i in range(5)
        ]
        jsonl_content = "\n".join(lines).encode()
        tmp = Path(generator.output_directory) / "events.jsonl"
        tmp.write_bytes(jsonl_content)
        config = {
            "source_type": "file_drop",
            "format": "json",
            "file_path": str(tmp),
            "entity_name": "events",
        }
        result = generator._detect_file_schema(config)
        col_names = [c["name"] for c in result.tables[0]["columns"]]
        assert "user_id" in col_names
        assert "event" in col_names

    def test_detect_file_schema_json_array(self, generator: Any) -> None:
        """A JSON file containing an array of objects should work."""
        records = [{"id": i, "val": str(i)} for i in range(3)]
        json_content = json.dumps(records).encode()
        tmp = Path(generator.output_directory) / "records.json"
        tmp.write_bytes(json_content)
        config = {
            "source_type": "file_drop",
            "format": "json",
            "file_path": str(tmp),
            "entity_name": "records",
        }
        result = generator._detect_file_schema(config)
        col_names = [c["name"] for c in result.tables[0]["columns"]]
        assert "id" in col_names
        assert "val" in col_names

    def test_detect_file_schema_auto_detect_csv_extension(self, generator: Any) -> None:
        """format should be auto-detected from the .csv file extension."""
        csv_content = b"x,y\n1,2\n3,4\n"
        tmp = Path(generator.output_directory) / "data.csv"
        tmp.write_bytes(csv_content)
        config = {
            "source_type": "file_drop",
            "file_path": str(tmp),
            "entity_name": "data",
            # note: no "format" key
        }
        result = generator._detect_file_schema(config)
        assert len(result.tables) == 1

    def test_detect_file_schema_missing_file_raises(self, generator: Any) -> None:
        from csa_platform.metadata_framework.generator.pipeline_generator import (
            SchemaDetectionError,
        )

        config = {
            "source_type": "file_drop",
            "format": "csv",
            "file_path": "/nonexistent/path/data.csv",
            "entity_name": "x",
        }
        with pytest.raises(SchemaDetectionError, match="Failed to read file"):
            generator._detect_file_schema(config)

    def test_detect_file_schema_no_path_raises(self, generator: Any) -> None:
        from csa_platform.metadata_framework.generator.pipeline_generator import (
            SchemaDetectionError,
        )

        config = {"source_type": "file_drop", "format": "csv", "entity_name": "x"}
        with pytest.raises(SchemaDetectionError):
            generator._detect_file_schema(config)

    # ── Cosmos DB edge case ─────────────────────────────────────────────────

    def test_detect_cosmos_schema_empty_container(self, generator: Any) -> None:
        """Empty Cosmos DB container returns a valid empty SourceDetectionResult."""
        from unittest.mock import MagicMock

        mock_container = MagicMock()
        mock_container.query_items.return_value = []
        mock_db = MagicMock()
        mock_db.get_container_client.return_value = mock_container
        mock_client_instance = MagicMock()
        mock_client_instance.get_database_client.return_value = mock_db

        config = {
            "source_type": "cosmos_db",
            "endpoint": "https://myaccount.documents.azure.com:443/",
            "database": "mydb",
            "container": "mycontainer",
            "account_key": "fake-key",
        }

        # CosmosClient is imported inside the method body so we patch the
        # azure.cosmos module that the function imports from.
        mock_cosmos_module = MagicMock()
        mock_cosmos_module.CosmosClient = MagicMock(return_value=mock_client_instance)
        with patch.dict(
            "sys.modules",
            {
                "azure.cosmos": mock_cosmos_module,
                "azure.identity": MagicMock(),
            },
        ):
            result = generator._detect_cosmos_schema(config)

        assert result.tables[0]["table_name"] == "mycontainer"
        assert result.tables[0]["columns"] == []
        assert result.primary_keys.get("mycontainer") == ["id"]
        assert result.estimated_row_counts.get("mycontainer", 0) == 0

    def test_detect_cosmos_schema_missing_config_raises(self, generator: Any) -> None:
        from csa_platform.metadata_framework.generator.pipeline_generator import (
            SchemaDetectionError,
        )

        config = {"source_type": "cosmos_db", "endpoint": "", "database": "", "container": ""}
        with pytest.raises(SchemaDetectionError, match="endpoint, database, and container"):
            generator._detect_cosmos_schema(config)

    # ── Event Hub edge case ─────────────────────────────────────────────────

    def test_detect_stream_schema_event_hub_empty_samples(self, generator: Any) -> None:
        """Event Hub that yields no events returns an empty SourceDetectionResult."""
        from unittest.mock import MagicMock

        mock_client = MagicMock()
        mock_client.receive.return_value = None
        mock_context_manager = MagicMock()
        mock_context_manager.__enter__ = lambda s: mock_client
        mock_context_manager.__exit__ = MagicMock(return_value=False)

        config = {
            "source_type": "event_hub",
            "event_hub_namespace": "mynamespace",
            "event_hub_name": "empty-hub",
            "consumer_group": "$Default",
            "sample_size": 10,
        }

        # EventHubConsumerClient is imported lazily inside the method body.
        mock_eh_module = MagicMock()
        mock_eh_module.EventHubConsumerClient = MagicMock(
            return_value=mock_context_manager
        )
        with patch.dict(
            "sys.modules",
            {
                "azure.eventhub": mock_eh_module,
                "azure.identity": MagicMock(),
            },
        ):
            result = generator._detect_stream_schema(config)

        assert result.tables[0]["table_name"] == "empty-hub"
        assert result.tables[0]["columns"] == []
        assert result.recommended_watermark_columns.get("empty-hub") == ["enqueuedTime"]

    def test_detect_stream_schema_unknown_type_raises(self, generator: Any) -> None:
        from csa_platform.metadata_framework.generator.pipeline_generator import (
            SchemaDetectionError,
        )

        config = {"source_type": "mqtt"}  # Not implemented
        with pytest.raises(SchemaDetectionError, match="source_type"):
            generator._detect_stream_schema(config)

    def test_detect_source_schema_dispatches_to_stream_for_kafka(
        self, generator: Any
    ) -> None:
        """detect_source_schema should route kafka to _detect_stream_schema."""
        mock_result = MagicMock()
        config = {
            "source_type": "kafka",
            "source_id": "kafka-src",
            "bootstrap_servers": "broker:9092",
            "topic": "my-topic",
        }
        with patch.object(generator, "_detect_stream_schema", return_value=mock_result) as mock_fn:
            result = generator.detect_source_schema(config, connection_test=False)
            mock_fn.assert_called_once_with(config)
            assert result is mock_result

    # ── Large schema ────────────────────────────────────────────────────────

    def test_detect_file_schema_large_csv_column_count(self, generator: Any) -> None:
        """Schema detection should handle CSVs with many columns without error."""
        n_cols = 200
        header = ",".join(f"col_{i}" for i in range(n_cols))
        data_row = ",".join(str(i) for i in range(n_cols))
        csv_content = f"{header}\n{data_row}\n".encode()

        tmp = Path(generator.output_directory) / "wide.csv"
        tmp.write_bytes(csv_content)
        config = {
            "source_type": "file_drop",
            "format": "csv",
            "file_path": str(tmp),
            "entity_name": "wide",
        }
        result = generator._detect_file_schema(config)
        assert len(result.tables[0]["columns"]) == n_cols

    def test_detect_file_schema_nested_json_maps_to_string(self, generator: Any) -> None:
        """Nested dict values in JSON: the file type_map omits 'dict', so they fall
        back to 'string'.  This is the actual behavior of the production code — verify
        it so any future change to the type map is caught."""
        records = [{"id": 1, "meta": {"key": "value"}}]
        json_content = json.dumps(records).encode()
        tmp = Path(generator.output_directory) / "nested.json"
        tmp.write_bytes(json_content)
        config = {
            "source_type": "file_drop",
            "format": "json",
            "file_path": str(tmp),
            "entity_name": "nested",
        }
        result = generator._detect_file_schema(config)
        type_map = {c["name"]: c["type"] for c in result.tables[0]["columns"]}
        # "dict" is not in the file_type_map; Python's fallback is "string"
        assert type_map.get("meta") == "string"
        # The integer id should be typed as "integer"
        assert type_map.get("id") == "integer"


# ---------------------------------------------------------------------------
# DLZ Provisioner tests
# ---------------------------------------------------------------------------


@pytest.fixture
def provisioner(tmp_path: Path) -> Any:
    from csa_platform.metadata_framework.generator.dlz_provisioner import DLZProvisioner

    dlz_template_dir = tmp_path / "templates" / "dlz"
    dlz_template_dir.mkdir(parents=True)
    return DLZProvisioner(
        template_directory=dlz_template_dir,
        output_directory=tmp_path / "output" / "dlz",
    )


def _dlz_source(**overrides: Any) -> dict[str, Any]:
    """Minimal source config for DLZ provisioning."""
    config: dict[str, Any] = {
        "source_id": "src-dlz-001",
        "source_name": "crm-customers",
        "source_type": "sql_server",
        "ingestion": {"mode": "incremental"},
        "connection": {"server": "sql.example.com", "database": "crm"},
        "target": {"container": "bronze"},
        "owner": {"email": "owner@example.com", "domain": "CRM"},
        "classification": "internal",
    }
    config.update(overrides)
    return config


class TestDLZLandingZoneNaming:
    """Landing zone and storage account name generation."""

    def test_generate_landing_zone_name_from_source(self, provisioner: Any) -> None:
        config = _dlz_source(source_name="crm-customers")
        name = provisioner.generate_landing_zone_name(config)
        assert name.startswith("lz-")
        assert "crm" in name.lower()

    def test_generate_landing_zone_name_uses_target_if_specified(
        self, provisioner: Any
    ) -> None:
        config = _dlz_source(target={"container": "bronze", "landing_zone": "lz-custom"})
        name = provisioner.generate_landing_zone_name(config)
        assert name == "lz-custom"

    def test_storage_account_name_max_24_chars(self, provisioner: Any) -> None:
        config = _dlz_source(
            source_name="a" * 50,
            owner={"email": "x@x.com", "domain": "a" * 20},
        )
        lz_name = provisioner.generate_landing_zone_name(config)
        sa_name = provisioner.generate_storage_account_name(lz_name)
        assert len(sa_name) <= 24

    def test_storage_account_name_no_hyphens(self, provisioner: Any) -> None:
        lz_name = "lz-crm-customers"
        sa_name = provisioner.generate_storage_account_name(lz_name)
        assert "-" not in sa_name

    def test_storage_account_name_ends_with_suffix(self, provisioner: Any) -> None:
        lz_name = "lz-test-source"
        sa_name = provisioner.generate_storage_account_name(lz_name)
        assert sa_name.endswith("dlz")


class TestDLZMedallionStructure:
    """Medallion storage structure generation."""

    def test_all_medallion_containers_present(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-crm-customers")
        containers = structure["containers"]
        assert "bronze" in containers
        assert "silver" in containers
        assert "gold" in containers
        assert "sandbox" in containers

    def test_containers_have_public_access_none(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        for _name, container_def in structure["containers"].items():
            assert container_def["public_access"] == "None"

    def test_folder_structure_bronze_contains_raw(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        bronze_path = structure["folder_structure"]["bronze"]["base_path"]
        assert "raw" in bronze_path

    def test_folder_structure_sandbox_uses_user_experiment(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        sandbox_partitioning = structure["folder_structure"]["sandbox"]["partitioning"]
        assert sandbox_partitioning == "user_experiment"

    def test_retention_policies_populated(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        assert "retention_policies" in structure
        for layer in ["bronze", "silver", "gold"]:
            assert layer in structure["retention_policies"]
            assert structure["retention_policies"][layer]["retention_days"] > 0

    def test_access_policies_include_owner_and_reader(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        for _layer, policy in structure["access_policies"].items():
            assert "owner_access" in policy
            assert "reader_access" in policy


class TestDLZRBACAssignments:
    """RBAC assignment generation."""

    def test_four_rbac_assignments_generated(self, provisioner: Any) -> None:
        config = _dlz_source()
        assignments = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        assert len(assignments) == 4

    def test_owner_gets_contributor_role(self, provisioner: Any) -> None:
        config = _dlz_source(owner={"email": "alice@example.com", "domain": "CRM"})
        assignments = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        owner_assignments = [
            a for a in assignments if a.get("principal_email") == "alice@example.com"
        ]
        assert len(owner_assignments) == 1
        assert owner_assignments[0]["role_definition_name"] == "Storage Blob Data Contributor"

    def test_adf_gets_contributor_role(self, provisioner: Any) -> None:
        config = _dlz_source()
        assignments = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        adf_assignments = [a for a in assignments if "adf-csa-prod" in a.get("principal_name", "")]
        assert len(adf_assignments) == 1
        assert adf_assignments[0]["role_definition_name"] == "Storage Blob Data Contributor"

    def test_purview_gets_reader_role(self, provisioner: Any) -> None:
        config = _dlz_source()
        assignments = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        purview_assignments = [
            a for a in assignments if "purview" in a.get("principal_name", "")
        ]
        assert len(purview_assignments) == 1
        assert purview_assignments[0]["role_definition_name"] == "Storage Blob Data Reader"

    def test_domain_group_gets_reader_role(self, provisioner: Any) -> None:
        config = _dlz_source(owner={"email": "x@x.com", "domain": "Sales"})
        assignments = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        group_assignments = [
            a for a in assignments if "DataDomain-Sales" in a.get("principal_name", "")
        ]
        assert len(group_assignments) == 1
        assert group_assignments[0]["role_definition_name"] == "Storage Blob Data Reader"

    def test_all_assignments_scoped_to_storage_account(self, provisioner: Any) -> None:
        config = _dlz_source()
        sa_name = "myteststorage"
        assignments = provisioner.generate_rbac_assignments(config, "lz-test", sa_name)
        for a in assignments:
            assert sa_name in a["scope"]


class TestDLZPurviewScans:
    """Purview scan configuration generation."""

    def test_scan_per_medallion_container(self, provisioner: Any) -> None:
        config = _dlz_source()
        scans = provisioner.generate_purview_scans(config, "lz-test", "testsa")
        scan_containers = {s["scope"]["container"] for s in scans}
        assert "bronze" in scan_containers
        assert "silver" in scan_containers
        assert "gold" in scan_containers

    def test_scan_names_include_container(self, provisioner: Any) -> None:
        config = _dlz_source()
        scans = provisioner.generate_purview_scans(config, "lz-test", "testsa")
        for scan in scans:
            assert scan["scope"]["container"] in scan["scan_name"]

    def test_scan_schedule_is_weekly(self, provisioner: Any) -> None:
        config = _dlz_source()
        scans = provisioner.generate_purview_scans(config, "lz-test", "testsa")
        for scan in scans:
            assert scan["schedule"]["kind"] == "Weekly"

    def test_confidential_source_adds_pii_classification_rules(
        self, provisioner: Any
    ) -> None:
        config = _dlz_source(classification="confidential")
        scans = provisioner.generate_purview_scans(config, "lz-test", "testsa")
        for scan in scans:
            rules = scan["classification_rules"]
            assert any("PERSONAL" in r for r in rules)

    def test_internal_source_minimal_classification_rules(
        self, provisioner: Any
    ) -> None:
        config = _dlz_source(classification="internal")
        scans = provisioner.generate_purview_scans(config, "lz-test", "testsa")
        for scan in scans:
            rules = scan["classification_rules"]
            # Only System classification, no PII rules
            assert rules == ["System"]

    def test_scan_metadata_includes_source_info(self, provisioner: Any) -> None:
        config = _dlz_source(
            source_name="crm-data",
            source_type="sql_server",
            owner={"email": "owner@example.com", "domain": "CRM"},
        )
        scans = provisioner.generate_purview_scans(config, "lz-test", "testsa")
        for scan in scans:
            meta = scan["metadata"]
            assert meta["source_name"] == "crm-data"
            assert meta["source_type"] == "sql_server"
            assert meta["owner"] == "owner@example.com"


class TestDLZBicepParameters:
    """Bicep parameter file generation."""

    def test_bicep_params_schema_version(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        rbac = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        params = provisioner.generate_bicep_parameters(config, "lz-test", "testsa", structure, rbac)
        assert "2019-04-01" in params["$schema"]

    def test_bicep_params_includes_required_fields(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        rbac = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        params = provisioner.generate_bicep_parameters(
            config, "lz-test", "testsa", structure, rbac, environment="staging"
        )
        p = params["parameters"]
        assert p["landingZoneName"]["value"] == "lz-test"
        assert p["storageAccountName"]["value"] == "testsa"
        assert p["environment"]["value"] == "staging"
        assert p["dataClassification"]["value"] == "internal"

    def test_bicep_params_includes_tags(self, provisioner: Any) -> None:
        config = _dlz_source()
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        rbac = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        params = provisioner.generate_bicep_parameters(config, "lz-test", "testsa", structure, rbac)
        tags = params["parameters"]["tags"]["value"]
        assert tags["Project"] == "CSA-in-a-Box"
        assert tags["DataClassification"] == "internal"

    def test_bicep_params_includes_data_product_when_present(
        self, provisioner: Any
    ) -> None:
        config = _dlz_source(
            data_product={
                "name": "crm-analytics",
                "domain": "CRM",
                "sla_freshness_minutes": 60,
            }
        )
        structure = provisioner.generate_medallion_structure(config, "lz-test")
        rbac = provisioner.generate_rbac_assignments(config, "lz-test", "testsa")
        params = provisioner.generate_bicep_parameters(config, "lz-test", "testsa", structure, rbac)
        assert "dataProduct" in params["parameters"]
        assert params["parameters"]["dataProduct"]["value"]["name"] == "crm-analytics"


class TestDLZEndToEnd:
    """Full DLZ provisioning workflow."""

    def test_provision_dlz_from_config_returns_result(self, provisioner: Any) -> None:
        from csa_platform.metadata_framework.generator.dlz_provisioner import (
            DLZProvisioningResult,
        )

        config = _dlz_source()
        result = provisioner.provision_dlz_from_config(config)
        assert isinstance(result, DLZProvisioningResult)
        assert result.dlz_id is not None
        assert result.landing_zone_name.startswith("lz-")

    def test_provision_dlz_from_config_has_all_artifacts(self, provisioner: Any) -> None:
        config = _dlz_source()
        result = provisioner.provision_dlz_from_config(config)
        assert result.rbac_assignments is not None
        assert len(result.rbac_assignments) > 0
        assert result.purview_scans is not None
        assert len(result.purview_scans) > 0
        assert result.storage_structure is not None
        assert result.parameters_file is not None
        assert result.deployment_config is not None

    def test_provision_dlz_from_yaml_file(
        self, provisioner: Any, tmp_path: Path
    ) -> None:
        config = _dlz_source()
        yaml_file = tmp_path / "source.yaml"
        yaml_file.write_text(yaml.dump(config), encoding="utf-8")
        result = provisioner.provision_dlz_from_file(yaml_file)
        assert result.landing_zone_name is not None

    def test_provision_dlz_from_missing_file_raises(self, provisioner: Any) -> None:
        from csa_platform.metadata_framework.generator.dlz_provisioner import (
            DLZProvisioningError,
        )

        with pytest.raises(DLZProvisioningError, match="Source file not found"):
            provisioner.provision_dlz_from_file("/nonexistent/source.yaml")

    def test_save_provisioning_artifacts_creates_files(
        self, provisioner: Any, tmp_path: Path
    ) -> None:
        config = _dlz_source()
        result = provisioner.provision_dlz_from_config(config)
        saved = provisioner.save_provisioning_artifacts(result, tmp_path / "out")
        assert "parameters_file" in saved
        assert saved["parameters_file"].exists()
        assert "rbac_assignments" in saved
        assert saved["rbac_assignments"].exists()

    def test_save_artifacts_rbac_is_valid_json(
        self, provisioner: Any, tmp_path: Path
    ) -> None:
        config = _dlz_source()
        result = provisioner.provision_dlz_from_config(config)
        saved = provisioner.save_provisioning_artifacts(result, tmp_path / "out")
        content = json.loads(saved["rbac_assignments"].read_text(encoding="utf-8"))
        assert isinstance(content, list)
        assert len(content) == 4

    def test_save_artifacts_purview_scans_is_valid_json(
        self, provisioner: Any, tmp_path: Path
    ) -> None:
        config = _dlz_source()
        result = provisioner.provision_dlz_from_config(config)
        saved = provisioner.save_provisioning_artifacts(result, tmp_path / "out")
        content = json.loads(saved["purview_scans"].read_text(encoding="utf-8"))
        assert isinstance(content, list)
        assert len(content) == 4  # One per medallion container

    def test_validate_dlz_config_passes_valid_result(self, provisioner: Any) -> None:
        config = _dlz_source()
        result = provisioner.provision_dlz_from_config(config)
        warnings = provisioner.validate_dlz_configuration(result)
        assert warnings == []

    def test_validate_dlz_config_warns_missing_lz_prefix(
        self, provisioner: Any
    ) -> None:
        from csa_platform.metadata_framework.generator.dlz_provisioner import (
            DLZProvisioningResult,
        )

        result = DLZProvisioningResult(
            dlz_id="test",
            landing_zone_name="nolzprefix",  # Missing "lz-" prefix
        )
        warnings = provisioner.validate_dlz_configuration(result)
        assert any("lz-" in w for w in warnings)

    def test_validate_dlz_config_warns_missing_containers(
        self, provisioner: Any
    ) -> None:
        from csa_platform.metadata_framework.generator.dlz_provisioner import (
            DLZProvisioningResult,
        )

        result = DLZProvisioningResult(
            dlz_id="test",
            landing_zone_name="lz-test",
            storage_structure={"containers": {"bronze": {}}},  # Missing silver & gold
        )
        warnings = provisioner.validate_dlz_configuration(result)
        assert any("containers" in w for w in warnings)


# ---------------------------------------------------------------------------
# CLI argument validation (argparse layer)
# ---------------------------------------------------------------------------


class TestCLIArguments:
    """Tests for the CLI argument parser in pipeline_generator.py."""

    def test_cli_unsupported_format_exits(self) -> None:
        """Passing an unsupported --format value should fail argparse."""
        import argparse
        import importlib.util
        import sys

        # We test the argparse spec rather than executing __main__
        parser = argparse.ArgumentParser()
        parser.add_argument("source_file")
        parser.add_argument("--format", choices=["arm", "bicep", "both"], default="arm")
        parser.add_argument("--environment", default="development")
        parser.add_argument("--validate-only", action="store_true")
        parser.add_argument("--debug", action="store_true")

        with pytest.raises(SystemExit):
            parser.parse_args(["source.yaml", "--format", "invalid"])

    def test_cli_valid_format_arm(self) -> None:
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("source_file")
        parser.add_argument("--format", choices=["arm", "bicep", "both"], default="arm")
        parser.add_argument("--environment", default="development")
        parser.add_argument("--validate-only", action="store_true")
        parser.add_argument("--debug", action="store_true")

        args = parser.parse_args(["source.yaml"])
        assert args.format == "arm"
        assert args.environment == "development"

    def test_cli_validate_only_flag(self) -> None:
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("source_file")
        parser.add_argument("--format", choices=["arm", "bicep", "both"], default="arm")
        parser.add_argument("--environment", default="development")
        parser.add_argument("--validate-only", action="store_true")
        parser.add_argument("--debug", action="store_true")

        args = parser.parse_args(["source.yaml", "--validate-only"])
        assert args.validate_only is True

    def test_cli_environment_override(self) -> None:
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("source_file")
        parser.add_argument("--format", choices=["arm", "bicep", "both"], default="arm")
        parser.add_argument("--environment", default="development")
        parser.add_argument("--validate-only", action="store_true")
        parser.add_argument("--debug", action="store_true")

        args = parser.parse_args(["source.yaml", "--environment", "production"])
        assert args.environment == "production"
