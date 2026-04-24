# Azure Government Deployment Templates

[deploy](../../README.md) / [bicep](../README.md) / **gov**


> [!TIP]
> **TL;DR** — Parallel deployment templates for Azure Government (MAG). Provides Fabric-equivalent capabilities using FedRAMP High-authorized PaaS services available in Gov today.

This directory contains **parallel deployment templates** for Azure Government (MAG).
Every template in the main `deploy/bicep/` directory has a corresponding
Government-compatible version here.

> [!NOTE]
> A parallel Terraform path is on the roadmap (see CSA-0015 / audit approval
> queue). Today, Bicep is the only implemented IaC path.

## Table of Contents

- [Why Government Templates?](#-why-government-templates)
- [Service Availability Matrix](#-service-availability-matrix)
- [Government-Specific Configuration](#%EF%B8%8F-government-specific-configuration)
- [Usage](#-usage)
- [Open-Source Alternatives](#-open-source-alternatives)
- [Related Documentation](#-related-documentation)

---

## 📋 Why Government Templates?

Microsoft Fabric is **NOT yet available in Azure Government** (status: "Forecasted" as
of April 2026). CSA-in-a-Box provides Fabric-equivalent capabilities using Azure PaaS
services that ARE available in Azure Government today.

---

## ✨ Service Availability Matrix

| Service | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Notes |
|---|---|---|---|---|---|
| **Microsoft Fabric** | GA | Forecasted | Forecasted | Forecasted | **This repo ships Fabric-parity on Azure PaaS while Fabric is pre-GA in Gov** |
| **ADLS Gen2** | GA | GA | GA | GA | Core storage, fully available |
| **Azure Databricks** | GA | GA | GA | GA | Unity Catalog available |
| **Synapse Analytics** | GA | GA | GA | GA | All pool types available |
| **Azure Data Factory** | GA | GA | GA | GA | Includes SHIR support |
| **Microsoft Purview** | GA | GA | GA | GA | Data governance |
| **Azure OpenAI** | GA | GA | GA | GA | GPT-4, embeddings |
| **Event Hubs** | GA | GA | GA | GA | Streaming ingestion |
| **Azure Data Explorer** | GA | GA | GA | GA | Real-time analytics |
| **Azure ML** | GA | GA | GA | N/A | ML lifecycle |
| **Power BI** | GA | GA | GA | GA | Reporting |
| **Key Vault** | GA | GA | GA | GA | Secrets management |
| **Azure Functions** | GA | GA | GA | GA | Serverless compute |
| **Logic Apps** | GA | GA | GA | GA | Workflow orchestration |
| **API Management** | GA | GA | GA | GA | API gateway |
| **Container Apps** | GA | GA | GA | GA | Container orchestration |
| **AKS** | GA | GA | GA | GA | Kubernetes |
| **Microsoft Entra External ID** (formerly Azure AD B2C) | GA | **N/A** | **N/A** | **N/A** | Use Entra ID custom policies |
| **Cosmos DB** | GA | GA | GA | GA | NoSQL database |
| **Azure SQL** | GA | GA | GA | GA | Relational database |
| **App Service** | GA | GA | GA | GA | Web hosting |
| **Static Web Apps** | GA | GA | GA | GA | JAMstack hosting |

---

## ⚙️ Government-Specific Configuration

### 🔌 Endpoint Differences

```text
# Commercial Azure
*.blob.core.windows.net
*.dfs.core.windows.net
*.database.windows.net
*.azuredatabricks.net
login.microsoftonline.com

# Azure Government
*.blob.core.usgovcloudapi.net
*.dfs.core.usgovcloudapi.net
*.database.usgovcloudapi.net
*.databricks.azure.us
login.microsoftonline.us
```

### 🔒 Compliance Tags

All Government templates automatically apply:
- `FedRAMP_Level: High`
- `FISMA_Impact: High`
- `Data_Classification: CUI` (configurable)
- `Compliance_Framework: NIST-800-53-Rev5`

### 🔒 FedRAMP Requirements by Vertical

| Vertical | FedRAMP Level | Additional Compliance |
|---|---|---|
| Tribal Health (BIA/IHS) | High | HIPAA, Tribal Data Sovereignty |
| EPA | High | EPA data handling policies |
| DOT | Moderate+ | DOT cybersecurity directives |
| Interior (USGS/BLM) | High | FISMA |
| Commerce (Census/BEA) | High | Title 13 (Census), Title 26 (Tax) |
| NOAA | Moderate | NOAA data sharing policies |
| USDA | Moderate | USDA cybersecurity framework |
| Casino (Tribal) | N/A (Tribal) | NIGC regulations, Title 31 |

---

## 💡 Usage

```bash
# Deploy DLZ to Azure Government
az cloud set --name AzureUSGovernment
az login

# Use Gov parameter files
bash scripts/deploy/deploy-platform.sh \
  --environment gov-dev \
  --location usgovvirginia
```

---

## 📦 Open-Source Alternatives

For services with limited Gov availability, see
[csa_platform/oss_alternatives/](../../csa_platform/oss_alternatives/) for open-source
replacements deployable on AKS in Azure Government.

---

## 🔗 Related Documentation

- [Government Service Matrix](../../../docs/GOV_SERVICE_MATRIX.md) — Full Gov service availability details
- [IaC & CI/CD Best Practices](../../../docs/IaC-CICD-Best-Practices.md) — Deployment pipeline guidance

> [!NOTE]
> A Terraform alternative deployment path is on the roadmap but not yet
> implemented; link omitted to avoid 404 (CSA-0015).
