# -*- coding: utf-8 -*-
# Databricks notebook source
# MAGIC %md
# MAGIC # 01 — Sentinel Alert Exploration
# MAGIC
# MAGIC Exploratory analysis of Bronze-layer Sentinel alerts:
# MAGIC - Distribution by severity, tactic, and provider
# MAGIC - Timeline visualization
# MAGIC - Entity extraction and network graph

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup & Configuration

# COMMAND ----------

import json
from pyspark.sql import functions as F
from pyspark.sql.types import (
    StructType, StructField, StringType, ArrayType, TimestampType
)

# Configuration
BRONZE_PATH = "/mnt/datalake/bronze/sentinel-alerts/"
SAMPLE_DATA = "/Workspace/examples/cybersecurity/data/sample-sentinel-alerts.json"

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Sentinel Alerts from Bronze Layer

# COMMAND ----------

# Load raw alerts — use sample data if Bronze layer is not populated
try:
    df_alerts = spark.read.json(BRONZE_PATH)
    print(f"Loaded {df_alerts.count()} alerts from Bronze layer")
except Exception:
    df_alerts = spark.read.option("multiline", "true").json(SAMPLE_DATA)
    print(f"Loaded {df_alerts.count()} sample alerts")

df_alerts.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Alert Distribution by Severity

# COMMAND ----------

df_severity = (
    df_alerts
    .groupBy("Severity")
    .agg(F.count("*").alias("alert_count"))
    .orderBy(
        F.when(F.col("Severity") == "Critical", 1)
        .when(F.col("Severity") == "High", 2)
        .when(F.col("Severity") == "Medium", 3)
        .otherwise(4)
    )
)

display(df_severity)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Alert Distribution by MITRE ATT&CK Tactic

# COMMAND ----------

df_tactics = (
    df_alerts
    .select(F.explode("Tactics").alias("Tactic"))
    .groupBy("Tactic")
    .agg(F.count("*").alias("alert_count"))
    .orderBy(F.desc("alert_count"))
)

display(df_tactics)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Alert Distribution by Provider

# COMMAND ----------

df_providers = (
    df_alerts
    .groupBy("ProviderName")
    .agg(F.count("*").alias("alert_count"))
    .orderBy(F.desc("alert_count"))
)

display(df_providers)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Alert Timeline

# COMMAND ----------

df_timeline = (
    df_alerts
    .withColumn("TimeGenerated", F.to_timestamp("TimeGenerated"))
    .withColumn("hour", F.date_trunc("hour", "TimeGenerated"))
    .groupBy("hour", "Severity")
    .agg(F.count("*").alias("alert_count"))
    .orderBy("hour")
)

display(df_timeline)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Entity Extraction

# COMMAND ----------

# Extract hosts
df_hosts = (
    df_alerts
    .select(
        "AlertId",
        "AlertName",
        "Severity",
        F.explode("Entities").alias("entity")
    )
    .filter(F.col("entity.Type") == "Host")
    .select(
        "AlertId",
        "AlertName",
        "Severity",
        F.col("entity.HostName").alias("host_name")
    )
)

print("=== Affected Hosts ===")
display(df_hosts)

# COMMAND ----------

# Extract accounts
df_accounts = (
    df_alerts
    .select(
        "AlertId",
        "AlertName",
        "Severity",
        F.explode("Entities").alias("entity")
    )
    .filter(F.col("entity.Type") == "Account")
    .select(
        "AlertId",
        "AlertName",
        "Severity",
        F.col("entity.Name").alias("account_name")
    )
)

print("=== Affected Accounts ===")
display(df_accounts)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Entity Relationship Network
# MAGIC
# MAGIC Build a simple graph of host ↔ account relationships from alert entities.

# COMMAND ----------

# Create edges: host-account pairs from the same alert
df_edges = (
    df_hosts.alias("h")
    .join(
        df_accounts.alias("a"),
        F.col("h.AlertId") == F.col("a.AlertId"),
        "inner"
    )
    .select(
        F.col("h.host_name").alias("source"),
        F.col("a.account_name").alias("target"),
        F.col("h.Severity").alias("severity"),
        F.col("h.AlertName").alias("alert_name")
    )
    .distinct()
)

print(f"Entity relationships: {df_edges.count()} edges")
display(df_edges)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Statistics

# COMMAND ----------

total_alerts = df_alerts.count()
critical_high = df_alerts.filter(
    F.col("Severity").isin("Critical", "High")
).count()
unique_hosts = df_hosts.select("host_name").distinct().count()
unique_accounts = df_accounts.select("account_name").distinct().count()
unique_tactics = df_tactics.count()

print(f"""
========================================
  SENTINEL ALERT SUMMARY
========================================
  Total Alerts:          {total_alerts}
  Critical/High:         {critical_high}
  Unique Hosts:          {unique_hosts}
  Unique Accounts:       {unique_accounts}
  Unique ATT&CK Tactics: {unique_tactics}
========================================
""")
