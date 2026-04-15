# Deployment — Infrastructure as Code

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** DevOps Engineers

This directory contains all Infrastructure as Code (IaC) for provisioning the CSA-in-a-Box
platform using Azure Bicep templates. The deployment follows the Azure Cloud Adoption Framework
landing zone model across four subscriptions.

## Table of Contents

- [Structure](#structure)
- [Deployment Strategy](#deployment-strategy)
- [Getting Started](#getting-started)
- [Azure Government](#azure-government)
- [Related Documentation](#related-documentation)

## Structure

| Directory | Purpose |
|-----------|---------|
| [bicep/DLZ/](bicep/DLZ/) | **Data Landing Zone** — ADLS Gen2, Synapse, Databricks, ADF, Key Vault, Spoke VNet |
| [bicep/DMLZ/](bicep/DMLZ/) | **Data Management Landing Zone** — Purview, Container Registry, Shared Key Vault |
| [bicep/LandingZone - ALZ/](bicep/LandingZone%20-%20ALZ/) | **Azure Landing Zone** — Policy, RBAC, networking hub, security baselines |
| [bicep/gov/](bicep/gov/) | **Azure Government** — Gov-specific endpoint and API version overrides |
| [bicep/shared/](bicep/shared/) | Shared Bicep modules reused across landing zones |
| [bicep/code/](bicep/code/) | Utility scripts for Bicep deployment |
| [notebooks/](notebooks/) | Deployment verification notebooks |

## Deployment Strategy

The platform deploys across four Azure subscriptions:

1. **Management** — Policy, monitoring, Log Analytics
2. **Connectivity** — Hub VNet, Azure Firewall, Private DNS, VPN/ExpressRoute
3. **Data Management (DMLZ)** — Purview, shared services, catalog
4. **Data Landing Zone (DLZ)** — Per-domain compute and storage

## Getting Started

1. Install the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and [Bicep CLI](https://learn.microsoft.com/azure/azure-resource-manager/bicep/install)
2. Run `make lint-bicep` to validate all templates
3. Review parameter files (`params.dev.json`, `params.prod.json`) in each landing zone
4. Deploy to dev: `make deploy-dev` (runs a what-if dry run first)
5. See `scripts/deploy/` for automated deployment scripts

## Azure Government

All templates support Azure Government via the `bicep/gov/` overrides.
See [gov/README.md](bicep/gov/README.md) for Government-specific guidance.

---

## Related Documentation

- [Architecture](../docs/ARCHITECTURE.md) — System architecture reference
- [IaC & CI/CD Best Practices](../docs/IaC-CICD-Best-Practices.md) — Deployment patterns and standards
- [Environment Protection](../docs/ENVIRONMENT_PROTECTION.md) — Branch and environment safeguards
- [Production Checklist](../docs/PRODUCTION_CHECKLIST.md) — Pre-production validation steps
