"""CSA-in-a-Box Metadata-Driven Pipeline Framework.

A declarative, schema-driven approach to data ingestion that automatically
generates Azure Data Factory pipelines and provisions data landing zones
from metadata definitions.

This framework enables:
- Automated pipeline generation from YAML/JSON source registrations
- Standardized data landing zones with medallion architecture
- Integrated governance with RBAC and Purview
- Support for multiple ingestion patterns (full, incremental, CDC, streaming)
- Quality validation and monitoring
"""

__version__ = "1.0.0"

# Make key classes available at package level for convenience
try:
    from .generator import DLZProvisioner, PipelineGenerator
    __all__ = ["DLZProvisioner", "PipelineGenerator"]
except ImportError:
    # Gracefully handle import errors during development
    __all__ = []
