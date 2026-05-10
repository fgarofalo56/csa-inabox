---
title: "Security Troubleshooting - CSA in-a-Box"
description: "Comprehensive guide for diagnosing and resolving security-related issues including authentication failures, authorization problems, network security, and data protection across Cloud Scale Analytic..."
tags:
  - troubleshooting
---
# Security Troubleshooting - CSA in-a-Box

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)

Comprehensive guide for diagnosing and resolving security-related issues including authentication failures, authorization problems, network security, and data protection across Cloud Scale Analytics services.

## Table of Contents

- [Overview](#overview)
- [Authentication Issues](#authentication-issues)
- [Authorization Issues](#authorization-issues)
- [Network Security](#network-security)
- [Data Protection](#data-protection)
- [Managed Identity Issues](#managed-identity-issues)
- [Key Vault Access](#key-vault-access)
- [Diagnostic Queries](#diagnostic-queries)
- [Resolution Procedures](#resolution-procedures)
- [Related Resources](#related-resources)

---

## Overview

Security issues can prevent access to resources, block data operations, or expose sensitive information. This guide provides systematic troubleshooting for authentication, authorization, networking, and data protection problems in Azure Cloud Scale Analytics environments.

> **⚠️ Critical:** Security incidents require immediate attention. Follow your organization's security incident response procedures for suspected breaches.

---

## Authentication Issues

### Issue 1: Authentication Failures

**Symptoms:**
- "Authentication failed" errors
- Unable to connect to Synapse workspace
- Token expiration errors
- Service principal authentication failures

**Common Error Messages:**

```text
401 Unauthorized: The request did not have the correct authentication information.
AADSTS70011: The provided value for the input parameter 'scope' is not valid.
AADSTS700016: Application with identifier 'xxx' was not found in the directory 'xxx'.
```

**Common Causes:**

| Cause | Likelihood | Impact | Quick Check |
|:------|:-----------|:-------|:------------|
| Expired credentials | High | High | Check token expiration |
| Wrong tenant ID | Medium | High | Verify tenant configuration |
| Service principal deleted | Low | High | Check AAD registration |
| Incorrect client secret | High | High | Verify secret value |
| Multi-factor authentication required | Medium | Medium | Check conditional access |

**Step-by-Step Resolution:**

#### 1. Verify Service Principal Configuration

```bash
# Check if service principal exists
az ad sp show --id <app-id>

# Verify app registration
az ad app show --id <app-id>

# List service principal credentials
az ad app credential list --id <app-id>
```

#### 2. Test Authentication

```python
from azure.identity import ClientSecretCredential, DefaultAzureCredential
from azure.core.exceptions import ClientAuthenticationError

def test_service_principal_auth(tenant_id, client_id, client_secret):
    """Test service principal authentication."""
    try:
        credential = ClientSecretCredential(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret
        )

        # Test getting token
        token = credential.get_token("https://management.azure.com/.default")
        print(f"✅ Authentication successful. Token expires: {token.expires_on}")
        return True

    except ClientAuthenticationError as e:
        print(f"❌ Authentication failed: {e}")
        print(f"Error details: {e.message}")
        return False

# Test authentication
test_service_principal_auth(
    tenant_id="your-tenant-id",
    client_id="your-client-id",
    client_secret="your-client-secret"
)
```

#### 3. Verify Token Claims

```bash
# Get access token and decode it
az account get-access-token --resource https://management.azure.com

# Or use PowerShell
$token = (Get-AzAccessToken -ResourceUrl "https://management.azure.com").Token

# Decode token at https://jwt.ms to verify:
# - aud (audience)
# - iss (issuer)
# - exp (expiration)
# - roles/scp (permissions)
```

#### 4. Check Conditional Access Policies

```powershell
# List conditional access policies
Connect-AzureAD
Get-AzureADMSConditionalAccessPolicy | Format-Table DisplayName, State

# Check specific policy
Get-AzureADMSConditionalAccessPolicy -PolicyId <policy-id>
```

### Issue 2: Managed Identity Authentication

**Symptoms:**
- "No Managed Identity endpoint found" errors
- Service unable to authenticate automatically
- Missing managed identity assignments

**Error Messages:**

```text
ManagedIdentityCredential authentication unavailable. No Managed Identity endpoint found.
DefaultAzureCredential failed to retrieve a token from the included credentials.
```

**Resolution:**

#### 1. Verify Managed Identity is Enabled

```bash
# Check if system-assigned managed identity is enabled
az vm identity show --name <vm-name> --resource-group <rg-name>

# Enable system-assigned managed identity
az vm identity assign --name <vm-name> --resource-group <rg-name>

# For Azure Synapse workspace
az synapse workspace show --name <workspace-name> --resource-group <rg-name> \
    --query identity

# Enable managed identity for Synapse
az synapse workspace update --name <workspace-name> --resource-group <rg-name> \
    --enable-managed-virtual-network true
```

#### 2. Verify Identity Assignments

```bash
# List role assignments for managed identity
az role assignment list --assignee <managed-identity-principal-id>

# Assign required roles
az role assignment create \
    --assignee <managed-identity-principal-id> \
    --role "Storage Blob Data Contributor" \
    --scope <storage-account-resource-id>
```

#### 3. Test Managed Identity Authentication

```python
from azure.identity import ManagedIdentityCredential
from azure.storage.blob import BlobServiceClient

def test_managed_identity():
    """Test managed identity authentication."""
    try:
        # Get managed identity credential
        credential = ManagedIdentityCredential()

        # Test accessing storage
        account_url = "https://<storage-account>.blob.core.windows.net"
        blob_service_client = BlobServiceClient(
            account_url=account_url,
            credential=credential
        )

        # List containers to verify access
        containers = list(blob_service_client.list_containers())
        print(f"✅ Managed identity working. Found {len(containers)} containers.")
        return True

    except Exception as e:
        print(f"❌ Managed identity test failed: {e}")
        return False

test_managed_identity()
```

---

## Authorization Issues

### Issue 1: Permission Denied Errors

**Symptoms:**
- "403 Forbidden" errors
- "You do not have permission to perform this action"
- Unable to access resources despite successful authentication

**Error Messages:**

```text
403 Forbidden: The client does not have sufficient permission.
AuthorizationFailed: The client 'xxx' with object id 'xxx' does not have authorization to perform action 'Microsoft.Synapse/workspaces/read'.
```

**Common Causes:**

| Cause | Service | Impact | Quick Check |
|:------|:--------|:-------|:------------|
| Missing RBAC role | All | High | Check role assignments |
| Insufficient permissions | All | High | Review role definition |
| Resource-level lock | All | Medium | Check locks |
| Deny assignment | All | High | Check deny assignments |
| Policy restriction | All | Medium | Review Azure Policy |

**Resolution:**

#### 1. Check Current Permissions

```bash
# List current user's role assignments
az role assignment list --assignee <user-or-principal-id> --all

# Check effective permissions on specific resource
az role assignment list --scope <resource-id>

# List deny assignments
az role assignment list --include-inherited --include-deny
```

#### 2. Verify Required Roles

**Common Required Roles by Service:**

| Service | Minimum Role | Common Actions |
|:--------|:-------------|:---------------|
| **Azure Synapse** | Synapse Contributor | Create/manage pipelines, run queries |
| **ADLS Gen2** | Storage Blob Data Contributor | Read/write data |
| **Key Vault** | Key Vault Secrets User | Read secrets |
| **Azure SQL** | SQL DB Contributor | Manage databases |
| **Data Factory** | Data Factory Contributor | Create/run pipelines |

#### 3. Grant Required Permissions

```bash
# Grant Synapse Contributor role
az role assignment create \
    --assignee <user-or-principal-id> \
    --role "Synapse Contributor" \
    --scope <synapse-workspace-id>

# Grant Storage Blob Data Contributor
az role assignment create \
    --assignee <user-or-principal-id> \
    --role "Storage Blob Data Contributor" \
    --scope <storage-account-id>

# Grant Key Vault Secrets User
az role assignment create \
    --assignee <user-or-principal-id> \
    --role "Key Vault Secrets User" \
    --scope <keyvault-id>
```

#### 4. Check for Resource Locks

```bash
# List locks on resource
az lock list --resource-group <rg-name> --resource-name <resource-name> \
    --resource-type <resource-type>

# Remove lock if necessary (requires appropriate permissions)
az lock delete --name <lock-name> --resource-group <rg-name>
```

### Issue 2: Synapse RBAC Permissions

**Symptoms:**
- Can access workspace but cannot run pipelines
- Cannot publish changes to Synapse workspace
- Unable to execute SQL queries

**Resolution:**

#### 1. Check Synapse RBAC Assignments

```powershell
# Using Synapse PowerShell module
Install-Module -Name Az.Synapse

# List RBAC assignments
Get-AzSynapseRoleAssignment -WorkspaceName <workspace-name>

# Check specific user's roles
Get-AzSynapseRoleAssignment -WorkspaceName <workspace-name> -SignInName <user-email>
```

#### 2. Grant Synapse RBAC Roles

```bash
# Grant Synapse Administrator role
az synapse role assignment create \
    --workspace-name <workspace-name> \
    --role "Synapse Administrator" \
    --assignee <user-or-principal-id>

# Grant Synapse Contributor role
az synapse role assignment create \
    --workspace-name <workspace-name> \
    --role "Synapse Contributor" \
    --assignee <user-or-principal-id>

# Grant Synapse SQL Administrator
az synapse role assignment create \
    --workspace-name <workspace-name> \
    --role "Synapse SQL Administrator" \
    --assignee <user-or-principal-id>
```

---

## Network Security

### Issue 1: Firewall Blocking Access

**Symptoms:**
- Connection timeouts
- "Unable to reach the service" errors
- Intermittent connectivity issues

**Error Messages:**

```text
A connection was successfully established with the server, but then an error occurred during the login process.
Cannot open server 'xxx' requested by the login. Client with IP address 'xxx' is not allowed to access the server.
```

**Resolution:**

#### 1. Check Firewall Rules

```bash
# List storage account firewall rules
az storage account show --name <storage-account> --resource-group <rg-name> \
    --query "networkRuleSet"

# List Synapse firewall rules
az synapse workspace firewall-rule list \
    --workspace-name <workspace-name> \
    --resource-group <rg-name>

# List SQL Server firewall rules
az sql server firewall-rule list \
    --server <server-name> \
    --resource-group <rg-name>
```

#### 2. Add Firewall Rules

```bash
# Add IP to storage account firewall
az storage account network-rule add \
    --account-name <storage-account> \
    --resource-group <rg-name> \
    --ip-address <your-ip>

# Add IP to Synapse firewall
az synapse workspace firewall-rule create \
    --name "AllowMyIP" \
    --workspace-name <workspace-name> \
    --resource-group <rg-name> \
    --start-ip-address <your-ip> \
    --end-ip-address <your-ip>

# Add IP to SQL Server firewall
az sql server firewall-rule create \
    --name "AllowMyIP" \
    --server <server-name> \
    --resource-group <rg-name> \
    --start-ip-address <your-ip> \
    --end-ip-address <your-ip>
```

#### 3. Test Connectivity

```powershell
# Test TCP connection to Synapse
Test-NetConnection -ComputerName <workspace-name>.sql.azuresynapse.net -Port 1433

# Test storage account connectivity
Test-NetConnection -ComputerName <storage-account>.blob.core.windows.net -Port 443

# PowerShell connectivity test with detailed output
$result = Test-NetConnection -ComputerName <workspace-name>.sql.azuresynapse.net -Port 1433 -InformationLevel Detailed
$result | Format-List *
```

### Issue 2: Private Endpoint Issues

**Symptoms:**
- Cannot connect via private endpoint
- DNS resolution failures
- Routing issues in virtual network

**Resolution:**

#### 1. Verify Private Endpoint Configuration

```bash
# List private endpoints
az network private-endpoint list --resource-group <rg-name>

# Check private endpoint details
az network private-endpoint show \
    --name <pe-name> \
    --resource-group <rg-name>

# Verify DNS zone configuration
az network private-dns zone list --resource-group <rg-name>
```

#### 2. Test DNS Resolution

```powershell
# Test DNS resolution from VM in VNet
Resolve-DnsName <workspace-name>.sql.azuresynapse.net

# Expected result should show private IP address
# If showing public IP, DNS configuration is incorrect

# Test from specific DNS server
Resolve-DnsName <workspace-name>.sql.azuresynapse.net -Server 168.63.129.16
```

#### 3. Verify Network Security Group (NSG) Rules

```bash
# List NSG rules
az network nsg show --name <nsg-name> --resource-group <rg-name>

# Check effective NSG rules on network interface
az network nic show-effective-nsg --name <nic-name> --resource-group <rg-name>
```

---

## Data Protection

### Issue 1: Encryption Key Access

**Symptoms:**
- "Unable to access encryption key" errors
- Data decryption failures
- Key rotation issues

**Resolution:**

#### 1. Check Customer-Managed Key Configuration

```bash
# Verify storage account encryption
az storage account show --name <storage-account> --resource-group <rg-name> \
    --query "encryption"

# Check key vault key
az keyvault key show --vault-name <keyvault-name> --name <key-name>

# Verify key permissions
az keyvault show --name <keyvault-name> --resource-group <rg-name> \
    --query "properties.accessPolicies"
```

#### 2. Grant Key Vault Permissions

```bash
# Grant managed identity access to key vault
az keyvault set-policy \
    --name <keyvault-name> \
    --object-id <managed-identity-principal-id> \
    --key-permissions get unwrapKey wrapKey
```

### Issue 2: Data Access Auditing

**Symptoms:**
- Need to track who accessed sensitive data
- Compliance requirement for audit logs
- Investigating potential data breach

**Resolution:**

#### 1. Enable Diagnostic Logging

```bash
# Enable storage account logging
az monitor diagnostic-settings create \
    --name "StorageAuditLogs" \
    --resource <storage-account-id> \
    --logs '[{"category":"StorageRead","enabled":true},{"category":"StorageWrite","enabled":true}]' \
    --workspace <log-analytics-workspace-id>

# Enable Synapse audit logging
az synapse workspace update \
    --name <workspace-name> \
    --resource-group <rg-name> \
    --enable-sql-audit true
```

#### 2. Query Audit Logs

```kusto
// Storage access audit
StorageBlobLogs
| where TimeGenerated > ago(24h)
| where OperationName in ("GetBlob", "PutBlob", "DeleteBlob")
| project TimeGenerated, AccountName, CallerIpAddress, AuthenticationType, RequesterObjectId, Uri
| order by TimeGenerated desc

// Synapse SQL audit
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.SYNAPSE"
| where Category == "SQLSecurityAuditEvents"
| where TimeGenerated > ago(24h)
| project TimeGenerated, server_principal_name_s, statement_s, client_ip_s, succeeded_s
| order by TimeGenerated desc
```

---

## Managed Identity Issues

### Issue 1: Managed Identity Not Found

**Symptoms:**
- "Managed identity credential unavailable"
- Identity not assigned to resource
- Missing in Azure AD

**Resolution:**

```bash
# Enable system-assigned managed identity for Synapse
az synapse workspace update \
    --name <workspace-name> \
    --resource-group <rg-name> \
    --enable-managed-identity true

# Create user-assigned managed identity
az identity create \
    --name <identity-name> \
    --resource-group <rg-name>

# Assign user-assigned identity to resource
az vm identity assign \
    --name <vm-name> \
    --resource-group <rg-name> \
    --identities <identity-resource-id>
```

### Issue 2: Managed Identity Role Assignments

**Symptoms:**
- Managed identity cannot access resources
- Permission errors when using managed identity

**Resolution:**

```bash
# Get managed identity principal ID
PRINCIPAL_ID=$(az synapse workspace show \
    --name <workspace-name> \
    --resource-group <rg-name> \
    --query "identity.principalId" -o tsv)

# Assign roles to managed identity
az role assignment create \
    --assignee $PRINCIPAL_ID \
    --role "Storage Blob Data Contributor" \
    --scope <storage-account-id>

# Verify assignments
az role assignment list --assignee $PRINCIPAL_ID
```

---

## Key Vault Access

### Issue 1: Unable to Access Secrets

**Symptoms:**
- "Secret not found" errors
- Access denied to key vault
- Application cannot retrieve secrets

**Resolution:**

#### 1. Verify Secret Exists

```bash
# List secrets
az keyvault secret list --vault-name <keyvault-name>

# Get specific secret
az keyvault secret show --vault-name <keyvault-name> --name <secret-name>
```

#### 2. Check Access Policies

```bash
# Show key vault access policies
az keyvault show --name <keyvault-name> --query "properties.accessPolicies"

# Add access policy for user/service principal
az keyvault set-policy \
    --name <keyvault-name> \
    --object-id <user-or-principal-id> \
    --secret-permissions get list

# Add access policy for managed identity
az keyvault set-policy \
    --name <keyvault-name> \
    --object-id <managed-identity-principal-id> \
    --secret-permissions get
```

#### 3. Test Key Vault Access

```python
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

def test_keyvault_access(vault_url, secret_name):
    """Test access to key vault secret."""
    try:
        credential = DefaultAzureCredential()
        client = SecretClient(vault_url=vault_url, credential=credential)

        # Retrieve secret
        secret = client.get_secret(secret_name)
        print(f"✅ Successfully retrieved secret: {secret_name}")
        print(f"Secret value: {secret.value[:5]}...")  # Show first 5 chars only
        return True

    except Exception as e:
        print(f"❌ Failed to access secret: {e}")
        return False

# Test
test_keyvault_access(
    vault_url="https://<keyvault-name>.vault.azure.net/",
    secret_name="<secret-name>"
)
```

---

## Diagnostic Queries

### Security Audit Queries

```kusto
// Failed authentication attempts
AuditLogs
| where TimeGenerated > ago(24h)
| where ResultDescription contains "authentication" or ResultDescription contains "login"
| where Result == "failure"
| summarize FailureCount = count() by Identity, IPAddress, bin(TimeGenerated, 1h)
| where FailureCount > 5
| order by FailureCount desc

// Suspicious permission changes
AzureActivity
| where TimeGenerated > ago(24h)
| where OperationNameValue contains "roleAssignments"
| where ActivityStatusValue == "Success"
| project TimeGenerated, Caller, OperationNameValue, ResourceGroup, Resource
| order by TimeGenerated desc

// Data access patterns
StorageBlobLogs
| where TimeGenerated > ago(24h)
| summarize
    ReadCount = countif(OperationName == "GetBlob"),
    WriteCount = countif(OperationName == "PutBlob"),
    DeleteCount = countif(OperationName == "DeleteBlob")
    by CallerIpAddress, RequesterObjectId, bin(TimeGenerated, 1h)
| where DeleteCount > 10 or ReadCount > 1000
| order by TimeGenerated desc
```

### Identity and Access Monitoring

```kusto
// Monitor managed identity usage
AzureDiagnostics
| where ResourceType == "MANAGEDIDENTITY"
| where TimeGenerated > ago(24h)
| summarize count() by identity_claim_s, OperationName, ResultType
| order by count_ desc

// Track role assignment changes
AzureActivity
| where TimeGenerated > ago(7d)
| where OperationNameValue in (
    "Microsoft.Authorization/roleAssignments/write",
    "Microsoft.Authorization/roleAssignments/delete"
)
| project TimeGenerated, Caller, OperationNameValue, Properties
| order by TimeGenerated desc
```

---

## Resolution Procedures

### Procedure 1: Emergency Access Lockout Recovery

**When to Use:** User/application completely locked out of resources

**Steps:**

1. **Verify Identity:**
   ```bash
   # Confirm user/principal exists
   az ad user show --id <user-email>
   az ad sp show --id <app-id>
   ```

2. **Emergency Access Grant:**
   ```bash
   # Grant Owner role temporarily
   az role assignment create \
       --assignee <user-or-principal-id> \
       --role "Owner" \
       --scope <resource-group-id>
   ```

3. **Verify Access:**
   ```bash
   # Test access
   az synapse workspace show --name <workspace-name> --resource-group <rg-name>
   ```

4. **Audit and Adjust:**
   ```bash
   # Review what happened
   az monitor activity-log list --resource-group <rg-name> --offset 1h

   # Adjust to least-privilege role
   az role assignment delete --assignee <user-id> --role "Owner"
   az role assignment create --assignee <user-id> --role "Contributor"
   ```

### Procedure 2: Security Incident Investigation

**When to Use:** Suspected unauthorized access or data breach

**Steps:**

1. **Isolate Affected Resources:**
   ```bash
   # Lock resource to prevent changes
   az lock create \
       --name "SecurityIncidentLock" \
       --resource-group <rg-name> \
       --lock-type CanNotDelete

   # Update firewall to block suspicious IPs
   az storage account network-rule remove \
       --account-name <storage-account> \
       --ip-address <suspicious-ip>
   ```

2. **Collect Evidence:**
   ```kusto
   // Comprehensive audit log collection
   union AuditLogs, AzureActivity, StorageBlobLogs, AzureDiagnostics
   | where TimeGenerated between (datetime(<start-time>) .. datetime(<end-time>))
   | where CallerIpAddress == "<suspicious-ip>" or RequesterObjectId == "<suspicious-principal>"
   | project TimeGenerated, OperationName, ResourceId, CallerIpAddress, ResultType, Properties
   | order by TimeGenerated asc
   ```

3. **Revoke Compromised Credentials:**
   ```bash
   # Revoke service principal credentials
   az ad app credential delete --id <app-id> --key-id <key-id>

   # Disable user account
   az ad user update --id <user-id> --account-enabled false
   ```

4. **Document and Report:**
   - Save all audit logs
   - Document timeline of events
   - Report to security team
   - File support ticket if needed

---

## Related Resources

### Internal Documentation

| Resource | Description |
|----------|-------------|
| [Network Security Best Practices](../05-best-practices/cross-cutting-concerns/networking/network-security.md) | Network security configuration |
| [Data Governance](../best-practices-extra/data-governance/README.md) | Data classification and protection |
| [Security Checklist](../reference/security-checklist.md) | Security validation checklist |

### External Resources

| Resource | Link |
|----------|------|
| **Azure Security Best Practices** | [Microsoft Docs](https://docs.microsoft.com/azure/security/fundamentals/best-practices-and-patterns) |
| **Synapse Security** | [Security Baseline](https://docs.microsoft.com/azure/synapse-analytics/security/security-baseline) |
| **Azure RBAC** | [RBAC Documentation](https://docs.microsoft.com/azure/role-based-access-control/) |
| **Key Vault Security** | [Best Practices](https://docs.microsoft.com/azure/key-vault/general/best-practices) |

---

## When to Escalate

Contact Azure Support for:

- [ ] Suspected security breach or data exfiltration
- [ ] Complete lockout from critical resources
- [ ] Managed identity not working despite correct configuration
- [ ] Persistent authentication failures affecting production
- [ ] Key vault inaccessible with valid permissions
- [ ] Network security blocking legitimate traffic

**Critical Information to Provide:**
- Timeline of security events
- Affected user/service principal IDs
- Role assignments before and after issue
- Audit log excerpts
- Network configuration details
- Error messages with correlation IDs

---

> **🔒 Security Reminder:** Always follow the principle of least privilege. Grant only the minimum permissions required and regularly audit access.

**Last Updated:** 2025-12-10
**Version:** 1.0.0
