"""Tests for the platform/metadata-framework module.

Covers:
- PipelineGenerator (template selection, name generation, customization, validation)
- _infer_column_type (pure logic)
- Schema validation (mocked JSON Schema files)

Mocking strategy
----------------
The PipelineGenerator needs JSON Schema files on disk for ``_load_schemas``.
We create minimal schema files in a temp directory.  All external SDK calls
(pyodbc, Azure Blob, Cosmos DB, Event Hub, requests) are NOT tested here —
the schema detection methods require heavy external dependencies.  We focus
on the pure logic and template selection/generation paths.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from governance.common.logging import reset_logging_state

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset structlog state between tests."""
    reset_logging_state()
    yield
    reset_logging_state()


@pytest.fixture
def schema_dir(tmp_path: Path) -> Path:
    """Create minimal JSON Schema files for PipelineGenerator."""
    schema_path = tmp_path / "schema"
    schema_path.mkdir()

    # Minimal source registration schema
    source_schema = {
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
    (schema_path / "source_registration.json").write_text(json.dumps(source_schema), encoding="utf-8")

    # Minimal pipeline template schema
    pipeline_schema = {"type": "object", "properties": {}}
    (schema_path / "pipeline_template.json").write_text(json.dumps(pipeline_schema), encoding="utf-8")

    return schema_path


@pytest.fixture
def template_dir(tmp_path: Path) -> Path:
    """Create minimal pipeline template files."""
    templates = tmp_path / "templates"
    templates.mkdir()

    for template_name in [
        "adf_batch_copy.json",
        "adf_incremental.json",
        "adf_cdc.json",
        "adf_api_ingestion.json",
        "adf_streaming.json",
    ]:
        template = {
            "parameters": {},
            "resources": [{"type": "Microsoft.DataFactory/factories/pipelines"}],
        }
        (templates / template_name).write_text(json.dumps(template), encoding="utf-8")

    return templates


@pytest.fixture
def output_dir(tmp_path: Path) -> Path:
    """Create output directory."""
    out = tmp_path / "output"
    out.mkdir()
    return out


@pytest.fixture
def generator(schema_dir: Path, template_dir: Path, output_dir: Path) -> Any:
    """Create a PipelineGenerator with temp directories."""
    from platform.metadata_framework.generator.pipeline_generator import (
        PipelineGenerator,  # type: ignore[import-untyped]
    )

    return PipelineGenerator(
        template_directory=template_dir,
        schema_directory=schema_dir,
        output_directory=output_dir,
    )


def _make_source_config(**overrides: Any) -> dict[str, Any]:
    """Build a minimal valid source configuration."""
    config: dict[str, Any] = {
        "source_id": "src-001",
        "source_name": "orders-database",
        "source_type": "sql_server",
        "ingestion": {"mode": "full"},
        "connection": {"server": "sql.example.com", "database": "orders_db"},
        "target": {"container": "raw", "path_pattern": "{source_name}/{table_name}"},
    }
    config.update(overrides)
    return config


# ---------------------------------------------------------------------------
# _infer_column_type tests (pure logic)
# ---------------------------------------------------------------------------


class TestInferColumnType:
    """Tests for the _infer_column_type utility function."""

    def test_empty_values(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            _infer_column_type,  # type: ignore[import-untyped]
        )

        assert _infer_column_type([]) == "string"

    def test_integer_values(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            _infer_column_type,  # type: ignore[import-untyped]
        )

        assert _infer_column_type(["1", "2", "3", "42"]) == "integer"

    def test_float_values(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            _infer_column_type,  # type: ignore[import-untyped]
        )

        assert _infer_column_type(["1.5", "2.7", "3.14"]) == "float"

    def test_boolean_values(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            _infer_column_type,  # type: ignore[import-untyped]
        )

        assert _infer_column_type(["true", "false", "yes", "no"]) == "boolean"

    def test_datetime_values(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            _infer_column_type,  # type: ignore[import-untyped]
        )

        assert _infer_column_type(["2024-01-15", "2024-06-30"]) == "datetime"

    def test_string_values(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            _infer_column_type,  # type: ignore[import-untyped]
        )

        assert _infer_column_type(["hello", "world", "foo"]) == "string"

    def test_mixed_numeric_defaults_to_float(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            _infer_column_type,  # type: ignore[import-untyped]
        )

        # Contains floats, not pure integers
        assert _infer_column_type(["1", "2.5", "3"]) == "float"


# ---------------------------------------------------------------------------
# PipelineGenerator template selection tests
# ---------------------------------------------------------------------------


class TestSelectTemplate:
    """Tests for template selection logic."""

    def test_sql_server_full(self, generator: Any) -> None:
        assert generator.select_template("sql_server", "full") == "adf_batch_copy.json"

    def test_sql_server_incremental(self, generator: Any) -> None:
        assert generator.select_template("sql_server", "incremental") == "adf_incremental.json"

    def test_sql_server_cdc(self, generator: Any) -> None:
        assert generator.select_template("sql_server", "cdc") == "adf_cdc.json"

    def test_rest_api_full(self, generator: Any) -> None:
        assert generator.select_template("rest_api", "full") == "adf_api_ingestion.json"

    def test_event_hub_streaming(self, generator: Any) -> None:
        assert generator.select_template("event_hub", "streaming") == "adf_streaming.json"

    def test_cosmos_db_full(self, generator: Any) -> None:
        assert generator.select_template("cosmos_db", "full") == "adf_batch_copy.json"

    def test_unsupported_combination(self, generator: Any) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            PipelineGenerationError,  # type: ignore[import-untyped]
        )

        with pytest.raises(PipelineGenerationError, match="No template available"):
            generator.select_template("unsupported_db", "full")

    @pytest.mark.parametrize(
        ("source_type", "mode", "expected"),
        [
            ("azure_sql", "full", "adf_batch_copy.json"),
            ("oracle", "cdc", "adf_cdc.json"),
            ("mysql", "incremental", "adf_incremental.json"),
            ("postgres", "full", "adf_batch_copy.json"),
            ("s3", "full", "adf_batch_copy.json"),
            ("blob_storage", "incremental", "adf_incremental.json"),
            ("kafka", "streaming", "adf_streaming.json"),
        ],
    )
    def test_template_mapping_parametrized(self, generator: Any, source_type: str, mode: str, expected: str) -> None:
        assert generator.select_template(source_type, mode) == expected


# ---------------------------------------------------------------------------
# Pipeline name generation tests
# ---------------------------------------------------------------------------


class TestGeneratePipelineName:
    """Tests for pipeline name generation."""

    def test_basic_name(self, generator: Any) -> None:
        config = _make_source_config(source_name="orders-database")
        name = generator.generate_pipeline_name(config)
        assert name == "pl_orders_database_full"

    def test_name_with_spaces(self, generator: Any) -> None:
        config = _make_source_config(source_name="My Data Source")
        name = generator.generate_pipeline_name(config)
        assert name == "pl_my_data_source_full"

    def test_long_name_truncation(self, generator: Any) -> None:
        config = _make_source_config(source_name="a" * 300)
        name = generator.generate_pipeline_name(config)
        assert len(name) <= 240


# ---------------------------------------------------------------------------
# Source validation tests
# ---------------------------------------------------------------------------


class TestValidateSourceRegistration:
    """Tests for JSON Schema validation of source registrations."""

    def test_valid_source(self, generator: Any) -> None:
        """Valid source config passes validation."""
        config = _make_source_config()
        generator.validate_source_registration(config)  # Should not raise

    def test_missing_required_field(self, generator: Any) -> None:
        """Missing required fields fail validation."""
        from platform.metadata_framework.generator.pipeline_generator import (
            PipelineGenerationError,  # type: ignore[import-untyped]
        )

        config = {"source_id": "src-1"}  # Missing other required fields
        with pytest.raises(PipelineGenerationError, match="Schema validation failed"):
            generator.validate_source_registration(config)


# ---------------------------------------------------------------------------
# Template customization tests
# ---------------------------------------------------------------------------


class TestCustomizeTemplate:
    """Tests for template customization."""

    def test_customize_adds_pipeline_name(self, generator: Any) -> None:
        template = {"parameters": {}, "resources": []}
        config = _make_source_config()
        customized = generator.customize_template(template, config)
        assert "pipelineName" in customized["parameters"]

    def test_customize_database_template(self, generator: Any) -> None:
        template = {"parameters": {}, "resources": []}
        config = _make_source_config(
            source_type="sql_server",
            connection={"server": "sql.example.com", "database": "orders_db"},
            ingestion={"mode": "full"},
        )
        customized = generator.customize_template(template, config)
        assert "serverName" in customized["parameters"]
        assert "databaseName" in customized["parameters"]

    def test_customize_api_template(self, generator: Any) -> None:
        template = {"parameters": {}, "resources": []}
        config = _make_source_config(
            source_type="rest_api",
            connection={"base_url": "https://api.example.com"},
        )
        customized = generator.customize_template(template, config)
        assert "apiBaseUrl" in customized["parameters"]

    def test_customize_streaming_template(self, generator: Any) -> None:
        template = {"parameters": {}, "resources": []}
        config = _make_source_config(
            source_type="event_hub",
            connection={"name": "my-hub", "consumer_group": "$Default"},
        )
        customized = generator.customize_template(template, config)
        assert "eventHubName" in customized["parameters"]

    def test_does_not_modify_original(self, generator: Any) -> None:
        """Customization clones the template, not modifying the original."""
        template = {"parameters": {}, "resources": []}
        config = _make_source_config()
        customized = generator.customize_template(template, config)
        assert "pipelineName" not in template["parameters"]
        assert "pipelineName" in customized["parameters"]


# ---------------------------------------------------------------------------
# Template loading tests
# ---------------------------------------------------------------------------


class TestLoadTemplate:
    """Tests for template file loading."""

    def test_load_existing_template(self, generator: Any) -> None:
        template = generator.load_template("adf_batch_copy.json")
        assert "resources" in template

    def test_load_missing_template(self, generator: Any) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            PipelineGenerationError,  # type: ignore[import-untyped]
        )

        with pytest.raises(PipelineGenerationError, match="Template not found"):
            generator.load_template("nonexistent.json")


# ---------------------------------------------------------------------------
# End-to-end generation tests
# ---------------------------------------------------------------------------


class TestGenerateFromConfig:
    """Tests for the full pipeline generation workflow."""

    def test_generate_full_sql_server(self, generator: Any) -> None:
        """Full pipeline generation for SQL Server source."""
        config = _make_source_config()
        result = generator.generate_from_config(config)
        assert result.pipeline_name == "pl_orders_database_full"
        assert result.template_type == "adf_batch_copy.json"
        assert result.arm_template is not None
        assert result.parameters_file is not None

    def test_generate_with_bicep(self, generator: Any) -> None:
        """Generation with bicep output format."""
        config = _make_source_config()
        result = generator.generate_from_config(config, output_format="bicep")
        assert result.bicep_template is not None
        assert "targetScope" in result.bicep_template

    def test_generate_from_yaml_file(self, generator: Any, tmp_path: Path) -> None:
        """generate_from_file reads YAML source config."""
        import yaml

        config = _make_source_config()
        yaml_file = tmp_path / "source.yaml"
        yaml_file.write_text(yaml.dump(config), encoding="utf-8")

        result = generator.generate_from_file(yaml_file)
        assert result.pipeline_name == "pl_orders_database_full"

    def test_generate_from_json_file(self, generator: Any, tmp_path: Path) -> None:
        """generate_from_file reads JSON source config."""
        config = _make_source_config()
        json_file = tmp_path / "source.json"
        json_file.write_text(json.dumps(config), encoding="utf-8")

        result = generator.generate_from_file(json_file)
        assert result.pipeline_name == "pl_orders_database_full"

    def test_generate_from_missing_file(self, generator: Any) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            PipelineGenerationError,  # type: ignore[import-untyped]
        )

        with pytest.raises(PipelineGenerationError, match="Source file not found"):
            generator.generate_from_file("/nonexistent/source.yaml")


# ---------------------------------------------------------------------------
# Artifact saving tests
# ---------------------------------------------------------------------------


class TestSaveArtifacts:
    """Tests for saving generated pipeline artifacts."""

    def test_save_arm_template(self, generator: Any, output_dir: Path) -> None:
        config = _make_source_config()
        result = generator.generate_from_config(config)
        saved = generator.save_generated_artifacts(result)

        assert "arm_template" in saved
        assert saved["arm_template"].exists()
        content = json.loads(saved["arm_template"].read_text(encoding="utf-8"))
        assert "parameters" in content

    def test_save_with_bicep(self, generator: Any, output_dir: Path) -> None:
        config = _make_source_config()
        result = generator.generate_from_config(config, output_format="both")
        saved = generator.save_generated_artifacts(result)

        assert "bicep_template" in saved
        assert saved["bicep_template"].exists()


# ---------------------------------------------------------------------------
# Pipeline validation tests
# ---------------------------------------------------------------------------


class TestValidateGeneratedPipeline:
    """Tests for post-generation pipeline validation."""

    def test_valid_pipeline(self, generator: Any) -> None:
        config = _make_source_config()
        result = generator.generate_from_config(config)
        warnings = generator.validate_generated_pipeline(result)
        assert len(warnings) == 0

    def test_missing_resources(self, generator: Any) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            PipelineGenerationResult,  # type: ignore[import-untyped]
        )

        result = PipelineGenerationResult(
            pipeline_id="test",
            pipeline_name="test",
            template_type="test",
            arm_template={"parameters": {}},
        )
        warnings = generator.validate_generated_pipeline(result)
        assert any("resources" in w for w in warnings)

    def test_missing_parameters(self, generator: Any) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            PipelineGenerationResult,  # type: ignore[import-untyped]
        )

        result = PipelineGenerationResult(
            pipeline_id="test",
            pipeline_name="test",
            template_type="test",
            arm_template={"resources": []},
        )
        warnings = generator.validate_generated_pipeline(result)
        assert any("parameters" in w for w in warnings)


# ---------------------------------------------------------------------------
# Dataclass tests
# ---------------------------------------------------------------------------


class TestDataclasses:
    """Tests for pipeline generator dataclasses."""

    def test_pipeline_generation_result(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            PipelineGenerationResult,  # type: ignore[import-untyped]
        )

        result = PipelineGenerationResult(
            pipeline_id="id-1",
            pipeline_name="pl_test_full",
            template_type="adf_batch_copy.json",
            arm_template={"resources": []},
        )
        assert result.pipeline_id == "id-1"
        assert result.bicep_template is None

    def test_source_detection_result(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (
            SourceDetectionResult,  # type: ignore[import-untyped]
        )

        result = SourceDetectionResult(
            tables=[{"table_name": "orders"}],
            estimated_row_counts={"orders": 1000},
            primary_keys={"orders": ["id"]},
            data_types={"orders": {"id": "integer"}},
            recommended_watermark_columns={},
        )
        assert len(result.tables) == 1

    def test_custom_exceptions(self) -> None:
        from platform.metadata_framework.generator.pipeline_generator import (  # type: ignore[import-untyped]
            PipelineGenerationError,
            SchemaDetectionError,
        )

        with pytest.raises(PipelineGenerationError):
            raise PipelineGenerationError("test error")

        with pytest.raises(SchemaDetectionError):
            raise SchemaDetectionError("detection failed")
