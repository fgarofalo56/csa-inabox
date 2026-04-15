# Platform Governance — Purview Automation, Classification, and Data Sharing

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** Platform Engineers

> **Enhanced governance layer for CSA-in-a-Box**

## Table of Contents

- [Overview](#overview)
- [Components](#components)
- [Purview Automation](#purview-automation)
- [Classification Rules](#classification-rules)
- [Data Sharing Agreements](#data-sharing-agreements)
- [Deployment](#deployment)
- [Relationship to Core Governance](#relationship-to-core-governance)
- [Related Documentation](#related-documentation)

> Extends the core `governance/` package with Purview API automation,
> classification rule management, lineage registration, and inter-domain
> data sharing agreements.

## Overview

This module provides production-ready automation for Azure Purview
(Microsoft Purview) governance tasks that are typically manual in the
portal. It covers:

- **Classification Management** — auto-create PII, PHI, financial, and
  government classification rules from YAML definitions
- **Glossary Automation** — bulk import business glossary terms from YAML
- **Scan Scheduling** — programmatic scan creation and scheduling
- **Lineage Registration** — register lineage from ADF pipelines and
  dbt run metadata into Purview
- **Sensitivity Labeling** — auto-apply sensitivity labels based on
  classification results
- **Data Sharing** — enforce inter-domain data sharing agreements

## Components

```text
platform/governance/
├── README.md                       # This file
├── purview_automation.py           # Purview API automation module
├── classifications/
│   ├── pii_classifications.yaml    # PII detection rules (SSN, email, etc.)
│   ├── phi_classifications.yaml    # PHI detection rules (medical records)
│   ├── financial_classifications.yaml  # Financial data rules
│   └── government_classifications.yaml # Government markings (CUI, FOUO)
└── data_sharing/
    ├── sharing_agreement_template.yaml  # Inter-domain sharing template
    └── sharing_enforcer.py              # Validates sharing requests
```

## Purview Automation

The `purview_automation.py` module wraps the Purview REST API to automate
common governance tasks:

### Classification Rules

```python
from platform.governance.purview_automation import PurviewAutomation

purview = PurviewAutomation(
    account_name="purview-prod",
    credential=DefaultAzureCredential(),
)

# Load and apply all classification rules from YAML
purview.apply_classification_rules("classifications/pii_classifications.yaml")
purview.apply_classification_rules("classifications/phi_classifications.yaml")
```

### Glossary Import

```python
# Bulk import glossary terms
purview.import_glossary_terms("glossary/business_terms.yaml")
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

## Classification Rules

Classification rules are defined in YAML files under `classifications/`.
Each file contains rules for a specific category:

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

## Data Sharing Agreements

Inter-domain data sharing is governed by formal agreements defined in
YAML. The `sharing_enforcer.py` module validates sharing requests
against these agreements before granting access.

### Agreement Template

```yaml
agreement:
  provider:
    domain: finance
    dataProducts: [invoices, revenue-reconciliation]
  consumer:
    domain: sales
    purpose: Revenue reporting and reconciliation
  terms:
    accessLevel: read
    retention: 90 days
    piiAllowed: false
    auditRequired: true
    expiresAt: "2025-12-31"
```

### Enforcement

```python
from platform.governance.data_sharing.sharing_enforcer import SharingEnforcer

enforcer = SharingEnforcer(agreements_path="data_sharing/")

# Validate a sharing request
result = enforcer.validate_request(
    provider_domain="finance",
    consumer_domain="sales",
    data_product="invoices",
    access_level="read",
)

if result.approved:
    # Grant RBAC access
    ...
else:
    print(f"Denied: {result.reason}")
```

## Deployment

The governance automation scripts run as:

1. **CI/CD pipeline steps** — classification rules applied on merge to main
2. **Scheduled Azure Functions** — periodic scan scheduling and lineage sync
3. **CLI tools** — ad-hoc glossary imports and rule updates

```bash
# Apply all classification rules to Purview
python -m platform.governance.purview_automation \
  --account purview-prod \
  --action apply-classifications \
  --rules-dir classifications/

# Import glossary terms
python -m platform.governance.purview_automation \
  --account purview-prod \
  --action import-glossary \
  --glossary-file glossary/business_terms.yaml
```

## Relationship to Core Governance

This module extends the core `governance/` package:

| Core (`governance/`) | Platform (`platform/governance/`) |
|---|---|
| Contract validation | Purview classification rules |
| dbt test generation | Lineage registration |
| Pipeline enforcement | Scan scheduling |
| Great Expectations runner | Sensitivity labeling |
| | Data sharing agreements |

---

## Related Documentation

- [Platform Components](../README.md) - Platform component index
- [Platform Services](../../docs/PLATFORM_SERVICES.md) - Detailed platform service descriptions
- [Architecture](../../docs/ARCHITECTURE.md) - Overall system architecture
- [Data Marketplace](../data_marketplace/README.md) - Data product discovery and access
- [Shared Services](../shared-services/README.md) - Reusable function library
