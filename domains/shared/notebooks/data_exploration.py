# Databricks notebook source
# MAGIC %md
# MAGIC # CSA-in-a-Box: Data Exploration
# MAGIC
# MAGIC Generic notebook for exploring data across the medallion architecture
# MAGIC (bronze / silver / gold layers) in ADLS Gen2 storage.
# MAGIC
# MAGIC **Domains:** shared, finance, inventory, sales
# MAGIC
# MAGIC **Usage:** Set the widgets at the top to select domain and layer, then
# MAGIC run cells sequentially.

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configuration & Storage Mount

# COMMAND ----------

# --- Widget parameters (Databricks UI) ---
dbutils.widgets.text("storage_account", "", "ADLS Storage Account")
dbutils.widgets.dropdown("domain", "shared", ["shared", "finance", "inventory", "sales"])
dbutils.widgets.dropdown("layer", "gold", ["bronze", "silver", "gold"])

storage_account = dbutils.widgets.get("storage_account")
domain = dbutils.widgets.get("domain")
layer = dbutils.widgets.get("layer")

print(f"Domain: {domain} | Layer: {layer} | Storage: {storage_account}")

# COMMAND ----------

# Mount ADLS Gen2 using service principal (idempotent)
def mount_adls(container: str, storage_account: str, mount_point: str) -> None:
    """Mount an ADLS Gen2 container if not already mounted."""
    if any(m.mountPoint == mount_point for m in dbutils.fs.mounts()):
        print(f"Already mounted: {mount_point}")
        return

    configs = {
        "fs.azure.account.auth.type": "OAuth",
        "fs.azure.account.oauth.provider.type":
            "org.apache.hadoop.fs.azurebfs.oauth2.ClientCredsTokenProvider",
        "fs.azure.account.oauth2.client.id":
            dbutils.secrets.get(scope="csa-keyvault", key="sp-client-id"),
        "fs.azure.account.oauth2.client.secret":
            dbutils.secrets.get(scope="csa-keyvault", key="sp-client-secret"),
        "fs.azure.account.oauth2.client.endpoint":
            f"https://login.microsoftonline.com/"
            f"{dbutils.secrets.get(scope='csa-keyvault', key='tenant-id')}/oauth2/token",
    }

    dbutils.fs.mount(
        source=f"abfss://{container}@{storage_account}.dfs.core.windows.net/",
        mount_point=mount_point,
        extra_configs=configs,
    )
    print(f"Mounted: {mount_point}")

# Mount all medallion layers
for lyr in ["bronze", "silver", "gold"]:
    mount_adls(lyr, storage_account, f"/mnt/{lyr}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. List Available Tables & Paths

# COMMAND ----------

from pyspark.sql import functions as F


def list_tables_in_layer(layer_name: str) -> list[str]:
    """List Delta table paths within a medallion layer mount."""
    mount = f"/mnt/{layer_name}"
    try:
        entries = dbutils.fs.ls(mount)
        tables = [
            e.name.rstrip("/")
            for e in entries
            if e.isDir() and not e.name.startswith("_")
        ]
        return sorted(tables)
    except Exception as exc:
        print(f"Could not list {mount}: {exc}")
        return []

print("=" * 60)
for lyr in ["bronze", "silver", "gold"]:
    tables = list_tables_in_layer(lyr)
    print(f"\n{lyr.upper()} ({len(tables)} tables):")
    for t in tables:
        print(f"  - {t}")
print("=" * 60)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Sample Data Preview (First 10 Rows)

# COMMAND ----------

# Catalog-based access (Unity Catalog preferred over mount paths)
# Adjust catalog/schema names to match your Databricks workspace.
catalog = "csa_inabox"
schemas = {
    "bronze": f"{catalog}.bronze",
    "silver": f"{catalog}.silver",
    "gold":   f"{catalog}.gold",
}

# Key tables per domain for quick preview
domain_tables = {
    "shared": {
        "bronze": ["brz_customers", "brz_orders", "brz_products"],
        "silver": ["slv_customers", "slv_orders", "slv_products"],
        "gold":   ["dim_customers", "dim_products", "fact_orders",
                    "gld_customer_lifetime_value", "gld_monthly_revenue",
                    "gld_daily_order_metrics"],
    },
    "finance": {
        "bronze": ["brz_invoices", "brz_payments"],
        "silver": ["slv_invoices", "slv_payments"],
        "gold":   ["gld_aging_report", "gld_revenue_reconciliation"],
    },
    "inventory": {
        "bronze": ["brz_inventory", "brz_warehouses"],
        "silver": ["slv_inventory", "slv_warehouses"],
        "gold":   ["dim_warehouses", "fact_inventory_snapshot",
                    "gld_inventory_turnover", "gld_reorder_alerts"],
    },
    "sales": {
        "bronze": ["brz_sales_orders"],
        "silver": ["slv_sales_orders"],
        "gold":   ["gld_sales_metrics"],
    },
}

tables_to_preview = domain_tables.get(domain, {}).get(layer, [])
schema_prefix = schemas[layer]

for table_name in tables_to_preview:
    fqn = f"{schema_prefix}.{table_name}"
    print(f"\n{'=' * 60}")
    print(f"TABLE: {fqn}")
    print("=" * 60)
    try:
        df = spark.table(fqn)
        display(df.limit(10))
    except Exception as exc:
        print(f"  [SKIP] {exc}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Schema Comparison Across Layers

# COMMAND ----------

def get_schema_dict(fqn: str) -> dict:
    """Return {column_name: data_type} for a table."""
    try:
        df = spark.table(fqn)
        return {f.name: str(f.dataType) for f in df.schema.fields}
    except Exception:
        return {}

# Compare schemas for the selected domain across bronze -> silver -> gold
print(f"\nSchema comparison for domain '{domain}':")
print("-" * 80)

all_columns: set[str] = set()
layer_schemas: dict[str, dict] = {}

for lyr in ["bronze", "silver", "gold"]:
    for tbl in domain_tables.get(domain, {}).get(lyr, []):
        fqn = f"{schemas[lyr]}.{tbl}"
        schema = get_schema_dict(fqn)
        layer_schemas[f"{lyr}.{tbl}"] = schema
        all_columns.update(schema.keys())

# Build comparison DataFrame
rows = []
for col in sorted(all_columns):
    row = {"column": col}
    for key, schema in layer_schemas.items():
        row[key] = schema.get(col, "---")
    rows.append(row)

if rows:
    comparison_df = spark.createDataFrame(rows)
    display(comparison_df)
else:
    print("No tables found to compare.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Basic Statistics

# COMMAND ----------


def table_stats(fqn: str) -> dict:
    """Compute basic stats for a table: row count, null counts, distinct values."""
    try:
        df = spark.table(fqn)
    except Exception:
        return {}

    row_count = df.count()
    stats = {"table": fqn, "row_count": row_count, "columns": []}

    for field in df.schema.fields:
        col_stats = {
            "name": field.name,
            "type": str(field.dataType),
            "null_count": df.where(F.col(field.name).isNull()).count(),
            "distinct_count": df.select(field.name).distinct().count(),
        }
        col_stats["null_pct"] = round(
            col_stats["null_count"] / max(row_count, 1) * 100, 2
        )
        stats["columns"].append(col_stats)

    return stats

# Run stats for the selected domain + layer
for tbl in domain_tables.get(domain, {}).get(layer, []):
    fqn = f"{schemas[layer]}.{tbl}"
    result = table_stats(fqn)
    if not result:
        continue

    print(f"\n{'=' * 60}")
    print(f"TABLE: {result['table']}  |  ROWS: {result['row_count']:,}")
    print(f"{'=' * 60}")
    print(f"{'Column':<30} {'Type':<20} {'Nulls':>8} {'Null%':>7} {'Distinct':>10}")
    print("-" * 80)
    for c in result["columns"]:
        print(
            f"{c['name']:<30} {c['type']:<20} {c['null_count']:>8,} "
            f"{c['null_pct']:>6.1f}% {c['distinct_count']:>10,}"
        )

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Data Lineage Visualization Helper

# COMMAND ----------

def print_lineage(domain_name: str) -> None:
    """Print an ASCII lineage diagram for a domain's medallion pipeline."""
    lineage = {
        "shared": {
            "bronze": ["brz_customers", "brz_orders", "brz_products"],
            "silver": ["slv_customers", "slv_orders", "slv_products"],
            "gold": ["dim_customers", "dim_products", "fact_orders",
                      "gld_customer_lifetime_value", "gld_monthly_revenue"],
        },
        "finance": {
            "bronze": ["brz_invoices", "brz_payments"],
            "silver": ["slv_invoices", "slv_payments"],
            "gold": ["gld_aging_report", "gld_revenue_reconciliation"],
        },
        "inventory": {
            "bronze": ["brz_inventory", "brz_warehouses"],
            "silver": ["slv_inventory", "slv_warehouses"],
            "gold": ["dim_warehouses", "fact_inventory_snapshot",
                      "gld_inventory_turnover", "gld_reorder_alerts"],
        },
        "sales": {
            "bronze": ["brz_sales_orders"],
            "silver": ["slv_sales_orders"],
            "gold": ["gld_sales_metrics"],
        },
    }

    domain_lineage = lineage.get(domain_name, {})
    print(f"\nLineage: {domain_name}")
    print("=" * 70)

    for lyr in ["bronze", "silver", "gold"]:
        tables = domain_lineage.get(lyr, [])
        label = f"[{lyr.upper()}]"
        print(f"\n  {label}")
        for tbl in tables:
            print(f"    |-- {tbl}")
        if lyr != "gold":
            print("    |")
            print("    v")

    # Cross-domain references
    if domain_name == "finance":
        print("\n  [CROSS-DOMAIN]")
        print("    shared.fact_orders --> gld_revenue_reconciliation")
    if domain_name == "inventory":
        print("\n  [CROSS-DOMAIN]")
        print("    shared.dim_products --> gld_inventory_turnover, gld_reorder_alerts")

print_lineage(domain)
