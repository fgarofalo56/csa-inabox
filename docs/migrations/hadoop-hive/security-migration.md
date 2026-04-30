# Security and Governance Migration: Ranger/Sentry to Purview + RBAC

**A comprehensive guide for migrating Hadoop security and governance services — Ranger, Sentry, Atlas, Kerberos, HDFS ACLs, and encryption — to their Azure equivalents.**

---

## Overview

Security and governance are often the most underestimated aspects of a Hadoop-to-Azure migration. Organizations that have spent years building Ranger policies, Kerberos configurations, Atlas lineage graphs, and HDFS ACL structures need a systematic approach to replicate those protections in Azure.

This guide covers:

1. Apache Ranger to Purview access policies + Unity Catalog
2. Apache Sentry to Purview (for legacy Sentry environments)
3. Apache Atlas to Microsoft Purview catalog
4. Kerberos to Entra ID and managed identities
5. HDFS ACLs to ADLS Gen2 ACLs
6. Encryption at rest and in transit equivalents

---

## 1. Apache Ranger to Purview + Unity Catalog + Azure RBAC

### Ranger architecture

Apache Ranger provides centralized policy management for Hadoop services:

```
Ranger Admin (web UI + policy store)
    ├── HDFS plugin (file/directory ACLs)
    ├── Hive plugin (database/table/column access)
    ├── HBase plugin (table/column family access)
    ├── Kafka plugin (topic access)
    ├── YARN plugin (queue access)
    ├── Knox plugin (topology access)
    └── Solr plugin (collection access)
```

Each plugin enforces policies at the service level and sends audit events back to Ranger.

### Azure security architecture

Azure distributes Ranger's responsibilities across multiple services:

```
Entra ID (identity and authentication)
    ├── Azure RBAC (subscription/resource-level access)
    ├── ADLS Gen2 ACLs (file/directory-level access)
    ├── Unity Catalog (table/column/row-level access in Databricks)
    ├── Purview access policies (data-aware access governance)
    ├── Event Hubs RBAC (topic/consumer group access)
    ├── Cosmos DB RBAC (container/item-level access)
    └── Azure Monitor (audit logging)
```

### Policy mapping: Ranger to Azure

| Ranger policy type | Azure equivalent | Configuration method |
|---|---|---|
| HDFS path-based access | ADLS Gen2 POSIX ACLs + Azure RBAC | `az storage fs access set` or Purview access policies |
| Hive database access | Unity Catalog schema permissions | `GRANT USE SCHEMA ON schema TO principal` |
| Hive table access | Unity Catalog table permissions | `GRANT SELECT ON TABLE table TO principal` |
| Hive column masking | Unity Catalog column masking | `ALTER TABLE ADD CONSTRAINT mask_ssn MASK mask_function` |
| Hive row filtering | Unity Catalog row filters | `ALTER TABLE ADD CONSTRAINT region_filter ROW FILTER filter_function` |
| HBase table access | Cosmos DB RBAC | Azure RBAC data plane roles |
| Kafka topic access | Event Hubs RBAC | Azure RBAC roles (Sender, Receiver) |
| YARN queue access | Databricks cluster policies | Cluster policy permissions |
| Tag-based policies | Purview classifications + policies | Purview sensitivity labels |

### Step-by-step: migrating a Ranger HDFS policy

**Ranger HDFS policy (before):**

```json
{
    "service": "hadoop-hdfs",
    "name": "data-engineering-team-access",
    "resources": {
        "path": {
            "values": ["/user/hive/warehouse/silver/*"],
            "isRecursive": true
        }
    },
    "policyItems": [
        {
            "groups": ["data-engineering"],
            "accesses": [
                {"type": "read", "isAllowed": true},
                {"type": "write", "isAllowed": true},
                {"type": "execute", "isAllowed": true}
            ]
        },
        {
            "groups": ["data-analysts"],
            "accesses": [
                {"type": "read", "isAllowed": true}
            ]
        }
    ]
}
```

**ADLS Gen2 ACL (after):**

```bash
# Create Entra ID groups (if not already in Entra)
az ad group create --display-name "data-engineering" --mail-nickname "data-engineering"
az ad group create --display-name "data-analysts" --mail-nickname "data-analysts"

# Get group object IDs
DE_GROUP_ID=$(az ad group show --group "data-engineering" --query id -o tsv)
DA_GROUP_ID=$(az ad group show --group "data-analysts" --query id -o tsv)

# Set ACLs on ADLS Gen2 path
# data-engineering: rwx (read + write + execute)
az storage fs access set \
  --account-name datalake \
  --file-system silver \
  --path hive/warehouse \
  --acl "group:${DE_GROUP_ID}:rwx,default:group:${DE_GROUP_ID}:rwx"

# data-analysts: r-x (read + execute, no write)
az storage fs access set \
  --account-name datalake \
  --file-system silver \
  --path hive/warehouse \
  --acl "group:${DA_GROUP_ID}:r-x,default:group:${DA_GROUP_ID}:r-x"
```

### Step-by-step: migrating a Ranger Hive policy to Unity Catalog

**Ranger Hive policy (before):**

```json
{
    "service": "hadoop-hive",
    "name": "analyst-silver-access",
    "resources": {
        "database": {"values": ["silver"]},
        "table": {"values": ["*"]},
        "column": {"values": ["*"]}
    },
    "policyItems": [
        {
            "groups": ["data-analysts"],
            "accesses": [
                {"type": "select", "isAllowed": true}
            ]
        }
    ],
    "denyPolicyItems": [
        {
            "groups": ["data-analysts"],
            "accesses": [{"type": "select", "isAllowed": true}],
            "resources": {
                "database": {"values": ["silver"]},
                "table": {"values": ["*"]},
                "column": {"values": ["ssn", "credit_card"]}
            }
        }
    ]
}
```

**Unity Catalog (after):**

```sql
-- Grant read access to silver schema
GRANT USE CATALOG ON CATALOG main TO `data-analysts`;
GRANT USE SCHEMA ON SCHEMA main.silver TO `data-analysts`;
GRANT SELECT ON SCHEMA main.silver TO `data-analysts`;

-- Column masking for sensitive columns (instead of deny policy)
CREATE FUNCTION main.silver.mask_ssn(ssn STRING)
RETURNS STRING
RETURN CASE
    WHEN is_member('data-engineering') THEN ssn
    ELSE CONCAT('***-**-', RIGHT(ssn, 4))
END;

ALTER TABLE main.silver.customers
ALTER COLUMN ssn SET MASK main.silver.mask_ssn;

-- Row filtering (restrict by region)
CREATE FUNCTION main.silver.region_filter(region STRING)
RETURNS BOOLEAN
RETURN CASE
    WHEN is_member('data-engineering') THEN TRUE
    WHEN is_member('east-analysts') AND region = 'east' THEN TRUE
    ELSE FALSE
END;

ALTER TABLE main.silver.customers
SET ROW FILTER main.silver.region_filter ON (region);
```

---

## 2. Apache Sentry to Purview

Sentry was Cloudera's original authorization framework before the Cloudera-Hortonworks merger brought Ranger into CDP. If your environment uses Sentry:

| Sentry concept | Azure equivalent |
|---|---|
| Sentry roles | Entra ID groups + Unity Catalog roles |
| Sentry privileges (SELECT, INSERT, ALL) | Unity Catalog GRANT statements |
| Sentry server-level privilege | Catalog-level GRANT in Unity Catalog |
| Sentry database-level privilege | Schema-level GRANT in Unity Catalog |
| Sentry table-level privilege | Table-level GRANT in Unity Catalog |
| Sentry column-level privilege | Column masking in Unity Catalog |

The migration from Sentry is identical to Ranger in practice. Export Sentry roles and privileges, map to Unity Catalog GRANT statements.

---

## 3. Apache Atlas to Microsoft Purview

### Atlas capabilities and Purview equivalents

| Atlas capability | Purview equivalent | Migration approach |
|---|---|---|
| Type system (entity types) | Asset types (auto-discovered) | Purview auto-discovers most asset types |
| Entity catalog | Asset inventory | Purview scanners auto-catalog ADLS, Databricks, SQL |
| Classifications (tags) | Sensitivity labels + classifications | Purview auto-classifies PII, PHI, financial data |
| Glossary terms | Business glossary | Manual migration or re-creation in Purview |
| Lineage (Hive, Spark) | Lineage (ADF, Databricks, Fabric native) | Automatic with Azure services; no manual setup |
| REST API | Purview REST API + Python SDK | API patterns differ but functionality equivalent |
| Audit log | Azure Monitor + Purview audit | Built-in to Azure |

### Migrating Atlas glossary terms

```python
# Export Atlas glossary terms
import requests

atlas_url = "http://atlas-server:21000/api/atlas/v2"
headers = {"Content-Type": "application/json"}

# Get all glossary terms from Atlas
glossary = requests.get(f"{atlas_url}/glossary", headers=headers, auth=("admin", "password"))
terms = glossary.json()

# Import into Purview
from azure.purview.catalog import PurviewCatalogClient
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
purview_client = PurviewCatalogClient(
    endpoint="https://purview-account.purview.azure.com",
    credential=credential
)

for term in terms:
    purview_client.glossary.create_glossary_term({
        "name": term["name"],
        "longDescription": term.get("longDescription", ""),
        "abbreviation": term.get("abbreviation", ""),
        "status": "Approved",
        "anchor": {"glossaryGuid": target_glossary_guid}
    })
```

### Lineage migration

Atlas lineage is automatically replaced when you use Azure-native services:

| Data movement | Atlas lineage source | Purview lineage source |
|---|---|---|
| ETL pipeline | Hive hook, Spark Atlas connector | ADF native lineage (automatic) |
| Spark transformation | Spark Atlas connector | Databricks Unity Catalog lineage (automatic) |
| SQL transformation | Hive hook | Fabric SQL endpoint lineage (automatic) |
| Data copy | Custom Atlas entities | ADF copy activity lineage (automatic) |

**Key insight:** You do not need to "migrate" lineage. Azure services emit lineage events natively to Purview. Once workloads run on Azure, lineage builds itself automatically.

---

## 4. Kerberos to Entra ID and managed identities

### Kerberos in Hadoop

Hadoop uses Kerberos for authentication:

- Users authenticate via `kinit` (obtain TGT from KDC)
- Services authenticate via keytabs (stored credentials)
- Cross-realm trusts enable AD integration
- Every service (HDFS, YARN, Hive, HBase) requires a Kerberos principal

### Entra ID in Azure

| Kerberos concept | Entra ID equivalent |
|---|---|
| KDC (Key Distribution Center) | Entra ID (cloud identity provider) |
| Kerberos principal (`user@REALM`) | Entra user principal (`user@domain.com`) |
| Service principal (keytab) | Managed identity or Entra app registration |
| `kinit` (get TGT) | `az login` or token acquisition via MSAL |
| Keytab (stored credential) | Managed identity (no credential to manage) |
| Cross-realm trust | Entra ID federation / hybrid identity |
| Kerberos ticket (TGT) | OAuth2 access token |
| Kerberos service ticket | OAuth2 scope-based access token |

### Service-to-service authentication

```python
# BEFORE: Kerberos service authentication
# 1. Create keytab: ktutil add_entry -password -p spark/host@REALM -k 1 -e aes256-cts
# 2. Distribute keytab to all nodes
# 3. Configure Spark:
#    spark.yarn.keytab = /etc/security/keytabs/spark.service.keytab
#    spark.yarn.principal = spark/hostname@REALM

# AFTER: Managed identity authentication (zero credentials)
# 1. Enable managed identity on Databricks workspace (done at provisioning)
# 2. Grant managed identity access to ADLS Gen2:
#    az role assignment create --role "Storage Blob Data Contributor" \
#      --assignee-object-id <managed-identity-oid> \
#      --scope /subscriptions/.../storageAccounts/datalake

# 3. Spark configuration (Databricks):
spark.conf.set(
    "fs.azure.account.auth.type.datalake.dfs.core.windows.net",
    "OAuth"
)
spark.conf.set(
    "fs.azure.account.oauth.provider.type.datalake.dfs.core.windows.net",
    "org.apache.hadoop.fs.azurebfs.oauth2.MsiTokenProvider"
)
# No keytab, no credential rotation, no cross-realm trust configuration.
```

### User authentication

| Hadoop pattern | Azure pattern |
|---|---|
| `kinit user@REALM` → access Hive | SSO via Entra → access Databricks SQL |
| LDAP/AD-backed Kerberos | Entra ID (cloud-native or hybrid with AD Connect) |
| Kerberos ticket renewal (cron job) | OAuth2 token refresh (automatic) |
| Keytab distribution to edge nodes | Not needed — managed identities are instance-bound |

---

## 5. HDFS ACLs to ADLS Gen2 ACLs

### HDFS ACL model

```bash
# HDFS ACL example
hdfs dfs -getfacl /user/hive/warehouse/silver/orders
# Output:
# owner: hive
# group: hadoop
# user::rwx
# group::r-x
# other::---
# user:alice:rwx
# group:data-engineering:rwx
# group:data-analysts:r-x
# default:user::rwx
# default:group::r-x
# default:other::---
```

### ADLS Gen2 ACL model

ADLS Gen2 supports the same POSIX ACL model:

```bash
# ADLS Gen2 ACL example (identical semantics)
az storage fs access show \
  --account-name datalake \
  --file-system silver \
  --path orders

# Set ACLs (identical POSIX syntax)
az storage fs access set \
  --account-name datalake \
  --file-system silver \
  --path orders \
  --acl "user::rwx,group::r-x,other::---,user:${ALICE_OID}:rwx,group:${DE_OID}:rwx,group:${DA_OID}:r-x,default:user::rwx,default:group::r-x,default:other::---"
```

### Automated ACL migration script

```python
import subprocess
import json

def migrate_hdfs_acls_to_adls(hdfs_path, adls_account, adls_filesystem, adls_path, user_mapping):
    """
    Migrate HDFS ACLs to ADLS Gen2 ACLs.

    user_mapping: dict mapping Hadoop usernames/groups to Entra OIDs
    Example: {"alice": "oid-123", "data-engineering": "oid-456"}
    """

    # Get HDFS ACLs
    result = subprocess.run(
        ["hdfs", "dfs", "-getfacl", hdfs_path],
        capture_output=True, text=True
    )

    acl_entries = []
    for line in result.stdout.strip().split("\n"):
        if line.startswith("#") or not line.strip():
            continue

        parts = line.split(":")
        if len(parts) == 3:
            acl_type, name, perms = parts

            if name and name in user_mapping:
                # Map Hadoop user/group to Entra OID
                name = user_mapping[name]

            acl_entries.append(f"{acl_type}:{name}:{perms}")

    # Set ADLS ACLs
    acl_string = ",".join(acl_entries)
    subprocess.run([
        "az", "storage", "fs", "access", "set",
        "--account-name", adls_account,
        "--file-system", adls_filesystem,
        "--path", adls_path,
        "--acl", acl_string
    ])
```

### ACL best practices for Azure

| Hadoop practice | Azure recommendation |
|---|---|
| Per-user HDFS ACLs | Prefer Entra ID groups over individual user ACLs |
| Deep directory ACLs | Use default ACLs to propagate permissions to child objects |
| Ranger + HDFS ACLs | Prefer Unity Catalog for table-level + ADLS ACLs for storage-level |
| Complex ACL hierarchies | Simplify: use Azure RBAC for broad access + ACLs only for fine-grained |

---

## 6. Encryption at rest and in transit

### Hadoop encryption

| Feature | Hadoop implementation | Configuration effort |
|---|---|---|
| Encryption at rest (HDFS) | HDFS Transparent Encryption + Hadoop KMS | High: KMS setup, EZ creation, key rotation |
| Encryption at rest (HBase) | HFile encryption | High: per-table configuration |
| Encryption in transit | SASL/TLS on each service | High: certificate management across all nodes |
| Key management | Hadoop KMS or Ranger KMS | High: key rotation, ACLs, backup |

### Azure encryption

| Feature | Azure implementation | Configuration effort |
|---|---|---|
| Encryption at rest (storage) | **Default: enabled** (Microsoft-managed keys) | Zero — always on |
| Encryption at rest (CMK) | Azure Key Vault integration | Low: create Key Vault, assign CMK |
| Encryption at rest (Cosmos DB) | **Default: enabled** | Zero — always on |
| Encryption in transit | **Default: TLS 1.2+** on all services | Zero — always on |
| Key management | Azure Key Vault | Low: Key Vault is managed service |
| Key rotation | Automatic (Microsoft-managed) or scheduled (CMK) | Low |
| Double encryption | Infrastructure encryption option | Low: enable at account creation |

### Encryption comparison summary

```
Hadoop:
  - Encryption at rest: OPTIONAL, requires manual KMS setup
  - Encryption in transit: OPTIONAL, requires manual TLS configuration per service
  - Key management: Manual (Hadoop KMS / Ranger KMS)
  - Effort: High (weeks of configuration)

Azure:
  - Encryption at rest: DEFAULT ON, zero configuration
  - Encryption in transit: DEFAULT ON, zero configuration
  - Key management: Azure Key Vault (managed)
  - Effort: Zero for defaults, Low for customer-managed keys
```

---

## Migration checklist

- [ ] **Inventory Ranger policies:** Export all policies via Ranger Admin API
- [ ] **Map Hadoop users/groups to Entra ID:** Ensure all principals exist in Entra
- [ ] **Migrate HDFS ACLs to ADLS Gen2:** Script automated migration
- [ ] **Migrate Ranger Hive policies to Unity Catalog:** Convert to GRANT statements
- [ ] **Migrate Ranger HBase policies to Cosmos DB RBAC:** Map to data plane roles
- [ ] **Migrate Ranger Kafka policies to Event Hubs RBAC:** Map to Sender/Receiver roles
- [ ] **Migrate Atlas glossary to Purview:** Export and re-import terms
- [ ] **Configure Purview scanners:** Register ADLS, Databricks, Cosmos DB as sources
- [ ] **Decommission Kerberos dependencies:** Replace with Entra ID + managed identities
- [ ] **Verify encryption:** Confirm at-rest and in-transit encryption on all Azure resources
- [ ] **Validate audit logging:** Confirm Azure Monitor captures all access events
- [ ] **Test access controls:** Verify each user group has correct permissions in Azure

---

## Common pitfalls

| Pitfall | Mitigation |
|---|---|
| Assuming Azure RBAC replaces all Ranger policies | Azure RBAC is resource-level; Unity Catalog handles table/column-level |
| Not mapping Hadoop groups to Entra groups | Create Entra groups before migration; use AD Connect for hybrid |
| Forgetting default ACLs on ADLS directories | New files inherit default ACLs; set defaults on parent directories |
| Losing Ranger audit trail | Export Ranger audit logs before decommission; archive to ADLS |
| Ignoring service account credentials | Replace all service keytabs with managed identities |
| Under-testing column masking and row filters | Test with multiple user roles before cutover |

---

## Related

- [Feature Mapping](feature-mapping-complete.md) — all component mappings
- [HDFS Migration](hdfs-migration.md) — storage migration (ACLs are part of this)
- [HBase Migration](hbase-migration.md) — Cosmos DB RBAC details
- [Migration Hub](index.md) — full migration center
- [ADR 0006 — Purview over Atlas](../../adr/0006-purview-over-atlas.md)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Feature Mapping](feature-mapping-complete.md) | [HDFS Migration](hdfs-migration.md) | [Migration Hub](index.md)
