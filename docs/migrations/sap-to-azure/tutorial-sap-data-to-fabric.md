# Tutorial: SAP Data to Microsoft Fabric

**Step-by-step: configure Fabric Mirroring for SAP HANA to replicate SAP data to OneLake, build Delta tables, create Power BI reports on SAP data, and integrate with the CSA-in-a-Box analytics layer.**

---

!!! info "Prerequisites" - SAP HANA running on Azure VMs (or RISE with SAP on Azure) - Microsoft Fabric capacity (F64 or higher recommended) - Power BI Pro or Premium license - Network connectivity between SAP HANA and Fabric (VNet peering or private endpoints) - SAP HANA database user with SELECT privileges on target tables - Estimated time: 2--3 hours

---

## Architecture overview

```
SAP HANA (Azure VM)                Microsoft Fabric
┌──────────────────┐               ┌──────────────────────────┐
│ VBAK (sales hdr) │──────────────►│ Mirrored DB: sap_mirror  │
│ VBAP (sales itm) │──CDC Stream──►│   ├── vbak (Delta)       │
│ EKKO (PO header) │──────────────►│   ├── vbap (Delta)       │
│ EKPO (PO items)  │──────────────►│   ├── ekko (Delta)       │
│ ACDOCA (finance) │──────────────►│   ├── ekpo (Delta)       │
│ MARA (materials) │──────────────►│   └── acdoca (Delta)     │
└──────────────────┘               └───────────┬──────────────┘
                                               │
                                   ┌───────────▼──────────────┐
                                   │ Fabric Lakehouse         │
                                   │   ├── Bronze (mirrored)  │
                                   │   ├── Silver (cleansed)  │
                                   │   └── Gold (aggregated)  │
                                   └───────────┬──────────────┘
                                               │
                                   ┌───────────▼──────────────┐
                                   │ Power BI (Direct Lake)   │
                                   │   ├── Sales Dashboard    │
                                   │   ├── Procurement Report │
                                   │   └── Finance Overview   │
                                   └──────────────────────────┘
```

---

## Step 1: Prepare SAP HANA for Fabric Mirroring

### 1.1 Create a dedicated HANA user for Fabric

```sql
-- Connect to SAP HANA as SYSTEM
-- Create a database user for Fabric Mirroring
CREATE USER FABRIC_MIRROR PASSWORD "<SecurePassword123!>"
  NO FORCE_FIRST_PASSWORD_CHANGE;

-- Grant SELECT on target schemas
GRANT SELECT ON SCHEMA SAPS4H TO FABRIC_MIRROR;

-- Grant CDC-related privileges
GRANT CATALOG READ TO FABRIC_MIRROR;
GRANT SELECT ON SYS.M_TABLES TO FABRIC_MIRROR;
GRANT SELECT ON SYS.M_TABLE_COLUMNS TO FABRIC_MIRROR;
GRANT SELECT ON SYS.TABLE_COLUMNS TO FABRIC_MIRROR;

-- Enable change tracking on target tables
ALTER SYSTEM ALTER CONFIGURATION ('indexserver.ini', 'SYSTEM')
  SET ('change_tracking', 'enable') = 'true'
  WITH RECONFIGURE;
```

### 1.2 Verify network connectivity

```bash
# From Fabric private endpoint, verify HANA connectivity
# HANA SQL port is typically 3<instance>15 (e.g., 30015 for instance 00)
az network private-endpoint create \
  --resource-group rg-fabric-integration \
  --name pe-fabric-to-hana \
  --vnet-name vnet-csa-data \
  --subnet fabric-subnet \
  --private-connection-resource-id /subscriptions/$SUB_ID/resourceGroups/rg-sap-prod/providers/Microsoft.Network/privateLinkServices/pls-hana \
  --connection-name fabric-hana-connection
```

---

## Step 2: Configure Fabric Mirroring for SAP HANA

### 2.1 Create a mirrored database in Fabric

1. Open **Microsoft Fabric** portal (app.fabric.microsoft.com)
2. Navigate to your workspace (e.g., `ws-sap-analytics`)
3. Click **+ New item** > **Mirrored Database**
4. Select **SAP HANA** as the source
5. Enter connection details:

| Field           | Value                                              |
| --------------- | -------------------------------------------------- |
| Server          | `vm-hana-prd.contoso.com` (or private endpoint IP) |
| Port            | `30015`                                            |
| Database        | `S4H`                                              |
| Authentication  | Username and password                              |
| Username        | `FABRIC_MIRROR`                                    |
| Password        | `<SecurePassword123!>`                             |
| Connection name | `SAP-HANA-Production`                              |

### 2.2 Select tables for mirroring

Select the SAP tables to replicate. Start with high-value tables:

| SAP table     | Description                        | Typical size   | Refresh pattern    |
| ------------- | ---------------------------------- | -------------- | ------------------ |
| VBAK          | Sales order header                 | 5--50M rows    | Near-real-time CDC |
| VBAP          | Sales order items                  | 10--100M rows  | Near-real-time CDC |
| EKKO          | Purchase order header              | 2--20M rows    | Near-real-time CDC |
| EKPO          | Purchase order items               | 5--50M rows    | Near-real-time CDC |
| ACDOCA        | Universal Journal (FI)             | 50--500M rows  | Near-real-time CDC |
| MARA          | Material master                    | 500K--5M rows  | Near-real-time CDC |
| MAKT          | Material descriptions              | 500K--5M rows  | Near-real-time CDC |
| KNA1 / BUT000 | Customer master / Business Partner | 100K--2M rows  | Near-real-time CDC |
| LFA1 / BUT000 | Vendor master / Business Partner   | 50K--500K rows | Near-real-time CDC |

### 2.3 Start mirroring

1. Click **Mirror database** to begin initial synchronization
2. Monitor the initial sync progress in the Fabric portal
3. Initial sync time depends on table sizes:

| Total data volume | Initial sync time (estimated) |
| ----------------- | ----------------------------- |
| < 10 GB           | 15--30 minutes                |
| 10--50 GB         | 30--120 minutes               |
| 50--200 GB        | 2--6 hours                    |
| 200 GB+           | 6--24 hours                   |

---

## Step 3: Build the Fabric Lakehouse (medallion architecture)

### 3.1 Create a Fabric Lakehouse

1. In your workspace, click **+ New item** > **Lakehouse**
2. Name it `lh_sap_analytics`
3. This lakehouse will contain the silver and gold layers

### 3.2 Create silver layer transformations (Fabric notebook)

```python
# Fabric Notebook: Transform SAP mirrored data to silver layer
# This notebook reads from the mirrored database and writes cleansed data

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import *

# Read mirrored SAP sales order data
df_vbak = spark.read.format("delta").load(
    "Tables/sap_mirror/vbak"
)

df_vbap = spark.read.format("delta").load(
    "Tables/sap_mirror/vbap"
)

# Transform: Silver layer - cleansed sales orders
silver_sales_orders = (
    df_vbak
    .filter(F.col("mandt") == "100")  # Filter to production client
    .select(
        F.col("vbeln").alias("sales_order_number"),
        F.col("erdat").alias("created_date"),
        F.col("erzet").alias("created_time"),
        F.col("ernam").alias("created_by"),
        F.col("auart").alias("order_type"),
        F.col("vkorg").alias("sales_org"),
        F.col("vtweg").alias("distribution_channel"),
        F.col("spart").alias("division"),
        F.col("kunnr").alias("customer_number"),
        F.col("netwr").alias("net_value"),
        F.col("waerk").alias("currency"),
        F.col("bstnk").alias("po_number"),
        F.col("lifsk").alias("delivery_block"),
        F.col("faksk").alias("billing_block"),
        F.to_date("erdat", "yyyyMMdd").alias("order_date")
    )
)

# Write silver layer
silver_sales_orders.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .save("Tables/silver/sales_orders")

# Transform: Silver layer - sales order items
silver_sales_items = (
    df_vbap
    .filter(F.col("mandt") == "100")
    .select(
        F.col("vbeln").alias("sales_order_number"),
        F.col("posnr").alias("item_number"),
        F.col("matnr").alias("material_number"),
        F.col("arktx").alias("item_description"),
        F.col("kwmeng").alias("order_quantity"),
        F.col("vrkme").alias("sales_unit"),
        F.col("netwr").alias("net_value"),
        F.col("waerk").alias("currency"),
        F.col("werks").alias("plant"),
        F.col("lgort").alias("storage_location"),
        F.col("pstyv").alias("item_category")
    )
)

silver_sales_items.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .save("Tables/silver/sales_order_items")

print("Silver layer transformation complete.")
```

### 3.3 Create gold layer aggregations

```python
# Gold layer: Sales analytics aggregations

# Read silver layer
df_orders = spark.read.format("delta").load("Tables/silver/sales_orders")
df_items = spark.read.format("delta").load("Tables/silver/sales_order_items")

# Gold: Daily sales summary
gold_daily_sales = (
    df_orders
    .groupBy("order_date", "sales_org", "order_type")
    .agg(
        F.count("*").alias("order_count"),
        F.sum("net_value").alias("total_net_value"),
        F.countDistinct("customer_number").alias("unique_customers")
    )
    .orderBy("order_date")
)

gold_daily_sales.write \
    .format("delta") \
    .mode("overwrite") \
    .save("Tables/gold/daily_sales_summary")

# Gold: Material sales performance
gold_material_sales = (
    df_items
    .join(df_orders, "sales_order_number")
    .groupBy("material_number", "item_description", "sales_org")
    .agg(
        F.sum("net_value").alias("total_revenue"),
        F.sum("order_quantity").alias("total_quantity"),
        F.count("*").alias("line_item_count")
    )
    .orderBy(F.desc("total_revenue"))
)

gold_material_sales.write \
    .format("delta") \
    .mode("overwrite") \
    .save("Tables/gold/material_sales_performance")

print("Gold layer aggregation complete.")
```

---

## Step 4: Create Power BI reports on SAP data

### 4.1 Create a Power BI semantic model

1. In the Fabric Lakehouse, click **New semantic model**
2. Select tables: `gold/daily_sales_summary`, `gold/material_sales_performance`, `silver/sales_orders`
3. The semantic model uses **Direct Lake** mode (no data import; reads directly from Delta tables)

### 4.2 Build a sales dashboard

1. Open **Power BI Desktop** or create a report in the Fabric portal
2. Connect to the semantic model
3. Create visualizations:

| Visualization | Data                                                               | Purpose                  |
| ------------- | ------------------------------------------------------------------ | ------------------------ |
| KPI card      | `SUM(total_net_value)`                                             | Total sales value        |
| KPI card      | `COUNT(order_count)`                                               | Total order count        |
| Line chart    | `order_date` (x) vs `total_net_value` (y)                          | Sales trend over time    |
| Bar chart     | `material_number` vs `total_revenue`                               | Top materials by revenue |
| Map           | `sales_org` location vs `total_net_value`                          | Sales by region          |
| Table         | `sales_order_number`, `customer_number`, `net_value`, `order_date` | Order details            |
| Slicer        | `sales_org`, `order_type`, `order_date`                            | Interactive filtering    |

### 4.3 DAX measures for SAP analytics

```dax
// Total Revenue
Total Revenue = SUM('daily_sales_summary'[total_net_value])

// Year-over-Year Growth
YoY Growth =
VAR CurrentYear = [Total Revenue]
VAR PreviousYear = CALCULATE(
    [Total Revenue],
    SAMEPERIODLASTYEAR('sales_orders'[order_date])
)
RETURN DIVIDE(CurrentYear - PreviousYear, PreviousYear, 0)

// Average Order Value
Avg Order Value = DIVIDE([Total Revenue], SUM('daily_sales_summary'[order_count]))

// Customer Concentration (Top 10%)
Top 10% Customer Revenue =
CALCULATE(
    [Total Revenue],
    TOPN(
        CALCULATE(DISTINCTCOUNT('sales_orders'[customer_number])) * 0.1,
        ALL('sales_orders'[customer_number]),
        [Total Revenue],
        DESC
    )
)
```

---

## Step 5: Integrate with CSA-in-a-Box

### 5.1 Register SAP data in Purview

```bash
# Register HANA source in Purview
az purview account create \
  --resource-group rg-csa-governance \
  --name purview-csa-inabox \
  --location eastus2

# Scan SAP HANA metadata
# Configure in Purview portal:
# 1. Register SAP HANA as a data source
# 2. Create classification rules for SAP data (PII, financial)
# 3. Schedule metadata scan
# 4. Review discovered assets in Purview catalog
```

### 5.2 Connect to CSA-in-a-Box dbt models

```yaml
# dbt project: reference SAP data from Fabric Lakehouse
# profiles.yml
sap_analytics:
    target: fabric
    outputs:
        fabric:
            type: fabric
            server: <workspace>.datawarehouse.fabric.microsoft.com
            database: lh_sap_analytics
            schema: gold
            threads: 4
```

```sql
-- dbt model: SAP procurement analytics
-- models/gold/procurement/purchase_order_summary.sql
{{ config(materialized='table', tags=['sap', 'procurement']) }}

SELECT
    po.sales_org,
    po.vendor_number,
    v.vendor_name,
    DATE_TRUNC('month', po.order_date) AS order_month,
    COUNT(*) AS po_count,
    SUM(po.net_value) AS total_po_value,
    AVG(po.net_value) AS avg_po_value
FROM {{ ref('silver_purchase_orders') }} po
LEFT JOIN {{ ref('dim_vendors') }} v
    ON po.vendor_number = v.vendor_number
GROUP BY 1, 2, 3, 4
```

### 5.3 Enable Azure AI on SAP data

```python
# Azure OpenAI: Natural language queries on SAP data
from openai import AzureOpenAI

client = AzureOpenAI(
    azure_endpoint="https://aoai-csa-inabox.openai.azure.com/",
    api_version="2024-02-15-preview"
)

# User asks a question about SAP data
user_question = "What were our top 5 selling materials last quarter?"

# Generate SQL from natural language
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{
        "role": "system",
        "content": """You are a data analyst. Generate Spark SQL queries against
        these tables:
        - gold.material_sales_performance (material_number, item_description,
          total_revenue, total_quantity, sales_org)
        - gold.daily_sales_summary (order_date, sales_org, order_type,
          order_count, total_net_value)
        Return only the SQL query, no explanation."""
    }, {
        "role": "user",
        "content": user_question
    }]
)

# Execute the generated SQL
sql_query = response.choices[0].message.content
result_df = spark.sql(sql_query)
result_df.show()
```

---

## Step 6: Schedule and monitor

### 6.1 Schedule notebook refresh

1. In Fabric, open the notebook pipeline
2. Click **Schedule** > set refresh frequency (e.g., every 4 hours for silver/gold layers)
3. Fabric Mirroring runs continuously (no scheduling needed --- CDC is real-time)

### 6.2 Monitor data freshness

```python
# Check mirroring status
mirror_status = spark.sql("""
    SELECT table_name,
           last_sync_timestamp,
           row_count,
           DATEDIFF(minute, last_sync_timestamp, current_timestamp()) AS minutes_behind
    FROM information_schema.mirror_status
    WHERE database_name = 'sap_mirror'
""")
mirror_status.show()
```

---

## What you built

In this tutorial, you:

1. Configured SAP HANA for Fabric Mirroring (CDC-based replication)
2. Created a mirrored database in Microsoft Fabric with key SAP tables
3. Built a medallion architecture (bronze/silver/gold) in a Fabric Lakehouse
4. Created Power BI reports with Direct Lake mode on SAP data
5. Integrated with CSA-in-a-Box: Purview governance, dbt models, Azure AI

SAP transactional data now flows continuously into OneLake, is governed by Purview, transformed by dbt, visualized by Power BI, and available for AI-driven insights --- all within the CSA-in-a-Box platform.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Analytics Migration](analytics-migration.md) | [Tutorial: Deploy SAP on Azure](tutorial-sap-azure-deployment.md) | [Best Practices](best-practices.md)
