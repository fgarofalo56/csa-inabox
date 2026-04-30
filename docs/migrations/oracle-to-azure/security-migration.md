# Oracle Security Migration to Azure

**Migrating Oracle security features to Azure: VPD/OLS to row-level security, TDE key migration, Oracle audit to Azure Monitor/Sentinel, Oracle roles to Azure RBAC, and network encryption.**

---

!!! abstract "Key principle"
Oracle's security model is database-centric -- security is enforced inside the database engine. Azure's security model is platform-centric -- security is enforced across the platform (Entra ID, Key Vault, Azure Monitor, Defender) with database-level controls as one layer. Migration means moving from a single-layer database security model to a multi-layer platform security model.

---

## 1. Security model comparison

| Security domain           | Oracle approach                                             | Azure approach                                       |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| **Identity**              | Oracle users, roles, profiles                               | Entra ID + database roles                            |
| **Authentication**        | Password, Kerberos, certificate, wallet                     | Entra ID (MFA, conditional access), managed identity |
| **Authorization**         | Object privileges, system privileges, roles                 | Azure RBAC + database permissions                    |
| **Row-level access**      | Virtual Private Database (VPD), Oracle Label Security (OLS) | Row-Level Security (RLS) policies                    |
| **Encryption at rest**    | Transparent Data Encryption (TDE), tablespace encryption    | TDE (included), storage encryption                   |
| **Encryption in transit** | Oracle Net encryption (sqlnet.ora)                          | TLS 1.2+ enforced by default                         |
| **Data masking**          | Data Redaction                                              | Dynamic Data Masking, static masking                 |
| **Auditing**              | Unified Auditing, Fine-Grained Auditing                     | SQL Auditing, Azure Monitor, Microsoft Sentinel      |
| **Key management**        | Oracle Wallet, Oracle Key Vault                             | Azure Key Vault                                      |
| **Network security**      | Oracle Net ACL, firewall rules                              | VNet integration, Private Endpoints, NSGs            |

---

## 2. Identity and authentication migration

### 2.1 Oracle users to Entra ID

```sql
-- Oracle: Database users with password authentication
CREATE USER app_user IDENTIFIED BY "ComplexP@ss123"
    DEFAULT TABLESPACE users
    QUOTA UNLIMITED ON users
    PROFILE app_profile;

CREATE PROFILE app_profile LIMIT
    PASSWORD_LIFE_TIME 90
    PASSWORD_REUSE_TIME 365
    PASSWORD_REUSE_MAX 12
    FAILED_LOGIN_ATTEMPTS 5
    PASSWORD_LOCK_TIME 1/24;

GRANT CREATE SESSION TO app_user;
GRANT SELECT ON hr.employees TO app_user;
```

```sql
-- Azure SQL MI: Entra ID authentication (recommended)
-- 1. Create Entra ID user (no password managed by database)
CREATE USER [app_user@agency.onmicrosoft.com] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [app_user@agency.onmicrosoft.com];

-- 2. Or create Entra ID group for role-based access
CREATE USER [DBA-Team-SecurityGroup] FROM EXTERNAL PROVIDER;
ALTER ROLE db_owner ADD MEMBER [DBA-Team-SecurityGroup];

-- 3. Managed identity for applications (no credentials to manage)
CREATE USER [app-managed-identity] FROM EXTERNAL PROVIDER;
GRANT SELECT ON dbo.employees TO [app-managed-identity];
```

```sql
-- PostgreSQL: Entra ID authentication
-- Configure in server parameters: azure.extensions = pgaadauth
-- Then create users mapped to Entra ID
SELECT * FROM pgaadauth_create_principal('app_user@agency.onmicrosoft.com', false, false);
GRANT SELECT ON ALL TABLES IN SCHEMA app_schema TO "app_user@agency.onmicrosoft.com";
```

### 2.2 Oracle roles to Azure RBAC + database roles

| Oracle role pattern     | Azure equivalent                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `DBA` role              | Entra ID group mapped to `db_owner` (database) + Azure RBAC `SQL MI Contributor` (platform) |
| `CONNECT` role          | Entra ID user with `CREATE SESSION` equivalent (login permission)                           |
| `RESOURCE` role         | `db_ddladmin` + `db_datawriter`                                                             |
| `SELECT_CATALOG_ROLE`   | `db_datareader` on system views                                                             |
| Custom application role | Custom database role with specific object permissions                                       |
| `EXP_FULL_DATABASE`     | `db_backupoperator`                                                                         |

---

## 3. Virtual Private Database (VPD) to Row-Level Security

VPD is one of Oracle's most powerful security features. It attaches security policies to tables that automatically inject WHERE clause predicates based on the session context.

### 3.1 Oracle VPD example

```sql
-- Oracle VPD: Restrict employees to see only their department's data
CREATE OR REPLACE FUNCTION dept_security_policy(
    p_schema IN VARCHAR2,
    p_object IN VARCHAR2
) RETURN VARCHAR2 IS
    v_dept_id NUMBER;
BEGIN
    -- Get current user's department from context
    v_dept_id := SYS_CONTEXT('HR_CTX', 'DEPARTMENT_ID');

    IF v_dept_id IS NOT NULL THEN
        RETURN 'department_id = ' || v_dept_id;
    ELSE
        RETURN '1=0';  -- No access if no department context
    END IF;
END;
/

-- Apply policy to table
BEGIN
    DBMS_RLS.ADD_POLICY(
        object_schema   => 'HR',
        object_name     => 'EMPLOYEES',
        policy_name     => 'DEPT_ACCESS_POLICY',
        function_schema => 'HR',
        policy_function => 'DEPT_SECURITY_POLICY',
        statement_types => 'SELECT,INSERT,UPDATE,DELETE'
    );
END;
/
```

### 3.2 Azure SQL MI Row-Level Security equivalent

```sql
-- Azure SQL MI: Row-Level Security
-- 1. Create schema for security predicates
CREATE SCHEMA Security;
GO

-- 2. Create predicate function
CREATE FUNCTION Security.fn_dept_security_predicate(
    @department_id int
)
RETURNS TABLE
WITH SCHEMABINDING
AS
    RETURN SELECT 1 AS fn_result
    WHERE @department_id = (
        SELECT department_id
        FROM dbo.user_department_mapping
        WHERE user_name = SUSER_SNAME()
    )
    OR IS_MEMBER('db_owner') = 1;  -- DBA bypass
GO

-- 3. Create security policy
CREATE SECURITY POLICY Security.DeptAccessPolicy
ADD FILTER PREDICATE Security.fn_dept_security_predicate(department_id)
    ON dbo.employees,
ADD BLOCK PREDICATE Security.fn_dept_security_predicate(department_id)
    ON dbo.employees AFTER INSERT,
ADD BLOCK PREDICATE Security.fn_dept_security_predicate(department_id)
    ON dbo.employees AFTER UPDATE
WITH (STATE = ON);
GO
```

### 3.3 PostgreSQL Row-Level Security equivalent

```sql
-- PostgreSQL: Row-Level Security
-- 1. Enable RLS on the table
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

-- 2. Create policy
CREATE POLICY dept_access_policy ON employees
    USING (
        department_id = (
            SELECT department_id
            FROM user_department_mapping
            WHERE user_name = current_user
        )
        OR current_user IN (SELECT rolname FROM pg_roles WHERE rolsuper)
    );

-- 3. Force RLS for table owner too (optional)
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
```

---

## 4. Oracle Label Security (OLS) migration

OLS provides multi-level security with labels (classification levels, compartments, and groups). There is no direct equivalent in Azure SQL MI or PostgreSQL.

### 4.1 OLS to RLS conversion pattern

```sql
-- Oracle OLS: Row labeled with security classification
-- Labels: UNCLASSIFIED, CUI, SECRET, TOP_SECRET
-- Users have maximum label clearance

-- Azure SQL MI equivalent: Classification column + RLS
-- 1. Add classification column to table
ALTER TABLE sensitive_documents ADD security_level nvarchar(20) NOT NULL DEFAULT 'UNCLASSIFIED';

-- 2. Create user-clearance mapping table
CREATE TABLE dbo.user_clearance (
    user_name nvarchar(128) PRIMARY KEY,
    max_clearance_level int NOT NULL  -- 0=UNCLASS, 1=CUI, 2=SECRET, 3=TS
);

-- 3. Create clearance-level mapping
CREATE TABLE dbo.clearance_levels (
    level_name nvarchar(20) PRIMARY KEY,
    level_order int NOT NULL
);
INSERT INTO dbo.clearance_levels VALUES
    ('UNCLASSIFIED', 0), ('CUI', 1), ('SECRET', 2), ('TOP_SECRET', 3);

-- 4. Create RLS predicate that enforces clearance
CREATE FUNCTION Security.fn_classification_predicate(
    @security_level nvarchar(20)
)
RETURNS TABLE WITH SCHEMABINDING AS
RETURN SELECT 1 AS result
WHERE (
    SELECT cl.level_order FROM dbo.clearance_levels cl WHERE cl.level_name = @security_level
) <= (
    SELECT uc.max_clearance_level FROM dbo.user_clearance uc WHERE uc.user_name = SUSER_SNAME()
);

-- 5. Apply security policy
CREATE SECURITY POLICY Security.ClassificationPolicy
ADD FILTER PREDICATE Security.fn_classification_predicate(security_level)
    ON dbo.sensitive_documents
WITH (STATE = ON);
```

---

## 5. TDE encryption migration

### 5.1 Oracle TDE to Azure SQL MI

Oracle TDE encrypts data at rest using tablespace or column-level encryption with keys stored in an Oracle Wallet or Oracle Key Vault.

Azure SQL MI TDE is automatic and included at no additional cost:

```sql
-- Oracle: TDE configuration
ALTER SYSTEM SET ENCRYPTION KEY IDENTIFIED BY "wallet_password";
ALTER TABLESPACE users ENCRYPTION USING 'AES256' ENCRYPT;

-- Azure SQL MI: TDE is enabled by default
-- No configuration needed for service-managed keys

-- For customer-managed keys (BYOK):
-- 1. Create key in Azure Key Vault
-- az keyvault key create --vault-name kv-feddb --name tde-key --kty RSA --size 2048

-- 2. Configure SQL MI to use customer-managed key
-- az sql mi tde-key set --server-key-type AzureKeyVault \
--     --kid "https://kv-feddb.vault.azure.net/keys/tde-key/..." \
--     --managed-instance mi-instance \
--     --resource-group rg-prod
```

### 5.2 PostgreSQL encryption

PostgreSQL on Azure uses storage-level encryption (AES-256) by default. Column-level encryption uses `pgcrypto`:

```sql
-- PostgreSQL: Column-level encryption (pgcrypto)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Encrypt sensitive column
UPDATE employees
SET ssn_encrypted = pgp_sym_encrypt(ssn, 'encryption_key')
WHERE ssn IS NOT NULL;
```

---

## 6. Audit migration

### 6.1 Oracle Unified Auditing to Azure Monitor

```sql
-- Oracle: Unified audit policy
CREATE AUDIT POLICY sensitive_data_access
    ACTIONS SELECT ON hr.employees,
            UPDATE ON hr.employees,
            DELETE ON hr.employees;
AUDIT POLICY sensitive_data_access;

-- Oracle: Fine-grained auditing
BEGIN
    DBMS_FGA.ADD_POLICY(
        object_schema => 'HR',
        object_name   => 'EMPLOYEES',
        policy_name   => 'FGA_SALARY_ACCESS',
        audit_column  => 'SALARY,SSN',
        statement_types => 'SELECT'
    );
END;
/
```

```sql
-- Azure SQL MI: SQL Auditing (automatic, logs to Azure Monitor)
-- Enabled via Azure Portal or CLI:
-- az sql mi audit-policy update \
--     --resource-group rg-prod \
--     --managed-instance mi-instance \
--     --state Enabled \
--     --storage-account staudit \
--     --log-analytics-target-state Enabled \
--     --log-analytics-workspace-resource-id /subscriptions/.../workspaces/law-prod

-- Query audit logs in Log Analytics
-- AzureDiagnostics
-- | where Category == "SQLSecurityAuditEvents"
-- | where statement_s contains "employees"
-- | project TimeGenerated, server_principal_name_s, statement_s, response_rows_d
```

```sql
-- PostgreSQL: pgAudit extension
-- Enable in server parameters: shared_preload_libraries = 'pgaudit'
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Configure audit logging
ALTER SYSTEM SET pgaudit.log = 'read, write, ddl';
ALTER SYSTEM SET pgaudit.log_catalog = 'off';
ALTER SYSTEM SET pgaudit.log_relation = 'on';

-- Object-level auditing
ALTER ROLE auditor SET pgaudit.role = 'auditor';
GRANT SELECT ON hr.employees TO auditor;
-- Now all SELECT on hr.employees is audited
```

### 6.2 Integration with CSA-in-a-Box audit framework

CSA-in-a-Box provides a tamper-evident audit path (CSA-0016) that integrates with Azure Monitor:

- Database audit logs flow to **Azure Monitor / Log Analytics**
- Log Analytics forwards to **Microsoft Sentinel** for security analytics
- Purview audit tracks data access across the analytics platform
- The tamper-evident audit logger provides hash-chained evidence for compliance

---

## 7. Network security migration

| Oracle network security                                       | Azure equivalent                           |
| ------------------------------------------------------------- | ------------------------------------------ |
| Oracle Net Encryption (sqlnet.ora `SQLNET.ENCRYPTION_SERVER`) | TLS 1.2+ enforced by default               |
| Oracle Net ACL (`DBMS_NETWORK_ACL_ADMIN`)                     | VNet integration + Network Security Groups |
| Firewall rules (`TCP.VALIDNODE_CHECKING`)                     | Private Endpoints + NSG rules              |
| Oracle Connection Manager (CMAN)                              | Azure Application Gateway or VNet peering  |
| Oracle Wallet for client certificates                         | Azure Key Vault + managed certificates     |

### 7.1 Private Endpoint configuration

```bash
# Azure SQL MI: Already deployed in a VNet (inherently private)
# External access is controlled by the MI's public endpoint setting

# PostgreSQL: Create Private Endpoint
az network private-endpoint create \
    --resource-group rg-prod \
    --name pe-postgres-prod \
    --vnet-name vnet-prod \
    --subnet snet-data \
    --private-connection-resource-id /subscriptions/.../flexibleServers/pg-prod \
    --group-id postgresqlServer \
    --connection-name pg-prod-connection
```

---

## 8. Compliance mapping

| Oracle security feature | Compliance control    | Azure equivalent             | CSA-in-a-Box evidence         |
| ----------------------- | --------------------- | ---------------------------- | ----------------------------- |
| TDE                     | NIST AC-3, SC-28      | TDE / storage encryption     | `nist-800-53-rev5.yaml` SC-28 |
| VPD                     | NIST AC-3, AC-4       | Row-Level Security           | `nist-800-53-rev5.yaml` AC-3  |
| Unified Auditing        | NIST AU-2, AU-3, AU-6 | Azure SQL Auditing + Monitor | `nist-800-53-rev5.yaml` AU-2  |
| Network encryption      | NIST SC-8, SC-13      | TLS 1.2+ enforced            | `nist-800-53-rev5.yaml` SC-8  |
| Oracle Wallet           | NIST SC-12            | Azure Key Vault              | `nist-800-53-rev5.yaml` SC-12 |
| Database Vault          | NIST AC-6, CM-7       | Azure RBAC + no sa access    | `nist-800-53-rev5.yaml` AC-6  |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
