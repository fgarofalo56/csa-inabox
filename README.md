# CSA-in-a-Box: Cloud-Scale Analytics Platform

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** All Users

> An open-source, Azure-native data platform that delivers Data Mesh, Data Fabric, and Data Lakehouse capabilities as a deployable "in-a-box" solution -- a fully featured alternative to Microsoft Fabric built on Azure services and open-source technologies.

## Table of Contents

- [What Is This?](#what-is-this)
- [Architecture](#architecture)
- [Subscription Layout (4 Subscriptions)](#subscription-layout-4-subscriptions)
- [Repository Structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Data Platform Components](#data-platform-components)
  - [Data Lakehouse (Delta Lake)](#data-lakehouse-delta-lake)
  - [Data Mesh Domains](#data-mesh-domains)
  - [Data Integration](#data-integration)
  - [Data Governance](#data-governance)
  - [Observability](#observability)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)
- [Related Resources](#related-resources)

## What Is This?

CSA-in-a-Box deploys a complete enterprise data platform across Azure subscriptions, providing:

- **Data Lakehouse** -- Delta Lake on ADLS Gen2 with medallion architecture (Bronze/Silver/Gold)
- **Data Mesh** -- Domain-oriented data ownership with self-serve infrastructure
- **Data Fabric** -- Unified metadata layer with automated governance via Azure Purview
- **Data Engineering** -- Apache Spark on Synapse/Databricks with dbt transformations
- **Data Integration** -- Azure Data Factory / Synapse Pipelines for ETL/ELT
- **Data Warehousing** -- Synapse Dedicated SQL Pools and Serverless SQL
- **Real-Time Analytics** -- Azure Data Explorer + Event Hubs streaming
- **AI/ML** -- Azure Machine Learning + Azure OpenAI integration
- **Data Governance** -- Microsoft Purview for cataloging, classification, and lineage
- **Observability** -- Log Analytics + Azure Monitor + custom KQL dashboards

## Architecture

```text
                    Management Subscription
                    +--------------------+
                    | Azure Landing Zone |
                    | Policy & Governance|
                    | Log Analytics      |
                    | Azure Monitor      |
                    +--------+-----------+
                             |
              +--------------+--------------+
              |                             |
   Connectivity Subscription    Data Management LZ (DMLZ)
   +--------------------+      +----------------------+
   | Hub VNet           |      | Azure Purview        |
   | Azure Firewall     |      | Container Registry   |
   | Private DNS Zones  |      | Shared Key Vault     |
   | VPN/ExpressRoute   |      | Data Catalog         |
   +--------+-----------+      +----------+-----------+
              |                             |
    +---------+---------+                   |
    |                   |                   |
  Data Landing Zone 1   Data Landing Zone N |
  (Dev/Domain A)        (Prod/Domain B)     |
  +------------------+  +--------------+    |
  | ADLS Gen2        |  | ADLS Gen2    |    |
  | Synapse Workspace|  | Databricks   |    |
  | ADF Pipelines    |  | ADF Pipelines|    |
  | Key Vault        |  | Key Vault    |    |
  | Spoke VNet       |  | Spoke VNet   |    |
  +---------+--------+  +------+-------+    |
            |                  |            |
            +------ Peered ----+--- Peered -+
```

## Subscription Layout (4 Subscriptions)

| Subscription | Purpose | Key Resources |
|---|---|---|
| **Management** | Platform governance, logging, monitoring | Log Analytics, Azure Monitor, Policy Assignments |
| **Connectivity** | Hub networking, DNS, firewall | Hub VNet, Azure Firewall, Private DNS Zones, VPN Gateway |
| **Data Management (DMLZ)** | Shared data services, governance | Purview, Container Registry, Shared Key Vault |
| **Data Landing Zone (DLZ)** | Domain data workloads | ADLS Gen2, Synapse, Databricks, ADF, Domain Key Vault |

## Repository Structure

```text
csa-inabox/                    # Infrastructure-as-Code
|   +-- bicep/
|   |   +-- DLZ/              # Data Landing Zone modules
|   |   +-- DMLZ/             # Data Management Landing Zone
|   |   +-- LandingZone-ALZ/  # Azure Landing Zone foundation
|   +-- arm/                   # Legacy ARM templates (deprecated)
|   +-- scripts/               # Deployment helper scripts
|   +-- notebooks/             # Setup & config notebooks
+-- domains/                   # Domain-oriented data mesh
|   +-- finance/               # Finance domain (aging reports, revenue reconciliation)
|   +-- inventory/             # Inventory domain (turnover, reorder alerts, warehouses)
|   +-- sales/                 # Sales domain (sales metrics, order analytics)
|   +-- shared/                # Shared domain (customers, orders, products, CLV)
|   +-- sharedServices/        # Azure Functions (AI enrichment, event processing)
|   +-- dlz/                   # Data Landing Zone examples
|   +-- spark/                 # Spark configurations & libraries
+-- scripts/                   # Operations & management scripts
|   +-- Azure IPs/            # Azure IP range management
|   +-- Diagnostic Settings/  # Policy-based diagnostic settings
|   +-- deploy/               # Deployment automation (ADF, cost estimation)
|   +-- monitor/              # KQL queries & monitoring
|   +-- purview/              # Purview catalog bootstrap & lineage
|   +-- seed/                 # Sample data loading
|   +-- streaming/            # Event Hub producer & Stream Analytics
|   +-- PowerShell/           # Management automation
|   +-- sql/                  # SQL & KQL references
+-- governance/                # Data governance framework
|   +-- common/               # Shared logging, validation utilities
|   +-- contracts/            # Data contracts & enforcement
|   +-- dataquality/          # Quality rules, Great Expectations runner
|   +-- finops/               # FinOps budget alerts (Bicep)
+-- great_expectations/        # GE checkpoints & DataContext config
+-- docs/                      # Platform documentation
|   +-- runbooks/             # Incident response & DR runbooks
+-- tests/                     # pytest test suite (80%+ coverage gate)
+-- tools/                    # Development tools
|   +-- dbt/                  # dbt for data transformations
+-- .github/                  # CI/CD workflows
```

## Prerequisites

- **Azure CLI** >= 2.50.0
- **Bicep CLI** >= 0.25
- **PowerShell** >= 7.3 with Az module >= 11.0
- **Python** >= 3.10 (for scripts and dbt)
- **Git** >= 2.40
- **Azure Subscriptions** -- 4 subscriptions with Owner or Contributor access
- **Azure AD** -- Global Admin or Privileged Role Administrator (for initial setup)

## Quick Start

See [QUICKSTART.md](docs/QUICKSTART.md) for the complete setup guide, including
infrastructure deployment, sample data loading, dbt pipeline execution, and
expected row counts for every model.

## Configuration

All environment-specific values are externalized to parameter files:

| Parameter File | Purpose |
|---|---|
| `params.template.json` | Template with placeholder values (committed) |
| `params.dev.json` | Development environment (not committed) |
| `params.test.json` | Test environment (not committed) |
| `params.prod.json` | Production environment (not committed) |

**Never commit parameter files with real subscription IDs, secrets, or environment-specific values.**

## Data Platform Components

### Data Lakehouse (Delta Lake)
- ADLS Gen2 storage with hierarchical namespace
- Medallion architecture: Raw (Bronze) -> Curated (Silver) -> Enriched (Gold)
- Delta Lake format for ACID transactions and time travel

### Data Mesh Domains
- Self-serve data infrastructure per domain
- Domain-specific Synapse/Databricks workspaces
- Data products registered in Purview catalog
- Federated governance via Azure Policy

### Data Integration
- Azure Data Factory for batch ETL/ELT pipelines
- Synapse Pipelines for integrated data flows
- Event Hubs for real-time data streaming
- Self-Hosted Integration Runtime for on-premises connectivity

### Data Governance
- Microsoft Purview for data cataloging and classification
- Automated data lineage tracking
- Sensitivity labeling and access policies
- Data quality monitoring

### Observability
- Log Analytics workspace with custom KQL queries
- Diagnostic settings for all deployed resources
- Azure Monitor alerts and dashboards
- Spark/Databricks job monitoring

## Security

- **Zero-trust networking** -- Private endpoints for all data services
- **Managed identities** -- No passwords or keys in code
- **RBAC** -- Role-based access control with least privilege
- **Encryption** -- TLS 1.2 minimum, encryption at rest with platform keys
- **Key Vault** -- Centralized secret management per domain
- **Azure Policy** -- Compliance enforcement and drift detection
- **Defender for Cloud** -- Threat detection and security posture

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines, coding standards, and the pull request process.

## License

This project is licensed under the MIT License -- see the [LICENSE](LICENSE) file for details.

## Related Resources

- [Azure Cloud-Scale Analytics](https://learn.microsoft.com/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/)
- [Azure Landing Zones](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/landing-zone/)
- [Data Mesh Architecture](https://learn.microsoft.com/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-mesh-pattern)
- [Azure Well-Architected Framework](https://learn.microsoft.com/azure/well-architected/)

---

## Related Documentation

- [Getting Started](docs/GETTING_STARTED.md) - Prerequisites and deployment walkthrough
- [Quick Start](docs/QUICKSTART.md) - 60-minute hands-on tutorial
- [Architecture](docs/ARCHITECTURE.md) - Comprehensive architecture reference
- [Contributing](CONTRIBUTING.md) - Development guidelines and PR process
- [Changelog](CHANGELOG.md) - All notable changes to the project
