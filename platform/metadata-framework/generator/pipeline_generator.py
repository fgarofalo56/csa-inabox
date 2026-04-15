"""Pipeline Generator for CSA-in-a-Box Metadata-Driven Framework.

This module generates Azure Data Factory pipelines from metadata definitions.
It validates source registrations against JSON Schema, selects appropriate
pipeline templates, and outputs deployable ARM/Bicep templates.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml
from jsonschema import ValidationError, validate

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
        debug: bool = False
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

        logger.info("Pipeline generator initialized",
                   template_dir=str(self.template_directory),
                   schema_dir=str(self.schema_directory),
                   output_dir=str(self.output_directory))

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
            logger.info("Source registration validation passed",
                       source_id=source_config.get("source_id"))

        except ValidationError as e:
            logger.error("Source registration validation failed",
                        error=str(e),
                        schema_path=list(e.absolute_path))
            raise PipelineGenerationError(f"Schema validation failed: {e.message}") from e

    def detect_source_schema(
        self,
        source_config: dict[str, Any],
        connection_test: bool = True
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
        source_type = source_config["source_type"]
        logger.info("Starting schema detection",
                   source_type=source_type,
                   source_id=source_config.get("source_id"))

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
            logger.error("Schema detection failed",
                        source_type=source_type,
                        error=str(e))
            raise SchemaDetectionError(f"Schema detection failed: {e}") from e

    def _detect_database_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema for database sources.

        This would typically connect to the database and query system tables
        to get table metadata, column information, data types, etc.
        """
        # For demo purposes, return mock data
        # In production, this would use database-specific connectors
        logger.info("Detecting database schema (mock implementation)")

        return SourceDetectionResult(
            tables=[
                {
                    "table_name": "example_table",
                    "columns": [
                        {"name": "id", "type": "int", "nullable": False, "is_primary_key": True},
                        {"name": "name", "type": "varchar", "nullable": True},
                        {"name": "created_date", "type": "datetime", "nullable": False}
                    ]
                }
            ],
            estimated_row_counts={"example_table": 1000000},
            primary_keys={"example_table": ["id"]},
            data_types={"example_table": {"id": "int", "name": "varchar", "created_date": "datetime"}},
            recommended_watermark_columns={"example_table": ["created_date"]}
        )

    def _detect_api_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema for REST API sources."""
        logger.info("Detecting API schema (mock implementation)")
        # Would typically make API calls to introspect endpoints
        return SourceDetectionResult(
            tables=[],
            estimated_row_counts={},
            primary_keys={},
            data_types={},
            recommended_watermark_columns={}
        )

    def _detect_cosmos_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema for Cosmos DB sources."""
        logger.info("Detecting Cosmos schema (mock implementation)")
        # Would query Cosmos DB metadata
        return SourceDetectionResult(
            tables=[],
            estimated_row_counts={},
            primary_keys={},
            data_types={},
            recommended_watermark_columns={}
        )

    def _detect_file_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema for file-based sources."""
        logger.info("Detecting file schema (mock implementation)")
        # Would sample files to determine schema
        return SourceDetectionResult(
            tables=[],
            estimated_row_counts={},
            primary_keys={},
            data_types={},
            recommended_watermark_columns={}
        )

    def _detect_stream_schema(self, source_config: dict[str, Any]) -> SourceDetectionResult:
        """Detect schema for streaming sources."""
        logger.info("Detecting stream schema (mock implementation)")
        # Would sample stream messages
        return SourceDetectionResult(
            tables=[],
            estimated_row_counts={},
            primary_keys={},
            data_types={},
            recommended_watermark_columns={}
        )

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
        logger.info("Template selected",
                   source_type=source_type,
                   ingestion_mode=ingestion_mode,
                   template=template_name)

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
                template = json.load(f)

            logger.info("Template loaded", template=template_name)
            return template

        except FileNotFoundError as e:
            raise PipelineGenerationError(f"Template not found: {template_path}") from e
        except json.JSONDecodeError as e:
            raise PipelineGenerationError(f"Invalid JSON in template: {e}") from e

    def customize_template(
        self,
        template: dict[str, Any],
        source_config: dict[str, Any]
    ) -> dict[str, Any]:
        """Customize template with source-specific parameters.

        Args:
            template: ARM template
            source_config: Source configuration

        Returns:
            Customized ARM template
        """
        # Clone template to avoid modifying original
        customized = json.loads(json.dumps(template))

        # Update parameters with source-specific values
        pipeline_name = self.generate_pipeline_name(source_config)

        # Common parameters
        if "parameters" not in customized:
            customized["parameters"] = {}

        customized["parameters"].update({
            "pipelineName": {
                "type": "string",
                "defaultValue": pipeline_name
            }
        })

        # Add source-specific parameters based on source type
        source_type = source_config["source_type"]

        if source_type in ["sql_server", "azure_sql", "oracle", "mysql", "postgres"]:
            self._customize_database_template(customized, source_config)
        elif source_type == "rest_api":
            self._customize_api_template(customized, source_config)
        elif source_type in ["event_hub", "kafka"]:
            self._customize_streaming_template(customized, source_config)

        logger.info("Template customized",
                   pipeline_name=pipeline_name,
                   source_type=source_type)

        return customized

    def _customize_database_template(
        self,
        template: dict[str, Any],
        source_config: dict[str, Any]
    ) -> None:
        """Customize template for database sources."""
        connection = source_config["connection"]
        ingestion = source_config["ingestion"]

        # Add database-specific parameters
        template["parameters"].update({
            "serverName": {
                "type": "string",
                "defaultValue": connection["server"]
            },
            "databaseName": {
                "type": "string",
                "defaultValue": connection["database"]
            }
        })

        # Add watermark parameter for incremental loads
        if ingestion["mode"] == "incremental":
            template["parameters"]["watermarkColumnName"] = {
                "type": "string",
                "defaultValue": ingestion["watermark_column"]
            }

    def _customize_api_template(
        self,
        template: dict[str, Any],
        source_config: dict[str, Any]
    ) -> None:
        """Customize template for API sources."""
        connection = source_config["connection"]

        template["parameters"].update({
            "apiBaseUrl": {
                "type": "string",
                "defaultValue": connection["base_url"]
            }
        })

        # Add pagination parameters if specified
        if "pagination" in connection:
            pagination = connection["pagination"]
            template["parameters"].update({
                "paginationType": {
                    "type": "string",
                    "defaultValue": pagination.get("type", "none")
                },
                "pageSize": {
                    "type": "int",
                    "defaultValue": pagination.get("page_size", 100)
                }
            })

    def _customize_streaming_template(
        self,
        template: dict[str, Any],
        source_config: dict[str, Any]
    ) -> None:
        """Customize template for streaming sources."""
        connection = source_config["connection"]

        template["parameters"].update({
            "eventHubName": {
                "type": "string",
                "defaultValue": connection["name"]
            },
            "consumerGroup": {
                "type": "string",
                "defaultValue": connection.get("consumer_group", "$Default")
            }
        })

    def generate_parameters_file(
        self,
        source_config: dict[str, Any],
        deployment_environment: str = "development"
    ) -> dict[str, Any]:
        """Generate ARM template parameters file.

        Args:
            source_config: Source configuration
            deployment_environment: Target environment

        Returns:
            Parameters file content
        """
        parameters = {
            "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
            "contentVersion": "1.0.0.0",
            "parameters": {
                "dataFactoryName": {
                    "value": f"adf-csa-{deployment_environment}"
                },
                "pipelineName": {
                    "value": self.generate_pipeline_name(source_config)
                }
            }
        }

        # Add environment-specific parameters
        target = source_config["target"]
        parameters["parameters"].update({
            "containerName": {
                "value": target["container"]
            },
            "folderPath": {
                "value": target.get("path_pattern", "{source_name}/{table_name}")
            }
        })

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
        bicep_lines.extend([
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
            "}"
        ])

        return "\n".join(bicep_lines)

    def generate_from_config(
        self,
        source_config: dict[str, Any],
        output_format: str = "arm",
        deployment_environment: str = "development"
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
            parameters_file = self.generate_parameters_file(
                source_config,
                deployment_environment
            )

            # Generate Bicep if requested
            bicep_template = None
            if output_format in ("bicep", "both"):
                bicep_template = self.generate_bicep_template(customized_template)

            # Create deployment configuration
            deployment_config = {
                "resource_group": f"rg-data-platform-{deployment_environment}",
                "data_factory": f"adf-csa-{deployment_environment}",
                "environment": deployment_environment,
                "generated_at": datetime.utcnow().isoformat(),
                "source_id": source_config["source_id"],
                "pipeline_type": template_name.replace(".json", "")
            }

            logger.info("Pipeline generation completed",
                       pipeline_id=pipeline_id,
                       pipeline_name=pipeline_name,
                       template_type=template_name,
                       output_format=output_format)

            return PipelineGenerationResult(
                pipeline_id=pipeline_id,
                pipeline_name=pipeline_name,
                template_type=template_name,
                arm_template=customized_template,
                bicep_template=bicep_template,
                parameters_file=parameters_file,
                deployment_config=deployment_config
            )

        except Exception as e:
            logger.error("Pipeline generation failed", error=str(e))
            raise PipelineGenerationError(f"Failed to generate pipeline: {e}") from e

    def generate_from_file(
        self,
        source_file: str | Path,
        output_format: str = "arm",
        deployment_environment: str = "development"
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

            logger.info("Source configuration loaded",
                       file=str(source_path),
                       source_id=source_config.get("source_id"))

            return self.generate_from_config(
                source_config,
                output_format,
                deployment_environment
            )

        except FileNotFoundError as e:
            raise PipelineGenerationError(f"Source file not found: {source_path}") from e
        except (yaml.YAMLError, json.JSONDecodeError) as e:
            raise PipelineGenerationError(f"Invalid source file format: {e}") from e

    def save_generated_artifacts(
        self,
        result: PipelineGenerationResult,
        output_directory: Path | None = None
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

        logger.info("Generated artifacts saved",
                   pipeline_name=result.pipeline_name,
                   output_directory=str(output_dir),
                   files=list(saved_files.keys()))

        return saved_files

    def validate_generated_pipeline(
        self,
        result: PipelineGenerationResult
    ) -> list[str]:
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

    parser = argparse.ArgumentParser(
        description="Generate ADF pipelines from metadata source registrations"
    )
    parser.add_argument(
        "source_file",
        help="Path to source registration YAML/JSON file"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Output directory for generated files"
    )
    parser.add_argument(
        "--format",
        choices=["arm", "bicep", "both"],
        default="arm",
        help="Output format"
    )
    parser.add_argument(
        "--environment",
        default="development",
        help="Target deployment environment"
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only validate source registration, don't generate"
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging"
    )

    args = parser.parse_args()

    try:
        generator = PipelineGenerator(
            output_directory=args.output_dir,
            debug=args.debug
        )

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
            result = generator.generate_from_file(
                args.source_file,
                args.format,
                args.environment
            )

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
