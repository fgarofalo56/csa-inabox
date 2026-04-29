[Home](../README.md) > [Docs](./) > **Gov Service Matrix**

# Azure Government Service Availability Matrix

!!! note
**Quick Summary**: Comprehensive matrix of Azure service availability across Commercial vs Government regions (FedRAMP High, IL4, IL5, IL6), including endpoint URL differences, API version caveats, Bicep configuration for Gov, compliance requirements by vertical, and open-source alternatives for Government gaps.

!!! important
**Impact Level 6 (Classified / SIPR) — CSA-0086.** IL6 workloads run on
**Azure Government Secret** — a separate physically-isolated cloud with
its own Authority to Operate. It is **not** reachable from Azure
Government (IL4/IL5) and **none** of the Bicep, dbt, or portal
deployments in this repo have been authorized for IL6. DoD SIPR/TS
customers should treat this matrix as IL4/IL5-scoped and engage their
sponsor for the Azure Government Secret onboarding process. The
column below therefore reads `N/A — Azure Government Secret
    (separate ATO)` uniformly. Honesty over silence.

This document tracks the availability of every Azure service used by CSA-in-a-Box
across Azure Commercial and Azure Government regions, including FedRAMP
authorization levels and impact level (IL) support.

!!! important
**Last verified:** April 2026. Check
[Azure Government Services by Region](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/by-region/)
for the latest status.

## 📑 Table of Contents

- [☁️ Core Services](#️-core-services)
- [💻 Compute & Hosting](#-compute--hosting)
- [🤖 AI & ML](#-ai--ml)
- [🗄️ Databases](#️-databases)
- [🔒 Identity & Security](#-identity--security)
- [📊 Monitoring & Management](#-monitoring--management)
- [🌐 Endpoint URL Differences](#-endpoint-url-differences)
- [⚙️ API Version Differences](#️-api-version-differences)
- [📦 Bicep Configuration for Government](#-bicep-configuration-for-government)
- [🏛️ Compliance Requirements by Vertical](#️-compliance-requirements-by-vertical)
- [🔓 Open-Source Alternatives for Government Gaps](#-open-source-alternatives-for-government-gaps)
- [📚 References](#-references)

---

## ☁️ Core Services

| Service                       | Commercial | Gov FedRAMP High | Gov IL4    | Gov IL5    | Gov IL6      | Alternative in This Repo             |
| ----------------------------- | ---------- | ---------------- | ---------- | ---------- | ------------ | ------------------------------------ |
| **Microsoft Fabric**          | GA         | Forecasted       | Forecasted | Forecasted | N/A (Secret) | **This entire repository**           |
| **ADLS Gen2**                 | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use                           |
| **Azure Databricks**          | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use (Unity Catalog available) |
| **Azure Synapse Analytics**   | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use (all pool types)          |
| **Azure Data Factory**        | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use (SHIR supported)          |
| **Microsoft Purview**         | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use                           |
| **Azure Data Explorer (ADX)** | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use                           |
| **Event Hubs**                | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use (Kafka API available)     |
| **IoT Hub**                   | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use (DPS available)           |
| **Stream Analytics**          | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use                           |
| **Azure Key Vault**           | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use                           |
| **Azure Functions**           | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use                           |
| **Logic Apps**                | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use (Consumption + Standard)  |
| **API Management**            | GA         | GA               | GA         | GA         | N/A (Secret) | Direct use                           |

> "N/A (Secret)" means the service exists in Azure Government Secret
> but csa-inabox has not been authorized against that cloud. Customers
> requiring IL6 must engage their sponsor for the Azure Government
> Secret onboarding process.

---

## 💻 Compute & Hosting

| Service                      | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative |
| ---------------------------- | ---------- | ---------------- | ------- | ------- | ----------- |
| **Azure Kubernetes Service** | GA         | GA               | GA      | GA      | Direct use  |
| **Container Apps**           | GA         | GA               | GA      | GA      | Direct use  |
| **App Service**              | GA         | GA               | GA      | GA      | Direct use  |
| **Static Web Apps**          | GA         | GA               | GA      | GA      | Direct use  |
| **Azure Batch**              | GA         | GA               | GA      | GA      | Direct use  |

---

## 🤖 AI & ML

| Service                    | Commercial | Gov FedRAMP High | Gov IL4     | Gov IL5 | Alternative                        |
| -------------------------- | ---------- | ---------------- | ----------- | ------- | ---------------------------------- |
| **Azure OpenAI**           | GA         | GA               | GA          | GA      | Direct use (GPT-4, Ada embeddings) |
| **Azure Machine Learning** | GA         | GA               | GA          | N/A     | MLflow on AKS for IL5              |
| **Cognitive Services**     | GA         | GA (select)      | GA (select) | Limited | Hugging Face on AKS                |
| **Azure AI Search**        | GA         | GA               | GA          | N/A     | OpenSearch on AKS                  |

---

## 🗄️ Databases

| Service                           | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative |
| --------------------------------- | ---------- | ---------------- | ------- | ------- | ----------- |
| **Azure SQL Database**            | GA         | GA               | GA      | GA      | Direct use  |
| **Cosmos DB**                     | GA         | GA               | GA      | GA      | Direct use  |
| **Azure Database for PostgreSQL** | GA         | GA               | GA      | GA      | Direct use  |

---

## 🔒 Identity & Security

| Service                                | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative              |
| -------------------------------------- | ---------- | ---------------- | ------- | ------- | ------------------------ |
| **Microsoft Entra ID**                 | GA         | GA               | GA      | GA      | Direct use               |
| **Entra ID B2C**                       | GA         | **N/A**          | **N/A** | **N/A** | Entra ID custom policies |
| **Microsoft Entra Conditional Access** | GA         | GA               | GA      | GA      | Direct use               |
| **Defender for Cloud**                 | GA         | GA               | GA      | GA      | Direct use               |

---

## 📊 Monitoring & Management

| Service                  | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative            |
| ------------------------ | ---------- | ---------------- | ------- | ------- | ---------------------- |
| **Azure Monitor**        | GA         | GA               | GA      | GA      | Direct use             |
| **Log Analytics**        | GA         | GA               | GA      | GA      | Direct use             |
| **Application Insights** | GA         | GA               | GA      | GA      | Direct use             |
| **Azure Policy**         | GA         | GA               | GA      | GA      | Direct use             |
| **Power BI**             | GA         | GA               | GA      | GA      | Direct use (Gov cloud) |

---

## 🌐 Endpoint URL Differences

When deploying to Azure Government, all service endpoints use different domains:

| Service          | Commercial Endpoint         | Government Endpoint              |
| ---------------- | --------------------------- | -------------------------------- |
| Blob Storage     | `*.blob.core.windows.net`   | `*.blob.core.usgovcloudapi.net`  |
| ADLS Gen2        | `*.dfs.core.windows.net`    | `*.dfs.core.usgovcloudapi.net`   |
| SQL Database     | `*.database.windows.net`    | `*.database.usgovcloudapi.net`   |
| Databricks       | `*.azuredatabricks.net`     | `*.databricks.azure.us`          |
| Key Vault        | `*.vault.azure.net`         | `*.vault.usgovcloudapi.net`      |
| Entra ID (login) | `login.microsoftonline.com` | `login.microsoftonline.us`       |
| Microsoft Graph  | `graph.microsoft.com`       | `graph.microsoft.us`             |
| Management API   | `management.azure.com`      | `management.usgovcloudapi.net`   |
| Purview          | `*.purview.azure.com`       | `*.purview.azure.us`             |
| Event Hubs       | `*.servicebus.windows.net`  | `*.servicebus.usgovcloudapi.net` |
| IoT Hub          | `*.azure-devices.net`       | `*.azure-devices.us`             |
| Azure OpenAI     | `*.openai.azure.com`        | `*.openai.azure.us`              |

---

## ⚙️ API Version Differences

Most Azure Resource Manager API versions are identical between Commercial and
Government. However, verify these known cases:

| Service      | Concern                       | Guidance                                             |
| ------------ | ----------------------------- | ---------------------------------------------------- |
| Azure OpenAI | Model availability may lag    | Check `az cognitiveservices model list` in Gov       |
| Databricks   | Runtime versions may differ   | Pin runtime version in templates                     |
| Purview      | Some preview features delayed | Use GA API versions only                             |
| Event Hubs   | Schema Registry availability  | Use Avro/JSON without Schema Registry if unavailable |
| Azure ML     | Managed endpoints may lag     | Test in Gov before production deployment             |

---

## 📦 Bicep Configuration for Government

```bicep
// In your Bicep parameters file for Gov:
param environment string = 'AzureUSGovernment'
param location string = 'usgovvirginia'  // or 'usgovarizona', 'usdodeast', 'usdodcentral'

// Endpoint overrides
param storageEndpointSuffix string = 'core.usgovcloudapi.net'
param sqlEndpointSuffix string = 'database.usgovcloudapi.net'
param kvEndpointSuffix string = 'vault.usgovcloudapi.net'

// Compliance tags applied automatically
param complianceTags object = {
  FedRAMP_Level: 'High'
  FISMA_Impact: 'High'
  Data_Classification: 'CUI'
  Compliance_Framework: 'NIST-800-53-Rev5'
}
```

---

## 🏛️ Compliance Requirements by Vertical

| Vertical                | FedRAMP Level | Additional Compliance          | Data Classification |
| ----------------------- | ------------- | ------------------------------ | ------------------- |
| USDA (NASS)             | Moderate      | USDA Cybersecurity Framework   | Public / SBU        |
| DOT (FMCSA/NHTSA)       | Moderate+     | DOT Cybersecurity Directives   | SBU                 |
| USPS                    | High          | USPS Mail Security             | SBU / PII           |
| NOAA                    | Moderate      | NOAA Data Sharing Policies     | Public / SBU        |
| EPA                     | High          | EPA Data Handling Policies     | SBU / CUI           |
| Commerce (Census)       | High          | Title 13, Title 26             | CUI / PII           |
| Interior (USGS/BLM)     | High          | FISMA                          | SBU / CUI           |
| Tribal Health (BIA/IHS) | High          | HIPAA, Tribal Data Sovereignty | PHI / CUI           |
| Casino Analytics        | N/A (Tribal)  | NIGC Regulations, Title 31     | PII / Financial     |

---

## 🔓 Open-Source Alternatives for Government Gaps

For the rare cases where a service is unavailable in Government at a required
impact level, CSA-in-a-Box provides containerized open-source alternatives
deployable on AKS:

| Gap                         | OSS Alternative               | Deployment                                   |
| --------------------------- | ----------------------------- | -------------------------------------------- |
| Fabric                      | This entire repo              | N/A — you're looking at it                   |
| Entra ID B2C                | Keycloak on AKS               | `csa_platform/oss_alternatives/keycloak/`    |
| AI Search (IL5)             | OpenSearch on AKS             | `csa_platform/oss_alternatives/opensearch/`  |
| Azure ML (IL5)              | MLflow + Kubeflow on AKS      | `csa_platform/oss_alternatives/mlflow/`      |
| Cognitive Services (select) | Hugging Face Inference on AKS | `csa_platform/oss_alternatives/huggingface/` |

---

## 📚 References

- [Azure Government Documentation](https://learn.microsoft.com/en-us/azure/azure-government/)
- [Azure Government Services by Region](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/by-region/)
- [FedRAMP Authorized Services](https://marketplace.fedramp.gov/)
- [DoD IL Guidance](https://learn.microsoft.com/en-us/azure/compliance/offerings/offering-dod-il4)

---

## 🔗 Related Documentation

- [Environment Protection](ENVIRONMENT_PROTECTION.md) — GitHub Environment protection rules
- [Production Checklist](PRODUCTION_CHECKLIST.md) — Production readiness checklist
- [Gov Bicep Templates](../deploy/bicep/gov/README.md) — Azure Government deployment templates
