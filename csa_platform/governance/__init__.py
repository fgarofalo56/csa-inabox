"""csa_platform.governance — consolidated governance toolchain (CSA-0126).

Sub-packages:

    * common         — shared structlog logging + regex validation utilities
    * contracts      — data-contract validation, dbt test generation, pipeline enforcement
    * dataquality    — Great Expectations runner + quality-rule orchestration
    * compliance     — NIST / CMMC / HIPAA control manifests + validator
    * purview        — Microsoft Purview automation (classification, glossary, lineage, data sharing)

Also ships IaC assets (``finops/``, ``keyvault/``, ``network/``,
``policies/``, ``rbac/``) for the ``csa-deploy`` extraction target.

This tree consolidates what previously lived under
``csa_platform/purview_governance/`` (Python automation) and top-level
``governance/`` (common/contracts/dataquality/finops/compliance).
If you had imports from either old path, update to
``csa_platform.governance.*`` (CSA-0126 / AQ-0025).
"""

__all__ = [
    "common",
    "compliance",
    "contracts",
    "dataquality",
    "purview",
]
