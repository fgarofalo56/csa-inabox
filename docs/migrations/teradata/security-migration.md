# Security Migration — Teradata to Azure

> **Audience:** Security architects, compliance officers, and DBAs responsible for migrating Teradata's security model (access logging, row/column-level security, roles, encryption) to Azure equivalents. This guide ensures no security capability is lost during migration.

---

## 1. Security model comparison

| Security dimension | Teradata | Azure |
| --- | --- | --- |
| **Identity** | Teradata users + LDAP integration | Entra ID (native) |
| **Authentication** | Username/password, LDAP, Kerberos | Entra ID (MFA, conditional access, FIDO2) |
| **Authorization** | Database-level GRANT/REVOKE | Unity Catalog / Synapse RBAC / Fabric permissions |
| **Row-level security** | Views + session variables | Fabric RLS / Unity Catalog row filters / Synapse RLS |
| **Column-level security** | GRANT SELECT on columns | Dynamic data masking / Unity Catalog column masks |
| **Audit logging** | DBC.AccessLog, DBQL | Azure Monitor / Purview / Unity Catalog audit logs |
| **Encryption at rest** | Teradata encryption (AES-256) | Azure Storage Service Encryption (AES-256, automatic) |
| **Encryption in transit** | TLS 1.2 | TLS 1.2/1.3 (enforced) |
| **Network security** | Firewall rules, IP restrictions | Private Link, NSG, Azure Firewall |
| **Data classification** | Manual tagging | Microsoft Purview (automated classification) |

---

## 2. Identity and authentication migration

### 2.1 Teradata identity model

```sql
-- Teradata user management
CREATE USER analyst_user AS
    PERMANENT = 1e8,
    SPOOL = 5e9,
    TEMPORARY = 2e9,
    PASSWORD = '****',
    DEFAULT DATABASE = analytics;

-- LDAP integration (typical enterprise)
-- Teradata maps LDAP groups to database roles
GRANT analyst_role TO analyst_user;
```

### 2.2 Azure identity model (Entra ID)

All Azure data services integrate with Entra ID natively:

```
Entra ID
├── Users (synced from on-prem AD or cloud-native)
├── Groups
│   ├── sg-data-executives     → Tier-1 access
│   ├── sg-data-engineers      → Tier-2 access
│   ├── sg-data-analysts       → Tier-3 access
│   └── sg-data-developers     → Tier-4 access
├── Service Principals
│   ├── sp-adf-production      → ETL service account
│   ├── sp-dbt-runner          → dbt execution
│   └── sp-powerbi-service     → Power BI refresh
└── Managed Identities
    ├── mi-databricks-workspace → Databricks → ADLS
    └── mi-synapse-workspace    → Synapse → ADLS
```

### 2.3 Migration steps

1. **Map Teradata users to Entra ID users** — Most enterprises already have Entra ID (via AD sync). Create a mapping table:

    ```
    Teradata User       → Entra ID User
    analyst_user        → analyst@company.com
    etl_svc_account     → sp-adf-production (service principal)
    bi_refresh_account  → sp-powerbi-service (service principal)
    ```

2. **Map Teradata roles to Entra ID groups:**

    ```
    Teradata Role       → Entra ID Group
    analyst_role        → sg-data-analysts
    engineer_role       → sg-data-engineers
    admin_role          → sg-data-platform-admins
    ```

3. **Configure authentication:**

    ```sql
    -- Databricks: Entra ID authentication is default
    -- No password management needed

    -- Synapse: Entra ID admin
    -- Set via Azure Portal → Synapse workspace → Microsoft Entra admin

    -- Fabric: Entra ID is the only authentication method
    ```

4. **Enforce MFA and conditional access** (Entra ID policies — not available in Teradata):

    - Require MFA for all data platform access
    - Restrict access to corporate network or managed devices
    - Require compliant devices for sensitive data access

---

## 3. Access logging migration

### 3.1 Teradata access logging

```sql
-- Enable access logging
BEGIN LOGGING ON EACH ALL ON TABLE sensitive_data;
BEGIN LOGGING ON EACH SELECT ON DATABASE finance;

-- Query access logs
SELECT
    UserName,
    LogDate,
    LogTime,
    StatementType,
    ObjectDatabaseName,
    ObjectTableName,
    Frequency
FROM DBC.AccessLog
WHERE ObjectTableName = 'sensitive_data'
  AND LogDate >= CURRENT_DATE - 30
ORDER BY LogDate DESC, LogTime DESC;
```

```sql
-- DBQL (Database Query Log) for detailed query logging
SELECT
    UserName,
    QueryText,
    StartTime,
    TotalIOCount,
    AMPCPUTime,
    NumResultRows
FROM DBC.QryLog
WHERE StartTime >= CURRENT_TIMESTAMP - INTERVAL '24' HOUR
ORDER BY StartTime DESC;
```

### 3.2 Azure audit logging

**Databricks (Unity Catalog audit logs):**

```sql
-- Unity Catalog audit events are available via system tables
SELECT
    event_time,
    user_identity.email AS user_name,
    action_name,
    request_params.full_name_arg AS object_name,
    response.status_code
FROM system.access.audit
WHERE action_name IN ('getTable', 'selectFromTable', 'commandSubmit')
  AND event_date >= CURRENT_DATE() - 30
ORDER BY event_time DESC;
```

**Synapse (DMVs + Diagnostic Logs):**

```sql
-- Active and recent queries
SELECT
    request_id,
    login_name,
    submit_time,
    start_time,
    end_compile_time,
    total_elapsed_time,
    command
FROM sys.dm_pdw_exec_requests
WHERE submit_time >= DATEADD(HOUR, -24, GETDATE())
ORDER BY submit_time DESC;

-- Enable Diagnostic Logs via Azure Portal:
-- Synapse workspace → Diagnostic settings → Enable "SQLSecurityAuditEvents"
```

**Azure Monitor (centralized):**

```json
{
    "type": "Microsoft.Insights/diagnosticSettings",
    "properties": {
        "logs": [
            {
                "category": "SQLSecurityAuditEvents",
                "enabled": true,
                "retentionPolicy": { "enabled": true, "days": 365 }
            },
            {
                "category": "DatabricksAccounts",
                "enabled": true
            }
        ],
        "workspaceId": "/subscriptions/.../workspaces/log-analytics-workspace"
    }
}
```

### 3.3 Mapping table

| Teradata log | Azure equivalent | Retention |
| --- | --- | --- |
| DBC.AccessLog | Unity Catalog audit / Azure Monitor | Configurable (90-365+ days) |
| DBC.DeleteAccessLog | Azure Monitor delete events | Configurable |
| DBC.QryLog (DBQL) | Databricks Query History / Synapse DMVs | 90 days default, archive to ADLS |
| DBC.LogOnOff | Entra ID sign-in logs | 30-90 days (Entra), archive longer |
| DBC.DBQLStepTbl | Spark UI / Synapse query diagnostics | 30-90 days, archive to ADLS |

---

## 4. Row-level security (RLS) migration

### 4.1 Teradata RLS (view-based)

```sql
-- Teradata: RLS via secure views
CREATE VIEW secure_orders AS
SELECT * FROM orders
WHERE region IN (
    SELECT allowed_region FROM user_region_access
    WHERE username = SESSION.username
);

-- Grant access to the view, not the base table
GRANT SELECT ON secure_orders TO analyst_role;
REVOKE SELECT ON orders FROM analyst_role;
```

### 4.2 Azure RLS options

**Databricks (Unity Catalog row filters):**

```sql
-- Create row filter function
CREATE FUNCTION region_filter(region STRING)
RETURN (
    SELECT COUNT(*) > 0
    FROM user_region_access
    WHERE username = CURRENT_USER()
      AND allowed_region = region
);

-- Apply to table
ALTER TABLE silver.orders SET ROW FILTER region_filter ON (region);

-- Users automatically see only their allowed regions
SELECT * FROM silver.orders;  -- Filtered by region_filter
```

**Fabric / Power BI (native RLS):**

```dax
-- Power BI RLS role definition (DAX filter)
-- Role: "Region Analyst"
-- Table: orders
-- Filter expression:
[region] IN VALUES('UserRegionAccess'[allowed_region])

-- Or using USERPRINCIPALNAME():
PATHCONTAINS(
    CALCULATETABLE(
        VALUES('UserRegionAccess'[allowed_region]),
        'UserRegionAccess'[email] = USERPRINCIPALNAME()
    ),
    [region]
)
```

**Synapse (security policy):**

```sql
-- Create filter predicate function
CREATE FUNCTION dbo.fn_region_filter(@region VARCHAR(50))
RETURNS TABLE
WITH SCHEMABINDING
AS RETURN
    SELECT 1 AS result
    WHERE @region IN (
        SELECT allowed_region FROM dbo.user_region_access
        WHERE username = SUSER_SNAME()
    );

-- Create security policy
CREATE SECURITY POLICY region_policy
ADD FILTER PREDICATE dbo.fn_region_filter(region) ON dbo.orders
WITH (STATE = ON);
```

---

## 5. Column-level security migration

### 5.1 Teradata column-level GRANT

```sql
-- Teradata: restrict visible columns
GRANT SELECT (customer_id, order_date, region) ON orders TO analyst_role;
-- analyst_role cannot see: amount, discount, internal_notes
```

### 5.2 Azure column masking

**Databricks (Unity Catalog column masks):**

```sql
-- Create masking function
CREATE FUNCTION mask_amount(amount DECIMAL(12,2))
RETURN CASE
    WHEN IS_MEMBER('sg-data-finance') THEN amount
    ELSE NULL
END;

CREATE FUNCTION mask_ssn(ssn STRING)
RETURN CASE
    WHEN IS_MEMBER('sg-data-pii-access') THEN ssn
    ELSE CONCAT('XXX-XX-', RIGHT(ssn, 4))
END;

-- Apply masks
ALTER TABLE silver.customers ALTER COLUMN ssn SET MASK mask_ssn;
ALTER TABLE silver.orders ALTER COLUMN amount SET MASK mask_amount;
```

**Synapse (dynamic data masking):**

```sql
-- Apply dynamic data masking
ALTER TABLE dbo.customers
ALTER COLUMN ssn ADD MASKED WITH (FUNCTION = 'partial(0,"XXX-XX-",4)');

ALTER TABLE dbo.customers
ALTER COLUMN email ADD MASKED WITH (FUNCTION = 'email()');

ALTER TABLE dbo.orders
ALTER COLUMN amount ADD MASKED WITH (FUNCTION = 'default()');

-- Grant unmask to specific roles
GRANT UNMASK ON dbo.customers TO finance_role;
GRANT UNMASK ON dbo.orders TO finance_role;
```

**Microsoft Purview (centralized masking policies):**

Purview provides organization-wide data masking policies that apply across Databricks, Synapse, and Fabric. This is the recommended approach for enterprises with multiple compute engines.

---

## 6. Network security

### 6.1 Teradata network security

Teradata typically relies on:
- Physical network isolation (dedicated VLAN)
- Firewall rules on the Teradata system
- IP-based access restrictions
- Gateway/proxy server for remote access

### 6.2 Azure network security

```
┌─────────────────────────────────────────────────────────────┐
│                    Azure Virtual Network                     │
│                                                             │
│  ┌───────────────┐  Private   ┌───────────────┐            │
│  │ Databricks    │  Endpoint  │ ADLS Gen2     │            │
│  │ (VNet         ├───────────>│ (Private      │            │
│  │  injected)    │            │  Endpoint)    │            │
│  └───────┬───────┘            └───────────────┘            │
│          │                                                  │
│  ┌───────▼───────┐  Private   ┌───────────────┐            │
│  │ Synapse       │  Endpoint  │ Key Vault     │            │
│  │ Workspace     ├───────────>│ (Private      │            │
│  │               │            │  Endpoint)    │            │
│  └───────────────┘            └───────────────┘            │
│                                                             │
│  ┌───────────────┐                                          │
│  │ NSG Rules     │                                          │
│  │ - Allow: Corp │                                          │
│  │ - Deny: *     │                                          │
│  └───────────────┘                                          │
└──────────────────────┬──────────────────────────────────────┘
                       │ ExpressRoute
              ┌────────▼────────┐
              │ On-Premises     │
              │ (Corporate)     │
              └─────────────────┘
```

Key Azure network security components:

| Component | Purpose | Configuration |
| --- | --- | --- |
| Private Endpoints | No public internet exposure for data services | ADLS, Synapse, Key Vault, Databricks |
| VNet injection | Databricks runs inside your VNet | Databricks workspace deployment |
| NSG (Network Security Groups) | Firewall rules per subnet | Allow corporate IPs, deny all others |
| Azure Firewall | Centralized egress filtering | Prevent data exfiltration |
| ExpressRoute | Private connection to on-prem | Teradata → Azure data transfer |

---

## 7. Encryption

### 7.1 Encryption at rest

| System | Teradata | Azure |
| --- | --- | --- |
| Default encryption | Optional (must enable) | Always on (Azure SSE) |
| Algorithm | AES-256 | AES-256 |
| Key management | Teradata-managed or HSM | Azure Key Vault (customer-managed keys available) |
| Granularity | Database or table level | Storage account or resource level |
| Performance impact | 2-5% overhead | Negligible (hardware-accelerated) |

**Azure Key Vault configuration for customer-managed keys:**

```json
{
    "type": "Microsoft.Storage/storageAccounts",
    "properties": {
        "encryption": {
            "keySource": "Microsoft.Keyvault",
            "keyvaultproperties": {
                "keyvaulturi": "https://my-keyvault.vault.azure.net",
                "keyname": "adls-encryption-key",
                "keyversion": ""
            }
        }
    }
}
```

### 7.2 Encryption in transit

| System | Teradata | Azure |
| --- | --- | --- |
| Protocol | TLS 1.2 (configurable) | TLS 1.2/1.3 (enforced) |
| Certificate management | Manual (Teradata admin) | Automatic (Azure-managed) |
| Internal traffic | Optional encryption | Always encrypted within Azure backbone |
| Client connections | JDBC/ODBC with TLS | JDBC/ODBC/REST with TLS (mandatory) |

---

## 8. Data classification and governance

### 8.1 Teradata data classification

Teradata does not have built-in data classification. Most organizations use:
- Manual tagging in data catalogs
- Custom metadata tables
- Third-party tools (Collibra, Alation)

### 8.2 Microsoft Purview (automated classification)

Purview provides:

| Capability | Description |
| --- | --- |
| Automated scanning | Scans ADLS, Databricks, Synapse for sensitive data |
| Built-in classifiers | 200+ classifiers (SSN, credit card, email, etc.) |
| Custom classifiers | Regex or dictionary-based custom patterns |
| Sensitivity labels | Apply labels (Public, Confidential, Highly Confidential) |
| Data lineage | Track data flow from source to dashboard |
| Data catalog | Searchable catalog of all data assets |
| Access policies | Centralized access governance across platforms |

**Purview scanning configuration:**

```json
{
    "kind": "AzureStorageCredential",
    "properties": {
        "endpoint": "https://datalake.dfs.core.windows.net/",
        "resourceTypes": {
            "AzureStorageBlob": { "scanRulesetName": "default", "scanRulesetType": "System" }
        },
        "credential": {
            "referenceName": "purview-managed-identity",
            "credentialType": "ManagedIdentity"
        }
    }
}
```

---

## 9. Security migration checklist

### Pre-migration

- [ ] Inventory all Teradata users, roles, and grants
- [ ] Map Teradata users to Entra ID identities
- [ ] Map Teradata roles to Entra ID security groups
- [ ] Document RLS policies (views, filters)
- [ ] Document column-level access restrictions
- [ ] Inventory access logging configuration (which tables, which events)
- [ ] Document encryption settings (at rest, in transit)
- [ ] Identify sensitive data locations (PII, PHI, financial)

### Implementation

- [ ] Create Entra ID groups matching Teradata roles
- [ ] Configure Unity Catalog / Synapse permissions matching Teradata grants
- [ ] Implement row filters matching Teradata RLS views
- [ ] Implement column masks matching Teradata column grants
- [ ] Enable audit logging (Azure Monitor, Unity Catalog)
- [ ] Configure Purview scanning for automated classification
- [ ] Set up Private Endpoints for all data services
- [ ] Configure customer-managed keys in Key Vault (if required)
- [ ] Enable MFA and conditional access policies

### Validation

- [ ] Verify each user/role can access only authorized data
- [ ] Test RLS: confirm filtered results match Teradata
- [ ] Test column masking: confirm masked values for unauthorized users
- [ ] Verify audit logs capture all required events
- [ ] Run Purview scan and review classification results
- [ ] Penetration test: attempt unauthorized data access
- [ ] Verify encryption at rest (Key Vault audit)
- [ ] Verify TLS enforcement (connection test without TLS should fail)

---

## 10. Related resources

- [Feature Mapping](feature-mapping-complete.md) — Security feature mapping details
- [Workload Migration](workload-migration.md) — Workload-level security isolation
- [Best Practices](best-practices.md) — Security during parallel-run validation
- [Teradata Migration Overview](../teradata.md) — Security overview
- `docs/compliance/nist-800-53-rev5.md` — NIST 800-53 compliance mapping
- `docs/compliance/cmmc-2.0-l2.md` — CMMC 2.0 Level 2 compliance
- Microsoft Purview: <https://learn.microsoft.com/purview>
- Unity Catalog security: <https://docs.databricks.com/data-governance/unity-catalog/index.html>

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
