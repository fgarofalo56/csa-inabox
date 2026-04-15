# Databricks notebook source
# MAGIC %md
# MAGIC # Unity Catalog Setup — CSA-in-a-Box
# MAGIC
# MAGIC Initializes Unity Catalog resources for the CSA-in-a-Box platform.
# MAGIC Run once during initial platform deployment, then as needed for new domains.
# MAGIC
# MAGIC ## Prerequisites
# MAGIC - Databricks workspace with Unity Catalog enabled
# MAGIC - Account-level admin permissions
# MAGIC - ADLS storage account for metastore

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

# Widget parameters for flexible execution
dbutils.widgets.text("metastore_name", "csa_metastore", "Metastore Name")
dbutils.widgets.text("storage_account", "", "Storage Account Name")
dbutils.widgets.text("catalog_name", "csa_analytics", "Catalog Name")
dbutils.widgets.text("environment", "dev", "Environment (dev/prod)")
dbutils.widgets.text("domains", "shared,sales", "Comma-separated domain names")
dbutils.widgets.dropdown("dry_run", "true", ["true", "false"], "Dry-run (print GRANTs without executing)")

metastore_name = dbutils.widgets.get("metastore_name")
storage_account = dbutils.widgets.get("storage_account")
catalog_name = dbutils.widgets.get("catalog_name")
environment = dbutils.widgets.get("environment")
domains = [d.strip() for d in dbutils.widgets.get("domains").split(",")]
dry_run = dbutils.widgets.get("dry_run").lower() == "true"

print(f"Metastore: {metastore_name}")
print(f"Catalog: {catalog_name}")
print(f"Environment: {environment}")
print(f"Domains: {domains}")
print(f"Dry run: {dry_run}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Create Catalog

# COMMAND ----------

spark.sql(f"""
    CREATE CATALOG IF NOT EXISTS {catalog_name}
    COMMENT 'CSA-in-a-Box analytics catalog ({environment})'
""")
print(f"Catalog '{catalog_name}' ready")

# Set as default for this notebook
spark.sql(f"USE CATALOG {catalog_name}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Create Medallion Schemas

# COMMAND ----------

# Standard medallion layers
SCHEMAS = {
    "bronze": "Raw ingestion layer — minimally transformed source data",
    "silver": "Conformed layer — cleansed, deduped, enriched data",
    "gold": "Curated layer — business-ready aggregations and metrics",
    "platinum": "Published data products — versioned, contracted interfaces",
}

for schema_name, description in SCHEMAS.items():
    spark.sql(f"""
        CREATE SCHEMA IF NOT EXISTS {catalog_name}.{schema_name}
        COMMENT '{description}'
    """)
    print(f"  Schema '{schema_name}' ready")

# Domain-specific schemas
for domain in domains:
    for layer in ["bronze", "silver", "gold"]:
        schema = f"{layer}_{domain}"
        spark.sql(f"""
            CREATE SCHEMA IF NOT EXISTS {catalog_name}.{schema}
            COMMENT '{layer.capitalize()} layer for {domain} domain'
        """)
        print(f"  Schema '{schema}' ready")

print("\nAll schemas created")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configure External Locations

# COMMAND ----------

if storage_account:
    containers = ["raw", "bronze", "silver", "gold", "curated"]
    for container in containers:
        location_name = f"csa_{environment}_{container}"
        url = f"abfss://{container}@{storage_account}.dfs.core.windows.net/"
        try:
            spark.sql(f"""
                CREATE EXTERNAL LOCATION IF NOT EXISTS `{location_name}`
                URL '{url}'
                WITH (STORAGE CREDENTIAL `csa-storage-credential`)
                COMMENT 'CSA {environment} {container} container'
            """)
            print(f"  External location '{location_name}' -> {url}")
        except Exception as e:
            print(f"  WARN: Could not create external location '{location_name}': {e}")
else:
    print("SKIP: No storage account provided. Configure external locations manually.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Create Cluster Policies

# COMMAND ----------

import json

# Standard cluster policy for data engineering
de_policy = {
    "spark_version": {
        "type": "regex",
        "pattern": "1[3-9]\\.[0-9]+\\.x-scala.*",
        "defaultValue": "14.3.x-scala2.12",
    },
    "node_type_id": {
        "type": "allowlist",
        "values": ["Standard_DS3_v2", "Standard_DS4_v2", "Standard_D8s_v3"],
        "defaultValue": "Standard_DS3_v2",
    },
    "autotermination_minutes": {
        "type": "range",
        "minValue": 10,
        "maxValue": 120,
        "defaultValue": 30,
    },
    "num_workers": {
        "type": "range",
        "minValue": 1,
        "maxValue": 8 if environment == "dev" else 32,
        "defaultValue": 2,
    },
    "custom_tags.Environment": {
        "type": "fixed",
        "value": environment,
    },
    "custom_tags.Platform": {
        "type": "fixed",
        "value": "csa-inabox",
    },
}

print("Cluster policy configuration:")
print(json.dumps(de_policy, indent=2))
print("\nNote: Apply this policy via Databricks REST API or Terraform.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Grant Permissions

# COMMAND ----------

# Role-based access.  The group names below must exist in Databricks
# Account Console before running this notebook — see
# governance/rbac/rbac-matrix.json for the sanctioned naming scheme.
# Schema-level privileges are scoped to the layers each role needs; per
# the medallion contract, analysts cannot touch Bronze, and data
# engineers cannot touch the published Gold surface.
#
# Changes here are audited: every executed (or dry-run) GRANT is appended
# to ``audit_log`` and printed at the end so the run can be pasted into
# the change record.
ROLES = {
    "CSA-DataEngineers": {
        "catalog_privileges": ["USE_CATALOG"],
        "schema_privileges": {
            "bronze": ["USE_SCHEMA", "CREATE_TABLE", "SELECT", "MODIFY"],
            "silver": ["USE_SCHEMA", "CREATE_TABLE", "SELECT", "MODIFY"],
        },
    },
    "CSA-DataScientists": {
        "catalog_privileges": ["USE_CATALOG"],
        "schema_privileges": {
            "silver": ["USE_SCHEMA", "SELECT"],
            "gold": ["USE_SCHEMA", "SELECT", "CREATE_TABLE"],  # for feature tables
        },
    },
    "CSA-Analysts": {
        "catalog_privileges": ["USE_CATALOG"],
        "schema_privileges": {
            "gold": ["USE_SCHEMA", "SELECT"],
            "platinum": ["USE_SCHEMA", "SELECT"],
        },
    },
    "CSA-PlatformAdmin": {
        "catalog_privileges": ["ALL_PRIVILEGES"],
        "schema_privileges": {
            "bronze": ["ALL_PRIVILEGES"],
            "silver": ["ALL_PRIVILEGES"],
            "gold": ["ALL_PRIVILEGES"],
            "platinum": ["ALL_PRIVILEGES"],
        },
    },
}

audit_log: list[str] = []


def run_grant(statement: str) -> None:
    """Execute a GRANT statement (or print it, in dry-run mode)."""
    audit_log.append(statement)
    if dry_run:
        print(f"  [DRY-RUN] {statement}")
        return
    try:
        spark.sql(statement)
        print(f"  [OK]      {statement}")
    except Exception as e:
        print(f"  [FAIL]    {statement}  -- {e}")


print("RBAC Configuration:")
print("-" * 50)

for group_name, cfg in ROLES.items():
    print(f"\nGroup: {group_name}")

    # Catalog-level privileges
    for priv in cfg["catalog_privileges"]:
        run_grant(f"GRANT {priv} ON CATALOG {catalog_name} TO `{group_name}`")

    # Schema-level privileges (per-domain schemas too)
    for schema, privs in cfg["schema_privileges"].items():
        for target_schema in [schema] + [f"{schema}_{d}" for d in domains]:
            for priv in privs:
                run_grant(f"GRANT {priv} ON SCHEMA {catalog_name}.{target_schema} TO `{group_name}`")

# Table-level row security example: sales analysts can only see rows
# where customer_segment matches their allowed segments.  Databricks
# Unity Catalog supports row filters via CREATE FUNCTION + ALTER TABLE
# SET ROW FILTER.  This is commented out with a real, working shape so
# security engineers can adapt it when they add a new dimension.
#
# run_grant(f"""
# CREATE FUNCTION IF NOT EXISTS {catalog_name}.gold.segment_filter(segment STRING)
# RETURN IF(
#     is_member('CSA-SalesAnalysts'),
#     segment IN ('active', 'at_risk'),
#     TRUE
# )
# """)
# run_grant(f"""
# ALTER TABLE {catalog_name}.gold.gld_customer_lifetime_value
# SET ROW FILTER {catalog_name}.gold.segment_filter
# ON (customer_segment)
# """)

# Column-level masking example: mask PII email for analysts.
# run_grant(f"""
# CREATE FUNCTION IF NOT EXISTS {catalog_name}.silver.mask_email(email STRING)
# RETURN IF(
#     is_member('CSA-Analysts') AND NOT is_member('CSA-PlatformAdmin'),
#     '***@***',
#     email
# )
# """)
# run_grant(f"""
# ALTER TABLE {catalog_name}.silver.slv_customers
# ALTER COLUMN email SET MASK {catalog_name}.silver.mask_email
# """)

print("\n" + "=" * 60)
print(f"Audit log — {len(audit_log)} statements {'planned' if dry_run else 'executed'}:")
print("=" * 60)
for i, statement in enumerate(audit_log, 1):
    print(f"{i:3d}. {statement}")

if dry_run:
    print("\n[DRY-RUN] Re-run with dry_run=false to apply the GRANTs above.")
else:
    print("\nNext: verify with `SHOW GRANTS ON CATALOG " + catalog_name + "`")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print(f"""
{"=" * 60}
Unity Catalog Setup Complete
{"=" * 60}

Catalog:     {catalog_name}
Environment: {environment}
Schemas:     {len(SCHEMAS) + len(domains) * 3} total
Domains:     {", ".join(domains)}

Next Steps:
1. Create storage credential for ADLS access
2. Create external locations (run with storage_account parameter)
3. Create groups in Databricks Account Console
4. Apply GRANT statements for RBAC
5. Configure cluster policies via REST API
6. Test with: SELECT * FROM {catalog_name}.bronze.brz_orders LIMIT 10
""")
