#!/usr/bin/env python3
"""Command Line Interface for CSA-in-a-Box Metadata Framework.

This CLI provides commands for:
- Validating source registrations
- Generating ADF pipelines
- Provisioning data landing zones
- Managing metadata framework configurations
"""

import argparse
import sys
from pathlib import Path

# Add the framework modules to Python path
framework_root = Path(__file__).parent
sys.path.insert(0, str(framework_root))

try:
    from generator.dlz_provisioner import DLZProvisioner, DLZProvisioningError  # type: ignore[import-not-found]
    from generator.pipeline_generator import (  # type: ignore[import-not-found]
        PipelineGenerationError,
        PipelineGenerator,
    )
except ImportError as e:
    print(f"ERROR: Failed to import framework modules: {e}")
    print("Make sure you're running from the correct directory and dependencies are installed")
    sys.exit(1)


def cmd_validate(args: argparse.Namespace) -> int:
    """Validate source registration files."""
    try:
        generator = PipelineGenerator(debug=args.debug)

        for source_file in args.source_files:
            source_path = Path(source_file)
            if not source_path.exists():
                print(f"ERROR: Source file not found: {source_file}")
                return 1

            print(f"VALIDATE: Checking {source_file}...")

            # This will validate internally when generating
            result = generator.generate_from_file(source_path, output_format="arm")

            print(f"OK: {source_file} is valid")
            print(f"   Source ID: {result.pipeline_id}")
            print(f"   Pipeline: {result.pipeline_name}")
            print(f"   Template: {result.template_type}")

        return 0

    except (PipelineGenerationError, Exception) as e:
        print(f"ERROR: Validation failed: {e}")
        return 1


def cmd_generate(args: argparse.Namespace) -> int:
    """Generate ADF pipelines from source registrations."""
    try:
        generator = PipelineGenerator(
            output_directory=Path(args.output_dir) if args.output_dir else None, debug=args.debug
        )

        for source_file in args.source_files:
            source_path = Path(source_file)
            if not source_path.exists():
                print(f"ERROR: Source file not found: {source_file}")
                continue

            print(f"GENERATE: Creating pipeline for {source_file}...")

            # Generate pipeline
            result = generator.generate_from_file(source_path, args.format, args.environment)

            # Save artifacts
            saved_files = generator.save_generated_artifacts(result)

            # Validate generated pipeline
            warnings = generator.validate_generated_pipeline(result)
            if warnings:
                print("WARNING: Generated pipeline has warnings:")
                for warning in warnings:
                    print(f"  - {warning}")

            print(f"OK: Pipeline generated: {result.pipeline_name}")
            print(f"FILES: Saved to: {generator.output_directory}")
            for artifact_type, file_path in saved_files.items():
                print(f"  - {artifact_type}: {file_path.name}")

        return 0

    except (PipelineGenerationError, Exception) as e:
        print(f"ERROR: Pipeline generation failed: {e}")
        if args.debug:
            import traceback

            traceback.print_exc()
        return 1


def cmd_provision_dlz(args: argparse.Namespace) -> int:
    """Provision data landing zones from source registrations."""
    try:
        provisioner = DLZProvisioner(
            output_directory=Path(args.output_dir) if args.output_dir else None, debug=args.debug
        )

        for source_file in args.source_files:
            source_path = Path(source_file)
            if not source_path.exists():
                print(f"ERROR: Source file not found: {source_file}")
                continue

            print(f"PROVISION: Creating DLZ for {source_file}...")

            # Provision DLZ
            result = provisioner.provision_dlz_from_file(source_path, args.environment)

            # Save artifacts
            saved_files = provisioner.save_provisioning_artifacts(result)

            # Validate configuration
            warnings = provisioner.validate_dlz_configuration(result)
            if warnings:
                print("WARNING: DLZ configuration has warnings:")
                for warning in warnings:
                    print(f"  - {warning}")

            print(f"OK: DLZ provisioned: {result.landing_zone_name}")
            print(f"FILES: Saved to: {provisioner.output_directory}")
            for artifact_type, file_path in saved_files.items():
                print(f"  - {artifact_type}: {file_path.name}")

        return 0

    except (DLZProvisioningError, Exception) as e:
        print(f"ERROR: DLZ provisioning failed: {e}")
        if args.debug:
            import traceback

            traceback.print_exc()
        return 1


def cmd_generate_all(args: argparse.Namespace) -> int:
    """Generate both pipelines and DLZs from source registrations."""
    print("GENERATE-ALL: Creating complete infrastructure...")

    # Generate pipelines first
    pipeline_args = argparse.Namespace(
        source_files=args.source_files,
        output_dir=args.output_dir,
        format=args.format,
        environment=args.environment,
        debug=args.debug,
    )

    pipeline_result = cmd_generate(pipeline_args)
    if pipeline_result != 0:
        print("ERROR: Pipeline generation failed, skipping DLZ provisioning")
        return pipeline_result

    print()  # Add spacing

    # Then provision DLZs
    dlz_args = argparse.Namespace(
        source_files=args.source_files, output_dir=args.output_dir, environment=args.environment, debug=args.debug
    )

    dlz_result = cmd_provision_dlz(dlz_args)

    if pipeline_result == 0 and dlz_result == 0:
        print("\nSUCCESS: Complete infrastructure generated successfully!")
        return 0
    return 1


def cmd_list_templates(_args: argparse.Namespace) -> int:
    """List available pipeline templates."""
    try:
        generator = PipelineGenerator()

        print("TEMPLATES: Available Pipeline Templates:")
        print("-" * 50)

        for (source_type, mode), template in generator.template_mapping.items():
            print(f"{source_type:15} | {mode:12} | {template}")

        return 0

    except Exception as e:
        print(f"ERROR: Failed to list templates: {e}")
        return 1


def cmd_schema_info(_args: argparse.Namespace) -> int:
    """Show information about the source registration schema."""
    try:
        generator = PipelineGenerator()
        schema = generator.source_schema

        print("SCHEMA: Source Registration Schema Information:")
        print("-" * 50)
        print(f"Schema version: {schema.get('$schema', 'Unknown')}")
        print(f"Title: {schema.get('title', 'Unknown')}")
        print(f"Description: {schema.get('description', 'No description')}")

        print("\nSupported source types:")
        if "properties" in schema and "source_type" in schema["properties"]:
            source_types = schema["properties"]["source_type"].get("enum", [])
            for source_type in sorted(source_types):
                print(f"  - {source_type}")

        print("\nSupported ingestion modes:")
        if "properties" in schema and "ingestion" in schema["properties"]:
            ingestion_props = schema["properties"]["ingestion"]["properties"]
            if "mode" in ingestion_props:
                modes = ingestion_props["mode"].get("enum", [])
                for mode in sorted(modes):
                    print(f"  - {mode}")

        return 0

    except Exception as e:
        print(f"ERROR: Failed to get schema info: {e}")
        return 1


def cmd_example(args: argparse.Namespace) -> int:
    """Show example source registration files."""
    examples_dir = Path(__file__).parent / "examples"

    if not examples_dir.exists():
        print("ERROR: Examples directory not found")
        return 1

    print("EXAMPLES: Available Source Registrations:")
    print("-" * 50)

    for example_file in sorted(examples_dir.glob("*.yaml")):
        print(f"\n{example_file.name}")

        # Read first few lines to show the source type and description
        try:
            with open(example_file, encoding="utf-8") as f:
                lines = f.readlines()[:10]  # First 10 lines

            source_type = None
            source_name = None

            for line in lines:
                if line.startswith("source_type:"):
                    source_type = line.split(":", 1)[1].strip().strip('"')
                elif line.startswith("source_name:"):
                    source_name = line.split(":", 1)[1].strip().strip('"')

            if source_type and source_name:
                print(f"   Type: {source_type}")
                print(f"   Name: {source_name}")

        except (OSError, ValueError):
            print("   (Unable to read file details)")

        if args.show_content:
            print(f"   Path: {example_file}")
            if args.output_content:
                try:
                    with open(example_file, encoding="utf-8") as f:
                        content = f.read()
                    print(f"\n{content}")
                except Exception as e:
                    print(f"   Error reading file: {e}")

    print("\nUSAGE: Use any of these files with: metadata-framework generate <file>")
    return 0


def main() -> int:
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="CSA-in-a-Box Metadata Framework CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Validate a source registration
  %(prog)s validate examples/example_sql_source.yaml

  # Generate an ADF pipeline
  %(prog)s generate examples/example_sql_source.yaml --format arm

  # Provision a data landing zone
  %(prog)s provision-dlz examples/example_sql_source.yaml --environment production

  # Generate everything (pipeline + DLZ)
  %(prog)s generate-all examples/example_sql_source.yaml

  # List available templates
  %(prog)s list-templates

  # Show schema information
  %(prog)s schema-info

  # Show examples
  %(prog)s examples --show-content
        """,
    )

    parser.add_argument("--debug", action="store_true", help="Enable debug logging and detailed error messages")

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Validate command
    validate_parser = subparsers.add_parser("validate", help="Validate source registration files")
    validate_parser.add_argument("source_files", nargs="+", help="Source registration files to validate")

    # Generate command
    generate_parser = subparsers.add_parser("generate", help="Generate ADF pipelines from source registrations")
    generate_parser.add_argument("source_files", nargs="+", help="Source registration files")
    generate_parser.add_argument(
        "--format", choices=["arm", "bicep", "both"], default="arm", help="Output format (default: arm)"
    )
    generate_parser.add_argument(
        "--environment", default="development", help="Target environment (default: development)"
    )
    generate_parser.add_argument("--output-dir", help="Output directory for generated files")

    # Provision DLZ command
    dlz_parser = subparsers.add_parser("provision-dlz", help="Provision data landing zones")
    dlz_parser.add_argument("source_files", nargs="+", help="Source registration files")
    dlz_parser.add_argument("--environment", default="development", help="Target environment (default: development)")
    dlz_parser.add_argument("--output-dir", help="Output directory for generated files")

    # Generate all command
    all_parser = subparsers.add_parser("generate-all", help="Generate both pipelines and DLZs")
    all_parser.add_argument("source_files", nargs="+", help="Source registration files")
    all_parser.add_argument(
        "--format", choices=["arm", "bicep", "both"], default="arm", help="Pipeline output format (default: arm)"
    )
    all_parser.add_argument("--environment", default="development", help="Target environment (default: development)")
    all_parser.add_argument("--output-dir", help="Output directory for generated files")

    # List templates command
    subparsers.add_parser("list-templates", help="List available pipeline templates")

    # Schema info command
    subparsers.add_parser("schema-info", help="Show source registration schema information")

    # Examples command
    examples_parser = subparsers.add_parser("examples", help="Show example source registration files")
    examples_parser.add_argument("--show-content", action="store_true", help="Show file paths")
    examples_parser.add_argument("--output-content", action="store_true", help="Output full file content")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    # Command dispatch
    commands = {
        "validate": cmd_validate,
        "generate": cmd_generate,
        "provision-dlz": cmd_provision_dlz,
        "generate-all": cmd_generate_all,
        "list-templates": cmd_list_templates,
        "schema-info": cmd_schema_info,
        "examples": cmd_example,
    }

    if args.command in commands:
        return commands[args.command](args)
    print(f"ERROR: Unknown command: {args.command}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
