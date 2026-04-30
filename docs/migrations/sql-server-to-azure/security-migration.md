# Security Migration -- SQL Server to Azure SQL

**Audience:** DBAs, security architects, compliance officers
**Scope:** Authentication, encryption, access control, auditing, and threat protection migration

---

## Overview

Migrating SQL Server security to Azure SQL involves transitioning authentication from Windows/SQL logins to Microsoft Entra ID, migrating encryption keys to Azure Key Vault, configuring Azure-native auditing and threat detection, and mapping on-premises access control patterns to Azure RBAC and SQL permissions. This guide covers each security domain with migration steps and validation.

---

## Authentication migration

### SQL authentication to Entra ID

The recommended authentication model for Azure SQL is Microsoft Entra ID (formerly Azure Active Directory). Entra ID provides centralized identity management, multi-factor authentication, conditional access, and passwordless options.

#### Step 1: Configure Entra ID admin

```bash
# Set Entra ID admin for Azure SQL Database
az sql server ad-admin create \
  --resource-group myRG \
  --server myserver \
  --display-name "SQL Admins" \
  --object-id "<entra-group-object-id>"

# Set Entra ID admin for SQL Managed Instance
az sql mi ad-admin create \
  --resource-group myRG \
  --managed-instance myMI \
  --display-name "SQL Admins" \
  --object-id "<entra-group-object-id>"
```

#### Step 2: Create Entra ID users

```sql
-- Create Entra ID user (individual)
CREATE USER [user@contoso.com] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [user@contoso.com];

-- Create Entra ID group
CREATE USER [SQL-Readers] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [SQL-Readers];

-- Create managed identity user (for applications)
CREATE USER [my-app-identity] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datawriter ADD MEMBER [my-app-identity];
```

#### Step 3: Update application authentication

```csharp
// Before: SQL authentication
"Server=myserver.database.windows.net;Database=myDB;User ID=appuser;Password=secret;"

// After: Managed identity (recommended for Azure-hosted apps)
"Server=myserver.database.windows.net;Database=myDB;Authentication=Active Directory Managed Identity;"

// After: Entra ID interactive (for developer tools)
"Server=myserver.database.windows.net;Database=myDB;Authentication=Active Directory Interactive;"

// After: Entra ID service principal (for CI/CD)
"Server=myserver.database.windows.net;Database=myDB;Authentication=Active Directory Service Principal;User ID=<app-id>;Password=<client-secret>;"
```

!!! tip "Eliminate SQL authentication"
After migration, disable SQL authentication entirely by enabling Entra-only authentication on the server. This eliminates password-based attacks and simplifies identity management.

```bash
# Enable Entra-only authentication
az sql server ad-only-auth enable \
  --resource-group myRG \
  --name myserver
```

### Windows authentication migration

| On-premises pattern | Azure SQL Database  | Azure SQL Managed Instance          |
| ------------------- | ------------------- | ----------------------------------- |
| Windows login (AD)  | Entra ID user/group | Entra ID or Windows auth (Kerberos) |
| Windows group       | Entra ID group      | Entra ID group                      |
| Service account     | Managed identity    | Managed identity                    |
| gMSA                | Managed identity    | Managed identity or Kerberos        |

---

## Encryption migration

### TDE (Transparent Data Encryption)

TDE is enabled by default on Azure SQL Database and Managed Instance with a service-managed key. For customer-managed key (CMK) scenarios:

```bash
# Step 1: Create Azure Key Vault
az keyvault create \
  --name migration-kv \
  --resource-group myRG \
  --location eastus2 \
  --enable-purge-protection \
  --enable-soft-delete

# Step 2: Create or import TDE protector key
az keyvault key create \
  --vault-name migration-kv \
  --name tde-protector \
  --kty RSA \
  --size 2048

# Step 3: Assign Key Vault permissions to SQL Server identity
az keyvault set-policy \
  --name migration-kv \
  --object-id "<sql-server-identity>" \
  --key-permissions get wrapKey unwrapKey

# Step 4: Set TDE protector
az sql server tde-key set \
  --resource-group myRG \
  --server myserver \
  --server-key-type AzureKeyVault \
  --kid "https://migration-kv.vault.azure.net/keys/tde-protector/<version>"
```

!!! warning "TDE certificate migration for SQL on VM"
When migrating TDE-protected databases to SQL Server on Azure VM, you must export the TDE certificate from the source and import it on the target VM before restoring the database.

```sql
-- Export TDE certificate (on source)
BACKUP CERTIFICATE TDE_Cert
TO FILE = 'C:\Certs\TDE_Cert.cer'
WITH PRIVATE KEY (
    FILE = 'C:\Certs\TDE_Cert.pvk',
    ENCRYPTION BY PASSWORD = 'StrongP@ssw0rd!'
);

-- Import TDE certificate (on target VM)
CREATE CERTIFICATE TDE_Cert
FROM FILE = 'F:\Certs\TDE_Cert.cer'
WITH PRIVATE KEY (
    FILE = 'F:\Certs\TDE_Cert.pvk',
    DECRYPTION BY PASSWORD = 'StrongP@ssw0rd!'
);
```

### Always Encrypted migration

Always Encrypted column master keys should migrate from on-premises certificate stores to Azure Key Vault:

```sql
-- Step 1: Create a new column master key in Azure Key Vault
CREATE COLUMN MASTER KEY [CMK_AzureKeyVault]
WITH (
    KEY_STORE_PROVIDER_NAME = 'AZURE_KEY_VAULT',
    KEY_PATH = 'https://migration-kv.vault.azure.net/keys/ae-cmk/<version>'
);

-- Step 2: Rotate column encryption keys to use the new CMK
-- Use SSMS Always Encrypted wizard or PowerShell
-- This re-encrypts the column encryption keys with the new CMK
```

```powershell
# PowerShell: Rotate column master key
$oldCmk = Get-SqlColumnMasterKey -Name "CMK_OnPrem" -InputObject $database
$newCmk = Get-SqlColumnMasterKey -Name "CMK_AzureKeyVault" -InputObject $database
Invoke-SqlColumnMasterKeyRotation -SourceColumnMasterKeyName $oldCmk.Name `
  -TargetColumnMasterKeyName $newCmk.Name `
  -InputObject $database
```

---

## Access control migration

### SQL permissions mapping

Map existing SQL permissions to Azure SQL:

```sql
-- Export current permissions from source
SELECT
    dp.name AS principal_name,
    dp.type_desc AS principal_type,
    o.name AS object_name,
    p.permission_name,
    p.state_desc
FROM sys.database_permissions p
JOIN sys.database_principals dp ON p.grantee_principal_id = dp.principal_id
LEFT JOIN sys.objects o ON p.major_id = o.object_id
WHERE dp.name NOT IN ('dbo', 'guest', 'sys', 'INFORMATION_SCHEMA')
ORDER BY dp.name, o.name;

-- Export role memberships
SELECT
    r.name AS role_name,
    m.name AS member_name
FROM sys.database_role_members rm
JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id
JOIN sys.database_principals m ON rm.member_principal_id = m.principal_id
ORDER BY r.name, m.name;
```

### Row-Level Security (RLS)

RLS policies migrate directly to Azure SQL Database and MI:

```sql
-- RLS security predicate (works identically on Azure SQL)
CREATE FUNCTION dbo.fn_SecurityPredicate(@TenantId INT)
RETURNS TABLE
WITH SCHEMABINDING
AS
    RETURN SELECT 1 AS result
    WHERE @TenantId = CAST(SESSION_CONTEXT(N'TenantId') AS INT);

CREATE SECURITY POLICY TenantFilter
ADD FILTER PREDICATE dbo.fn_SecurityPredicate(TenantId)
ON dbo.SalesOrders;
```

### Dynamic Data Masking

Dynamic Data Masking migrates directly:

```sql
-- Verify masking rules after migration
SELECT
    t.name AS table_name,
    c.name AS column_name,
    mc.masking_function
FROM sys.masked_columns mc
JOIN sys.columns c ON mc.object_id = c.object_id AND mc.column_id = c.column_id
JOIN sys.tables t ON c.object_id = t.object_id;
```

---

## Auditing migration

### On-premises SQL Audit to Azure

| On-premises audit target | Azure equivalent                              |
| ------------------------ | --------------------------------------------- |
| File system audit        | Azure Blob Storage                            |
| Windows Event Log        | Azure Monitor Log Analytics                   |
| SQL Server Audit         | Azure SQL Auditing (to Blob or Log Analytics) |
| C2 audit mode            | Not available (use Azure SQL Auditing)        |

```bash
# Enable Azure SQL auditing
az sql server audit-policy update \
  --resource-group myRG \
  --name myserver \
  --state Enabled \
  --blobStorageTargetState Enabled \
  --storageAccountAccessKey "$STORAGE_KEY" \
  --storage-account mystorageaccount

# Enable Log Analytics auditing (recommended)
az sql server audit-policy update \
  --resource-group myRG \
  --name myserver \
  --state Enabled \
  --log-analytics-target-state Enabled \
  --log-analytics-workspace-resource-id "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{workspace}"
```

### Query auditing data

```sql
-- Query audit logs in Log Analytics (KQL)
-- AzureDiagnostics
-- | where Category == "SQLSecurityAuditEvents"
-- | where action_name_s == "SELECT"
-- | project TimeGenerated, server_principal_name_s, database_name_s, statement_s
-- | order by TimeGenerated desc
```

---

## Microsoft Defender for SQL

Defender for SQL provides advanced threat detection that does not exist on-premises:

```bash
# Enable Defender for SQL
az sql server advanced-threat-protection-setting update \
  --resource-group myRG \
  --name myserver \
  --state Enabled

# Enable vulnerability assessment
az sql server va-setting update \
  --resource-group myRG \
  --name myserver \
  --storage-account mystorageaccount \
  --storage-container-path "https://mystorageaccount.blob.core.windows.net/vulnerability-assessment"
```

Defender for SQL detects:

- SQL injection attacks and attempts
- Anomalous database access patterns
- Brute-force login attempts
- Suspicious data exfiltration
- Unusual administrative operations

---

## CSA-in-a-Box security integration

After migrating security to Azure SQL, integrate with the CSA-in-a-Box governance layer:

1. **Purview classifications:** Azure SQL data scanned by Purview receives automatic PII, PHI, and financial data classifications using the classification taxonomies in `csa_platform/governance/purview/classifications/`
2. **Audit integration:** Azure SQL audit logs feed into Azure Monitor alongside CSA-in-a-Box platform logs for unified security monitoring
3. **Defender alerts:** Defender for SQL alerts integrate with the CSA-in-a-Box alerting pipeline
4. **Entra ID:** All Azure SQL access uses the same Entra ID identities as the rest of the CSA-in-a-Box platform

---

## Related

- [Feature Mapping](feature-mapping-complete.md)
- [HA/DR Migration](ha-dr-migration.md)
- [Federal Migration Guide](federal-migration-guide.md)
- [Best Practices](best-practices.md)

---

## References

- [Entra ID authentication for Azure SQL](https://learn.microsoft.com/azure/azure-sql/database/authentication-aad-overview)
- [TDE with customer-managed keys](https://learn.microsoft.com/azure/azure-sql/database/transparent-data-encryption-byok-overview)
- [Always Encrypted with Azure Key Vault](https://learn.microsoft.com/azure/azure-sql/database/always-encrypted-azure-key-vault-configure)
- [Azure SQL auditing](https://learn.microsoft.com/azure/azure-sql/database/auditing-overview)
- [Microsoft Defender for SQL](https://learn.microsoft.com/azure/defender-for-cloud/defender-for-sql-introduction)
- [Row-Level Security](https://learn.microsoft.com/sql/relational-databases/security/row-level-security)
