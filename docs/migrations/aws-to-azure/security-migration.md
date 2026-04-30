# Security Migration: IAM, Lake Formation, and KMS to Azure

**A deep-dive guide for security engineers and ISSOs migrating AWS security, identity, governance, and monitoring services to Azure equivalents.**

---

## Executive summary

AWS security for analytics spans multiple services: IAM for identity and access, Lake Formation for fine-grained data access control, KMS for encryption key management, Secrets Manager for credential storage, CloudTrail for audit logging, GuardDuty for threat detection, and VPC networking for isolation. On Azure, these map to Entra ID, Azure RBAC, Purview/Unity Catalog, Key Vault, Azure Monitor, Microsoft Defender for Cloud, and VNet with Private Endpoints.

The security model difference is architectural. AWS IAM is policy-based with JSON policy documents attached to principals and resources. Azure uses Role-Based Access Control (RBAC) with built-in and custom role definitions assigned at scope levels (management group, subscription, resource group, resource). Both models are capable; the migration requires translating policy intent, not just syntax.

---

## Service mapping overview

| AWS security service     | Azure equivalent                                 | Migration complexity | Notes                                          |
| ------------------------ | ------------------------------------------------ | -------------------- | ---------------------------------------------- |
| IAM users                | Entra ID users                                   | S                    | Federated from existing directory              |
| IAM groups               | Entra ID groups                                  | S                    | Dynamic or assigned membership                 |
| IAM roles                | Managed identities + RBAC role assignments       | M                    | Service-to-service auth via managed identity   |
| IAM policies (JSON)      | Azure RBAC role definitions + assignments        | M                    | Different model; requires intent translation   |
| IAM conditions           | Azure ABAC conditions                            | M                    | ABAC is newer; less mature than IAM conditions |
| STS (assume role)        | Managed identity / workload identity federation  | S                    | No credential management needed                |
| Lake Formation           | Purview + Unity Catalog                          | L                    | Different governance model; see below          |
| KMS (CMK)                | Azure Key Vault (keys)                           | S                    | HSM-backed keys available                      |
| KMS grants               | Key Vault access policies / RBAC                 | S                    | RBAC model preferred                           |
| Secrets Manager          | Azure Key Vault (secrets)                        | XS                   | Direct mapping                                 |
| CloudTrail               | Azure Monitor Activity Log + Diagnostic Settings | S                    | Unified monitoring                             |
| CloudWatch               | Azure Monitor + Log Analytics                    | S                    | Single pane of glass                           |
| CloudWatch Logs          | Log Analytics workspace                          | S                    | KQL query language                             |
| X-Ray                    | Application Insights                             | S                    | OpenTelemetry compatible                       |
| GuardDuty                | Microsoft Defender for Cloud                     | S                    | Broader threat detection                       |
| VPC                      | Azure VNet                                       | M                    | Similar concepts, different implementation     |
| Security groups          | Network Security Groups (NSGs)                   | S                    | Stateful rules; similar model                  |
| NACLs                    | NSGs (subnet-level)                              | S                    | NSGs can be applied at subnet level            |
| AWS Organizations        | Azure Management Groups                          | M                    | Hierarchical policy inheritance                |
| Service Control Policies | Azure Policy                                     | M                    | Deny/audit/deploy-if-not-exists                |
| AWS Config               | Azure Policy + Resource Graph                    | S                    | Compliance evaluation                          |
| AWS WAF                  | Azure WAF (on Front Door / App Gateway)          | S                    | Similar rule sets                              |

---

## Part 1: IAM to Entra ID and Azure RBAC

### Identity model comparison

| AWS IAM concept          | Azure equivalent                           | Notes                                 |
| ------------------------ | ------------------------------------------ | ------------------------------------- |
| IAM User                 | Entra ID User                              | Usually synced from on-prem AD        |
| IAM Group                | Entra ID Security Group                    | Dynamic membership available          |
| IAM Role (service)       | Managed Identity (system or user-assigned) | No credentials to manage              |
| IAM Role (cross-account) | Service Principal + RBAC                   | Cross-subscription access             |
| IAM Role (federated)     | Workload Identity Federation               | For GitHub Actions, GCP, etc.         |
| Root account             | Global Administrator                       | Break-glass access only               |
| IAM Policy (inline)      | RBAC role assignment (direct)              | Assigned at scope                     |
| IAM Policy (managed)     | Built-in or custom RBAC role               | Pre-defined role definitions          |
| IAM Policy (resource)    | Resource-level RBAC                        | Scope to specific resource            |
| STS AssumeRole           | Managed identity token acquisition         | Automatic with DefaultAzureCredential |
| STS session tags         | Entra ID claims + ABAC conditions          | Attribute-based conditions            |

### Common IAM role translations

| AWS IAM role pattern           | Azure RBAC equivalent                        | Scope                          |
| ------------------------------ | -------------------------------------------- | ------------------------------ |
| `AmazonS3ReadOnlyAccess`       | Storage Blob Data Reader                     | Storage account or container   |
| `AmazonS3FullAccess`           | Storage Blob Data Contributor                | Storage account or container   |
| `AmazonRedshiftReadOnlyAccess` | Databricks SQL access (Unity Catalog grants) | Catalog/schema/table           |
| `AmazonEMR_FullAccess`         | Contributor on Databricks workspace          | Resource group                 |
| `AWSGlueServiceRole`           | Contributor on ADF + Purview Reader          | Resource group                 |
| `AmazonAthenaFullAccess`       | Databricks SQL access (Unity Catalog grants) | Catalog/schema/table           |
| `AmazonKinesisFullAccess`      | Azure Event Hubs Data Owner                  | Event Hubs namespace           |
| `AmazonSageMakerFullAccess`    | AzureML Data Scientist                       | ML workspace                   |
| `CloudWatchReadOnlyAccess`     | Monitoring Reader                            | Subscription or resource group |
| `AdministratorAccess`          | Owner (use sparingly)                        | Subscription                   |

### IAM policy to RBAC translation example

**AWS IAM policy (data analyst):**

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:ListBucket"],
            "Resource": [
                "arn:aws:s3:::acme-analytics-curated",
                "arn:aws:s3:::acme-analytics-curated/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": ["athena:StartQueryExecution", "athena:GetQueryResults"],
            "Resource": "*",
            "Condition": {
                "StringEquals": {
                    "athena:workGroup": "analyst-workgroup"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": ["glue:GetTable", "glue:GetDatabase"],
            "Resource": "*"
        }
    ]
}
```

**Azure RBAC equivalent (multiple assignments):**

```bash
# Storage: read access to curated container
az role assignment create \
  --role "Storage Blob Data Reader" \
  --assignee-object-id <analyst-group-id> \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/acmeanalyticsgov/blobServices/default/containers/curated"

# Databricks: SQL access via Unity Catalog grants (not ARM RBAC)
# Run in Databricks SQL:
GRANT USAGE ON CATALOG sales_prod TO `analysts@agency.gov`;
GRANT USAGE ON SCHEMA sales_prod.gold TO `analysts@agency.gov`;
GRANT SELECT ON SCHEMA sales_prod.gold TO `analysts@agency.gov`;

# Purview: read catalog metadata
az role assignment create \
  --role "Purview Data Reader" \
  --assignee-object-id <analyst-group-id> \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Purview/accounts/acme-purview"
```

### Managed Identity pattern (replacing IAM Instance Profiles)

```python
# AWS: IAM Instance Profile (automatic on EC2/EMR/SageMaker)
# boto3 automatically uses the instance profile credentials
s3 = boto3.client('s3')  # Uses instance profile

# Azure: Managed Identity (automatic on Azure resources)
# DefaultAzureCredential automatically uses managed identity
from azure.identity import DefaultAzureCredential
from azure.storage.filedatalake import DataLakeServiceClient

credential = DefaultAzureCredential()  # Uses managed identity on Azure resources
service = DataLakeServiceClient(
    account_url="https://acmeanalyticsgov.dfs.core.usgovcloudapi.net",
    credential=credential
)
```

---

## Part 2: Lake Formation to Purview and Unity Catalog

### Access control model comparison

| Lake Formation concept    | Azure equivalent                               | Notes                         |
| ------------------------- | ---------------------------------------------- | ----------------------------- |
| Database permissions      | Unity Catalog: `GRANT USAGE ON CATALOG/SCHEMA` | Catalog/schema level          |
| Table permissions         | Unity Catalog: `GRANT SELECT/MODIFY ON TABLE`  | Table level                   |
| Column permissions        | Unity Catalog: column masks                    | Column-level security         |
| Row filter expression     | Unity Catalog: row filters                     | Row-level security            |
| Data location permissions | Unity Catalog: external locations              | Storage credential management |
| Tag-based access control  | Unity Catalog grants (roadmap for tags)        | Different model; use grants   |
| Cross-account sharing     | Delta Sharing                                  | Open protocol                 |
| Data catalog (Glue)       | Purview Unified Catalog                        | Business glossary + lineage   |

### Lake Formation grants to Unity Catalog grants

**Lake Formation grant:**

```python
import boto3
lf = boto3.client('lakeformation')

lf.grant_permissions(
    Principal={'DataLakePrincipalIdentifier': 'arn:aws:iam::123456789012:role/analyst-role'},
    Resource={
        'Table': {
            'DatabaseName': 'sales',
            'Name': 'fact_orders',
            'TableWildcard': {}
        }
    },
    Permissions=['SELECT'],
    PermissionsWithGrantOption=[]
)
```

**Unity Catalog equivalent:**

```sql
-- Grant SELECT on a specific table
GRANT SELECT ON TABLE sales_prod.gold.fact_orders TO `analyst-group@agency.gov`;

-- Grant column-level access (column mask)
CREATE FUNCTION sales_prod.gold.mask_pii(val STRING)
  RETURN CASE
    WHEN is_member('pii-authorized') THEN val
    ELSE '***REDACTED***'
  END;

ALTER TABLE sales_prod.gold.fact_orders
  ALTER COLUMN customer_name
  SET MASK sales_prod.gold.mask_pii;

-- Row-level filter
CREATE FUNCTION sales_prod.gold.region_filter()
  RETURN CASE
    WHEN is_member('all-regions') THEN TRUE
    WHEN is_member('east-region') THEN region = 'EAST'
    ELSE FALSE
  END;

ALTER TABLE sales_prod.gold.fact_orders
  SET ROW FILTER sales_prod.gold.region_filter ON ();
```

---

## Part 3: KMS to Azure Key Vault

### Key management comparison

| AWS KMS concept            | Azure Key Vault equivalent            | Notes                            |
| -------------------------- | ------------------------------------- | -------------------------------- |
| Customer managed key (CMK) | Key Vault key (RSA/EC)                | HSM-backed or software-protected |
| AWS managed key            | Microsoft-managed key                 | Default encryption               |
| KMS key policy             | Key Vault access policy or RBAC       | RBAC recommended                 |
| KMS grant                  | Key Vault RBAC role assignment        | Scoped to specific key           |
| KMS alias                  | Key Vault key name + version          | Named reference                  |
| Envelope encryption        | Envelope encryption (same pattern)    | Key wrapping                     |
| Key rotation (automatic)   | Automatic key rotation (configurable) | 30-365 day rotation              |
| Multi-region key           | Key Vault with geo-replication        | Different approach               |
| CloudHSM                   | Azure Dedicated HSM / Managed HSM     | FIPS 140-2 Level 3               |

### Storage encryption mapping

```bash
# AWS: S3 bucket encryption with KMS CMK
# (configured at bucket level)

# Azure: ADLS Gen2 encryption with Key Vault CMK
az storage account update \
  --name acmeanalyticsgov \
  --resource-group analytics-rg \
  --encryption-key-name analytics-cmk \
  --encryption-key-vault "https://acme-keyvault.vault.usgovcloudapi.net" \
  --encryption-key-source Microsoft.Keyvault
```

### Secrets Manager to Key Vault

```python
# AWS Secrets Manager
import boto3
sm = boto3.client('secretsmanager')
secret = sm.get_secret_value(SecretId='prod/database/connection')
connection_string = secret['SecretString']

# Azure Key Vault
from azure.keyvault.secrets import SecretClient
from azure.identity import DefaultAzureCredential

client = SecretClient(
    vault_url="https://acme-keyvault.vault.usgovcloudapi.net",
    credential=DefaultAzureCredential()
)
secret = client.get_secret("database-connection-string")
connection_string = secret.value
```

---

## Part 4: CloudTrail to Azure Monitor

### Audit logging comparison

| CloudTrail feature         | Azure Monitor equivalent                      | Notes                                   |
| -------------------------- | --------------------------------------------- | --------------------------------------- |
| Management events          | Activity Log                                  | ARM operations (create, update, delete) |
| Data events (S3, Lambda)   | Diagnostic Settings (storage, compute)        | Per-resource configuration              |
| Insights events            | Azure Advisor + Defender                      | Anomaly detection                       |
| Trail (log delivery to S3) | Diagnostic Settings → Log Analytics / Storage | Centralized log collection              |
| CloudTrail Lake            | Log Analytics workspace (KQL)                 | Query and analyze logs                  |
| Organization trail         | Azure Policy (diagnostic settings)            | Enforce logging across subscriptions    |

### Setting up comprehensive audit logging

```bash
# Enable diagnostic settings for ADLS Gen2 (equivalent to S3 data events)
az monitor diagnostic-settings create \
  --name "storage-audit" \
  --resource "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/acmeanalyticsgov" \
  --workspace "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/analytics-logs" \
  --logs '[
    {"category": "StorageRead", "enabled": true, "retentionPolicy": {"days": 365, "enabled": true}},
    {"category": "StorageWrite", "enabled": true, "retentionPolicy": {"days": 365, "enabled": true}},
    {"category": "StorageDelete", "enabled": true, "retentionPolicy": {"days": 365, "enabled": true}}
  ]'

# Enable diagnostic settings for Databricks
az monitor diagnostic-settings create \
  --name "databricks-audit" \
  --resource "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Databricks/workspaces/acme-databricks" \
  --workspace "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/analytics-logs" \
  --logs '[
    {"category": "dbfs", "enabled": true},
    {"category": "clusters", "enabled": true},
    {"category": "accounts", "enabled": true},
    {"category": "jobs", "enabled": true},
    {"category": "notebook", "enabled": true},
    {"category": "sqlPermissions", "enabled": true},
    {"category": "unityCatalog", "enabled": true}
  ]'
```

### KQL queries for security monitoring (replacing CloudTrail Insights)

```kusto
// Failed access attempts (equivalent to CloudTrail unauthorized access)
AzureActivity
| where OperationNameValue has "Microsoft.Storage"
| where ActivityStatusValue == "Failed"
| where Authorization_d.evidence.role has "Blob"
| summarize FailedAttempts = count() by CallerIpAddress, Caller, bin(TimeGenerated, 1h)
| where FailedAttempts > 10
| order by FailedAttempts desc

// Unity Catalog access audit (equivalent to Glue/Lake Formation data events)
DatabricksUnityCatalog
| where ActionName in ("getTable", "selectFromTable", "createTable", "alterTable")
| summarize AccessCount = count() by Identity, ActionName, RequestParams_s, bin(TimeGenerated, 1h)
| order by TimeGenerated desc

// Data exfiltration detection (large data reads)
StorageBlobLogs
| where OperationName == "GetBlob"
| where ResponseBodySize > 1073741824  // > 1GB
| summarize TotalBytes = sum(ResponseBodySize), RequestCount = count()
    by CallerIpAddress, AccountName, bin(TimeGenerated, 1h)
| where TotalBytes > 10737418240  // > 10GB in 1 hour
| order by TotalBytes desc
```

---

## Part 5: GuardDuty to Microsoft Defender for Cloud

### Threat detection comparison

| GuardDuty finding type      | Defender equivalent            | Notes                     |
| --------------------------- | ------------------------------ | ------------------------- |
| UnauthorizedAccess (S3)     | Defender for Storage alerts    | Anomalous access patterns |
| CryptoCurrency mining (EC2) | Defender for Servers           | Compute threat detection  |
| Recon (port scanning)       | Defender for Network           | Network anomalies         |
| Trojan/Backdoor             | Defender for Endpoint          | Endpoint protection       |
| IAM anomalies               | Entra ID Protection + Defender | Identity threat detection |
| DNS exfiltration            | Defender for DNS               | DNS analytics             |

### Defender for Cloud configuration

```bash
# Enable Defender for Storage
az security pricing create \
  --name StorageAccounts \
  --tier Standard

# Enable Defender for Key Vault
az security pricing create \
  --name KeyVaults \
  --tier Standard

# Enable Defender for Databases
az security pricing create \
  --name SqlServers \
  --tier Standard
```

---

## Part 6: VPC to Azure VNet and Private Endpoints

### Network security comparison

| AWS VPC concept           | Azure VNet equivalent                  | Notes                                      |
| ------------------------- | -------------------------------------- | ------------------------------------------ |
| VPC                       | Virtual Network (VNet)                 | Address space, subnets                     |
| Subnet (public/private)   | Subnet (no public/private distinction) | Use NSG + route table for isolation        |
| Security Group (stateful) | Network Security Group (NSG)           | Stateful; similar rule model               |
| NACL (stateless)          | NSG at subnet level                    | NSGs are stateful; no stateless equivalent |
| Internet Gateway          | Default internet routing / NAT Gateway | Implicit in Azure                          |
| NAT Gateway               | Azure NAT Gateway                      | Similar functionality                      |
| VPC Endpoint (Gateway)    | Service Endpoint                       | Route to service via backbone              |
| VPC Endpoint (Interface)  | Private Endpoint                       | Private IP for PaaS service                |
| Transit Gateway           | Azure Virtual WAN / VNet Peering       | Hub-and-spoke networking                   |
| VPC Peering               | VNet Peering                           | Direct peering; transitive via hub         |
| VPN Gateway               | Azure VPN Gateway                      | Site-to-site and point-to-site             |
| Direct Connect            | ExpressRoute                           | Dedicated private connectivity             |
| AWS PrivateLink           | Azure Private Link                     | PaaS service private connectivity          |

### Private Endpoint configuration for analytics services

```bash
# Private endpoint for ADLS Gen2
az network private-endpoint create \
  --name pe-adls-analytics \
  --resource-group analytics-rg \
  --vnet-name analytics-vnet \
  --subnet data-subnet \
  --private-connection-resource-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/acmeanalyticsgov" \
  --group-id dfs \
  --connection-name adls-pe-connection

# Private endpoint for Key Vault
az network private-endpoint create \
  --name pe-keyvault \
  --resource-group analytics-rg \
  --vnet-name analytics-vnet \
  --subnet data-subnet \
  --private-connection-resource-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/acme-keyvault" \
  --group-id vault \
  --connection-name keyvault-pe-connection

# Private endpoint for Event Hubs
az network private-endpoint create \
  --name pe-eventhubs \
  --resource-group analytics-rg \
  --vnet-name analytics-vnet \
  --subnet data-subnet \
  --private-connection-resource-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.EventHub/namespaces/acme-streaming" \
  --group-id namespace \
  --connection-name eh-pe-connection
```

---

## Part 7: AWS Organizations to Azure Management Groups

| AWS Organizations concept    | Azure equivalent               | Notes                       |
| ---------------------------- | ------------------------------ | --------------------------- |
| Organization                 | Tenant (Entra ID)              | Root of hierarchy           |
| Root                         | Root Management Group          | Top-level scope             |
| Organizational Unit (OU)     | Management Group               | Hierarchical grouping       |
| Account                      | Subscription                   | Billing and access boundary |
| Service Control Policy (SCP) | Azure Policy (deny effect)     | Guardrails                  |
| Tag policy                   | Azure Policy (tag enforcement) | Require tags on resources   |
| Backup policy                | Azure Backup policies          | Resource protection         |

### CSA-in-a-Box 4-subscription pattern

```
Root Management Group
  └── Analytics Management Group
        ├── Connectivity Subscription (networking, DNS, firewall)
        ├── Management Subscription (monitoring, security, backup)
        ├── Identity Subscription (Entra ID, Key Vault)
        └── Data Landing Zone Subscription (ADLS, Databricks, ADF, Purview)
```

---

## Migration sequence

| Phase                 | Duration  | Activities                                                         |
| --------------------- | --------- | ------------------------------------------------------------------ |
| 1. Identity mapping   | 2-3 weeks | Map IAM users/groups/roles to Entra ID; configure federation       |
| 2. RBAC deployment    | 2-3 weeks | Translate IAM policies to Azure RBAC; deploy role assignments      |
| 3. Key Vault setup    | 1-2 weeks | Create Key Vault; migrate KMS keys; configure CMK encryption       |
| 4. Network deployment | 2-3 weeks | Deploy VNet, subnets, NSGs, Private Endpoints                      |
| 5. Monitoring setup   | 1-2 weeks | Configure diagnostic settings, Log Analytics, Defender             |
| 6. Data governance    | 3-4 weeks | Configure Purview scans, Unity Catalog grants, row/column security |
| 7. Validation         | 2-3 weeks | Audit access patterns; verify least-privilege; penetration test    |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Federal Migration Guide](federal-migration-guide.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../aws-to-azure.md)
