# Azure Government Service Availability Matrix

This document tracks the availability of every Azure service used by CSA-in-a-Box
across Azure Commercial and Azure Government regions, including FedRAMP
authorization levels and impact level (IL) support.

> **Last verified:** April 2026. Check
> [Azure Government Services by Region](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/by-region/)
> for the latest status.

## Core Services

| Service | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative in This Repo |
|---------|-----------|-----------------|---------|---------|-------------------------|
| **Microsoft Fabric** | GA | Forecasted | Forecasted | Forecasted | **This entire repository** |
| **ADLS Gen2** | GA | GA | GA | GA | Direct use |
| **Azure Databricks** | GA | GA | GA | GA | Direct use (Unity Catalog available) |
| **Azure Synapse Analytics** | GA | GA | GA | GA | Direct use (all pool types) |
| **Azure Data Factory** | GA | GA | GA | GA | Direct use (SHIR supported) |
| **Microsoft Purview** | GA | GA | GA | GA | Direct use |
| **Azure Data Explorer (ADX)** | GA | GA | GA | GA | Direct use |
| **Event Hubs** | GA | GA | GA | GA | Direct use (Kafka API available) |
| **IoT Hub** | GA | GA | GA | GA | Direct use (DPS available) |
| **Stream Analytics** | GA | GA | GA | GA | Direct use |
| **Azure Key Vault** | GA | GA | GA | GA | Direct use |
| **Azure Functions** | GA | GA | GA | GA | Direct use |
| **Logic Apps** | GA | GA | GA | GA | Direct use (Consumption + Standard) |
| **API Management** | GA | GA | GA | GA | Direct use |

## Compute & Hosting

| Service | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative |
|---------|-----------|-----------------|---------|---------|-------------|
| **Azure Kubernetes Service** | GA | GA | GA | GA | Direct use |
| **Container Apps** | GA | GA | GA | GA | Direct use |
| **App Service** | GA | GA | GA | GA | Direct use |
| **Static Web Apps** | GA | GA | GA | GA | Direct use |
| **Azure Batch** | GA | GA | GA | GA | Direct use |

## AI & ML

| Service | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative |
|---------|-----------|-----------------|---------|---------|-------------|
| **Azure OpenAI** | GA | GA | GA | GA | Direct use (GPT-4, Ada embeddings) |
| **Azure Machine Learning** | GA | GA | GA | N/A | MLflow on AKS for IL5 |
| **Cognitive Services** | GA | GA (select) | GA (select) | Limited | Hugging Face on AKS |
| **Azure AI Search** | GA | GA | GA | N/A | OpenSearch on AKS |

## Databases

| Service | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative |
|---------|-----------|-----------------|---------|---------|-------------|
| **Azure SQL Database** | GA | GA | GA | GA | Direct use |
| **Cosmos DB** | GA | GA | GA | GA | Direct use |
| **Azure Database for PostgreSQL** | GA | GA | GA | GA | Direct use |

## Identity & Security

| Service | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative |
|---------|-----------|-----------------|---------|---------|-------------|
| **Microsoft Entra ID** | GA | GA | GA | GA | Direct use |
| **Entra ID B2C** | GA | **N/A** | **N/A** | **N/A** | Entra ID custom policies |
| **Azure AD Conditional Access** | GA | GA | GA | GA | Direct use |
| **Defender for Cloud** | GA | GA | GA | GA | Direct use |

## Monitoring & Management

| Service | Commercial | Gov FedRAMP High | Gov IL4 | Gov IL5 | Alternative |
|---------|-----------|-----------------|---------|---------|-------------|
| **Azure Monitor** | GA | GA | GA | GA | Direct use |
| **Log Analytics** | GA | GA | GA | GA | Direct use |
| **Application Insights** | GA | GA | GA | GA | Direct use |
| **Azure Policy** | GA | GA | GA | GA | Direct use |
| **Power BI** | GA | GA | GA | GA | Direct use (Gov cloud) |

## Endpoint URL Differences

When deploying to Azure Government, all service endpoints use different domains:

| Service | Commercial Endpoint | Government Endpoint |
|---------|-------------------|-------------------|
| Blob Storage | `*.blob.core.windows.net` | `*.blob.core.usgovcloudapi.net` |
| ADLS Gen2 | `*.dfs.core.windows.net` | `*.dfs.core.usgovcloudapi.net` |
| SQL Database | `*.database.windows.net` | `*.database.usgovcloudapi.net` |
| Databricks | `*.azuredatabricks.net` | `*.databricks.azure.us` |
| Key Vault | `*.vault.azure.net` | `*.vault.usgovcloudapi.net` |
| Entra ID (login) | `login.microsoftonline.com` | `login.microsoftonline.us` |
| Azure AD Graph | `graph.microsoft.com` | `graph.microsoft.us` |
| Management API | `management.azure.com` | `management.usgovcloudapi.net` |
| Purview | `*.purview.azure.com` | `*.purview.azure.us` |
| Event Hubs | `*.servicebus.windows.net` | `*.servicebus.usgovcloudapi.net` |
| IoT Hub | `*.azure-devices.net` | `*.azure-devices.us` |
| Azure OpenAI | `*.openai.azure.com` | `*.openai.azure.us` |

## API Version Differences

Most Azure Resource Manager API versions are identical between Commercial and
Government. However, verify these known cases:

| Service | Concern | Guidance |
|---------|---------|---------|
| Azure OpenAI | Model availability may lag | Check `az cognitiveservices model list` in Gov |
| Databricks | Runtime versions may differ | Pin runtime version in templates |
| Purview | Some preview features delayed | Use GA API versions only |
| Event Hubs | Schema Registry availability | Use Avro/JSON without Schema Registry if unavailable |
| Azure ML | Managed endpoints may lag | Test in Gov before production deployment |

## Bicep Configuration for Government

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

## Compliance Requirements by Vertical

| Vertical | FedRAMP Level | Additional Compliance | Data Classification |
|----------|---------------|----------------------|-------------------|
| USDA (NASS) | Moderate | USDA Cybersecurity Framework | Public / SBU |
| DOT (FMCSA/NHTSA) | Moderate+ | DOT Cybersecurity Directives | SBU |
| USPS | High | USPS Mail Security | SBU / PII |
| NOAA | Moderate | NOAA Data Sharing Policies | Public / SBU |
| EPA | High | EPA Data Handling Policies | SBU / CUI |
| Commerce (Census) | High | Title 13, Title 26 | CUI / PII |
| Interior (USGS/BLM) | High | FISMA | SBU / CUI |
| Tribal Health (BIA/IHS) | High | HIPAA, Tribal Data Sovereignty | PHI / CUI |
| Casino Analytics | N/A (Tribal) | NIGC Regulations, Title 31 | PII / Financial |

## Open-Source Alternatives for Government Gaps

For the rare cases where a service is unavailable in Government at a required
impact level, CSA-in-a-Box provides containerized open-source alternatives
deployable on AKS:

| Gap | OSS Alternative | Deployment |
|-----|----------------|-----------|
| Fabric | This entire repo | N/A — you're looking at it |
| Entra ID B2C | Keycloak on AKS | `platform/oss-alternatives/keycloak/` |
| AI Search (IL5) | OpenSearch on AKS | `platform/oss-alternatives/opensearch/` |
| Azure ML (IL5) | MLflow + Kubeflow on AKS | `platform/oss-alternatives/mlflow/` |
| Cognitive Services (select) | Hugging Face Inference on AKS | `platform/oss-alternatives/huggingface/` |

## References

- [Azure Government Documentation](https://learn.microsoft.com/en-us/azure/azure-government/)
- [Azure Government Services by Region](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/by-region/)
- [FedRAMP Authorized Services](https://marketplace.fedramp.gov/)
- [DoD IL Guidance](https://learn.microsoft.com/en-us/azure/compliance/offerings/offering-dod-il4)
