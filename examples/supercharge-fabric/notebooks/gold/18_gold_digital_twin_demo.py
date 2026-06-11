# Databricks notebook source
# MAGIC %md
# MAGIC # Digital Twin Builder - Casino Floor Demo
# MAGIC
# MAGIC **Notebook:** `17_gold_digital_twin_demo`
# MAGIC **Layer:** Gold (Analytics)
# MAGIC **Source:** Eventhouse real-time telemetry + Bronze/Silver Delta tables
# MAGIC **Target:** Digital Twin entity models for casino floor monitoring
# MAGIC
# MAGIC ## Overview
# MAGIC This notebook demonstrates how to prepare data for Fabric's Digital Twin Builder,
# MAGIC creating entity models for a casino floor with zones, slot machines, gaming tables,
# MAGIC and real-time operational metrics.

# COMMAND ----------

# ---------------------------------------------------------------------------
# Fabric/local compatibility shim
# ---------------------------------------------------------------------------
import os

try:
    import notebookutils  # Fabric runtime
    def _get_arg(name, default=None):
        try:
            return notebookutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)
    def _notebook_exit(status: str) -> None:
        notebookutils.notebook.exit(status)
except ImportError:
    try:
        import mssparkutils  # legacy Synapse/Fabric runtime
        def _get_arg(name, default=None):
            try:
                return mssparkutils.notebook.getArgument(name, default)
            except Exception:
                return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            mssparkutils.notebook.exit(status)
    except ImportError:
        def _get_arg(name, default=None):
            return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            raise SystemExit(status)


# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    avg,
    coalesce,
    col,
    count,
    current_timestamp,
    lit,
    max,
    min,
    round,
    struct,
    sum,
    to_json,
    when,
)
from pyspark.sql.types import (
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
)

# Parameters
batch_id = (
    _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
)

# Source tables
SOURCE_SLOT_PERFORMANCE = "lh_gold.gold_slot_performance"
SOURCE_SLOT_TELEMETRY = "lh_silver.silver_slot_cleansed"

# Target tables
TARGET_ENTITIES = "lh_gold.gold_digital_twin_entities"
TARGET_RELATIONSHIPS = "lh_gold.gold_digital_twin_relationships"
TARGET_FEDERAL_TEMPLATE = "lh_gold.gold_digital_twin_federal_template"

# Entity type definitions
ENTITY_TYPES = {
    "CasinoFloor": {
        "description": "Top-level casino floor facility",
        "id_prefix": "FLOOR",
        "static_properties": ["floor_name", "total_capacity", "square_footage"],
    },
    "Zone": {
        "description": "Casino floor zone grouping machines and tables",
        "id_prefix": "ZONE",
        "static_properties": ["zone_name", "zone_type", "capacity", "floor_id"],
    },
    "SlotMachine": {
        "description": "Individual slot machine with real-time telemetry",
        "id_prefix": "SLOT",
        "static_properties": [
            "machine_type", "manufacturer", "denomination", "install_date",
        ],
        "dynamic_properties": [
            "current_credits", "coins_in_last_hour", "coins_out_last_hour",
            "temperature", "utilization_pct", "status",
        ],
    },
}

print(f"Processing batch: {batch_id}")
print(f"Entity types defined: {list(ENTITY_TYPES.keys())}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Entity Schemas

# COMMAND ----------

# SlotMachine entity schema
# Static properties: machine_id, zone_id, floor_id, machine_type, manufacturer, install_date, status
# Dynamic properties: current_credits, coins_in_last_hour, coins_out_last_hour, temperature, utilization_pct

slot_entity_schema = StructType([
    StructField("entity_id", StringType(), False),
    StructField("entity_type", StringType(), False),
    StructField("machine_id", StringType(), False),
    StructField("zone_id", StringType(), True),
    StructField("floor_id", StringType(), True),
    StructField("machine_type", StringType(), True),
    StructField("manufacturer", StringType(), True),
    StructField("denomination", DoubleType(), True),
    StructField("install_date", StringType(), True),
    StructField("status", StringType(), True),
    # Dynamic (telemetry-driven) properties
    StructField("current_credits", DoubleType(), True),
    StructField("coins_in_last_hour", DoubleType(), True),
    StructField("coins_out_last_hour", DoubleType(), True),
    StructField("temperature", DoubleType(), True),
    StructField("utilization_pct", DoubleType(), True),
])

# Zone entity schema
zone_entity_schema = StructType([
    StructField("entity_id", StringType(), False),
    StructField("entity_type", StringType(), False),
    StructField("zone_id", StringType(), False),
    StructField("floor_id", StringType(), True),
    StructField("zone_name", StringType(), True),
    StructField("capacity", IntegerType(), True),
    StructField("zone_type", StringType(), True),
])

# Relationship schema
relationship_schema = StructType([
    StructField("relationship_id", StringType(), False),
    StructField("source_entity_id", StringType(), False),
    StructField("target_entity_id", StringType(), False),
    StructField("relationship_type", StringType(), False),
])

print("Entity schemas defined:")
print(f"  SlotMachine: {len(slot_entity_schema.fields)} fields")
print(f"  Zone:        {len(zone_entity_schema.fields)} fields")
print(f"  Relationship: {len(relationship_schema.fields)} fields")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Build Entity State from Delta Tables

# COMMAND ----------

# Read gold slot performance KPIs (static metadata + aggregated financial metrics)
df_slot_performance = spark.table(SOURCE_SLOT_PERFORMANCE)

# Read silver slot telemetry (latest operational state per machine)
df_slot_telemetry = spark.table(SOURCE_SLOT_TELEMETRY)

print(f"Slot performance records: {df_slot_performance.count():,}")
print(f"Slot telemetry records:   {df_slot_telemetry.count():,}")

# Aggregate latest telemetry state per machine (simulates real-time digital twin state)
df_latest_telemetry = df_slot_telemetry \
    .groupBy("machine_id") \
    .agg(
        max("event_timestamp").alias("last_event_time"),
        sum("coin_in").alias("coins_in_last_hour"),
        sum("coin_out").alias("coins_out_last_hour"),
        avg("coin_in").alias("current_credits"),
        count("*").alias("event_count"),
    )

# Aggregate static metadata from performance table (latest business_date per machine)
df_machine_metadata = df_slot_performance \
    .groupBy("machine_id", "zone", "denomination", "manufacturer", "machine_type") \
    .agg(
        max("business_date").alias("latest_business_date"),
        round(avg("actual_hold_pct"), 2).alias("avg_hold_pct"),
        sum("total_games").alias("lifetime_games"),
    )

# Join static metadata with latest telemetry to build the current machine entity state
df_machine_state = df_machine_metadata.alias("meta") \
    .join(
        df_latest_telemetry.alias("telem"),
        col("meta.machine_id") == col("telem.machine_id"),
        "left"
    ) \
    .select(
        col("meta.machine_id"),
        col("meta.zone").alias("zone_id"),
        col("meta.machine_type"),
        col("meta.manufacturer"),
        col("meta.denomination"),
        coalesce(col("telem.current_credits"), lit(0.0)).alias("current_credits"),
        coalesce(col("telem.coins_in_last_hour"), lit(0.0)).alias("coins_in_last_hour"),
        coalesce(col("telem.coins_out_last_hour"), lit(0.0)).alias("coins_out_last_hour"),
        col("meta.avg_hold_pct"),
        coalesce(col("telem.event_count"), lit(0)).alias("recent_event_count"),
    ) \
    .withColumn(
        "utilization_pct",
        when(col("recent_event_count") > 50, lit(95.0))
        .when(col("recent_event_count") > 20, lit(70.0))
        .when(col("recent_event_count") > 5, lit(40.0))
        .otherwise(lit(10.0))
    ) \
    .withColumn(
        "status",
        when(col("recent_event_count") == 0, lit("OFFLINE"))
        .when(col("utilization_pct") >= 70, lit("ACTIVE"))
        .when(col("utilization_pct") >= 30, lit("IDLE"))
        .otherwise(lit("MAINTENANCE"))
    ) \
    .withColumn("temperature",
        round(lit(68.0) + (col("utilization_pct") / 100.0) * lit(12.0), 1)
    )

print(f"Machine entity states built: {df_machine_state.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Create Zone-Level Aggregations

# COMMAND ----------

# Aggregate machine data to zone level for zone digital twin entities
df_zone_entities = df_machine_state \
    .groupBy("zone_id") \
    .agg(
        round(avg("utilization_pct"), 2).alias("avg_utilization"),
        round(sum("coins_in_last_hour") - sum("coins_out_last_hour"), 2).alias("total_revenue"),
        count("*").alias("total_machines"),
        sum(when(col("status") == "ACTIVE", 1).otherwise(0)).alias("machines_active"),
        sum(when(col("status") == "IDLE", 1).otherwise(0)).alias("machines_idle"),
        sum(when(col("status") == "MAINTENANCE", 1).otherwise(0)).alias("machines_maintenance"),
        sum(when(col("status") == "OFFLINE", 1).otherwise(0)).alias("machines_offline"),
        round(avg("temperature"), 1).alias("avg_temperature"),
    )

# Create zone health score (0-100) based on operational metrics
# Factors: utilization (40%), active machine ratio (30%), revenue positivity (20%), temperature (10%)
df_zone_health = df_zone_entities \
    .withColumn("active_ratio",
        when(col("total_machines") > 0,
             col("machines_active") / col("total_machines") * 100)
        .otherwise(lit(0))
    ) \
    .withColumn("revenue_score",
        when(col("total_revenue") > 0, lit(100.0))
        .when(col("total_revenue") > -1000, lit(50.0))
        .otherwise(lit(0.0))
    ) \
    .withColumn("temp_score",
        when((col("avg_temperature") >= 65) & (col("avg_temperature") <= 80), lit(100.0))
        .when((col("avg_temperature") >= 60) & (col("avg_temperature") <= 85), lit(70.0))
        .otherwise(lit(30.0))
    ) \
    .withColumn("zone_health_score",
        round(
            col("avg_utilization") * 0.4
            + col("active_ratio") * 0.3
            + col("revenue_score") * 0.2
            + col("temp_score") * 0.1,
            1
        )
    ) \
    .withColumn("zone_status",
        when(col("zone_health_score") >= 80, lit("HEALTHY"))
        .when(col("zone_health_score") >= 50, lit("DEGRADED"))
        .otherwise(lit("CRITICAL"))
    )

print(f"Zone entities built: {df_zone_health.count():,}")
df_zone_health.select(
    "zone_id", "total_machines", "machines_active", "avg_utilization",
    "total_revenue", "zone_health_score", "zone_status"
).show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Digital Twin Export Format

# COMMAND ----------

# Transform machine data into Digital Twin Builder compatible format
# Each entity row: entity_id, entity_type, display_name, properties (JSON), last_updated

FLOOR_ID = "FLOOR-001"

# --- Machine entities ---
df_machine_entities = df_machine_state \
    .withColumn("entity_id", col("machine_id")) \
    .withColumn("entity_type", lit("SlotMachine")) \
    .withColumn("display_name", col("machine_id")) \
    .withColumn("floor_id", lit(FLOOR_ID)) \
    .withColumn("properties",
        to_json(struct(
            col("machine_type"),
            col("manufacturer"),
            col("denomination"),
            col("status"),
            col("current_credits"),
            col("coins_in_last_hour"),
            col("coins_out_last_hour"),
            col("temperature"),
            col("utilization_pct"),
        ))
    ) \
    .select("entity_id", "entity_type", "display_name", "floor_id",
            "zone_id", "properties")

# --- Zone entities ---
df_zone_twin_entities = df_zone_health \
    .withColumn("entity_id", col("zone_id")) \
    .withColumn("entity_type", lit("Zone")) \
    .withColumn("display_name", col("zone_id")) \
    .withColumn("floor_id", lit(FLOOR_ID)) \
    .withColumn("properties",
        to_json(struct(
            col("total_machines"),
            col("machines_active"),
            col("machines_maintenance"),
            col("avg_utilization"),
            col("total_revenue"),
            col("zone_health_score"),
            col("zone_status"),
            col("avg_temperature"),
        ))
    ) \
    .select("entity_id", "entity_type", "display_name", "floor_id",
            col("zone_id"), "properties")

# --- Floor entity (single row) ---
df_floor_entity = df_zone_health \
    .agg(
        sum("total_machines").alias("total_machines"),
        sum("machines_active").alias("total_active"),
        round(avg("avg_utilization"), 2).alias("avg_utilization"),
        round(sum("total_revenue"), 2).alias("total_revenue"),
        round(avg("zone_health_score"), 1).alias("overall_health"),
    ) \
    .withColumn("entity_id", lit(FLOOR_ID)) \
    .withColumn("entity_type", lit("CasinoFloor")) \
    .withColumn("display_name", lit("Main Casino Floor")) \
    .withColumn("floor_id", lit(FLOOR_ID)) \
    .withColumn("zone_id", lit(None).cast(StringType())) \
    .withColumn("properties",
        to_json(struct(
            col("total_machines"),
            col("total_active"),
            col("avg_utilization"),
            col("total_revenue"),
            col("overall_health"),
        ))
    ) \
    .select("entity_id", "entity_type", "display_name", "floor_id",
            "zone_id", "properties")

# Union all entity types
df_all_entities = df_machine_entities \
    .unionByName(df_zone_twin_entities) \
    .unionByName(df_floor_entity) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# --- Relationships: Machine belongs_to Zone, Zone belongs_to Floor ---
df_machine_zone_rels = df_machine_state \
    .select(col("machine_id").alias("source_entity_id"),
            col("zone_id").alias("target_entity_id")) \
    .withColumn("relationship_id",
        col("source_entity_id")) \
    .withColumn("relationship_type", lit("belongs_to"))

df_zone_floor_rels = df_zone_health \
    .select(col("zone_id").alias("source_entity_id")) \
    .withColumn("target_entity_id", lit(FLOOR_ID)) \
    .withColumn("relationship_id", col("source_entity_id")) \
    .withColumn("relationship_type", lit("belongs_to"))

df_all_relationships = df_machine_zone_rels \
    .unionByName(df_zone_floor_rels) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# Write entities (Delta MERGE - incremental)
try:
    if spark.catalog.tableExists(TARGET_ENTITIES):
        deltaTable = DeltaTable.forName(spark, TARGET_ENTITIES)
        deltaTable.alias("target").merge(
            df_all_entities.alias("source"),
            "target.entity_id = source.entity_id"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_all_entities.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_ENTITIES)

    if spark.catalog.tableExists(TARGET_RELATIONSHIPS):
        deltaTableRel = DeltaTable.forName(spark, TARGET_RELATIONSHIPS)
        deltaTableRel.alias("target").merge(
            df_all_relationships.alias("source"),
            "target.relationship_id = source.relationship_id"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_all_relationships.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_RELATIONSHIPS)

    entity_count = spark.table(TARGET_RELATIONSHIPS).count()
    rel_count = df_all_relationships.count()
    print(f"Merged {entity_count:,} entities into {TARGET_ENTITIES}")
    print(f"Merged {rel_count:,} relationships into {TARGET_RELATIONSHIPS}")
except Exception as e:
    print(f"ERROR in digital twin export (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Federal Facility Twin Template
# MAGIC
# MAGIC Template demonstrating how the Digital Twin pattern extends to federal agencies.
# MAGIC Example: USDA warehouse facility with storage units and environmental sensors.

# COMMAND ----------

# Federal facility twin template for USDA warehouse monitoring
# Entity types: Facility, StorageUnit, Sensor

federal_template_data = [
    # Facility entities
    ("FACILITY-USDA-001", "Facility", "USDA Regional Warehouse - Midwest",
     '{"agency": "USDA", "facility_type": "Cold Storage Warehouse", '
     '"location": "Kansas City, MO", "capacity_sqft": 125000, '
     '"compliance_standard": "FSMA", "last_inspection": "2026-03-01"}'),
    ("FACILITY-USDA-002", "Facility", "USDA Grain Inspection Center - Plains",
     '{"agency": "USDA", "facility_type": "Grain Inspection", '
     '"location": "Topeka, KS", "capacity_sqft": 85000, '
     '"compliance_standard": "FGIS", "last_inspection": "2026-02-15"}'),
    # StorageUnit entities
    ("STORAGE-001", "StorageUnit", "Cold Storage Bay A",
     '{"parent_facility": "FACILITY-USDA-001", "storage_type": "Refrigerated", '
     '"temperature_target_f": 34.0, "humidity_target_pct": 85.0, '
     '"inventory_level_pct": 72.5, "commodity_stored": "Fresh Produce"}'),
    ("STORAGE-002", "StorageUnit", "Dry Storage Bay B",
     '{"parent_facility": "FACILITY-USDA-001", "storage_type": "Dry", '
     '"temperature_target_f": 65.0, "humidity_target_pct": 45.0, '
     '"inventory_level_pct": 88.3, "commodity_stored": "Grains"}'),
    ("STORAGE-003", "StorageUnit", "Grain Silo Unit 1",
     '{"parent_facility": "FACILITY-USDA-002", "storage_type": "Silo", '
     '"temperature_target_f": 60.0, "humidity_target_pct": 40.0, '
     '"inventory_level_pct": 95.1, "commodity_stored": "Wheat"}'),
    # Sensor entities
    ("SENSOR-T001", "Sensor", "Temperature Sensor - Bay A",
     '{"parent_unit": "STORAGE-001", "sensor_type": "Temperature", '
     '"current_reading": 33.8, "unit": "Fahrenheit", "status": "NORMAL", '
     '"alert_threshold_low": 30.0, "alert_threshold_high": 40.0}'),
    ("SENSOR-H001", "Sensor", "Humidity Sensor - Bay A",
     '{"parent_unit": "STORAGE-001", "sensor_type": "Humidity", '
     '"current_reading": 84.2, "unit": "Percent", "status": "NORMAL", '
     '"alert_threshold_low": 70.0, "alert_threshold_high": 95.0}'),
    ("SENSOR-T002", "Sensor", "Temperature Sensor - Bay B",
     '{"parent_unit": "STORAGE-002", "sensor_type": "Temperature", '
     '"current_reading": 66.1, "unit": "Fahrenheit", "status": "WARNING", '
     '"alert_threshold_low": 55.0, "alert_threshold_high": 70.0}'),
    ("SENSOR-T003", "Sensor", "Temperature Sensor - Silo 1",
     '{"parent_unit": "STORAGE-003", "sensor_type": "Temperature", '
     '"current_reading": 59.4, "unit": "Fahrenheit", "status": "NORMAL", '
     '"alert_threshold_low": 50.0, "alert_threshold_high": 70.0}'),
]

federal_template_columns = ["entity_id", "entity_type", "display_name", "properties"]

df_federal_template = spark.createDataFrame(
    federal_template_data, schema=federal_template_columns
) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

try:
    if spark.catalog.tableExists(TARGET_FEDERAL_TEMPLATE):
        deltaTable = DeltaTable.forName(spark, TARGET_FEDERAL_TEMPLATE)
        deltaTable.alias("target").merge(
            df_federal_template.alias("source"),
            "target.entity_id = source.entity_id"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_federal_template.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_FEDERAL_TEMPLATE)

    print(f"Merged {df_federal_template.count():,} federal template entities into {TARGET_FEDERAL_TEMPLATE}")
except Exception as e:
    print(f"ERROR in federal template (batch_id={batch_id}): {e}")
    raise

# Show template summary
print("\nFederal Digital Twin Template - Entity Breakdown:")
df_federal_template.groupBy("entity_type").agg(count("*").alias("count")).show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation & Summary

# COMMAND ----------

# --- Entity counts by type ---
print("=" * 70)
print("DIGITAL TWIN BUILDER - VALIDATION SUMMARY")
print("=" * 70)

df_entity_counts = spark.table(TARGET_ENTITIES) \
    .groupBy("entity_type") \
    .agg(count("*").alias("entity_count"))

entity_rows = df_entity_counts.collect()
total_entities = 0
for row in entity_rows:
    print(f"  {row['entity_type']:.<30} {row['entity_count']:,} entities")
    total_entities += row['entity_count']
print(f"  {'TOTAL':.<30} {total_entities:,} entities")

# --- Relationship integrity ---
print("\n" + "-" * 70)
print("RELATIONSHIP INTEGRITY")
print("-" * 70)

df_rels = spark.table(TARGET_RELATIONSHIPS)
rel_count = df_rels.count()
print(f"  Total relationships: {rel_count:,}")

df_rel_types = df_rels.groupBy("relationship_type").agg(count("*").alias("count"))
for row in df_rel_types.collect():
    print(f"  {row['relationship_type']:.<30} {row['count']:,} links")

# Verify referential integrity: all source_entity_ids exist in entities table
df_entities = spark.table(TARGET_ENTITIES)
orphan_sources = df_rels.alias("r") \
    .join(
        df_entities.alias("e"),
        col("r.source_entity_id") == col("e.entity_id"),
        "left_anti"
    ).count()

orphan_targets = df_rels.alias("r") \
    .join(
        df_entities.alias("e"),
        col("r.target_entity_id") == col("e.entity_id"),
        "left_anti"
    ).count()

print(f"  Orphan source references: {orphan_sources:,}")
print(f"  Orphan target references: {orphan_targets:,}")

# --- Data quality: all entities have required properties ---
print("\n" + "-" * 70)
print("DATA QUALITY CHECKS")
print("-" * 70)

null_entity_id = df_entities.filter(col("entity_id").isNull()).count()
null_entity_type = df_entities.filter(col("entity_type").isNull()).count()
null_properties = df_entities.filter(col("properties").isNull()).count()

print(f"  Null entity_id:   {null_entity_id:,}")
print(f"  Null entity_type: {null_entity_type:,}")
print(f"  Null properties:  {null_properties:,}")

quality_passed = (null_entity_id == 0 and null_entity_type == 0
                  and null_properties == 0 and orphan_sources == 0
                  and orphan_targets == 0)

# --- Federal template summary ---
print("\n" + "-" * 70)
print("FEDERAL TEMPLATE")
print("-" * 70)
fed_count = spark.table(TARGET_FEDERAL_TEMPLATE).count()
print(f"  Template entities: {fed_count:,}")

# --- Final summary ---
print("\n" + "=" * 70)
print("FINAL STATUS")
print("=" * 70)
print(f"  Entity count:       {total_entities:,}")
print(f"  Relationship count: {rel_count:,}")
print(f"  Federal template:   {fed_count:,}")
print(f"  Quality check:      {'PASSED' if quality_passed else 'FAILED'}")
print(f"  Batch ID:           {batch_id}")
print("=" * 70)
