# Snowflake Security Migration Guide

**Status:** Authored 2026-04-30
**Audience:** Security architects, CISOs, IAM engineers, data governance leads
**Scope:** Network policies to Private Endpoints, Dynamic Masking to Purview masking, RBAC to Entra + Unity Catalog, hierarchy mapping

---

## 1. Security architecture comparison

### Snowflake security model

Snowflake provides a vertically integrated security model:

| Layer | Snowflake mechanism |
|---|---|
| Network | Network policies (IP allowlists/blocklists) |
| Authentication | Username/password, key pair, SSO (SAML/OAuth), MFA |
| Authorization | RBAC (roles + grants on database objects) |
| Data protection | Dynamic data masking, row access policies |
| Encryption | Always-on encryption (AES-256); customer-managed keys (Tri-Secret Secure) |
| Audit | Access history, query history, login history |
| Classification | Object tagging (manual) |

### Azure security model

Azure provides a defense-in-depth model across multiple services:

| Layer | Azure mechanism | Advantage |
|---|---|---|
| Network | Private Endpoints + NSGs + Azure Firewall + DDoS Protection | Stronger isolation; no public IP required |
| Authentication | Entra ID (SSO, MFA, conditional access, managed identities) | Enterprise identity platform; passwordless options |
| Authorization | Entra RBAC + Unity Catalog grants + Purview access policies | Cross-platform; inherited by all Azure services |
| Data protection | Unity Catalog MASK functions + row filters + Purview sensitivity labels | Classification-driven masking; auto-discovery |
| Encryption | ADLS Gen2 encryption at rest (AES-256) + customer-managed keys (Key Vault) | Key Vault integration; HSM-backed keys |
| Audit | Azure Monitor + Purview audit + tamper-evident audit chain (CSA-0016) | Tamper-evident chain exceeds Snowflake audit |
| Classification | Purview auto-classification (200+ built-in classifiers) | Automated scanning; no manual tagging |

---

## 2. Network security migration

### Snowflake network policies

```sql
-- Snowflake: Create network policy
CREATE NETWORK POLICY agency_network_policy
    ALLOWED_IP_LIST = ('10.0.0.0/8', '172.16.0.0/12', '192.168.1.0/24')
    BLOCKED_IP_LIST = ('192.168.1.100');

-- Apply to account
ALTER ACCOUNT SET NETWORK_POLICY = agency_network_policy;

-- Apply to specific user
ALTER USER svc_account SET NETWORK_POLICY = agency_network_policy;
```

### Azure Private Endpoints (replacement)

Private Endpoints are stronger than IP allowlists because they remove public network exposure entirely:

```bicep
// Bicep: Private Endpoint for Databricks
resource databricksPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: 'pe-databricks-${environment}'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'databricks-connection'
        properties: {
          privateLinkServiceId: databricksWorkspace.id
          groupIds: ['databricks_ui_api']
        }
      }
    ]
  }
}

// Private DNS zone for name resolution
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.azuredatabricks.net'
  location: 'global'
}
```

**Network security comparison:**

| Snowflake feature | Azure equivalent | Security improvement |
|---|---|---|
| IP allowlist | NSG rules + Private Endpoints | No public IP exposure |
| IP blocklist | NSG deny rules | Applied at network layer, not application |
| Account-level policy | Subscription-level NSGs + Azure Firewall | Centralized enforcement |
| User-level policy | Conditional Access policies (Entra ID) | Identity-aware, not IP-only |
| PrivateLink (Snowflake) | Private Endpoints (Azure) | Equivalent; both use private connectivity |

### Migration steps

1. Document all Snowflake network policies (IP ranges, user assignments)
2. Create Azure NSGs with equivalent allow/deny rules
3. Deploy Private Endpoints for Databricks, ADLS Gen2, Key Vault, and other services
4. Configure Private DNS zones for name resolution
5. Set up Azure Firewall for centralized egress control (if required)
6. Configure Entra ID Conditional Access for identity-aware network policies
7. Test connectivity from all client networks
8. Disable public access on Databricks workspace

---

## 3. Authentication migration

### Snowflake authentication methods

| Method | Snowflake implementation |
|---|---|
| Username/password | Native Snowflake credentials |
| Key pair | RSA key pair authentication |
| SSO | SAML 2.0 or OAuth via external IdP |
| MFA | Duo Security integration |
| Service accounts | Dedicated Snowflake users with key pair |

### Entra ID authentication (replacement)

| Snowflake method | Entra ID equivalent | Migration action |
|---|---|---|
| Username/password | Entra ID credentials (discouraged; use SSO) | Create Entra accounts; enable SSO |
| Key pair | Service principal with certificate | Create service principal; upload certificate |
| SSO (SAML) | Entra ID native SSO | Configure Entra as IdP for Databricks |
| MFA | Entra MFA (Authenticator, FIDO2, phone) | Enable MFA policy in Entra; configure CA policies |
| Service accounts | Managed identities (preferred) or service principals | Use managed identities to eliminate credential management |

### Managed identities advantage

Snowflake requires managing service account credentials (passwords or key pairs). Azure managed identities eliminate this:

```python
# Snowflake: Service account with key pair (before)
connection_params = {
    "account": "ACMEGOV.us-gov-west-1.snowflake-gov",
    "user": "SVC_DATA_PIPELINE",
    "private_key_path": "/secrets/snowflake_rsa_key.p8",
    "private_key_passphrase": os.environ["SNOWFLAKE_KEY_PASSPHRASE"]
}

# Azure: Managed identity (after) -- no credentials to manage
from azure.identity import DefaultAzureCredential
credential = DefaultAzureCredential()

# Databricks uses workspace-managed identity
# No keys, no passwords, no rotation -- Azure handles it
```

---

## 4. RBAC migration

### Snowflake role hierarchy

```
ACCOUNTADMIN
├── SYSADMIN
│   ├── FINANCE_ADMIN
│   │   ├── FINANCE_ENGINEER
│   │   └── FINANCE_ANALYST
│   └── HR_ADMIN
│       ├── HR_ENGINEER
│       └── HR_ANALYST
├── SECURITYADMIN
│   └── USERADMIN
└── PUBLIC
```

### Azure role mapping

| Snowflake role | Azure equivalent | Scope |
|---|---|---|
| `ACCOUNTADMIN` | Global Admin (Entra) + Workspace Admin (Databricks) | Tenant / Workspace |
| `SYSADMIN` | Contributor (Azure RBAC) + Metastore Admin (Unity Catalog) | Subscription / Metastore |
| `SECURITYADMIN` | Security Admin (Entra) + Purview Data Governance Admin | Tenant / Purview |
| `USERADMIN` | User Admin (Entra) | Tenant |
| `PUBLIC` | Default role (Unity Catalog) | Catalog |
| Domain admin (e.g., `FINANCE_ADMIN`) | Entra group `grp-finance-admin` + UC catalog owner | Catalog |
| Domain engineer (e.g., `FINANCE_ENGINEER`) | Entra group `grp-finance-engineer` + UC schema grants | Schema |
| Domain analyst (e.g., `FINANCE_ANALYST`) | Entra group `grp-finance-analyst` + UC SELECT grants | Schema / Table |

### Grant translation

```sql
-- Snowflake grants (before)
GRANT USAGE ON DATABASE FINANCE_DB TO ROLE FINANCE_ANALYST;
GRANT USAGE ON SCHEMA FINANCE_DB.MARTS TO ROLE FINANCE_ANALYST;
GRANT SELECT ON ALL TABLES IN SCHEMA FINANCE_DB.MARTS TO ROLE FINANCE_ANALYST;
GRANT SELECT ON FUTURE TABLES IN SCHEMA FINANCE_DB.MARTS TO ROLE FINANCE_ANALYST;

-- Unity Catalog grants (after)
GRANT USE CATALOG ON CATALOG finance_prod TO `grp-finance-analyst`;
GRANT USE SCHEMA ON SCHEMA finance_prod.marts TO `grp-finance-analyst`;
GRANT SELECT ON SCHEMA finance_prod.marts TO `grp-finance-analyst`;
-- Future grants are implicit: schema-level grants apply to new tables
```

### Migration script

```sql
-- Generate Unity Catalog grant statements from Snowflake role inventory
-- Run this against your Snowflake account to generate migration scripts

SELECT
    'GRANT ' ||
    CASE privilege_type
        WHEN 'USAGE' THEN 'USE CATALOG'
        WHEN 'SELECT' THEN 'SELECT'
        WHEN 'INSERT' THEN 'MODIFY'
        WHEN 'UPDATE' THEN 'MODIFY'
        WHEN 'DELETE' THEN 'MODIFY'
        WHEN 'CREATE TABLE' THEN 'CREATE TABLE'
        WHEN 'CREATE VIEW' THEN 'CREATE TABLE'
    END ||
    ' ON ' ||
    CASE object_type
        WHEN 'DATABASE' THEN 'CATALOG'
        WHEN 'SCHEMA' THEN 'SCHEMA'
        WHEN 'TABLE' THEN 'TABLE'
        WHEN 'VIEW' THEN 'TABLE'
    END ||
    ' ' || LOWER(object_name) ||
    ' TO `grp-' || LOWER(REPLACE(grantee_name, '_', '-')) || '`;'
    AS uc_grant_statement
FROM snowflake.account_usage.grants_to_roles
WHERE deleted_on IS NULL
  AND privilege_type IN ('USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE TABLE', 'CREATE VIEW')
ORDER BY grantee_name, object_type, object_name;
```

---

## 5. Dynamic data masking migration

### Snowflake masking policies

```sql
-- Snowflake: Create masking policy
CREATE MASKING POLICY ssn_mask AS (val STRING) RETURNS STRING ->
    CASE
        WHEN CURRENT_ROLE() IN ('FINANCE_ADMIN', 'COMPLIANCE_OFFICER') THEN val
        ELSE 'XXX-XX-' || RIGHT(val, 4)
    END;

-- Apply to column
ALTER TABLE raw.employees MODIFY COLUMN ssn SET MASKING POLICY ssn_mask;
```

### Unity Catalog column masks (replacement)

```sql
-- Unity Catalog: Create column mask function
CREATE FUNCTION analytics_prod.security.ssn_mask(ssn STRING)
RETURNS STRING
RETURN
    CASE
        WHEN is_account_group_member('grp-finance-admin')
          OR is_account_group_member('grp-compliance-officer')
        THEN ssn
        ELSE CONCAT('XXX-XX-', RIGHT(ssn, 4))
    END;

-- Apply mask to column
ALTER TABLE analytics_prod.raw.employees
ALTER COLUMN ssn SET MASK analytics_prod.security.ssn_mask;
```

### Translation reference

| Snowflake masking pattern | Unity Catalog equivalent |
|---|---|
| `CURRENT_ROLE() IN (...)` | `is_account_group_member('group-name')` |
| `IS_ROLE_IN_SESSION(...)` | `is_account_group_member('group-name')` |
| `SYSTEM$GET_TAG(...)` | Query Purview classification via external function |
| Full mask (return NULL) | `RETURN NULL` |
| Partial mask (last 4 digits) | `CONCAT('XXX-XX-', RIGHT(val, 4))` |
| Hash mask | `SHA2(val, 256)` |
| Date mask (year only) | `DATE_TRUNC('year', val)` |
| Email mask | `CONCAT(LEFT(val, 1), '***@', SPLIT(val, '@')[1])` |

### Purview sensitivity labels (classification-driven masking)

Purview can automatically discover and classify sensitive data, then drive masking policies:

```yaml
# Purview classification-to-mask mapping
classifications:
  - name: "Social Security Number"
    purview_type: "MICROSOFT.GOVERNMENT.US.SOCIAL_SECURITY_NUMBER"
    mask_function: "analytics_prod.security.ssn_mask"
    
  - name: "Credit Card Number"
    purview_type: "MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER"
    mask_function: "analytics_prod.security.credit_card_mask"
    
  - name: "Email Address"
    purview_type: "MICROSOFT.PERSONAL.EMAIL"
    mask_function: "analytics_prod.security.email_mask"
    
  - name: "Protected Health Information"
    purview_type: "MICROSOFT.HEALTH.US.HIPAA"
    mask_function: "analytics_prod.security.phi_mask"
```

See `csa_platform/csa_platform/governance/purview/classifications/` for the full classification library.

---

## 6. Row access policies migration

### Snowflake row access policies

```sql
-- Snowflake: Row access policy
CREATE ROW ACCESS POLICY region_access AS (region STRING) RETURNS BOOLEAN ->
    CASE
        WHEN CURRENT_ROLE() = 'ADMIN' THEN TRUE
        WHEN CURRENT_ROLE() = 'EAST_ANALYST' AND region = 'EAST' THEN TRUE
        WHEN CURRENT_ROLE() = 'WEST_ANALYST' AND region = 'WEST' THEN TRUE
        ELSE FALSE
    END;

ALTER TABLE marts.regional_sales ADD ROW ACCESS POLICY region_access ON (region);
```

### Unity Catalog row filters (replacement)

```sql
-- Unity Catalog: Row filter function
CREATE FUNCTION analytics_prod.security.region_filter(region STRING)
RETURNS BOOLEAN
RETURN
    CASE
        WHEN is_account_group_member('grp-admin') THEN TRUE
        WHEN is_account_group_member('grp-east-analyst') AND region = 'EAST' THEN TRUE
        WHEN is_account_group_member('grp-west-analyst') AND region = 'WEST' THEN TRUE
        ELSE FALSE
    END;

-- Apply row filter to table
ALTER TABLE analytics_prod.marts.regional_sales
SET ROW FILTER analytics_prod.security.region_filter ON (region);
```

---

## 7. Object hierarchy mapping

### Snowflake hierarchy to Azure hierarchy

```
Snowflake                          Azure
─────────                          ─────
Account                      →     Entra ID Tenant
  ├── Database               →       ├── Unity Catalog Catalog
  │   ├── Schema             →       │   ├── Schema
  │   │   ├── Table          →       │   │   ├── Table (Delta)
  │   │   ├── View           →       │   │   ├── View
  │   │   ├── Stage          →       │   │   ├── Volume (UC) / ADLS container
  │   │   ├── Pipe           →       │   │   ├── Autoloader config
  │   │   ├── Stream         →       │   │   ├── CDF-enabled table
  │   │   ├── Task           →       │   │   ├── Databricks Job / ADF trigger
  │   │   └── Function/SP    →       │   │   └── UC function / notebook
  │   └── (more schemas)     →       │   └── (more schemas)
  ├── (more databases)       →       ├── (more catalogs)
  ├── Warehouse              →       ├── SQL Warehouse (Databricks)
  ├── Resource Monitor       →       ├── Azure Cost Management budget
  ├── Network Policy         →       ├── NSG + Private Endpoint
  ├── Role                   →       ├── Entra ID Group
  └── User                   →       └── Entra ID User / Service Principal
```

### Multi-account to multi-workspace

| Snowflake pattern | Azure pattern |
|---|---|
| Single account, multiple databases | Single workspace, multiple UC catalogs |
| Multiple accounts (isolation) | Multiple workspaces (isolation) |
| Organization (multi-account management) | Entra ID tenant + Azure management groups |
| Account replication (DR) | Workspace disaster recovery + ADLS GRS |

---

## 8. Encryption migration

### Snowflake encryption

- Always-on AES-256 encryption at rest and in transit
- Tri-Secret Secure: customer-managed key wraps Snowflake-managed key
- Automatic key rotation (annual)

### Azure encryption

```bicep
// Key Vault for customer-managed keys
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${environment}-encryption'
  location: location
  properties: {
    enabledForDiskEncryption: true
    enabledForDeployment: true
    enabledForTemplateDeployment: true
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    sku: {
      family: 'A'
      name: 'premium' // HSM-backed for federal
    }
  }
}

// Customer-managed key for ADLS Gen2
resource storageEncryption 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'stadatalake${environment}'
  properties: {
    encryption: {
      keySource: 'Microsoft.Keyvault'
      keyvaultproperties: {
        keyname: encryptionKey.name
        keyvaulturi: keyVault.properties.vaultUri
      }
    }
  }
}
```

| Snowflake encryption | Azure equivalent |
|---|---|
| AES-256 at rest | ADLS Gen2 AES-256 at rest (default) |
| AES-256 in transit | TLS 1.2+ (enforced) |
| Tri-Secret Secure | Customer-managed key (Key Vault) |
| Annual key rotation | Key Vault auto-rotation (configurable) |
| FIPS 140-2 Level 1 | Key Vault Premium: FIPS 140-2 Level 3 (HSM) |

---

## 9. Audit and compliance migration

### Snowflake audit surfaces

```sql
-- Query history
SELECT * FROM snowflake.account_usage.query_history;

-- Login history
SELECT * FROM snowflake.account_usage.login_history;

-- Access history (who accessed what data)
SELECT * FROM snowflake.account_usage.access_history;

-- Grants history
SELECT * FROM snowflake.account_usage.grants_to_roles;
```

### Azure audit surfaces

| Snowflake audit | Azure equivalent | Retention |
|---|---|---|
| `query_history` | Databricks `system.query.history` + Log Analytics | Configurable (90 days default; extend via archive) |
| `login_history` | Entra ID sign-in logs | 30 days (free) or archive to storage |
| `access_history` | Purview audit logs + Unity Catalog audit | Configurable |
| `grants_to_roles` | Unity Catalog `system.information_schema.grants` | Real-time |
| No equivalent | Tamper-evident audit chain (CSA-0016) | Immutable; cryptographic chain |

The tamper-evident audit chain (CSA-0016) is unique to csa-inabox and provides cryptographic evidence that audit records have not been modified -- a requirement that exceeds Snowflake's audit capabilities for FedRAMP High evidence.

---

## 10. Migration execution checklist

### Network security
- [ ] Document all Snowflake network policies
- [ ] Deploy Private Endpoints for all Azure services
- [ ] Configure NSGs with equivalent allow/deny rules
- [ ] Set up Private DNS zones
- [ ] Disable public access on Databricks workspace
- [ ] Test connectivity from all client networks

### Authentication
- [ ] Map Snowflake users to Entra ID accounts
- [ ] Configure SSO for Databricks via Entra ID
- [ ] Create service principals for automation
- [ ] Set up managed identities where possible
- [ ] Enable MFA via Conditional Access policies
- [ ] Decommission Snowflake credentials

### Authorization
- [ ] Map Snowflake roles to Entra ID groups
- [ ] Generate Unity Catalog grant statements
- [ ] Apply grants per catalog/schema/table
- [ ] Test access for each role/group combination
- [ ] Validate least-privilege enforcement

### Data protection
- [ ] Inventory all masking policies
- [ ] Create Unity Catalog mask functions
- [ ] Apply masks to columns
- [ ] Inventory all row access policies
- [ ] Create Unity Catalog row filters
- [ ] Run Purview auto-classification scan
- [ ] Validate masking behavior for each role

### Encryption
- [ ] Deploy Key Vault with HSM-backed keys
- [ ] Configure customer-managed keys for ADLS Gen2
- [ ] Configure customer-managed keys for Databricks
- [ ] Set up key rotation policy
- [ ] Validate encryption at rest and in transit

### Audit
- [ ] Configure Databricks diagnostic settings to Log Analytics
- [ ] Enable Purview audit logging
- [ ] Set up tamper-evident audit chain (CSA-0016)
- [ ] Configure retention policies
- [ ] Validate audit trail completeness

---

## Related documents

- [Feature Mapping](feature-mapping-complete.md) -- Section 7 for security features
- [Federal Migration Guide](federal-migration-guide.md) -- compliance-specific security requirements
- [Why Azure over Snowflake](why-azure-over-snowflake.md) -- Section 1 for FedRAMP gap
- [Master playbook](../snowflake.md) -- Section 4.4 for permissions migration
- `csa_platform/csa_platform/governance/purview/` -- Purview automation reference
- `csa_platform/unity_catalog_pattern/unity_catalog/` -- Unity Catalog configuration reference

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
