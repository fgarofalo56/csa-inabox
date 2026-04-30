# Tutorial: Managed Identity for Zero Stored Secrets

**Status:** Authored 2026-04-30
**Audience:** Application Developers, Platform Engineers, Database Administrators
**Purpose:** Hands-on tutorial for replacing HashiCorp Vault dynamic database credentials with Azure managed identity -- achieving zero stored secrets for Azure SQL, PostgreSQL, and Cosmos DB

---

## Prerequisites

- **Azure subscription** with Contributor role
- **Azure CLI** 2.60+
- **Python** 3.9+ (for application examples)
- **An existing Azure database** (SQL, PostgreSQL, or Cosmos DB)
- **An application workload** running on App Service, AKS, or Azure VM

---

## Part 1: Azure SQL Database -- Zero Password Access

### Step 1: Create a user-assigned managed identity

```bash
# Create resource group (if needed)
az group create --name rg-mi-demo --location eastus2

# Create user-assigned managed identity
az identity create \
  --name mi-webapp-sql \
  --resource-group rg-mi-demo \
  --location eastus2

# Store the client ID and principal ID for later use
MI_CLIENT_ID=$(az identity show \
  --name mi-webapp-sql \
  --resource-group rg-mi-demo \
  --query clientId -o tsv)

MI_PRINCIPAL_ID=$(az identity show \
  --name mi-webapp-sql \
  --resource-group rg-mi-demo \
  --query principalId -o tsv)

MI_RESOURCE_ID=$(az identity show \
  --name mi-webapp-sql \
  --resource-group rg-mi-demo \
  --query id -o tsv)

echo "Client ID: $MI_CLIENT_ID"
echo "Principal ID: $MI_PRINCIPAL_ID"
```

### Step 2: Configure Azure SQL for Entra-only authentication

```bash
# Set your Entra ID user or group as the SQL admin
ADMIN_OID=$(az ad signed-in-user show --query id -o tsv)
ADMIN_UPN=$(az ad signed-in-user show --query userPrincipalName -o tsv)

# Update SQL server to use Entra-only authentication
az sql server ad-admin create \
  --server sql-prod \
  --resource-group rg-mi-demo \
  --display-name "$ADMIN_UPN" \
  --object-id "$ADMIN_OID"

# Disable SQL authentication (Entra-only mode)
az sql server ad-only-auth enable \
  --server sql-prod \
  --resource-group rg-mi-demo

echo "SQL Server configured for Entra-only authentication"
```

### Step 3: Grant database access to the managed identity

Connect to the database as the Entra admin and run:

```sql
-- Create a database user mapped to the managed identity
CREATE USER [mi-webapp-sql] FROM EXTERNAL PROVIDER;

-- Grant appropriate database roles
ALTER ROLE db_datareader ADD MEMBER [mi-webapp-sql];
ALTER ROLE db_datawriter ADD MEMBER [mi-webapp-sql];

-- Verify the user was created
SELECT name, type_desc, authentication_type_desc
FROM sys.database_principals
WHERE name = 'mi-webapp-sql';
```

### Step 4: Assign managed identity to your application

=== "App Service"

    ```bash
    az webapp identity assign \
      --name webapp-prod \
      --resource-group rg-app \
      --identities $MI_RESOURCE_ID
    ```

=== "AKS (workload identity)"

    ```bash
    # Create federated credential for AKS workload identity
    AKS_OIDC_ISSUER=$(az aks show \
      --name aks-prod \
      --resource-group rg-aks \
      --query oidcIssuerProfile.issuerUrl -o tsv)

    az identity federated-credential create \
      --name fc-webapp-sql \
      --identity-name mi-webapp-sql \
      --resource-group rg-mi-demo \
      --issuer "$AKS_OIDC_ISSUER" \
      --subject system:serviceaccount:app-namespace:webapp-sa
    ```

=== "Azure VM"

    ```bash
    az vm identity assign \
      --name vm-app-prod \
      --resource-group rg-vm \
      --identities $MI_RESOURCE_ID
    ```

### Step 5: Update application code

**Before (Vault dynamic secrets):**

```python
import hvac
import pyodbc

# Authenticate to Vault
vault = hvac.Client(url='https://vault:8200')
vault.auth.approle.login(role_id='xxx', secret_id='yyy')

# Get dynamic SQL credentials
creds = vault.secrets.database.generate_credentials('webapp-sql-role')
username = creds['data']['username']
password = creds['data']['password']

# Connect with Vault-generated credentials
conn_str = (
    f"DRIVER={{ODBC Driver 18 for SQL Server}};"
    f"SERVER=sql-prod.database.windows.net;"
    f"DATABASE=appdb;"
    f"UID={username};"
    f"PWD={password};"
    f"Encrypt=yes;"
)
conn = pyodbc.connect(conn_str)
```

**After (managed identity):**

```python
from azure.identity import DefaultAzureCredential
import pyodbc
import struct

# Get token using managed identity (no secrets anywhere)
credential = DefaultAzureCredential(
    managed_identity_client_id="<MI_CLIENT_ID>"  # Optional: specify which MI
)
token = credential.get_token("https://database.windows.net/.default")

# Build connection with token
token_bytes = token.token.encode("UTF-16-LE")
token_struct = struct.pack(f'<I{len(token_bytes)}s', len(token_bytes), token_bytes)
SQL_COPT_SS_ACCESS_TOKEN = 1256

conn = pyodbc.connect(
    "DRIVER={ODBC Driver 18 for SQL Server};"
    "SERVER=sql-prod.database.windows.net;"
    "DATABASE=appdb;"
    "Encrypt=yes;",
    attrs_before={SQL_COPT_SS_ACCESS_TOKEN: token_struct}
)

# Execute a query to verify
cursor = conn.cursor()
cursor.execute("SELECT CURRENT_USER AS connected_as")
row = cursor.fetchone()
print(f"Connected as: {row.connected_as}")  # Should print: mi-webapp-sql
```

### Step 6: Test the connection

```python
#!/usr/bin/env python3
"""Test managed identity SQL connection."""
from azure.identity import DefaultAzureCredential
import pyodbc
import struct

SERVER = "sql-prod.database.windows.net"
DATABASE = "appdb"

print(f"Testing connection to {SERVER}/{DATABASE}...")

try:
    credential = DefaultAzureCredential()
    token = credential.get_token("https://database.windows.net/.default")
    print(f"Token acquired (expires: {token.expires_on})")

    token_bytes = token.token.encode("UTF-16-LE")
    token_struct = struct.pack(f'<I{len(token_bytes)}s', len(token_bytes), token_bytes)

    conn = pyodbc.connect(
        f"DRIVER={{ODBC Driver 18 for SQL Server}};"
        f"SERVER={SERVER};"
        f"DATABASE={DATABASE};"
        f"Encrypt=yes;",
        attrs_before={1256: token_struct}
    )

    cursor = conn.cursor()
    cursor.execute("SELECT CURRENT_USER AS username, @@VERSION AS version")
    row = cursor.fetchone()
    print(f"Connected as: {row.username}")
    print(f"SQL Server: {row.version[:50]}...")
    print("SUCCESS: Managed identity connection works.")

    conn.close()
except Exception as e:
    print(f"FAILED: {e}")
```

---

## Part 2: Azure Database for PostgreSQL -- Zero Password Access

### Step 1: Enable Entra authentication on PostgreSQL

```bash
# Enable Entra authentication
az postgres flexible-server parameter set \
  --server pg-prod \
  --resource-group rg-mi-demo \
  --name azure.extensions \
  --value pgaadauth

# Set Entra admin
az postgres flexible-server ad-admin create \
  --server pg-prod \
  --resource-group rg-mi-demo \
  --display-name "$ADMIN_UPN" \
  --object-id "$ADMIN_OID" \
  --type User

# Optionally disable password authentication entirely
az postgres flexible-server parameter set \
  --server pg-prod \
  --resource-group rg-mi-demo \
  --name password_encryption \
  --value off
```

### Step 2: Create PostgreSQL role for managed identity

Connect as the Entra admin using a token:

```bash
# Get token for PostgreSQL
export PGPASSWORD=$(az account get-access-token \
  --resource-type oss-rdbms \
  --query accessToken -o tsv)

psql "host=pg-prod.postgres.database.azure.com \
  port=5432 \
  dbname=appdb \
  user=$ADMIN_UPN \
  sslmode=require"
```

Then run:

```sql
-- Create Entra role for the managed identity
SELECT * FROM pgaadauth_create_principal('mi-webapp-sql', false, false);

-- Grant permissions
GRANT CONNECT ON DATABASE appdb TO "mi-webapp-sql";
GRANT USAGE ON SCHEMA public TO "mi-webapp-sql";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "mi-webapp-sql";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "mi-webapp-sql";

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "mi-webapp-sql";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO "mi-webapp-sql";

-- Verify
SELECT * FROM pgaadauth_list_principals();
```

### Step 3: Update application code

```python
from azure.identity import DefaultAzureCredential
import psycopg2

credential = DefaultAzureCredential()
token = credential.get_token("https://ossrdbms-aad.database.windows.net/.default")

conn = psycopg2.connect(
    host="pg-prod.postgres.database.azure.com",
    port=5432,
    database="appdb",
    user="mi-webapp-sql",     # Managed identity name
    password=token.token,     # Token as password
    sslmode="require"
)

cursor = conn.cursor()
cursor.execute("SELECT current_user, version()")
row = cursor.fetchone()
print(f"Connected as: {row[0]}")
print(f"PostgreSQL: {row[1][:50]}...")
```

### Token refresh for long-running connections

```python
from azure.identity import DefaultAzureCredential
import psycopg2
import time

class ManagedIdentityPgConnection:
    """PostgreSQL connection with automatic token refresh."""

    def __init__(self, host, database, identity_name, mi_client_id=None):
        self.host = host
        self.database = database
        self.identity_name = identity_name
        self.credential = DefaultAzureCredential(
            managed_identity_client_id=mi_client_id
        )
        self._conn = None
        self._token_expires = 0

    def get_connection(self):
        """Get or refresh the database connection."""
        now = time.time()
        if self._conn is None or now >= self._token_expires - 300:
            # Token expired or will expire in 5 minutes -- refresh
            if self._conn:
                self._conn.close()

            token = self.credential.get_token(
                "https://ossrdbms-aad.database.windows.net/.default"
            )
            self._token_expires = token.expires_on

            self._conn = psycopg2.connect(
                host=self.host,
                port=5432,
                database=self.database,
                user=self.identity_name,
                password=token.token,
                sslmode="require"
            )
        return self._conn

# Usage
pg = ManagedIdentityPgConnection(
    host="pg-prod.postgres.database.azure.com",
    database="appdb",
    identity_name="mi-webapp-sql"
)
conn = pg.get_connection()
```

---

## Part 3: Azure Cosmos DB -- Zero Password Access

### Step 1: Enable Entra RBAC on Cosmos DB

```bash
# Disable key-based authentication (Entra-only)
az cosmosdb update \
  --name cosmos-prod \
  --resource-group rg-mi-demo \
  --disable-key-based-metadata-write-access true

# Assign the built-in "Cosmos DB Built-in Data Contributor" role
# to the managed identity
az cosmosdb sql role assignment create \
  --account-name cosmos-prod \
  --resource-group rg-mi-demo \
  --role-definition-id "00000000-0000-0000-0000-000000000002" \
  --principal-id "$MI_PRINCIPAL_ID" \
  --scope "/dbs/appdb"

echo "Cosmos DB configured for Entra RBAC with managed identity"
```

### Step 2: Update application code

**Before (Vault-stored primary key):**

```python
import hvac
from azure.cosmos import CosmosClient

vault = hvac.Client(url='https://vault:8200')
vault.auth.approle.login(role_id='xxx', secret_id='yyy')
secret = vault.secrets.kv.v2.read_secret_version(path='cosmos/primary-key')
primary_key = secret['data']['data']['key']

client = CosmosClient(
    url='https://cosmos-prod.documents.azure.com:443/',
    credential=primary_key
)
```

**After (managed identity):**

```python
from azure.identity import DefaultAzureCredential
from azure.cosmos import CosmosClient

credential = DefaultAzureCredential()

client = CosmosClient(
    url='https://cosmos-prod.documents.azure.com:443/',
    credential=credential  # Managed identity -- no key needed
)

database = client.get_database_client('appdb')
container = database.get_container_client('items')

# Query data
items = list(container.query_items(
    query="SELECT * FROM c WHERE c.category = @cat",
    parameters=[{"name": "@cat", "value": "electronics"}],
    enable_cross_partition_query=True
))
print(f"Found {len(items)} items")
```

---

## Part 4: AKS workload identity integration

For applications running on AKS, workload identity provides managed identity access without VM-level identity assignment.

### Step 1: Configure AKS cluster

```bash
# Enable workload identity on existing cluster
az aks update \
  --name aks-prod \
  --resource-group rg-aks \
  --enable-oidc-issuer \
  --enable-workload-identity
```

### Step 2: Create Kubernetes service account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
    name: webapp-sa
    namespace: app-namespace
    annotations:
        azure.workload.identity/client-id: "<MI_CLIENT_ID>"
    labels:
        azure.workload.identity/use: "true"
```

### Step 3: Deploy application

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
    name: webapp
    namespace: app-namespace
spec:
    replicas: 3
    selector:
        matchLabels:
            app: webapp
    template:
        metadata:
            labels:
                app: webapp
                azure.workload.identity/use: "true" # Required label
        spec:
            serviceAccountName: webapp-sa # Must match federated credential
            containers:
                - name: webapp
                  image: myregistry.azurecr.io/webapp:latest
                  env:
                      - name: DATABASE_HOST
                        value: "sql-prod.database.windows.net"
                      - name: DATABASE_NAME
                        value: "appdb"
                      # No DB_PASSWORD env var needed
                      # Azure Identity SDK will use workload identity automatically
```

### Step 4: Application code remains the same

The application code using `DefaultAzureCredential` works identically in AKS with workload identity, App Service with managed identity, or local development with `az login`.

```python
from azure.identity import DefaultAzureCredential

# This single line works everywhere:
# - Local dev: uses az login / Visual Studio / IntelliJ credentials
# - App Service: uses system-assigned or user-assigned managed identity
# - AKS: uses workload identity (OIDC federation)
# - Azure VM: uses managed identity via IMDS
credential = DefaultAzureCredential()
```

---

## Validation checklist

After completing the migration for each database:

- [ ] Managed identity is created and assigned to the application resource
- [ ] Entra admin is configured on the database server
- [ ] Database user/role is created for the managed identity
- [ ] Password authentication is disabled on the database (Entra-only)
- [ ] Application connects successfully using `DefaultAzureCredential`
- [ ] No connection strings, passwords, or keys exist in application configuration
- [ ] No Vault Agent sidecar or Vault SDK references remain in application code
- [ ] Vault database engine role for this application can be decommissioned
- [ ] Application works in local development (via `az login`)
- [ ] Application works in staging and production (via managed identity)
- [ ] Monitoring confirms managed identity sign-ins in Entra ID logs
- [ ] Database audit logs show managed identity authentication

---

## Troubleshooting

| Issue                                                               | Solution                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `AADSTS700024: Client assertion is not within its valid time range` | Clock skew on the application host; sync NTP                                                                                    |
| `Login failed for user '<token-identified principal>'`              | Ensure `CREATE USER [mi-name] FROM EXTERNAL PROVIDER` was run in the correct database                                           |
| `DefaultAzureCredential` fails locally                              | Run `az login` or set `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` env vars                                                            |
| Token acquisition timeout in AKS                                    | Verify `azure.workload.identity/use: "true"` label on pod and `azure.workload.identity/client-id` annotation on service account |
| `pgaadauth_create_principal` function not found                     | Enable the `pgaadauth` extension: `CREATE EXTENSION pgaadauth;`                                                                 |
| Cosmos DB `Forbidden` error                                         | Verify the role assignment scope matches the database path (`/dbs/appdb`)                                                       |

---

## Related resources

- **Dynamic secrets migration guide:** [Dynamic Secrets Migration](dynamic-secrets-migration.md)
- **Secrets migration:** [Secrets Migration Guide](secrets-migration.md)
- **Best practices:** [Best Practices](best-practices.md)
- **Microsoft Learn:**
    - [Managed identity overview](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/overview)
    - [Azure SQL + managed identity](https://learn.microsoft.com/azure/azure-sql/database/authentication-azure-ad-user-assigned-managed-identity)
    - [PostgreSQL + Entra auth](https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-configure-sign-in-azure-ad-authentication)
    - [Cosmos DB + Entra RBAC](https://learn.microsoft.com/azure/cosmos-db/how-to-setup-rbac)
    - [AKS workload identity](https://learn.microsoft.com/azure/aks/workload-identity-overview)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
