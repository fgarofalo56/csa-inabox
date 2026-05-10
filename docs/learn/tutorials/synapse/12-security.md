# Tutorial 12: Security Configuration

## Overview

This tutorial covers comprehensive security configuration for Azure Synapse Analytics, including authentication, authorization, network security, data protection, and compliance controls.

## Prerequisites

- Completed [Tutorial 11: Power BI Integration](11-power-bi-integration.md)
- Azure AD administrative access
- Understanding of security concepts

## Learning Objectives

By the end of this tutorial, you will be able to:

- Configure authentication methods
- Implement role-based access control
- Set up network security
- Enable data encryption
- Implement auditing and compliance

---

## Section 1: Authentication

### Azure Active Directory Authentication

```sql
-- Create Azure AD user in Synapse
CREATE USER [user@company.com] FROM EXTERNAL PROVIDER;

-- Create Azure AD group
CREATE USER [SynapseDataEngineers] FROM EXTERNAL PROVIDER;

-- Grant permissions to AD group
GRANT SELECT ON SCHEMA::reporting TO [SynapseDataEngineers];
GRANT EXECUTE ON SCHEMA::etl TO [SynapseDataEngineers];

-- View AD users
SELECT
    name,
    type_desc,
    authentication_type_desc
FROM sys.database_principals
WHERE type IN ('E', 'X');  -- E = External User, X = External Group
```

### Managed Identity Configuration

```sql
-- Grant managed identity access to storage
-- (Done via Azure Portal or CLI)
-- az role assignment create --assignee <managed-identity-id> \
--   --role "Storage Blob Data Reader" \
--   --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>

-- Use managed identity in SQL
CREATE DATABASE SCOPED CREDENTIAL ManagedIdentityCredential
WITH IDENTITY = 'Managed Identity';
GO

CREATE EXTERNAL DATA SOURCE SecureDataLake
WITH (
    LOCATION = 'https://securestorage.dfs.core.windows.net/data',
    CREDENTIAL = ManagedIdentityCredential
);
GO
```

### Service Principal Authentication

```powershell
# Create service principal
az ad sp create-for-rbac --name "synapse-etl-sp" --role contributor \
    --scopes /subscriptions/<subscription-id>/resourceGroups/<resource-group>

# Output contains appId, password, tenant
```

```sql
-- Create credential for service principal
CREATE DATABASE SCOPED CREDENTIAL ServicePrincipalCredential
WITH
    IDENTITY = '<application-id>@https://login.microsoftonline.com/<tenant-id>/oauth2/token',
    SECRET = '<client-secret>';
GO
```

---

## Section 2: Authorization and RBAC

### Synapse RBAC Roles

```
┌─────────────────────────────────────────────────────────────────┐
│                  Synapse RBAC Role Hierarchy                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Synapse Administrator                                           │
│  └── Full control over workspace                                │
│                                                                  │
│  Synapse Contributor                                             │
│  └── Create/manage pools, pipelines, notebooks                  │
│                                                                  │
│  Synapse SQL Administrator                                       │
│  └── Full control over SQL pools                                │
│                                                                  │
│  Synapse Spark Administrator                                     │
│  └── Full control over Spark pools                              │
│                                                                  │
│  Synapse Artifact Publisher                                      │
│  └── Publish artifacts (git integration)                        │
│                                                                  │
│  Synapse Artifact User                                           │
│  └── Read artifacts, run published content                      │
│                                                                  │
│  Synapse Compute Operator                                        │
│  └── Start/stop compute resources                               │
│                                                                  │
│  Synapse Credential User                                         │
│  └── Use credentials in pipelines                               │
│                                                                  │
│  Synapse Linked Data Manager                                     │
│  └── Manage linked services, integration runtimes               │
│                                                                  │
│  Synapse User                                                    │
│  └── View workspace resources (read-only)                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### SQL Pool Permissions

```sql
-- Create custom database role
CREATE ROLE DataAnalyst;

-- Grant schema-level permissions
GRANT SELECT ON SCHEMA::reporting TO DataAnalyst;
GRANT SELECT ON SCHEMA::dim TO DataAnalyst;
GRANT SELECT ON SCHEMA::fact TO DataAnalyst;

-- Grant specific table permissions
GRANT SELECT ON fact.Sales TO DataAnalyst;
GRANT SELECT ON dim.Product TO DataAnalyst;
GRANT SELECT ON dim.Customer TO DataAnalyst;

-- Create role for data engineers
CREATE ROLE DataEngineer;

-- Grant broader permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::staging TO DataEngineer;
GRANT SELECT ON SCHEMA::fact TO DataEngineer;
GRANT EXECUTE ON SCHEMA::etl TO DataEngineer;
GRANT ALTER ON SCHEMA::staging TO DataEngineer;

-- Create admin role
CREATE ROLE DataAdmin;
GRANT CONTROL ON DATABASE::SalesDB TO DataAdmin;

-- Add users to roles
EXEC sp_addrolemember 'DataAnalyst', 'analyst@company.com';
EXEC sp_addrolemember 'DataEngineer', 'engineer@company.com';
EXEC sp_addrolemember 'DataAdmin', 'admin@company.com';

-- View role memberships
SELECT
    dp.name AS role_name,
    dp2.name AS member_name
FROM sys.database_role_members drm
JOIN sys.database_principals dp ON drm.role_principal_id = dp.principal_id
JOIN sys.database_principals dp2 ON drm.member_principal_id = dp2.principal_id
ORDER BY dp.name;
```

### Object-Level Permissions

```sql
-- Grant column-level permissions
GRANT SELECT ON fact.Sales(SaleID, DateKey, TotalAmount) TO DataAnalyst;

-- Deny access to sensitive columns
DENY SELECT ON dim.Customer(CreditCardNumber, SSN) TO DataAnalyst;

-- Grant execute on specific procedures
GRANT EXECUTE ON etl.LoadDailySales TO DataEngineer;
GRANT EXECUTE ON reporting.GetSalesSummary TO DataAnalyst;

-- View effective permissions
SELECT
    permission_name,
    state_desc
FROM sys.fn_my_permissions('fact.Sales', 'OBJECT');
```

---

## Section 3: Row-Level Security

### Implementing RLS

```sql
-- Create schema for security objects
CREATE SCHEMA security;
GO

-- Create user mapping table
CREATE TABLE security.UserDataAccess
(
    UserId INT IDENTITY(1,1),
    UserEmail VARCHAR(200) NOT NULL,
    AccessLevel VARCHAR(50) NOT NULL,  -- 'All', 'Region', 'Country'
    Region VARCHAR(50) NULL,
    Country VARCHAR(100) NULL,
    IsActive BIT DEFAULT 1
)
WITH (DISTRIBUTION = REPLICATE);

-- Populate user access
INSERT INTO security.UserDataAccess (UserEmail, AccessLevel, Region, Country) VALUES
('global.admin@company.com', 'All', NULL, NULL),
('regional.manager.na@company.com', 'Region', 'North America', NULL),
('regional.manager.eu@company.com', 'Region', 'Europe', NULL),
('country.manager.us@company.com', 'Country', 'North America', 'United States'),
('country.manager.uk@company.com', 'Country', 'Europe', 'United Kingdom');

-- Create security predicate function
CREATE FUNCTION security.fn_DataAccessPredicate(@Region VARCHAR(50), @Country VARCHAR(100))
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
    SELECT 1 AS AccessGranted
    WHERE
        -- Global access
        EXISTS (
            SELECT 1 FROM security.UserDataAccess
            WHERE UserEmail = USER_NAME()
              AND AccessLevel = 'All'
              AND IsActive = 1
        )
        OR
        -- Regional access
        EXISTS (
            SELECT 1 FROM security.UserDataAccess
            WHERE UserEmail = USER_NAME()
              AND AccessLevel = 'Region'
              AND Region = @Region
              AND IsActive = 1
        )
        OR
        -- Country access
        EXISTS (
            SELECT 1 FROM security.UserDataAccess
            WHERE UserEmail = USER_NAME()
              AND AccessLevel = 'Country'
              AND Region = @Region
              AND Country = @Country
              AND IsActive = 1
        );
GO

-- Apply security policy to sales view
CREATE SECURITY POLICY security.SalesDataPolicy
ADD FILTER PREDICATE security.fn_DataAccessPredicate(Region, Country)
ON reporting.vw_SalesByRegion,
ADD FILTER PREDICATE security.fn_DataAccessPredicate(Region, Country)
ON fact.Sales
WITH (STATE = ON);
GO

-- Test RLS
EXECUTE AS USER = 'country.manager.us@company.com';
SELECT COUNT(*) AS AccessibleRows FROM fact.Sales;
REVERT;

EXECUTE AS USER = 'global.admin@company.com';
SELECT COUNT(*) AS AccessibleRows FROM fact.Sales;
REVERT;
```

### Dynamic Data Masking

```sql
-- Add dynamic data masking to sensitive columns
ALTER TABLE dim.Customer
ALTER COLUMN Email ADD MASKED WITH (FUNCTION = 'email()');

ALTER TABLE dim.Customer
ALTER COLUMN PhoneNumber ADD MASKED WITH (FUNCTION = 'partial(0,"XXX-XXX-",4)');

ALTER TABLE dim.Customer
ALTER COLUMN CreditCardNumber ADD MASKED WITH (FUNCTION = 'partial(0,"XXXX-XXXX-XXXX-",4)');

ALTER TABLE dim.Customer
ALTER COLUMN SSN ADD MASKED WITH (FUNCTION = 'default()');

-- Grant unmask permission to specific users
GRANT UNMASK ON dim.Customer TO DataAdmin;

-- View masked data (as regular user)
EXECUTE AS USER = 'analyst@company.com';
SELECT CustomerID, CustomerName, Email, PhoneNumber, CreditCardNumber
FROM dim.Customer;
REVERT;

-- View unmasked data (as admin)
EXECUTE AS USER = 'admin@company.com';
SELECT CustomerID, CustomerName, Email, PhoneNumber, CreditCardNumber
FROM dim.Customer;
REVERT;

-- View masking configuration
SELECT
    OBJECT_NAME(object_id) AS table_name,
    name AS column_name,
    masking_function
FROM sys.masked_columns;
```

---

## Section 4: Network Security

### Private Endpoints

```bicep
// Bicep template for private endpoint
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2021-05-01' = {
  name: 'synapse-pe'
  location: resourceGroup().location
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'synapse-plsc'
        properties: {
          privateLinkServiceId: synapseWorkspaceId
          groupIds: [
            'Sql'
            'SqlOnDemand'
            'Dev'
          ]
        }
      }
    ]
  }
}
```

### Firewall Rules

```sql
-- View current firewall rules (via Azure CLI)
-- az synapse workspace firewall-rule list --workspace-name myworkspace --resource-group myrg

-- Create firewall rule
-- az synapse workspace firewall-rule create \
--   --workspace-name myworkspace \
--   --resource-group myrg \
--   --name AllowOffice \
--   --start-ip-address 203.0.113.0 \
--   --end-ip-address 203.0.113.255

-- Allow Azure services
-- az synapse workspace firewall-rule create \
--   --workspace-name myworkspace \
--   --resource-group myrg \
--   --name AllowAllAzureIps \
--   --start-ip-address 0.0.0.0 \
--   --end-ip-address 0.0.0.0
```

### Managed Virtual Network

```json
// ARM template for managed VNet workspace
{
  "type": "Microsoft.Synapse/workspaces",
  "apiVersion": "2021-06-01",
  "name": "[parameters('workspaceName')]",
  "location": "[parameters('location')]",
  "properties": {
    "managedVirtualNetwork": "default",
    "managedVirtualNetworkSettings": {
      "preventDataExfiltration": true,
      "allowedAadTenantIdsForLinking": [
        "[subscription().tenantId]"
      ]
    }
  }
}
```

---

## Section 5: Data Encryption

### Transparent Data Encryption (TDE)

```sql
-- Check TDE status
SELECT
    db.name AS database_name,
    db.is_encrypted,
    de.encryption_state,
    de.encryption_state_desc,
    de.key_algorithm,
    de.key_length
FROM sys.databases db
LEFT JOIN sys.dm_database_encryption_keys de ON db.database_id = de.database_id;

-- TDE is enabled by default for dedicated SQL pools
-- Using service-managed keys (recommended for most cases)

-- For customer-managed keys (CMK):
-- Configure via Azure Key Vault integration
```

### Column-Level Encryption (Always Encrypted)

```sql
-- Create column master key
CREATE COLUMN MASTER KEY CMK_Auto
WITH (
    KEY_STORE_PROVIDER_NAME = 'AZURE_KEY_VAULT',
    KEY_PATH = 'https://mykeyvault.vault.azure.net/keys/AlwaysEncryptedKey/xxx'
);

-- Create column encryption key
CREATE COLUMN ENCRYPTION KEY CEK_Auto
WITH VALUES (
    COLUMN_MASTER_KEY = CMK_Auto,
    ALGORITHM = 'RSA_OAEP',
    ENCRYPTED_VALUE = 0x01700000...  -- Generated value
);

-- Create table with encrypted columns
CREATE TABLE secure.SensitiveData
(
    ID INT PRIMARY KEY,
    SSN CHAR(11) ENCRYPTED WITH (
        COLUMN_ENCRYPTION_KEY = CEK_Auto,
        ENCRYPTION_TYPE = Deterministic,
        ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256'
    ),
    Salary DECIMAL(10,2) ENCRYPTED WITH (
        COLUMN_ENCRYPTION_KEY = CEK_Auto,
        ENCRYPTION_TYPE = Randomized,
        ALGORITHM = 'AEAD_AES_256_CBC_HMAC_SHA_256'
    ),
    Department VARCHAR(50)
);
```

### Data Lake Encryption

```powershell
# Enable storage account encryption with customer-managed keys
az storage account update \
    --name mystorageaccount \
    --resource-group myrg \
    --encryption-key-source Microsoft.Keyvault \
    --encryption-key-vault https://mykeyvault.vault.azure.net \
    --encryption-key-name storage-encryption-key

# Enable infrastructure encryption (double encryption)
az storage account create \
    --name mystorageaccount \
    --resource-group myrg \
    --location eastus \
    --sku Standard_LRS \
    --require-infrastructure-encryption
```

---

## Section 6: Auditing and Monitoring

### SQL Auditing

```sql
-- View audit settings (via Azure Portal or CLI)
-- Auditing is configured at workspace level

-- Query audit logs (stored in Log Analytics or Storage)
-- Sample KQL query for Log Analytics:
/*
SynapseAuditLogs
| where TimeGenerated > ago(24h)
| where Category == "SQLSecurityAuditEvents"
| where ActionName in ("SELECT", "INSERT", "UPDATE", "DELETE")
| project
    TimeGenerated,
    PrincipalName,
    ActionName,
    ObjectName,
    Statement
| order by TimeGenerated desc
*/

-- View failed logins
SELECT
    event_time,
    session_id,
    database_name,
    server_principal_name,
    client_ip,
    succeeded
FROM sys.fn_get_audit_file
    ('https://audit.blob.core.windows.net/audit/*', default, default)
WHERE succeeded = 0
ORDER BY event_time DESC;
```

### Activity Logging

```sql
-- Query Synapse activity via SQL
SELECT
    request_id,
    status,
    [label],
    command,
    resource_class,
    submit_time,
    start_time,
    end_time,
    total_elapsed_time / 1000.0 AS elapsed_seconds
FROM sys.dm_pdw_exec_requests
WHERE submit_time >= DATEADD(hour, -24, GETUTCDATE())
ORDER BY submit_time DESC;

-- Query by specific user
SELECT *
FROM sys.dm_pdw_exec_requests
WHERE [label] LIKE '%user@company.com%'
ORDER BY submit_time DESC;
```

### Security Alerts

```json
// Azure Monitor alert rule for suspicious activity
{
  "type": "Microsoft.Insights/scheduledQueryRules",
  "apiVersion": "2021-08-01",
  "name": "SuspiciousActivityAlert",
  "location": "[resourceGroup().location]",
  "properties": {
    "severity": 2,
    "enabled": true,
    "evaluationFrequency": "PT5M",
    "windowSize": "PT5M",
    "criteria": {
      "allOf": [
        {
          "query": "SynapseAuditLogs | where ActionName == 'DROP TABLE' or ActionName == 'TRUNCATE TABLE' | count",
          "timeAggregation": "Count",
          "operator": "GreaterThan",
          "threshold": 5
        }
      ]
    },
    "actions": {
      "actionGroups": ["[resourceId('Microsoft.Insights/actionGroups', 'SecurityTeam')]"]
    }
  }
}
```

---

## Section 7: Compliance Controls

### Data Classification

```sql
-- Add sensitivity classifications
ADD SENSITIVITY CLASSIFICATION TO dim.Customer.Email
WITH (LABEL = 'Confidential - PII', INFORMATION_TYPE = 'Contact Info');

ADD SENSITIVITY CLASSIFICATION TO dim.Customer.SSN
WITH (LABEL = 'Highly Confidential', INFORMATION_TYPE = 'National ID');

ADD SENSITIVITY CLASSIFICATION TO dim.Customer.CreditCardNumber
WITH (LABEL = 'Confidential - Financial', INFORMATION_TYPE = 'Financial');

ADD SENSITIVITY CLASSIFICATION TO dim.Customer.PhoneNumber
WITH (LABEL = 'Confidential - PII', INFORMATION_TYPE = 'Contact Info');

-- View classifications
SELECT
    OBJECT_NAME(major_id) AS table_name,
    COL_NAME(major_id, minor_id) AS column_name,
    Label AS sensitivity_label,
    information_type
FROM sys.sensitivity_classifications;

-- Generate classification report
EXEC sp_generate_classifications_report;
```

### Compliance Checklists

```markdown
## GDPR Compliance Checklist

- [ ] Personal data identified and classified
- [ ] Row-level security implemented for data access control
- [ ] Data masking applied to PII columns
- [ ] Audit logging enabled and retained
- [ ] Data retention policies configured
- [ ] Right to erasure procedures documented
- [ ] Data export procedures for subject requests
- [ ] Privacy impact assessment completed

## HIPAA Compliance Checklist

- [ ] PHI data identified and classified
- [ ] Encryption at rest enabled (TDE)
- [ ] Encryption in transit enforced (TLS)
- [ ] Access controls implemented (RBAC, RLS)
- [ ] Audit trails enabled and monitored
- [ ] BAA in place with Microsoft
- [ ] Security incident response plan documented
- [ ] Employee training completed

## SOC 2 Compliance Checklist

- [ ] Access provisioning processes documented
- [ ] Change management procedures in place
- [ ] Security monitoring configured
- [ ] Incident response procedures documented
- [ ] Data backup and recovery tested
- [ ] Vendor management processes established
- [ ] Risk assessment completed annually
```

---

## Exercises

### Exercise 1: Implement RBAC
Create a complete role hierarchy for a sales analytics team with different access levels.

### Exercise 2: Configure RLS
Implement row-level security for a multi-tenant application.

### Exercise 3: Security Audit
Perform a security audit using built-in tools and document findings.

---

## Best Practices Summary

| Area | Recommendation |
|------|----------------|
| Authentication | Use Azure AD, avoid SQL auth |
| Authorization | Implement least privilege |
| Network | Use private endpoints, disable public access |
| Encryption | Enable TDE, use CMK for sensitive data |
| Auditing | Enable and monitor all activities |
| Compliance | Classify data, document controls |

---

## Next Steps

- Continue to [Tutorial 13: Monitoring and Diagnostics](13-monitoring.md)
- Explore [Security Best Practices](../../best-practices/security.md)
- Review [Security Troubleshooting](../../troubleshooting/security-troubleshooting.md)
