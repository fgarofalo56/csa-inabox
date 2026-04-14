"""Data Landing Zone Provisioner for CSA-in-a-Box Metadata-Driven Framework.

This module provisions data landing zones from metadata definitions. It generates
Bicep parameter files, creates storage structures, configures RBAC assignments,
and registers Purview scans.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import yaml

from governance.common.logging import configure_structlog, get_logger


# Configure structured logging
configure_structlog(service="metadata-framework-dlz-provisioner")
logger = get_logger(__name__)


@dataclass
class DLZProvisioningResult:
    """Result of DLZ provisioning operation."""

    dlz_id: str
    landing_zone_name: str
    bicep_template_path: Optional[str] = None
    parameters_file: Optional[Dict[str, Any]] = None
    rbac_assignments: Optional[List[Dict[str, Any]]] = None
    purview_scans: Optional[List[Dict[str, Any]]] = None
    storage_structure: Optional[Dict[str, Any]] = None
    deployment_config: Optional[Dict[str, Any]] = None


class DLZProvisioningError(Exception):
    """Raised when DLZ provisioning fails."""
    pass


class DLZProvisioner:
    """Provisions Data Landing Zones from metadata source registrations.

    This module creates the infrastructure needed to store ingested data,
    including storage accounts, containers, RBAC assignments, and Purview
    integration for governance and cataloging.
    """

    def __init__(
        self,
        template_directory: Optional[Path] = None,
        output_directory: Optional[Path] = None,
        debug: bool = False
    ) -> None:
        """Initialize the DLZ provisioner.

        Args:
            template_directory: Path to Bicep templates
            output_directory: Path for generated outputs
            debug: Enable debug logging
        """
        self.debug = debug

        # Set default paths relative to this module
        framework_root = Path(__file__).parent.parent
        self.template_directory = template_directory or framework_root / "templates" / "dlz"
        self.output_directory = output_directory or framework_root / "output" / "dlz"

        # Ensure directories exist
        self.output_directory.mkdir(parents=True, exist_ok=True)

        # Default configuration
        self.default_config = {
            "location": "eastus2",
            "storage_account_suffix": "dlz",
            "retention_days": 2555,  # 7 years
            "medallion_containers": ["bronze", "silver", "gold", "sandbox"],
            "purview_collection": "data-landing-zones",
            "data_classification_tags": {
                "public": {"retention": "1year", "encryption": "standard"},
                "internal": {"retention": "3years", "encryption": "standard"},
                "confidential": {"retention": "7years", "encryption": "customer_managed"},
                "restricted": {"retention": "7years", "encryption": "customer_managed"}
            }
        }

        logger.info("DLZ provisioner initialized",
                   template_dir=str(self.template_directory),
                   output_dir=str(self.output_directory))

    def generate_landing_zone_name(self, source_config: Dict[str, Any]) -> str:
        """Generate a unique landing zone name.

        Args:
            source_config: Source registration configuration

        Returns:
            Generated landing zone name
        """
        # Use target landing zone if specified, otherwise generate from source
        if "target" in source_config and "landing_zone" in source_config["target"]:
            return source_config["target"]["landing_zone"]

        # Generate from source metadata
        owner_domain = source_config["owner"]["domain"]
        source_name = source_config["source_name"]

        # Clean names for Azure resource naming
        clean_domain = "".join(c for c in owner_domain if c.isalnum()).lower()
        clean_source = "".join(c for c in source_name if c.isalnum()).lower()

        return f"lz-{clean_domain}-{clean_source}"

    def generate_storage_account_name(self, landing_zone_name: str) -> str:
        """Generate storage account name from landing zone name.

        Args:
            landing_zone_name: Landing zone name

        Returns:
            Valid Azure storage account name
        """
        # Remove 'lz-' prefix and hyphens, ensure max 24 chars
        clean_name = landing_zone_name.replace("lz-", "").replace("-", "")
        suffix = self.default_config["storage_account_suffix"]

        # Ensure total length is within Azure limits (24 chars max)
        max_base_length = 24 - len(suffix)
        if len(clean_name) > max_base_length:
            clean_name = clean_name[:max_base_length]

        return f"{clean_name}{suffix}"

    def generate_medallion_structure(
        self,
        source_config: Dict[str, Any],
        landing_zone_name: str
    ) -> Dict[str, Any]:
        """Generate medallion architecture storage structure.

        Args:
            source_config: Source configuration
            landing_zone_name: Landing zone name

        Returns:
            Storage structure definition
        """
        source_name = source_config["source_name"]
        clean_source = source_name.replace(" ", "_").replace("-", "_").lower()

        structure = {
            "containers": {},
            "folder_structure": {},
            "retention_policies": {},
            "access_policies": {}
        }

        for container in self.default_config["medallion_containers"]:
            structure["containers"][container] = {
                "name": container,
                "public_access": "None",
                "metadata": {
                    "purpose": f"{container.title()} layer data",
                    "source": source_name,
                    "landing_zone": landing_zone_name
                }
            }

            # Define folder structure within container
            if container == "bronze":
                # Raw data from source
                folder_path = f"{clean_source}/raw/{{year}}/{{month}}/{{day}}"
            elif container == "silver":
                # Cleaned and standardized data
                folder_path = f"{clean_source}/standardized/{{year}}/{{month}}/{{day}}"
            elif container == "gold":
                # Business-ready aggregated data
                folder_path = f"{clean_source}/aggregated/{{year}}/{{month}}/{{day}}"
            else:  # sandbox
                # Experimental and development data
                folder_path = f"{clean_source}/sandbox/{{user}}/{{experiment}}"

            structure["folder_structure"][container] = {
                "base_path": folder_path,
                "partitioning": "date" if container != "sandbox" else "user_experiment"
            }

            # Retention policies based on classification
            classification = source_config.get("classification", "internal")
            retention_config = self.default_config["data_classification_tags"][classification]

            structure["retention_policies"][container] = {
                "retention_days": self.default_config["retention_days"],
                "delete_after_retention": False,
                "archive_after_days": 365 if container == "bronze" else 90
            }

            # Access policies
            structure["access_policies"][container] = {
                "owner_access": "rwx",  # Full access for data owner
                "reader_access": "rx",  # Read access for consumers
                "service_principal_access": "rwx"  # Full access for pipelines
            }

        return structure

    def generate_rbac_assignments(
        self,
        source_config: Dict[str, Any],
        landing_zone_name: str,
        storage_account_name: str
    ) -> List[Dict[str, Any]]:
        """Generate RBAC assignments for the landing zone.

        Args:
            source_config: Source configuration
            landing_zone_name: Landing zone name
            storage_account_name: Storage account name

        Returns:
            List of RBAC assignment definitions
        """
        assignments = []

        # Data owner gets Storage Blob Data Contributor
        owner_email = source_config["owner"]["email"]
        assignments.append({
            "principal_email": owner_email,
            "role_definition_name": "Storage Blob Data Contributor",
            "scope": f"storage_account:{storage_account_name}",
            "description": f"Data owner access for {landing_zone_name}"
        })

        # Data Factory managed identity gets Storage Blob Data Contributor
        assignments.append({
            "principal_type": "ServicePrincipal",
            "principal_name": "adf-csa-prod",  # Data Factory managed identity
            "role_definition_name": "Storage Blob Data Contributor",
            "scope": f"storage_account:{storage_account_name}",
            "description": f"ADF pipeline access for {landing_zone_name}"
        })

        # Purview managed identity gets Storage Blob Data Reader
        assignments.append({
            "principal_type": "ServicePrincipal",
            "principal_name": "purview-csa-prod",
            "role_definition_name": "Storage Blob Data Reader",
            "scope": f"storage_account:{storage_account_name}",
            "description": f"Purview scanning access for {landing_zone_name}"
        })

        # Data domain team gets Storage Blob Data Reader
        domain = source_config["owner"]["domain"]
        assignments.append({
            "principal_type": "Group",
            "principal_name": f"DataDomain-{domain}",
            "role_definition_name": "Storage Blob Data Reader",
            "scope": f"storage_account:{storage_account_name}",
            "description": f"Domain team read access for {landing_zone_name}"
        })

        return assignments

    def generate_purview_scans(
        self,
        source_config: Dict[str, Any],
        landing_zone_name: str,
        storage_account_name: str
    ) -> List[Dict[str, Any]]:
        """Generate Purview scan configurations.

        Args:
            source_config: Source configuration
            landing_zone_name: Landing zone name
            storage_account_name: Storage account name

        Returns:
            List of Purview scan definitions
        """
        scans = []

        # Create scan for each medallion container
        for container in self.default_config["medallion_containers"]:
            scan_name = f"scan-{landing_zone_name}-{container}"

            scans.append({
                "scan_name": scan_name,
                "data_source_name": f"dlz-{storage_account_name}",
                "collection_name": self.default_config["purview_collection"],
                "scope": {
                    "storage_account": storage_account_name,
                    "container": container,
                    "path": "/"
                },
                "scan_rule_set": "AdlsGen2",
                "schedule": {
                    "kind": "Weekly",
                    "day_of_week": "Sunday",
                    "time": "02:00:00"
                },
                "classification_rules": self._get_classification_rules(source_config),
                "metadata": {
                    "source_name": source_config["source_name"],
                    "source_type": source_config["source_type"],
                    "owner": source_config["owner"]["email"],
                    "domain": source_config["owner"]["domain"],
                    "classification": source_config.get("classification", "internal")
                }
            })

        return scans

    def _get_classification_rules(self, source_config: Dict[str, Any]) -> List[str]:
        """Get classification rules based on source configuration."""
        classification = source_config.get("classification", "internal")
        base_rules = ["System"]

        if classification in ["confidential", "restricted"]:
            base_rules.extend([
                "MICROSOFT.PERSONAL.NAME",
                "MICROSOFT.PERSONAL.EMAIL",
                "MICROSOFT.PERSONAL.PHONENUMBER",
                "MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER"
            ])

        return base_rules

    def generate_bicep_parameters(
        self,
        source_config: Dict[str, Any],
        landing_zone_name: str,
        storage_account_name: str,
        storage_structure: Dict[str, Any],
        rbac_assignments: List[Dict[str, Any]],
        environment: str = "development"
    ) -> Dict[str, Any]:
        """Generate Bicep parameters file for DLZ deployment.

        Args:
            source_config: Source configuration
            landing_zone_name: Landing zone name
            storage_account_name: Storage account name
            storage_structure: Storage structure definition
            rbac_assignments: RBAC assignments
            environment: Target environment

        Returns:
            Bicep parameters file content
        """
        parameters = {
            "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
            "contentVersion": "1.0.0.0",
            "parameters": {
                "landingZoneName": {
                    "value": landing_zone_name
                },
                "storageAccountName": {
                    "value": storage_account_name
                },
                "location": {
                    "value": self.default_config["location"]
                },
                "environment": {
                    "value": environment
                },
                "dataClassification": {
                    "value": source_config.get("classification", "internal")
                },
                "containers": {
                    "value": list(storage_structure["containers"].keys())
                },
                "ownerEmail": {
                    "value": source_config["owner"]["email"]
                },
                "ownerDomain": {
                    "value": source_config["owner"]["domain"]
                },
                "retentionDays": {
                    "value": self.default_config["retention_days"]
                },
                "sourceMetadata": {
                    "value": {
                        "source_id": source_config["source_id"],
                        "source_name": source_config["source_name"],
                        "source_type": source_config["source_type"]
                    }
                },
                "rbacAssignments": {
                    "value": rbac_assignments
                },
                "tags": {
                    "value": {
                        "Environment": environment,
                        "Project": "CSA-in-a-Box",
                        "LandingZone": landing_zone_name,
                        "DataDomain": source_config["owner"]["domain"],
                        "DataClassification": source_config.get("classification", "internal"),
                        "Owner": source_config["owner"]["email"],
                        "CreatedBy": "MetadataFramework",
                        "CreatedAt": datetime.utcnow().strftime("%Y-%m-%d")
                    }
                }
            }
        }

        # Add data product information if available
        if "data_product" in source_config:
            data_product = source_config["data_product"]
            parameters["parameters"]["dataProduct"] = {
                "value": {
                    "name": data_product["name"],
                    "domain": data_product["domain"],
                    "sla_freshness_minutes": data_product.get("sla_freshness_minutes", 1440)
                }
            }

        return parameters

    def generate_deployment_config(
        self,
        source_config: Dict[str, Any],
        landing_zone_name: str,
        environment: str
    ) -> Dict[str, Any]:
        """Generate deployment configuration.

        Args:
            source_config: Source configuration
            landing_zone_name: Landing zone name
            environment: Target environment

        Returns:
            Deployment configuration
        """
        return {
            "deployment_id": str(uuid.uuid4()),
            "landing_zone_name": landing_zone_name,
            "environment": environment,
            "resource_group": f"rg-data-landing-zones-{environment}",
            "subscription_id": "$(AZURE_SUBSCRIPTION_ID)",
            "deployment_mode": "Incremental",
            "template_file": f"dlz-{landing_zone_name}.bicep",
            "parameters_file": f"dlz-{landing_zone_name}.parameters.json",
            "generated_at": datetime.utcnow().isoformat(),
            "source_metadata": {
                "source_id": source_config["source_id"],
                "source_name": source_config["source_name"],
                "owner": source_config["owner"]["email"],
                "domain": source_config["owner"]["domain"]
            },
            "post_deployment_tasks": [
                {
                    "name": "register_purview_data_source",
                    "type": "purview_api",
                    "config": {
                        "account_name": "purview-csa-prod",
                        "collection_name": self.default_config["purview_collection"]
                    }
                },
                {
                    "name": "create_purview_scans",
                    "type": "purview_api",
                    "depends_on": ["register_purview_data_source"]
                },
                {
                    "name": "validate_rbac_assignments",
                    "type": "azure_cli",
                    "config": {
                        "command": "az role assignment list --scope /subscriptions/$(AZURE_SUBSCRIPTION_ID)/resourceGroups/$(RESOURCE_GROUP)/providers/Microsoft.Storage/storageAccounts/$(STORAGE_ACCOUNT_NAME)"
                    }
                }
            ]
        }

    def provision_dlz_from_config(
        self,
        source_config: Dict[str, Any],
        environment: str = "development"
    ) -> DLZProvisioningResult:
        """Provision DLZ from source configuration.

        Args:
            source_config: Source registration dictionary
            environment: Target deployment environment

        Returns:
            DLZProvisioningResult with provisioning artifacts

        Raises:
            DLZProvisioningError: If provisioning fails
        """
        try:
            # Generate names
            landing_zone_name = self.generate_landing_zone_name(source_config)
            storage_account_name = self.generate_storage_account_name(landing_zone_name)

            # Generate storage structure
            storage_structure = self.generate_medallion_structure(
                source_config,
                landing_zone_name
            )

            # Generate RBAC assignments
            rbac_assignments = self.generate_rbac_assignments(
                source_config,
                landing_zone_name,
                storage_account_name
            )

            # Generate Purview scans
            purview_scans = self.generate_purview_scans(
                source_config,
                landing_zone_name,
                storage_account_name
            )

            # Generate Bicep parameters
            parameters_file = self.generate_bicep_parameters(
                source_config,
                landing_zone_name,
                storage_account_name,
                storage_structure,
                rbac_assignments,
                environment
            )

            # Generate deployment config
            deployment_config = self.generate_deployment_config(
                source_config,
                landing_zone_name,
                environment
            )

            # Determine Bicep template path (would use a standard DLZ template)
            bicep_template_path = str(self.template_directory / "data-landing-zone.bicep")

            dlz_id = str(uuid.uuid4())

            logger.info("DLZ provisioning completed",
                       dlz_id=dlz_id,
                       landing_zone_name=landing_zone_name,
                       storage_account_name=storage_account_name,
                       environment=environment)

            return DLZProvisioningResult(
                dlz_id=dlz_id,
                landing_zone_name=landing_zone_name,
                bicep_template_path=bicep_template_path,
                parameters_file=parameters_file,
                rbac_assignments=rbac_assignments,
                purview_scans=purview_scans,
                storage_structure=storage_structure,
                deployment_config=deployment_config
            )

        except Exception as e:
            logger.error("DLZ provisioning failed", error=str(e))
            raise DLZProvisioningError(f"Failed to provision DLZ: {e}") from e

    def provision_dlz_from_file(
        self,
        source_file: Union[str, Path],
        environment: str = "development"
    ) -> DLZProvisioningResult:
        """Provision DLZ from source registration file.

        Args:
            source_file: Path to source registration YAML/JSON file
            environment: Target deployment environment

        Returns:
            DLZProvisioningResult with provisioning artifacts
        """
        source_path = Path(source_file)

        try:
            # Load source configuration
            with open(source_path, "r", encoding="utf-8") as f:
                if source_path.suffix.lower() in (".yaml", ".yml"):
                    source_config = yaml.safe_load(f)
                else:
                    source_config = json.load(f)

            logger.info("Source configuration loaded for DLZ provisioning",
                       file=str(source_path),
                       source_id=source_config.get("source_id"))

            return self.provision_dlz_from_config(source_config, environment)

        except FileNotFoundError as e:
            raise DLZProvisioningError(f"Source file not found: {source_path}") from e
        except (yaml.YAMLError, json.JSONDecodeError) as e:
            raise DLZProvisioningError(f"Invalid source file format: {e}") from e

    def save_provisioning_artifacts(
        self,
        result: DLZProvisioningResult,
        output_directory: Optional[Path] = None
    ) -> Dict[str, Path]:
        """Save DLZ provisioning artifacts to files.

        Args:
            result: DLZ provisioning result
            output_directory: Override default output directory

        Returns:
            Dictionary mapping artifact type to file path
        """
        output_dir = output_directory or self.output_directory
        output_dir.mkdir(parents=True, exist_ok=True)

        saved_files = {}
        base_name = f"dlz-{result.landing_zone_name}"

        # Save parameters file
        if result.parameters_file:
            params_path = output_dir / f"{base_name}.parameters.json"
            with open(params_path, "w", encoding="utf-8") as f:
                json.dump(result.parameters_file, f, indent=2)
            saved_files["parameters_file"] = params_path

        # Save RBAC assignments
        if result.rbac_assignments:
            rbac_path = output_dir / f"{base_name}.rbac.json"
            with open(rbac_path, "w", encoding="utf-8") as f:
                json.dump(result.rbac_assignments, f, indent=2)
            saved_files["rbac_assignments"] = rbac_path

        # Save Purview scans
        if result.purview_scans:
            purview_path = output_dir / f"{base_name}.purview-scans.json"
            with open(purview_path, "w", encoding="utf-8") as f:
                json.dump(result.purview_scans, f, indent=2)
            saved_files["purview_scans"] = purview_path

        # Save storage structure
        if result.storage_structure:
            storage_path = output_dir / f"{base_name}.storage-structure.json"
            with open(storage_path, "w", encoding="utf-8") as f:
                json.dump(result.storage_structure, f, indent=2)
            saved_files["storage_structure"] = storage_path

        # Save deployment config
        if result.deployment_config:
            deploy_path = output_dir / f"{base_name}.deployment.json"
            with open(deploy_path, "w", encoding="utf-8") as f:
                json.dump(result.deployment_config, f, indent=2)
            saved_files["deployment_config"] = deploy_path

        logger.info("DLZ provisioning artifacts saved",
                   landing_zone_name=result.landing_zone_name,
                   output_directory=str(output_dir),
                   files=list(saved_files.keys()))

        return saved_files

    def validate_dlz_configuration(
        self,
        result: DLZProvisioningResult
    ) -> List[str]:
        """Validate DLZ configuration.

        Args:
            result: DLZ provisioning result

        Returns:
            List of validation warnings/errors (empty if valid)
        """
        warnings = []

        # Check naming conventions
        if not result.landing_zone_name.startswith("lz-"):
            warnings.append("Landing zone name should start with 'lz-'")

        # Check storage structure
        if result.storage_structure:
            containers = result.storage_structure.get("containers", {})
            required_containers = {"bronze", "silver", "gold"}
            missing_containers = required_containers - set(containers.keys())
            if missing_containers:
                warnings.append(f"Missing required containers: {missing_containers}")

        # Check RBAC assignments
        if result.rbac_assignments:
            has_owner_access = any(
                "Storage Blob Data Contributor" in assignment.get("role_definition_name", "")
                for assignment in result.rbac_assignments
            )
            if not has_owner_access:
                warnings.append("No Storage Blob Data Contributor assignment found")

        return warnings


if __name__ == "__main__":
    """CLI interface for DLZ provisioning."""
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        description="Provision data landing zones from metadata source registrations"
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
        "--environment",
        default="development",
        help="Target deployment environment"
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging"
    )

    args = parser.parse_args()

    try:
        provisioner = DLZProvisioner(
            output_directory=args.output_dir,
            debug=args.debug
        )

        # Provision DLZ
        result = provisioner.provision_dlz_from_file(
            args.source_file,
            args.environment
        )

        # Save artifacts
        saved_files = provisioner.save_provisioning_artifacts(result)

        # Validate configuration
        warnings = provisioner.validate_dlz_configuration(result)
        if warnings:
            print("⚠️ DLZ configuration has warnings:")
            for warning in warnings:
                print(f"  - {warning}")

        print(f"✅ DLZ provisioned successfully: {result.landing_zone_name}")
        print(f"📁 Output files saved to: {provisioner.output_directory}")
        for artifact_type, file_path in saved_files.items():
            print(f"  - {artifact_type}: {file_path.name}")

    except DLZProvisioningError as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ Unexpected error: {e}", file=sys.stderr)
        if args.debug:
            import traceback
            traceback.print_exc()
        sys.exit(1)