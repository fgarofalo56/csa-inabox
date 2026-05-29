# Scripts — Operational Automation

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.



This directory contains operational scripts for deploying, seeding, monitoring, and
managing the CSA-in-a-Box platform.

## Table of Contents

- [Categories](#-categories)
- [Key Scripts](#-key-scripts)
- [Getting Started](#-getting-started)
- [Related Documentation](#-related-documentation)

---

## 📁 Categories

| Directory | Purpose | Language |
|-----------|---------|----------|
| [deploy/](deploy/) | Platform deployment and validation | Bash |
| [seed/](seed/) | Sample data loading | Python |
| [streaming/](streaming/) | Real-time event processing setup | Python, ASAQL |
| [monitor/](monitor/) | ADF, Databricks, Synapse monitoring notebooks | Python, KQL |
| [data/](data/) | Data utilities and management | Python |
| [azure-ips/](azure-ips/) | Azure IP range management | — |
| [diagnostic-settings/](diagnostic-settings/) | Azure Monitor diagnostic configuration | — |
| [powershell/](powershell/) | PowerShell automation utilities | PowerShell |
| [purview/](purview/) | Microsoft Purview management scripts | Python |
| [python/](python/) | General Python utilities | Python |
| [sap/](sap/) | SAP integration scripts | — |
| [service-principal/](service-principal/) | Service principal provisioning | — |
| [sql/](sql/) | SQL Server / Synapse SQL scripts | SQL |
| [synapse-dep/](synapse-dep/) | Synapse dependency management | — |

---

## ✨ Key Scripts

| Script | What It Does |
|--------|-------------|
| `deploy/deploy-platform.sh` | Full platform deployment orchestrator |
| `deploy/deploy-adf.sh` | Azure Data Factory deployment |
| `deploy/validate-prerequisites.sh` | Checks all prerequisites before deployment |
| `deploy/estimate-costs.sh` | Estimates monthly Azure costs |
| `seed/load_sample_data.py` | Loads sample datasets into ADLS / Synapse |
| `streaming/produce_events.py` | Generates streaming events for Event Hub |

---

## 🚀 Getting Started

1. Review `deploy/validate-prerequisites.sh` to check your environment
2. Run `make deploy-dev` for a dev deployment (uses `deploy/deploy-platform.sh`)
3. Run `make seed` to load sample data (uses `seed/load_sample_data.py`)
4. See `streaming/README.md` for the real-time analytics pipeline setup

---

## 🔗 Related Documentation

- [Getting Started](../docs/GETTING_STARTED.md) — Prerequisites and setup walkthrough
- [Quick Start](../docs/QUICKSTART.md) — 60-minute hands-on tutorial
- [Deployment](../docs/IaC-CICD-Best-Practices.md) — IaC and CI/CD patterns
