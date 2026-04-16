# Governance — Data Quality, Contracts & Compliance

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Data Engineers, Data Stewards

> [!NOTE]
> **TL;DR:** Publishable Python package providing data contract validation, data quality checks (Great Expectations), compliance policies, and infrastructure governance (Key Vault, FinOps, network). Zero dependencies on other repo modules.

This is the **only standalone-publishable Python package** in the monorepo. It enforces
data quality, contract compliance, and governance policies across the platform.

## Table of Contents

- [Structure](#-structure)
- [Modules](#-modules)
- [Getting Started](#-getting-started)
- [Testing](#-testing)
- [Future: PyPI Package](#-future-pypi-package)
- [Related Documentation](#-related-documentation)

---

## 📁 Structure

```text
governance/
├── __init__.py
├── common/                  # Shared utilities (logging, validation)
│   ├── logging.py
│   └── validation.py
├── contracts/               # Data contract validation
│   ├── contract_validator.py
│   ├── dbt_test_generator.py
│   └── pipeline_enforcer.py
├── dataquality/             # Great Expectations integration
│   ├── ge_runner.py
│   ├── quality-rules.yaml
│   └── run_quality_checks.py
├── compliance/              # Compliance documentation and checks
├── policies/                # Azure Policy definitions
├── purview/                 # Microsoft Purview integration
├── rbac/                    # Role-based access control definitions
├── finops/                  # FinOps — budget alerts and tagging (Bicep/JSON)
├── keyvault/                # Key Vault configuration and templates (Bicep)
└── network/                 # Network validation scripts (PowerShell)
```

---

## 🧩 Modules

| Module | Purpose | Language |
|--------|---------|----------|
| `contracts/` | Validate data contracts, generate dbt tests, enforce pipeline rules | Python |
| `dataquality/` | Run Great Expectations suites, quality rule definitions | Python |
| `common/` | Shared logging and validation utilities | Python |
| `compliance/` | Compliance posture documentation | Markdown |
| `policies/` | Azure Policy definitions for guardrails | JSON |
| `purview/` | Purview classification and lineage automation | Python |
| `rbac/` | RBAC role definitions and assignments | JSON |
| `finops/` | Budget alerts and tagging policies | Bicep, JSON |
| `keyvault/` | Key Vault provisioning and configuration | Bicep, PowerShell |
| `network/` | Network topology validation | PowerShell |

---

## 🚀 Getting Started

```bash
# Install the package in development mode
pip install -e ".[governance]"

# Run data quality checks
python -m governance.dataquality.run_quality_checks

# Validate a data contract
python -m governance.contracts.contract_validator --contract path/to/contract.yaml
```

---

## 🧪 Testing

Tests live in the repo-level `tests/` directory:

```bash
# Run all governance tests
pytest tests/contracts/ tests/dataquality/ tests/common/ -v

# Run e2e contract tests
pytest tests/e2e/test_e2e_contracts.py -v
```

---

## 📦 Future: PyPI Package

This module is designed for extraction as `csa-governance` on PyPI. See [`REPO_SPLIT.md`](../REPO_SPLIT.md) for the migration plan. The Python modules (`contracts/`, `dataquality/`, `common/`) have zero imports from other repo directories.

> **Note:** The IaC modules (`finops/`, `keyvault/`, `network/`) would move to `csa-deploy` during extraction, not into the PyPI package.

---

## 🔗 Related Documentation

- [Data Quality Rules](dataquality/quality-rules.yaml) — Quality rule definitions
- [Compliance Overview](compliance/compliance-overview.md) — Compliance posture
- [Repo Split Plan](../REPO_SPLIT.md) — Extraction roadmap
