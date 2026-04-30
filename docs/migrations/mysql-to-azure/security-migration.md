# MySQL / MariaDB Security Migration

**Authentication migration from mysql_native_password to Entra ID, TLS configuration, firewall rules and Private Link, data encryption at rest with customer-managed keys, and audit logging on Azure Database for MySQL Flexible Server.**

---

!!! abstract "Security migration summary"
Azure Database for MySQL Flexible Server upgrades the security posture of self-hosted MySQL in every dimension: enforced TLS 1.2+, Entra ID (Azure AD) authentication replacing password-based access, Private Link for zero-trust networking, AES-256 encryption at rest with customer-managed keys, and integrated audit logging streaming to Azure Monitor. The migration is an opportunity to modernize your security model, not just replicate it.

---

## 1. Authentication migration

### 1.1 MySQL authentication plugins

| MySQL auth plugin         | Description                              | Azure MySQL Flexible Server support   |
| ------------------------- | ---------------------------------------- | ------------------------------------- |
| **mysql_native_password** | SHA-1 password hashing (legacy)          | Supported but deprecated in MySQL 8.4 |
| **caching_sha2_password** | SHA-256 with caching (MySQL 8.0 default) | Supported (default)                   |
| **sha256_password**       | SHA-256 without caching                  | Supported                             |
| **auth_socket**           | Unix socket authentication               | Not applicable (no local access)      |
| **PAM**                   | Pluggable Authentication Module          | Not supported                         |
| **LDAP**                  | LDAP/Active Directory authentication     | Not supported natively; use Entra ID  |
| **mysql_no_login**        | Service accounts (no interactive login)  | Not supported; use managed identities |
| **Entra ID (Azure AD)**   | Azure Active Directory token-based       | Supported (recommended)               |

### 1.2 Migrating to Entra ID authentication

Entra ID authentication replaces MySQL password-based access with Azure AD tokens. This provides:

- Centralized identity management
- Multi-factor authentication (MFA)
- Conditional access policies
- Managed identity support for applications (no passwords in code)
- Azure RBAC integration
- Single sign-on (SSO) for DBA tools

**Step 1: Configure Entra ID admin on Flexible Server**

```bash
# Set Entra ID admin via Azure CLI
az mysql flexible-server ad-admin create \
  --resource-group myResourceGroup \
  --server-name myMySQLServer \
  --display-name "DBA Team" \
  --object-id "00000000-0000-0000-0000-000000000000" \
  --identity myUserAssignedIdentity
```

**Step 2: Create Entra ID users in MySQL**

```sql
-- Connect as Entra ID admin
-- Create Entra ID user
CREATE AADUSER 'user@domain.com' IDENTIFIED BY 'aad_user_object_id';

-- Create Entra ID group
CREATE AADUSER 'DBA_Group' IDENTIFIED BY 'aad_group_object_id';

-- Grant privileges
GRANT ALL PRIVILEGES ON mydb.* TO 'user@domain.com'@'%';
GRANT SELECT ON mydb.* TO 'DBA_Group'@'%';
FLUSH PRIVILEGES;
```

**Step 3: Connect using Entra ID token**

```bash
# Get access token
TOKEN=$(az account get-access-token \
  --resource-type oss-rdbms \
  --query accessToken -o tsv)

# Connect with token
mysql -h myMySQLServer.mysql.database.azure.com \
  --user user@domain.com \
  --password="$TOKEN" \
  --ssl-mode=REQUIRED \
  mydb
```

**Step 4: Configure managed identity for applications**

```python
# Python application using managed identity
from azure.identity import DefaultAzureCredential
import mysql.connector

credential = DefaultAzureCredential()
token = credential.get_token("https://ossrdbms-aad.database.windows.net/.default")

connection = mysql.connector.connect(
    host="myMySQLServer.mysql.database.azure.com",
    user="app-managed-identity@myMySQLServer",
    password=token.token,
    database="mydb",
    ssl_ca="/path/to/DigiCertGlobalRootCA.crt.pem"
)
```

### 1.3 Migration strategy for user accounts

| Source authentication              | Target authentication                          | Migration approach                                   |
| ---------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| **mysql_native_password** (DBAs)   | Entra ID users or groups                       | Create Entra ID users; phase out MySQL passwords     |
| **mysql_native_password** (apps)   | Managed identity                               | Configure system/user-assigned managed identity      |
| **Application connection strings** | Managed identity or Entra ID service principal | Update connection code; remove passwords from config |
| **Root/admin user**                | Entra ID admin + MySQL admin (backup)          | Set Entra ID admin; keep MySQL admin for break-glass |
| **Replication user**               | Service-managed replication                    | Not needed; Azure manages replica connections        |
| **Monitoring user**                | Azure Monitor (built-in)                       | Not needed; Azure Monitor collects metrics natively  |

### 1.4 User and privilege export

```sql
-- Export all users and privileges from source MySQL
SELECT CONCAT('CREATE USER ''', user, '''@''', host, ''' IDENTIFIED BY ''<password>'';')
FROM mysql.user
WHERE user NOT IN ('root', 'mysql.sys', 'mysql.session', 'mysql.infoschema')
ORDER BY user;

-- Export grants
SELECT CONCAT('SHOW GRANTS FOR ''', user, '''@''', host, ''';')
FROM mysql.user
WHERE user NOT IN ('root', 'mysql.sys', 'mysql.session', 'mysql.infoschema')
ORDER BY user;

-- Or use pt-show-grants (Percona Toolkit)
pt-show-grants --host source-host --user root --ask-pass > grants.sql
```

---

## 2. TLS/SSL configuration

### 2.1 Azure MySQL Flexible Server TLS

TLS is enforced by default on Azure MySQL Flexible Server. The minimum TLS version is configurable:

| Parameter                  | Default         | Options          | Recommendation                     |
| -------------------------- | --------------- | ---------------- | ---------------------------------- |
| `require_secure_transport` | ON              | ON/OFF           | Keep ON (never disable)            |
| `tls_version`              | TLSv1.2,TLSv1.3 | TLSv1.2, TLSv1.3 | TLSv1.2 minimum; TLSv1.3 preferred |

### 2.2 Configuring TLS on the client side

```bash
# Download Azure CA certificate
wget https://dl.cacerts.digicert.com/DigiCertGlobalRootCA.crt.pem

# Connect with SSL verification
mysql -h myMySQLServer.mysql.database.azure.com \
  -u admin -p \
  --ssl-mode=VERIFY_CA \
  --ssl-ca=DigiCertGlobalRootCA.crt.pem

# Connection string with SSL
mysql://admin:password@myMySQLServer.mysql.database.azure.com:3306/mydb?ssl-mode=VERIFY_CA&ssl-ca=/path/to/DigiCertGlobalRootCA.crt.pem
```

### 2.3 Application SSL configuration

| Platform                     | SSL parameter                                              | Value                                |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| **Python (mysql-connector)** | `ssl_ca`                                                   | Path to DigiCertGlobalRootCA.crt.pem |
| **Python (PyMySQL)**         | `ssl={'ca': '/path/to/cert.pem'}`                          | CA certificate path                  |
| **Java (JDBC)**              | `useSSL=true&requireSSL=true&verifyServerCertificate=true` | Enable and verify                    |
| **Node.js**                  | `ssl: { ca: fs.readFileSync('/path/to/cert.pem') }`        | CA certificate                       |
| **.NET (MySqlConnector)**    | `SslMode=VerifyCA;SslCa=/path/to/cert.pem`                 | Verify CA                            |
| **PHP (PDO)**                | `PDO::MYSQL_ATTR_SSL_CA => '/path/to/cert.pem'`            | CA certificate                       |

---

## 3. Network security

### 3.1 Firewall rules

Azure MySQL Flexible Server supports IP-based firewall rules for public access mode:

```bash
# Add firewall rule for specific IP
az mysql flexible-server firewall-rule create \
  --resource-group myResourceGroup \
  --name myMySQLServer \
  --rule-name AllowMyIP \
  --start-ip-address 203.0.113.10 \
  --end-ip-address 203.0.113.10

# Allow Azure services (not recommended for production)
az mysql flexible-server firewall-rule create \
  --resource-group myResourceGroup \
  --name myMySQLServer \
  --rule-name AllowAzureServices \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0
```

### 3.2 Private Link / VNet integration

For production and compliance-sensitive workloads, use VNet integration or Private Link:

```bash
# Create server with VNet integration (preferred for new deployments)
az mysql flexible-server create \
  --resource-group myResourceGroup \
  --name myMySQLServer \
  --vnet myVNet \
  --subnet mysql-subnet \
  --private-dns-zone myPrivateDnsZone

# Or add Private Endpoint to existing server
az network private-endpoint create \
  --resource-group myResourceGroup \
  --name myPrivateEndpoint \
  --vnet-name myVNet \
  --subnet private-endpoint-subnet \
  --private-connection-resource-id /subscriptions/.../providers/Microsoft.DBforMySQL/flexibleServers/myMySQLServer \
  --group-id mysqlServer \
  --connection-name myConnection
```

### 3.3 Network security comparison

| Source configuration                 | Azure equivalent                  | Security improvement                                   |
| ------------------------------------ | --------------------------------- | ------------------------------------------------------ |
| MySQL bind-address (IP restriction)  | Firewall rules + Private Link     | Centralized, auditable network controls                |
| iptables/firewalld rules             | Network Security Groups (NSG)     | Azure-native, policy-driven                            |
| SSH tunnel to MySQL                  | Private Link (no public exposure) | No SSH needed; private IP only                         |
| VPN to MySQL server                  | ExpressRoute or Azure VPN Gateway | Enterprise-grade, encrypted                            |
| MySQL `skip-networking` (local only) | VNet integration (private subnet) | Network-isolated, still accessible from Azure services |
| ProxySQL SSL termination             | Azure-managed TLS termination     | Simplified certificate management                      |

---

## 4. Data encryption

### 4.1 Encryption at rest

Azure MySQL Flexible Server encrypts all data at rest using AES-256:

| Encryption option                  | Key management                           | Use case                             |
| ---------------------------------- | ---------------------------------------- | ------------------------------------ |
| **Service-managed keys** (default) | Microsoft manages keys                   | Standard workloads                   |
| **Customer-managed keys (CMK)**    | Customer manages keys in Azure Key Vault | Federal compliance, data sovereignty |

**Configuring customer-managed keys:**

```bash
# Create Key Vault
az keyvault create \
  --name myKeyVault \
  --resource-group myResourceGroup \
  --location eastus \
  --enable-purge-protection true \
  --retention-days 90

# Create encryption key
az keyvault key create \
  --vault-name myKeyVault \
  --name myMySQLKey \
  --kty RSA \
  --size 2048

# Create user-assigned managed identity
az identity create \
  --resource-group myResourceGroup \
  --name myMySQLIdentity

# Grant Key Vault access to managed identity
az keyvault set-policy \
  --name myKeyVault \
  --object-id <identity-principal-id> \
  --key-permissions get unwrapKey wrapKey

# Configure CMK on Flexible Server
az mysql flexible-server update \
  --resource-group myResourceGroup \
  --name myMySQLServer \
  --key <key-id> \
  --identity myMySQLIdentity
```

### 4.2 Encryption in transit

TLS is enforced by default. No additional configuration needed beyond ensuring client applications use SSL connections.

### 4.3 Comparison with source MySQL encryption

| Source encryption                         | Azure equivalent                               | Notes                                                   |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| InnoDB tablespace encryption (TDE)        | Azure encryption at rest (always on)           | Azure encryption is transparent; no application changes |
| MySQL Enterprise Encryption functions     | Azure Key Vault + application-level encryption | For column-level encryption                             |
| `mysql_ssl_rsa_setup` (self-signed certs) | Azure-managed certificates                     | No manual certificate management                        |
| Manual key rotation                       | Azure Key Vault key rotation                   | Automated with Key Vault policies                       |

---

## 5. Audit logging

### 5.1 Enabling audit logging

```bash
# Enable audit log via server parameter
az mysql flexible-server parameter set \
  --resource-group myResourceGroup \
  --server-name myMySQLServer \
  --name audit_log_enabled \
  --value ON

# Configure what to audit
az mysql flexible-server parameter set \
  --resource-group myResourceGroup \
  --server-name myMySQLServer \
  --name audit_log_events \
  --value "CONNECTION,QUERY_DML,QUERY_DDL,QUERY_DCL"

# Exclude service accounts from audit (reduce noise)
az mysql flexible-server parameter set \
  --resource-group myResourceGroup \
  --server-name myMySQLServer \
  --name audit_log_exclude_users \
  --value "azure_superuser,azure_pg_admin"
```

### 5.2 Audit log events

| Event type     | What is logged                      | When to enable                      |
| -------------- | ----------------------------------- | ----------------------------------- |
| `CONNECTION`   | Connection and disconnection events | Always (compliance baseline)        |
| `QUERY_DML`    | SELECT, INSERT, UPDATE, DELETE      | When query auditing is required     |
| `QUERY_DDL`    | CREATE, ALTER, DROP                 | Always (track schema changes)       |
| `QUERY_DCL`    | GRANT, REVOKE                       | Always (track privilege changes)    |
| `GENERAL`      | All queries                         | Performance impact; use selectively |
| `TABLE_ACCESS` | Table-level access events           | Detailed access tracking            |

### 5.3 Streaming audit logs

```bash
# Send audit logs to Log Analytics workspace
az mysql flexible-server server-logs-download \
  --resource-group myResourceGroup \
  --server-name myMySQLServer

# Configure diagnostic settings for streaming
az monitor diagnostic-settings create \
  --resource /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DBforMySQL/flexibleServers/myMySQLServer \
  --name MySQLAuditLogs \
  --workspace <log-analytics-workspace-id> \
  --logs '[{"category": "MySqlAuditLogs", "enabled": true}]'
```

### 5.4 Audit logging comparison

| Source audit mechanism             | Azure equivalent                | Improvement                                      |
| ---------------------------------- | ------------------------------- | ------------------------------------------------ |
| MySQL audit log plugin (Community) | Azure audit log (built-in)      | No plugin management; always available           |
| MySQL Enterprise Audit             | Azure audit log (included free) | No additional licensing                          |
| Percona Audit Log                  | Azure audit log                 | Managed service; no plugin dependencies          |
| MariaDB Audit Plugin               | Azure audit log                 | Standardized format                              |
| Custom trigger-based auditing      | Azure audit log + Log Analytics | Centralized; no custom code                      |
| syslog forwarding                  | Azure Monitor + Log Analytics   | Structured queries, alerting, retention policies |

---

## 6. Azure Defender for MySQL

Azure Defender for open-source relational databases provides threat detection for Azure MySQL Flexible Server:

| Threat detected               | Description                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| **Brute force attacks**       | Excessive failed login attempts from single or distributed sources |
| **Anomalous database access** | Access from unusual locations, applications, or at unusual times   |
| **SQL injection attempts**    | Queries matching SQL injection patterns                            |
| **Anomalous query patterns**  | Unusual query volume, types, or data access patterns               |

```bash
# Enable Azure Defender
az security pricing create \
  --name OpenSourceRelationalDatabases \
  --tier Standard
```

---

## 7. Security migration checklist

- [ ] Export all MySQL users and privileges from source
- [ ] Plan Entra ID migration: map MySQL users to Entra ID users/groups
- [ ] Configure Entra ID admin on Azure MySQL Flexible Server
- [ ] Create Entra ID users/groups with appropriate MySQL privileges
- [ ] Configure managed identities for application authentication
- [ ] Update application connection strings for Entra ID token-based auth
- [ ] Verify TLS 1.2+ enforcement on target server
- [ ] Update client SSL certificates to Azure-issued CA certificates
- [ ] Configure VNet integration or Private Link for network isolation
- [ ] Remove any public firewall rules (or restrict to known IPs)
- [ ] Enable customer-managed keys (CMK) if required by compliance
- [ ] Enable audit logging with appropriate event categories
- [ ] Configure diagnostic settings to stream logs to Log Analytics
- [ ] Enable Azure Defender for threat detection
- [ ] Test application authentication end-to-end
- [ ] Decommission legacy MySQL user accounts after validation
- [ ] Document the new security model for operations team

---

**Next:** [Tutorial: DMS Online Migration](tutorial-dms-migration.md) | [Federal Migration Guide](federal-migration-guide.md) | [Data Migration](data-migration.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
