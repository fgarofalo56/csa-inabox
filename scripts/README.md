# Scripts — Operational Automation

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** DevOps Engineers, Data Engineers

This directory contains operational scripts for deploying, seeding, monitoring, and
managing the CSA-in-a-Box platform.

## Table of Contents

- [Categories](#categories)
- [Key Scripts](#key-scripts)
- [Getting Started](#getting-started)
- [Related Documentation](#related-documentation)

## Categories

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

## Key Scripts

| Script | What It Does |
|--------|-------------|
| `deploy/deploy-platform.sh` | Full platform deployment orchestrator |
| `deploy/deploy-adf.sh` | Azure Data Factory deployment |
| `deploy/validate-prerequisites.sh` | Checks all prerequisites before deployment |
| `deploy/estimate-costs.sh` | Estimates monthly Azure costs |
| `seed/load_sample_data.py` | Loads sample datasets into ADLS / Synapse |
| `streaming/produce_events.py` | Generates streaming events for Event Hub |

## Getting Started

1. Review `deploy/validate-prerequisites.sh` to check your environment
2. Run `make deploy-dev` for a dev deployment (uses `deploy/deploy-platform.sh`)
3. Run `make seed` to load sample data (uses `seed/load_sample_data.py`)
4. See `streaming/README.md` for the real-time analytics pipeline setup

---

## Related Documentation

- [Getting Started](../docs/GETTING_STARTED.md) — Prerequisites and setup walkthrough
- [Quick Start](../docs/QUICKSTART.md) — 60-minute hands-on tutorial
- [Deployment](../docs/IaC-CICD-Best-Practices.md) — IaC and CI/CD patterns
