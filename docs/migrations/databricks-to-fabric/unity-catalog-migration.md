# Unity Catalog Migration — Databricks to Fabric (OneLake + Purview)

**Status:** Authored 2026-04-30
**Audience:** Data governance leads, platform engineers, and security teams migrating Unity Catalog metadata, access controls, and lineage to Microsoft Fabric and Purview.
**Scope:** Catalog/schema/table namespace mapping, external location migration, access control translation, lineage preservation, data sharing patterns, and governance gap analysis.

---

## 1. Overview

Unity Catalog (UC) is Databricks' centralized governance layer. It provides:

- Three-level namespace: `catalog.schema.table`
- Fine-grained access control (table, column, row level)
- Data lineage tracking
- Delta Sharing for cross-organization data access
- Managed and external storage locations
- Data classification via tags

Fabric does **not** have a direct Unity Catalog equivalent. Instead, governance is distributed across:

- **OneLake** -- tenant-wide data lake with workspace-level organization
- **Fabric workspace roles** -- Admin, Member, Contributor, Viewer
- **Lakehouse/Warehouse metadata** -- table-level catalog
- **Microsoft Purview** -- classification, lineage, sensitivity labels, data governance
- **Entra ID (Azure AD)** -- authentication and authorization

This migration is the most complex part of moving from Databricks to Fabric. Plan carefully and document every mapping.

---

## 2. Namespace mapping

### 2.1 Unity Catalog hierarchy

```
Unity Catalog Metastore (account-level)
  └── Catalog (e.g., "production", "development")
        └── Schema (e.g., "bronze", "silver", "gold")
              └── Table / View / Function / Model
```

### 2.2 Fabric hierarchy

```
Fabric Tenant (Entra ID tenant)
  └── Capacity (F-SKU, billing boundary)
        └── Workspace (e.g., "Production-Analytics", "Development")
              └── Lakehouse / Warehouse (e.g., "bronze_lakehouse", "silver_lakehouse")
                    └── Table / View
```

### 2.3 Mapping rules

| Unity Catalog level | Fabric equivalent | Notes |
| --- | --- | --- |
| Metastore | Fabric tenant (Entra ID) | One metastore = one tenant |
| Catalog | Fabric workspace | One catalog maps to one or more workspaces |
| Schema | Lakehouse or Warehouse | One schema maps to one Lakehouse/Warehouse |
| Table | Lakehouse table or Warehouse table | Same Delta tables |
| View | Lakehouse view or Warehouse view | SQL views supported in both |
| Function (SQL UDF) | Warehouse SQL function | Lakehouse SQL endpoint does not support UDFs |
| Volume (file storage) | Lakehouse Files section | Unstructured file storage |

### 2.4 Worked example

**Databricks Unity Catalog:**
```
production (catalog)
├── bronze (schema)
│   ├── raw_customers (table)
│   ├── raw_orders (table)
│   └── raw_products (table)
├── silver (schema)
│   ├── customers_clean (table)
│   ├── orders_enriched (table)
│   └── products_dim (table)
└── gold (schema)
    ├── daily_sales_summary (table)
    └── customer_360 (table)
```

**Fabric equivalent:**
```
Production-Analytics (workspace)
├── bronze_lakehouse (Lakehouse)
│   ├── Tables/
│   │   ├── raw_customers
│   │   ├── raw_orders
│   │   └── raw_products
│   └── Files/ (raw files)
├── silver_lakehouse (Lakehouse)
│   ├── Tables/
│   │   ├── customers_clean
│   │   ├── orders_enriched
│   │   └── products_dim
└── gold_lakehouse (Lakehouse)
    ├── Tables/
    │   ├── daily_sales_summary
    │   └── customer_360
    └── SQL endpoint (auto-generated, read-only)
```

### 2.5 Cross-reference table

For every table in Unity Catalog, document the mapping:

| UC path | Fabric path | Storage location | Shortcut or copy | Owner |
| --- | --- | --- | --- | --- |
| `production.bronze.raw_customers` | `Production-Analytics / bronze_lakehouse / raw_customers` | `abfss://container@account.dfs.core.windows.net/bronze/customers/` | Shortcut | data-eng-team |
| `production.silver.customers_clean` | `Production-Analytics / silver_lakehouse / customers_clean` | OneLake (native) | Copy | data-eng-team |
| `production.gold.daily_sales_summary` | `Production-Analytics / gold_lakehouse / daily_sales_summary` | OneLake (native) | Copy | analytics-team |

---

## 3. External locations to OneLake shortcuts

### 3.1 Unity Catalog external locations

In UC, external locations register ADLS/S3/GCS paths as managed storage:

```sql
-- Databricks: Create external location
CREATE EXTERNAL LOCATION my_adls_location
    URL 'abfss://container@storageaccount.dfs.core.windows.net/data/'
    WITH (STORAGE CREDENTIAL my_credential);

-- Databricks: Create external table using location
CREATE TABLE production.bronze.raw_customers
    LOCATION 'abfss://container@storageaccount.dfs.core.windows.net/data/customers/'
    AS SELECT * FROM ...;
```

### 3.2 Fabric shortcuts

OneLake shortcuts present external data without copying:

```
Fabric workspace > Lakehouse > right-click Tables > New shortcut
  > Azure Data Lake Storage Gen2
  > Enter: storage account URL, container, path
  > Authenticate: Entra ID or storage account key
  > Name: raw_customers
```

After creating the shortcut, `raw_customers` appears as a table in the Lakehouse. Fabric reads Delta files directly from ADLS. No data movement.

### 3.3 Migration pattern

For each Unity Catalog external location:

1. **Identify the ADLS path** registered in UC
2. **Create an OneLake shortcut** in the target Lakehouse pointing to the same ADLS path
3. **Verify the shortcut** -- query the table via the Lakehouse SQL endpoint
4. **Document the mapping** -- add to the cross-reference table

```python
# Fabric REST API: Create shortcut programmatically
import requests

workspace_id = "<workspace-guid>"
lakehouse_id = "<lakehouse-guid>"
url = f"https://api.fabric.microsoft.com/v1/workspaces/{workspace_id}/items/{lakehouse_id}/shortcuts"

payload = {
    "path": "Tables",
    "name": "raw_customers",
    "target": {
        "adlsGen2": {
            "location": "https://storageaccount.dfs.core.windows.net",
            "subpath": "/container/data/customers"
        }
    }
}

headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
response = requests.post(url, json=payload, headers=headers)
```

### 3.4 Managed tables

UC managed tables (stored in the metastore's managed storage) need to be either:

- **Copied** to OneLake via Spark notebook (read from UC, write to Lakehouse)
- **Exported** to ADLS, then shortcutted

```python
# Copy managed table from Databricks to Fabric
# Run this in a Databricks notebook:
df = spark.table("production.bronze.raw_customers")
df.write.format("delta").mode("overwrite").save(
    "abfss://container@account.dfs.core.windows.net/fabric-migration/raw_customers"
)

# Then create an OneLake shortcut to that ADLS path in Fabric
```

---

## 4. Access control translation

### 4.1 Unity Catalog privileges

UC uses SQL GRANT/REVOKE on the catalog hierarchy:

```sql
-- UC grants
GRANT USAGE ON CATALOG production TO `data-eng@company.com`;
GRANT USAGE ON SCHEMA production.bronze TO `data-eng@company.com`;
GRANT SELECT ON TABLE production.bronze.raw_customers TO `analyst@company.com`;
GRANT MODIFY ON TABLE production.silver.customers_clean TO `data-eng@company.com`;

-- Column-level security
GRANT SELECT (customer_name, state) ON TABLE production.bronze.raw_customers
    TO `limited-analyst@company.com`;

-- Row-level security (via views or row filters)
ALTER TABLE production.gold.customer_360
    SET ROW FILTER security_filter ON (region);
```

### 4.2 Fabric access control

Fabric uses workspace roles + item-level permissions:

| UC privilege | Fabric equivalent | Scope |
| --- | --- | --- |
| `USAGE ON CATALOG` | Workspace role: Viewer+ | Workspace level |
| `USAGE ON SCHEMA` | Lakehouse role or SQL permission | Lakehouse/Warehouse level |
| `SELECT ON TABLE` | Workspace Viewer role OR SQL GRANT SELECT | Item level |
| `MODIFY ON TABLE` | Workspace Contributor role | Item level |
| `CREATE TABLE` | Workspace Contributor/Member role | Item level |
| `Column-level security` | Warehouse SQL (column-level DENY) | Warehouse only |
| `Row-level security` | Warehouse RLS + Power BI RLS | Warehouse + PBI |
| `Row filter` | Warehouse dynamic data masking | Warehouse only |

### 4.3 Workspace role mapping

| UC role pattern | Fabric workspace role | Permissions |
| --- | --- | --- |
| Catalog owner / admin | Workspace Admin | Full control over workspace and items |
| Schema owner / data engineer | Workspace Member | Create, edit, delete items; share workspace |
| Table writer / pipeline service principal | Workspace Contributor | Create and edit items; cannot share |
| Table reader / analyst | Workspace Viewer | Read-only access to items |

### 4.4 Important gaps

| UC capability | Fabric status | Workaround |
| --- | --- | --- |
| Column-level security on Lakehouse | Not available | Use Fabric Warehouse for column-level security |
| Row-level security on Lakehouse | Not available | Use Fabric Warehouse RLS or Power BI RLS |
| Fine-grained SQL GRANT/REVOKE | Available in Warehouse only | Sensitive tables should use Warehouse, not Lakehouse |
| Metastore-level auditing | Azure Monitor + Purview | Different audit surface |
| Cross-catalog references | Cross-workspace shortcuts | Shortcuts bridge workspaces |

---

## 5. Lineage migration

### 5.1 Unity Catalog lineage

UC automatically tracks table-level and column-level lineage:
- Which notebooks/jobs read/write each table
- Column-level provenance (which source columns produce which target columns)
- Lineage visualization in the Databricks UI

### 5.2 Fabric + Purview lineage

Fabric tracks lineage through:
- **Fabric lineage view** -- workspace-level lineage showing dependencies between items (Lakehouse -> Notebook -> Lakehouse -> Semantic Model -> Report)
- **Microsoft Purview** -- tenant-level data governance with lineage across Fabric, Azure SQL, Synapse, and external sources

**Setup steps:**
1. Connect Fabric to Purview (tenant-level setting in Fabric admin portal)
2. Enable automatic lineage scanning in Purview
3. Purview scans Fabric workspace metadata and builds lineage graph
4. View lineage in Purview Data Catalog or Fabric lineage view

### 5.3 Lineage gap analysis

| UC lineage feature | Fabric + Purview | Gap? |
| --- | --- | --- |
| Table-level lineage | Fabric lineage view | No |
| Column-level lineage | Purview (with scanning) | Partial -- depends on scan depth |
| Notebook-to-table lineage | Fabric lineage view | No |
| Pipeline-to-table lineage | Fabric lineage view | No |
| Cross-workspace lineage | Purview (tenant-wide) | No |
| External source lineage | Purview connectors | No -- Purview has broader coverage |

---

## 6. Data sharing migration

### 6.1 Unity Catalog Delta Sharing

UC uses the Delta Sharing open protocol for cross-organization data sharing:

```sql
-- Databricks: Create share
CREATE SHARE customer_share;
ALTER SHARE customer_share ADD TABLE production.gold.customer_360;

-- Databricks: Grant access to recipient
CREATE RECIPIENT partner_org
    USING ID 'partner-sharing-id';
GRANT SELECT ON SHARE customer_share TO RECIPIENT partner_org;
```

### 6.2 Fabric sharing options

| Sharing pattern | Fabric mechanism | Notes |
| --- | --- | --- |
| Cross-workspace (same tenant) | OneLake shortcuts | Zero-copy, same tenant |
| Cross-tenant (Fabric-to-Fabric) | Fabric data sharing (preview) | Evolving feature |
| Cross-platform (Fabric-to-external) | Delta Sharing (via Databricks or open-source) | Fabric can consume Delta Shares |
| B2B data sharing | Purview Data Share | Governed sharing with audit trail |
| API-based sharing | Fabric REST API + Lakehouse SQL endpoint | JDBC/ODBC access |

### 6.3 Migration recommendation

For organizations using Delta Sharing today:

1. **Internal sharing** -- replace with OneLake shortcuts (simpler, zero-copy)
2. **External sharing** -- continue using Delta Sharing from the ADLS source; Fabric consumers use shortcuts to the same ADLS path
3. **Governed sharing** -- evaluate Purview Data Share for audit trail and governance

---

## 7. Migration execution plan

### Phase 1: Document and map (1-2 weeks)

- [ ] Export Unity Catalog metastore inventory (catalogs, schemas, tables, views)
- [ ] Export UC privilege grants (`SHOW GRANTS ON...` for each object)
- [ ] Export external location definitions
- [ ] Map each UC object to Fabric target (workspace, Lakehouse/Warehouse, table)
- [ ] Identify tables requiring column/row-level security (route to Fabric Warehouse)
- [ ] Document all Delta Sharing relationships

### Phase 2: Create Fabric structure (1 week)

- [ ] Create Fabric workspaces matching UC catalogs
- [ ] Create Lakehouses/Warehouses matching UC schemas
- [ ] Assign workspace roles matching UC privilege patterns
- [ ] Connect workspaces to Purview for lineage

### Phase 3: Migrate data (2-4 weeks)

- [ ] Create OneLake shortcuts for external tables
- [ ] Copy managed tables to OneLake (via Spark notebooks)
- [ ] Validate table row counts and schemas
- [ ] Set up Warehouse security for sensitive tables (column/row-level)

### Phase 4: Validate and cutover (1-2 weeks)

- [ ] Run parallel queries on UC and Fabric; reconcile results
- [ ] Verify Purview lineage matches UC lineage
- [ ] Update downstream consumers (notebooks, pipelines, reports) to use Fabric paths
- [ ] Monitor for permission issues during cutover

---

## 8. Common pitfalls

| Pitfall | Mitigation |
| --- | --- |
| Assuming Fabric has a UC-equivalent namespace | Document the workspace/lakehouse mapping explicitly |
| Losing column-level security | Route sensitive tables to Fabric Warehouse, not Lakehouse |
| Forgetting UC row filters | Implement in Fabric Warehouse RLS or Power BI RLS |
| Expecting automatic lineage migration | Lineage must be rebuilt via Purview scanning; it does not transfer |
| Ignoring Delta Sharing dependencies | Map all sharing relationships before decommissioning UC |
| Over-permissioning via workspace roles | Workspace roles are coarser than UC grants; use Warehouse SQL grants for finer control |
| Not connecting Purview early | Connect Purview before migration so lineage builds from the start |

---

## Related

- [Feature Mapping](feature-mapping-complete.md) -- full feature-by-feature mapping (governance section)
- [Notebook Migration](notebook-migration.md) -- table reference changes in notebooks
- [Best Practices](best-practices.md) -- workspace mapping patterns
- [Parent guide: 5-phase migration](../databricks-to-fabric.md)
- Fabric workspace roles: <https://learn.microsoft.com/fabric/get-started/roles-workspaces>
- Purview + Fabric integration: <https://learn.microsoft.com/purview/register-scan-fabric>

---

**Maintainers:** csa-inabox core team
**Source finding:** CSA-0083 (HIGH, XL) -- approved via AQ-0010 ballot B6
**Last updated:** 2026-04-30
