"""CSA-in-a-Box Metadata-Driven Pipeline Framework.

This package provides tools for generating Azure Data Factory pipelines
and provisioning data landing zones from metadata source registrations.

Key modules:
- pipeline_generator: Generates ADF pipelines from source metadata
- dlz_provisioner: Provisions data landing zones with proper governance

Example usage:
    from metadata_framework.generator import PipelineGenerator, DLZProvisioner

    # Generate pipeline
    generator = PipelineGenerator()
    result = generator.generate_from_file("source_registration.yaml")

    # Provision landing zone
    provisioner = DLZProvisioner()
    dlz_result = provisioner.provision_dlz_from_file("source_registration.yaml")
"""

__version__ = "1.0.0"

from .dlz_provisioner import DLZProvisioner, DLZProvisioningError
from .pipeline_generator import PipelineGenerationError, PipelineGenerator

__all__ = ["DLZProvisioner", "DLZProvisioningError", "PipelineGenerationError", "PipelineGenerator"]
