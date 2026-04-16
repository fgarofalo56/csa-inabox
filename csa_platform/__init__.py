"""csa_platform — CSA-in-a-Box platform service modules.

Container package for the reusable platform services shipped by
CSA-in-a-Box:

    * ai_integration       — RAG, entity extraction, document classification
    * data_activator       — Event-driven alerting (Teams, PagerDuty, Email)
    * data_marketplace     — Data product discovery + access-request API
    * direct_lake          — Power BI Direct Lake semantic models
    * metadata_framework   — YAML-driven ADF pipeline auto-generation
    * multi_synapse        — Multi-workspace Synapse orchestration
    * onelake_pattern      — OneLake + Unity Catalog metadata management
    * oss_alternatives     — Helm charts for Gov-cloud OSS equivalents
    * purview_governance   — Purview classifications + data-sharing agreements
    * shared_services      — Shared Azure Functions (PII, quality, schema)

Each sub-package is independently importable and has its own tests under
``csa_platform/<module>/tests/`` plus (for the ones with coverage
tracking) under the root ``tests/platform/`` directory.

The package is declared in ``pyproject.toml`` under
``[tool.setuptools] packages`` so ``pip install -e .[platform]`` wires
up editable installs correctly.
"""

__all__: list[str] = []
