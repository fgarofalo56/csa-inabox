[← Platform Components](../README.md)

# Platform Governance — Consolidated


> **Note (2026-04-19):** This tree is the result of consolidating
> `csa_platform/purview_governance/` (Python automation) + top-level
> `governance/` (common/contracts/dataquality/finops/compliance + IaC for
> keyvault/network/policies/rbac) into a single canonical namespace
> (CSA-0126 / AQ-0025). If you had imports from either old path, update
> to `csa_platform.governance.*`. Doc paths that pointed at
> `governance/<sub>/` now resolve to `csa_platform/governance/<sub>/`.

> [!NOTE]
> **TL;DR:** One governance package covering (a) data-product contracts,
> data-quality orchestration, shared logging/validation, and compliance
> manifests, and (b) Microsoft Purview automation (classification rules,
> glossary, scan scheduling, lineage, data-sharing enforcement), plus the
> IaC assets for RBAC, Key Vault, network validation, Azure Policy
> references, and FinOps guardrails.

## Table of Contents

- [Structure](#-structure)
- [Modules](#-modules)
- [Purview Automation](#-purview-automation)
- [Classification Rules](#-classification-rules)
- [Data Sharing Agreements](#-data-sharing-agreements)
- [Compliance Manifests](#-compliance-manifests)
- [Getting Started](#-getting-started)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [PyPI Extraction Plan](#-pypi-extraction-plan)
- [Related Documentation](#-related-documentation)

---

## 📁 Structure

```text
csa_platform/governance/
├── __init__.py
├── README.md                     # This file
│
│ ── Python toolchain ────────────────────────────────────────────────
├── common/                       # Shared utilities (logging, validation)
│   ├── logging.py
│   └── validation.py
├── contracts/                    # Data contract validation
│   ├── contract_validator.py
│   ├── dbt_test_generator.py
│   └── pipeline_enforcer.py
├── dataquality/                  # Great Expectations integration
│   ├── ge_runner.py
│   ├── quality-rules.yaml
│   └── run_quality_checks.py
├── compliance/                   # Framework control manifests + validator
│   ├── cmmc-2.0-l2.yaml
│   ├── hipaa-security-rule.yaml
│   ├── nist-800-53-rev5.yaml
│   ├── compliance-overview.md
│   └── validate.py
│
│ ── Purview automation ──────────────────────────────────────────────
├── purview/
│   ├── purview_automation.py     # Purview REST-API automation
│   ├── classifications/          # PII/PHI/financial/government YAMLs
│   ├── data_sharing/             # Inter-domain sharing enforcer
│   ├── classification_rules/     # JSON classification rules (legacy)
│   ├── glossary/                 # Business glossary JSON
│   └── scanning/                 # Scan-source PS registration scripts
│
│ ── IaC / infrastructure governance ────────────────────────────────
├── finops/                       # Budget alerts + tagging policy
├── keyvault/                     # Key Vault Bicep + PS management
├── network/                      # Network validation PS scripts
├── policies/                     # Azure Policy reference CSVs
├── rbac/                         # RBAC matrix JSON + assign PS
│
└── tests/                        # Package-local tests (Purview + data-sharing)
```

---

## 🧩 Modules

| Module | Purpose | Language |
|---|---|---|
| `common/` | Shared structlog logging + regex validation utilities | Python |
| `contracts/` | Data-contract validation, dbt test generation, pipeline enforcement | Python |
| `dataquality/` | Great Expectations suites, quality rules, checkpoint runner | Python |
| `compliance/` | NIST 800-53 / CMMC / HIPAA control manifests + schema validator | YAML + Python |
| `purview/` | Microsoft Purview REST automation (classifications, glossary, lineage, scans, data sharing) | Python + YAML + JSON + PS |
| `finops/` | Budget alerts and tagging policy | Bicep + JSON |
| `keyvault/` | Key Vault provisioning and configuration | Bicep + PowerShell + JSON |
| `network/` | Network topology validation scripts | PowerShell |
| `policies/` | Azure Policy built-in reference index | CSV |
| `rbac/` | RBAC role matrix and assignment scripts | JSON + PowerShell |

---

## 🔌 Purview Automation

The `purview/purview_automation.py` module wraps the Purview REST API to
automate common governance tasks.

### Classification Rules

```python
from csa_platform.governance.purview.purview_automation import PurviewAutomation
from azure.identity import DefaultAzureCredential

purview = PurviewAutomation(
    account_name="purview-prod",
    credential=DefaultAzureCredential(),
)

# Load and apply all classification rules from YAML
purview.apply_classification_rules("csa_platform/governance/purview/classifications/pii_classifications.yaml")
purview.apply_classification_rules("csa_platform/governance/purview/classifications/phi_classifications.yaml")
```

### Glossary Import

```python
# Bulk import glossary terms
purview.import_glossary_terms("csa_platform/governance/purview/glossary/business_glossary.json")
```

### Lineage Registration

```python
# Register ADF pipeline lineage
purview.register_adf_lineage(
    pipeline_name="ingest_orders",
    factory_name="adf-prod",
    source_datasets=["raw_orders_csv"],
    sink_datasets=["bronze.raw_orders"],
)

# Register dbt run lineage
purview.register_dbt_lineage(
    manifest_path="target/manifest.json",
    run_results_path="target/run_results.json",
)
```

---

## 🔒 Classification Rules

Classification YAMLs live under `purview/classifications/`:

| File | Category | Patterns |
|---|---|---|
| `pii_classifications.yaml` | Personal Information | SSN, email, phone, address |
| `phi_classifications.yaml` | Protected Health Info | Medical records, diagnoses |
| `financial_classifications.yaml` | Financial Data | Account numbers, routing numbers |
| `government_classifications.yaml` | Government Markings | CUI, FOUO, classification levels |

### Rule Format

```yaml
classifications:
  - name: CSA_PII_SSN
    description: US Social Security Number
    category: PII
    dataPatterns:
      - pattern: '\b\d{3}-\d{2}-\d{4}\b'
        description: SSN with dashes (123-45-6789)
    columnPatterns:
      - pattern: '(?i)(ssn|social_security|ss_number)'
    sensitivity: Restricted
    minimumPercentageMatch: 60.0
```

---

## 🔒 Data Sharing Agreements

Inter-domain data sharing is governed by formal agreements defined in
YAML. The `purview/data_sharing/sharing_enforcer.py` module validates
sharing requests against these agreements before granting access.

```python
from csa_platform.governance.purview.data_sharing.sharing_enforcer import SharingEnforcer

enforcer = SharingEnforcer(agreements_dir="csa_platform/governance/purview/data_sharing/agreements/")
result = enforcer.validate_request(
    provider_domain="finance",
    consumer_domain="sales",
    data_product="invoices",
    access_level="read",
)
```

---

## 📜 Compliance Manifests

`compliance/` holds the CSA-0012 framework control matrices (NIST
800-53 Rev 5, CMMC 2.0 Level 2, HIPAA Security Rule). Validate schema
and evidence integrity with:

```bash
python csa_platform/governance/compliance/validate.py
python csa_platform/governance/compliance/validate.py --strict
```

See `compliance/compliance-overview.md` for the narrative posture.

---

## 🚀 Getting Started

```bash
# Install the package in development mode
pip install -e ".[governance]"

# Run data quality checks
python -m csa_platform.governance.dataquality.run_quality_checks

# Validate a data contract
python -m csa_platform.governance.contracts.contract_validator --contract path/to/contract.yaml

# Check dbt schema drift against contracts
python -m csa_platform.governance.contracts.dbt_test_generator --repo-root . --check
```

---

## 🧪 Testing

```bash
# Root test suite — contracts / dataquality / common / e2e
pytest tests/contracts/ tests/dataquality/ tests/common/ -v

# Purview + data-sharing tests (root suite)
pytest tests/csa_platform/test_purview_governance.py -v

# Package-local tests
pytest csa_platform/governance/tests/ -v
```

---

## 📦 Deployment

1. **CI/CD pipeline steps** — contract validation + dbt test drift checks on every PR (see `.github/workflows/test.yml`).
2. **Scheduled Azure Functions** — classification sync and lineage push (see `csa_platform/functions/`).
3. **CLI tools** — ad-hoc glossary imports and classification rule updates.

```bash
# Apply all classification rules to Purview
python -m csa_platform.governance.purview.purview_automation \
  --account purview-prod \
  --action apply-classifications \
  --rules-dir csa_platform/governance/purview/classifications/
```

---

## 📦 PyPI Extraction Plan

This tree was previously two separate packages. The long-term
extraction targets are:

- `csa-governance` (PyPI): the Python toolchain — `common/`,
  `contracts/`, `dataquality/`, `compliance/`, and the Purview
  automation under `purview/`.
- `csa-deploy`: the IaC assets — `finops/`, `keyvault/`, `network/`,
  `policies/`, `rbac/` (and the JSON/PS bits under `purview/`).

Consolidating here simplifies extraction: one tree to split, one
namespace to import from.

> **Status:** Aspirational. No extraction work is currently in
> flight. Treat this as a future-state note, not a roadmap commitment.

---

## 🔗 Related Documentation

- [Platform Components](../README.md) — Platform component index
- [Platform Services](../../docs/PLATFORM_SERVICES.md) — Detailed platform service descriptions
- [Architecture](../../docs/ARCHITECTURE.md) — Overall system architecture
- [Data Marketplace](../data_marketplace/README.md) — Data product discovery and access
- [Platform Functions](../functions/README.md) — Consolidated Azure Functions library
- [Log Schema](../../docs/LOG_SCHEMA.md) — Structured logging format
- [Compliance Overview](compliance/compliance-overview.md)
