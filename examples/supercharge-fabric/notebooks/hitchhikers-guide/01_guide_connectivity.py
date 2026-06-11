# Fabric notebook source
# MAGIC %md
# MAGIC # 🧭 Hitchhiker's Guide — 01: Connectivity (Azure-native)
# MAGIC
# MAGIC > Everything that goes "how do I connect Loom to ___?". Each section
# MAGIC > is independent. **Look up the section you need; ignore the rest.**
# MAGIC >
# MAGIC > Every recipe below is **Azure-native by default** (Synapse, ADLS Gen2,
# MAGIC > Azure SQL, ADX, Data API Builder, ARM) and runs with no Microsoft
# MAGIC > Fabric capacity or workspace. Where a Fabric equivalent exists it is
# MAGIC > called out only as an **opt-in alternative**.
# MAGIC
# MAGIC | Section | Source / target |
# MAGIC |---|---|
# MAGIC | A | ADLS Gen2 |
# MAGIC | B | Amazon S3 |
# MAGIC | C | Google Cloud Storage |
# MAGIC | D | On-prem SQL Server (gateway) |
# MAGIC | E | Snowflake |
# MAGIC | F | Synapse Serverless SQL |
# MAGIC | G | Databricks Delta tables |
# MAGIC | H | Synapse dedicated SQL pool / warehouse (T-SQL endpoint) |
# MAGIC | I | Azure SQL Database |
# MAGIC | J | Lakehouse SQL endpoint (Synapse Serverless) |
# MAGIC | K | Azure Data Explorer (ADX) / KQL DB |
# MAGIC | L | GraphQL endpoint (Data API Builder) |
# MAGIC | M | Loom semantic model (Synapse tabular layer) |
# MAGIC | N | Azure Resource Manager (control plane) |
# MAGIC | O | Cosmos DB (Synapse Link CDC → ADLS) |
# MAGIC | P | PostgreSQL / MySQL (ADF CDC → ADLS) |

# COMMAND ----------

# MAGIC %md
# MAGIC ## A — ADLS Gen2
# MAGIC
# MAGIC ✅ **Best: workspace identity (no creds)** — give the workspace
# MAGIC identity Storage Blob Data Reader/Contributor on the account, then
# MAGIC just mount.

# COMMAND ----------

mssparkutils.fs.mount(
    "abfss://mycontainer@mystorageaccount.dfs.core.windows.net",
    "/mydata",
)
mssparkutils.fs.ls("/mydata")
# 🔗 https://learn.microsoft.com/en-us/azure/storage/blobs/data-lake-storage-introduction

# COMMAND ----------

# MAGIC %md
# MAGIC **Account key via Key Vault:**

# COMMAND ----------

account_key = mssparkutils.credentials.getSecret(
    "https://myvault.vault.azure.net/", "storage-account-key"
)
mssparkutils.fs.mount(
    "abfss://mycontainer@myaccount.dfs.core.windows.net",
    "/mydata",
    {"accountKey": account_key},
)

# COMMAND ----------

# MAGIC %md
# MAGIC **OAuth (no mount) — direct PySpark read:**

# COMMAND ----------

acct, tenant, client_id, client_secret = "myacct", "<tenant-id>", "<sp-id>", "<sp-secret>"
spark.conf.set(f"fs.azure.account.auth.type.{acct}.dfs.core.windows.net", "OAuth")
spark.conf.set(
    f"fs.azure.account.oauth.provider.type.{acct}.dfs.core.windows.net",
    "org.apache.hadoop.fs.azurebfs.oauth2.ClientCredsTokenProvider",
)
spark.conf.set(f"fs.azure.account.oauth2.client.id.{acct}.dfs.core.windows.net", client_id)
spark.conf.set(f"fs.azure.account.oauth2.client.secret.{acct}.dfs.core.windows.net", client_secret)
spark.conf.set(
    f"fs.azure.account.oauth2.client.endpoint.{acct}.dfs.core.windows.net",
    f"https://login.microsoftonline.com/{tenant}/oauth2/token",
)
df = spark.read.format("delta").load(f"abfss://c@{acct}.dfs.core.windows.net/path")

# COMMAND ----------

# MAGIC %md
# MAGIC ## B — Amazon S3
# MAGIC
# MAGIC Azure-native default: read the bucket directly with Spark and land it as
# MAGIC ADLS Gen2 Bronze Delta (Loom medallion default).

# COMMAND ----------
# Azure-native: ADLS Gen2 has no "shortcut" object — read the foreign store
# directly with Spark and land it as ADLS Gen2 Bronze Delta (Loom medallion
# default). Credentials come from Key Vault via the workspace UAMI.
from azure.identity import DefaultAzureCredential

cred = DefaultAzureCredential()  # workspace user-assigned managed identity
# S3-compatible source (Key Vault-backed access key, never inline):
spark.conf.set("fs.s3a.access.key", mssparkutils.credentials.getSecret("https://<kv>.vault.azure.net/", "s3-access-key"))
spark.conf.set("fs.s3a.secret.key", mssparkutils.credentials.getSecret("https://<kv>.vault.azure.net/", "s3-secret-key"))

s3_path  = "s3a://my-bucket/data/orders"
adls_dst = "abfss://bronze@{{ADLS_ACCOUNT}}.dfs.core.windows.net/landing/partner_s3"

(spark.read.parquet(s3_path)
      .write.format("delta").mode("append").save(adls_dst))
print(f"Loaded {s3_path} -> {adls_dst}")
# For scheduled, incremental copy use a Synapse/ADF copy activity instead.
# COMMAND ----------

# MAGIC %md
# MAGIC ## C — Google Cloud Storage

# COMMAND ----------
# Azure-native: read Google Cloud Storage directly with the GCS Hadoop
# connector and land it as ADLS Gen2 Bronze Delta (replaces a Fabric OneLake
# GCS shortcut — no shortcut/REST object exists in ADLS).
spark.conf.set("google.cloud.auth.service.account.enable", "true")
spark.conf.set("google.cloud.auth.service.account.json.keyfile", "/path/to/gcs-key.json")

gcs_path = "gs://gcs-mybucket/orders"
adls_dst = "abfss://bronze@{{ADLS_ACCOUNT}}.dfs.core.windows.net/landing/partner_gcs"

(spark.read.parquet(gcs_path)
      .write.format("delta").mode("append").save(adls_dst))
print(f"Loaded {gcs_path} -> {adls_dst}")
# COMMAND ----------

# MAGIC %md
# MAGIC ## D — On-prem SQL Server
# MAGIC
# MAGIC - Install the **Self-hosted Integration Runtime (SHIR)** in Synapse/ADF
# MAGIC   (the Azure-native gateway) on a host with line of sight to the source.
# MAGIC - For private VNet sources, use a **Managed VNet IR + Managed Private
# MAGIC   Endpoint** to the SQL Server, or Private Link / ExpressRoute / VPN.
# MAGIC - For continuous CDC, use a **Synapse/ADF mapping data flow or Change
# MAGIC   Data Capture copy** landing into ADLS Bronze Delta.
# MAGIC
# MAGIC 🔗 [create-self-hosted-integration-runtime](https://learn.microsoft.com/en-us/azure/data-factory/create-self-hosted-integration-runtime)
# MAGIC 🔗 [tutorial-incremental-copy-change-data-capture-feature-portal](https://learn.microsoft.com/en-us/azure/data-factory/tutorial-incremental-copy-change-data-capture-feature-portal)

# COMMAND ----------

# MAGIC %md
# MAGIC ## E — Snowflake
# MAGIC
# MAGIC Azure-native ways:
# MAGIC 1. **Spark connector** in a notebook for ad-hoc reads (below).
# MAGIC 2. **ADF/Synapse Snowflake connector + CDC copy** into ADLS Bronze Delta
# MAGIC    (recommended for scheduled, incremental replication).
# MAGIC 3. **Iceberg interop** — read Snowflake-managed Iceberg tables from Spark.
# MAGIC
# MAGIC 🔗 [connector-snowflake](https://learn.microsoft.com/en-us/azure/data-factory/connector-snowflake)

# COMMAND ----------

sf_secret = mssparkutils.credentials.getSecret("https://myvault.vault.azure.net/", "snowflake-pwd")
sfopts = {
  "sfURL": "myacct.snowflakecomputing.com",
  "sfUser": "LOOM_READER",
  "sfPassword": sf_secret,
  "sfDatabase": "ANALYTICS",
  "sfSchema": "PUBLIC",
  "sfWarehouse": "COMPUTE_WH",
}
df = (spark.read.format("snowflake").options(**sfopts).option("dbtable", "DIM_CUSTOMER").load())

# COMMAND ----------

# MAGIC %md
# MAGIC ## F — Synapse Serverless SQL pool
# MAGIC
# MAGIC The Loom lakehouse SQL endpoint **is** Synapse Serverless. Query the ADLS
# MAGIC Delta tables directly via `synapsesql`, or read the parquet/Delta path in
# MAGIC Spark and skip the SQL hop entirely.

# COMMAND ----------

# MAGIC %md
# MAGIC ## G — Databricks Delta tables
# MAGIC
# MAGIC | Source posture | Azure-native pattern |
# MAGIC |---|---|
# MAGIC | ADLS-managed Delta | **Direct ABFS read** with workspace identity / OAuth |
# MAGIC | Unity Catalog table | Read the underlying ADLS Delta path, or UC Delta Sharing |
# MAGIC | Scheduled replication | **ADF/Synapse copy** Databricks → ADLS Bronze Delta |
# MAGIC
# MAGIC 🔗 [databricks abfs access](https://learn.microsoft.com/en-us/azure/databricks/connect/storage/azure-storage)
# MAGIC
# MAGIC See tutorial 57 for end-to-end examples.

# COMMAND ----------

# MAGIC %md
# MAGIC ## H — Synapse dedicated SQL pool / warehouse from a notebook (T-SQL endpoint)
# MAGIC
# MAGIC Azure-native default: the Spark–Synapse connector (`synapsesql`) reads and
# MAGIC writes the dedicated SQL pool with AAD/workspace-identity auth — no
# MAGIC connection string, no Fabric.

# COMMAND ----------

# Azure-native default: Spark connector against the Synapse dedicated SQL pool.
df = spark.read.synapsesql("loom_warehouse.dbo.dim_customer")
# 🔗 https://learn.microsoft.com/en-us/azure/synapse-analytics/spark/synapse-spark-sql-pool-import-export

# Opt-in: pyodbc against the Synapse dedicated SQL endpoint with an AAD token.
import struct, pyodbc

token_bytes = mssparkutils.credentials.getToken(
    "https://database.windows.net/"
).encode("utf-16-le")
token_struct = struct.pack(f"<I{len(token_bytes)}s", len(token_bytes), token_bytes)
SQL_COPT_SS_ACCESS_TOKEN = 1256

conn_str = (
    "Driver={ODBC Driver 18 for SQL Server};"
    "Server=<synapse-workspace>.sql.azuresynapse.net,1433;"
    "Database=<dedicated-pool>;"
    "Encrypt=yes;TrustServerCertificate=no;"
)
cn = pyodbc.connect(conn_str, attrs_before={SQL_COPT_SS_ACCESS_TOKEN: token_struct})

# COMMAND ----------

# MAGIC %md
# MAGIC ## I — Azure SQL Database
# MAGIC
# MAGIC Azure-native equivalent of the Fabric SQL DB recipe. Use the Azure SQL
# MAGIC server endpoint with `ActiveDirectoryDefault` (workspace identity).

# COMMAND ----------

conn_str = (
    "Driver={ODBC Driver 18 for SQL Server};"
    "Server=<sql-server-name>.database.windows.net,1433;"
    "Database=<db>;"
    "Encrypt=yes;TrustServerCertificate=no;"
    "Authentication=ActiveDirectoryDefault;"
)
# After `az login` (locally) or in a notebook with workspace identity,
# ActiveDirectoryDefault reuses cached credentials. ODBC 18+ required.
# 🔗 https://learn.microsoft.com/en-us/azure/azure-sql/database/connect-query-python

# COMMAND ----------

# MAGIC %md
# MAGIC ## J — Lakehouse SQL endpoint
# MAGIC
# MAGIC The Loom lakehouse SQL endpoint is **Synapse Serverless SQL** over the
# MAGIC ADLS Delta tables. Use the same pyodbc pattern as H/I against
# MAGIC `<workspace>-ondemand.sql.azuresynapse.net`, or `spark.read.synapsesql`.

# COMMAND ----------

# MAGIC %md
# MAGIC ## K — Azure Data Explorer (ADX) / KQL DB

# COMMAND ----------

# Azure-native: ADX cluster (the Loom eventhouse/KQL backend). The Kusto Spark
# connector reads the cluster with an AAD/workspace-identity token.
kusto_token = mssparkutils.credentials.getToken("https://kusto.kusto.windows.net")
df = (
    spark.read
    .format("com.microsoft.kusto.spark.synapse.datasource")
    .option("accessToken", kusto_token)
    .option("kustoCluster", "https://<cluster>.<region>.kusto.windows.net")
    .option("kustoDatabase", "<db>")
    .option("kustoQuery", "T | take 10")
    .load()
)
# Or read the materialized Delta export directly from ADLS:
df = spark.read.format("delta").load(
    "abfss://eventhouse@{{ADLS_ACCOUNT}}.dfs.core.windows.net/<db>/Tables/MyTable"
)
# 🔗 https://learn.microsoft.com/en-us/azure/data-explorer/spark-connector

# COMMAND ----------

# MAGIC %md
# MAGIC ## L — GraphQL endpoint (Data API Builder)

# COMMAND ----------

import requests
from azure.identity import DefaultAzureCredential

# Azure-native: the Loom GraphQL surface is served by Data API Builder (DAB)
# over Synapse SQL / Azure SQL — hosted as a Container App. Authenticate with
# the workspace identity (Entra ID), not a Fabric/Power BI token.
cred = DefaultAzureCredential()
token = cred.get_token("api://<dab-app-id>/.default").token
endpoint = "https://<loom-dab>.azurecontainerapps.io/graphql"
query = "{ products(first: 5) { items { productId name listPrice } } }"
r = requests.post(endpoint, headers={"Authorization": f"Bearer {token}"}, json={"query": query})
r.json()
# 🔗 https://learn.microsoft.com/en-us/azure/data-api-builder/graphql

# COMMAND ----------

# MAGIC %md
# MAGIC ## M — Loom semantic model (Synapse tabular layer)

# COMMAND ----------

# Azure-native: the Loom semantic layer is a tabular model over the Synapse
# warehouse / lakehouse (no Power BI workspace). Read measures/tables through
# the Synapse SQL endpoint (the semantic layer's serving surface).
df = spark.read.synapsesql("loom_warehouse.semantic.customer_profitability")
# Or query the Loom semantic-model API: GET /api/items/semantic-model/<id>/tables
# 🔗 https://learn.microsoft.com/en-us/azure/analysis-services/analysis-services-overview

# COMMAND ----------

# MAGIC %md
# MAGIC ## N — Azure Resource Manager (control plane)

# COMMAND ----------
import requests
from azure.identity import DefaultAzureCredential

# Azure-native: list Synapse (Loom analytics) workspaces via Azure Resource
# Manager instead of Fabric workspaces.
cred  = DefaultAzureCredential()
token = cred.get_token("https://management.azure.com/.default").token
sub   = "<subscription-id>"
r = requests.get(
    f"https://management.azure.com/subscriptions/{sub}/providers/Microsoft.Synapse/workspaces?api-version=2021-06-01",
    headers={"Authorization": f"Bearer {token}"},
)
r.json()
# Azure RBAC for Synapse pipelines: Contributor / Synapse Contributor.
# COMMAND ----------

# MAGIC %md
# MAGIC ## O — Cosmos DB (Synapse Link CDC → ADLS)
# MAGIC
# MAGIC Enable **Azure Synapse Link** on the Cosmos DB account — the analytical
# MAGIC store lands as columnar data you query from Synapse Spark/SQL without
# MAGIC touching the transactional store (no RU burn). For a Delta projection,
# MAGIC run a Synapse/ADF copy from the analytical store into ADLS Bronze Delta.
# MAGIC
# MAGIC 🔗 [synapse-link](https://learn.microsoft.com/en-us/azure/cosmos-db/synapse-link)

# COMMAND ----------

# MAGIC %md
# MAGIC ## P — PostgreSQL / MySQL (ADF CDC → ADLS)
# MAGIC
# MAGIC - **Azure Database for PostgreSQL / MySQL** → ADF/Synapse CDC copy into
# MAGIC   ADLS Bronze Delta, or read directly with the Spark JDBC connector.
# MAGIC - **On-prem or generic PG/MySQL** → Self-hosted IR + ADF Change Data
# MAGIC   Capture copy.
# MAGIC
# MAGIC 🔗 [connector-azure-database-for-postgresql](https://learn.microsoft.com/en-us/azure/data-factory/connector-azure-database-for-postgresql),
# MAGIC [connector-azure-database-for-mysql](https://learn.microsoft.com/en-us/azure/data-factory/connector-azure-database-for-mysql)
