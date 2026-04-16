#!/usr/bin/env python3
"""Test script for the CSA-in-a-Box Metadata Framework.

This script validates the framework by:
1. Testing schema validation
2. Generating pipelines from example sources
3. Provisioning landing zones
4. Validating generated artifacts

Run this after setting up the framework to ensure everything works correctly.
"""

import sys
from collections.abc import Callable
from pathlib import Path

# Add the platform modules to Python path
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

try:
    from csa_platform.metadata_framework.generator.dlz_provisioner import DLZProvisioner
    from csa_platform.metadata_framework.generator.pipeline_generator import PipelineGenerator
except ImportError as e:
    print(f"❌ Failed to import framework modules: {e}")
    print("Make sure you're running from the correct directory and dependencies are installed")
    sys.exit(1)


def test_schema_validation() -> bool:
    """Test JSON schema validation."""
    print("🔍 Testing schema validation...")

    try:
        generator = PipelineGenerator()
        examples_dir = Path(__file__).parent.parent / "examples"

        for example_file in examples_dir.glob("*.yaml"):
            print(f"  Validating {example_file.name}...")

            # This will validate the schema internally
            result = generator.generate_from_file(example_file, output_format="arm")

            print(f"  ✅ {example_file.name} is valid")
            print(f"     Generated pipeline: {result.pipeline_name}")

        print("✅ Schema validation passed")
        return True

    except Exception as e:
        print(f"❌ Schema validation failed: {e}")
        return False


def test_pipeline_generation() -> bool:
    """Test pipeline generation for different source types."""
    print("\n🏗️ Testing pipeline generation...")

    try:
        generator = PipelineGenerator()
        examples_dir = Path(__file__).parent.parent / "examples"

        # Test different source types
        test_cases = [
            ("SQL Server", "example_sql_source.yaml"),
            ("REST API", "example_api_source.yaml"),
            ("Event Hub", "example_streaming_source.yaml"),
        ]

        for source_type, filename in test_cases:
            print(f"  Testing {source_type} pipeline generation...")

            example_file = examples_dir / filename
            if not example_file.exists():
                print(f"  ⚠️ Example file not found: {filename}")
                continue

            # Generate ARM template
            result = generator.generate_from_file(example_file, output_format="arm")

            # Validate result
            assert result.pipeline_name, "Pipeline name should be generated"
            assert result.arm_template, "ARM template should be generated"
            assert result.parameters_file, "Parameters file should be generated"

            # Check ARM template structure
            arm_template = result.arm_template
            assert "$schema" in arm_template, "ARM template should have schema"
            assert "resources" in arm_template, "ARM template should have resources"
            assert "parameters" in arm_template, "ARM template should have parameters"

            print(f"  ✅ {source_type} pipeline generated: {result.pipeline_name}")

        print("✅ Pipeline generation tests passed")
        return True

    except Exception as e:
        print(f"❌ Pipeline generation failed: {e}")
        import traceback

        traceback.print_exc()
        return False


def test_dlz_provisioning() -> bool:
    """Test data landing zone provisioning."""
    print("\n🏢 Testing DLZ provisioning...")

    try:
        provisioner = DLZProvisioner()
        examples_dir = Path(__file__).parent.parent / "examples"

        # Test with SQL Server example
        example_file = examples_dir / "example_sql_source.yaml"

        print("  Provisioning DLZ for SQL Server source...")
        result = provisioner.provision_dlz_from_file(example_file)

        # Validate result
        assert result.landing_zone_name, "Landing zone name should be generated"
        assert result.parameters_file, "Parameters file should be generated"
        assert result.rbac_assignments, "RBAC assignments should be generated"
        assert result.purview_scans, "Purview scans should be generated"
        assert result.storage_structure, "Storage structure should be generated"

        # Check landing zone name format
        assert result.landing_zone_name.startswith("lz-"), "Landing zone should start with 'lz-'"

        # Check storage structure
        storage = result.storage_structure
        assert "containers" in storage, "Storage structure should have containers"
        containers = storage["containers"]
        assert "bronze" in containers, "Should have bronze container"
        assert "silver" in containers, "Should have silver container"
        assert "gold" in containers, "Should have gold container"

        # Check RBAC assignments
        rbac = result.rbac_assignments
        has_owner_access = any(
            "Storage Blob Data Contributor" in assignment.get("role_definition_name", "") for assignment in rbac
        )
        assert has_owner_access, "Should have owner access assignment"

        # Check Purview scans
        scans = result.purview_scans
        assert len(scans) > 0, "Should have at least one Purview scan"

        print(f"  ✅ DLZ provisioned: {result.landing_zone_name}")
        print("✅ DLZ provisioning tests passed")
        return True

    except Exception as e:
        print(f"❌ DLZ provisioning failed: {e}")
        import traceback

        traceback.print_exc()
        return False


def test_template_selection() -> bool:
    """Test template selection logic."""
    print("\n📋 Testing template selection...")

    try:
        generator = PipelineGenerator()

        # Test various source type and mode combinations
        test_cases = [
            ("sql_server", "full", "adf_batch_copy.json"),
            ("sql_server", "incremental", "adf_incremental.json"),
            ("sql_server", "cdc", "adf_cdc.json"),
            ("rest_api", "full", "adf_api_ingestion.json"),
            ("event_hub", "streaming", "adf_streaming.json"),
        ]

        for source_type, mode, expected_template in test_cases:
            template = generator.select_template(source_type, mode)
            assert template == expected_template, f"Expected {expected_template}, got {template}"
            print(f"  ✅ {source_type} + {mode} → {template}")

        print("✅ Template selection tests passed")
        return True

    except Exception as e:
        print(f"❌ Template selection failed: {e}")
        return False


def test_artifact_generation() -> bool:
    """Test artifact file generation."""
    print("\n📄 Testing artifact generation...")

    try:
        generator = PipelineGenerator()
        provisioner = DLZProvisioner()
        examples_dir = Path(__file__).parent.parent / "examples"
        test_output_dir = Path(__file__).parent / "output"

        # Clean output directory
        if test_output_dir.exists():
            import shutil

            shutil.rmtree(test_output_dir)

        # Generate pipeline artifacts
        example_file = examples_dir / "example_sql_source.yaml"
        result = generator.generate_from_file(example_file)
        pipeline_files = generator.save_generated_artifacts(result, test_output_dir / "pipelines")

        # Generate DLZ artifacts
        dlz_result = provisioner.provision_dlz_from_file(example_file)
        dlz_files = provisioner.save_provisioning_artifacts(dlz_result, test_output_dir / "dlz")

        # Validate files were created
        for file_type, file_path in pipeline_files.items():
            assert file_path.exists(), f"Pipeline file not created: {file_type}"
            print(f"  ✅ Pipeline {file_type}: {file_path.name}")

        for file_type, file_path in dlz_files.items():
            assert file_path.exists(), f"DLZ file not created: {file_type}"
            print(f"  ✅ DLZ {file_type}: {file_path.name}")

        print("✅ Artifact generation tests passed")
        return True

    except Exception as e:
        print(f"❌ Artifact generation failed: {e}")
        import traceback

        traceback.print_exc()
        return False


def main() -> int:
    """Run all tests."""
    print("🚀 CSA-in-a-Box Metadata Framework Test Suite")
    print("=" * 60)

    tests: list[Callable[[], bool]] = [
        test_schema_validation,
        test_pipeline_generation,
        test_dlz_provisioning,
        test_template_selection,
        test_artifact_generation,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            if test():
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print(f"❌ Test {test.__name__} failed with exception: {e}")
            failed += 1

    print("\n" + "=" * 60)
    print(f"📊 Test Results: {passed} passed, {failed} failed")

    if failed == 0:
        print("🎉 All tests passed! The metadata framework is working correctly.")
        return 0
    print("⚠️ Some tests failed. Please check the output above for details.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
