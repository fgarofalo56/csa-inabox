# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Tribal Healthcare Patient 360 & Population Health
# MAGIC
# MAGIC This notebook creates comprehensive analytics tables for tribal healthcare:
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_tribal_patient_360** - Complete patient encounter history, diagnosis summary, and medication list
# MAGIC - **gold_tribal_population_health** - Population health metrics by service unit
# MAGIC - **gold_tribal_community_kpis** - Community health KPIs by area office
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Diabetes prevalence rate
# MAGIC - Behavioral health utilization
# MAGIC - Emergency department visit rate
# MAGIC - Immunization coverage (estimated)
# MAGIC - Provider utilization by type
# MAGIC - Insurance coverage distribution

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
    asc,
    avg,
    coalesce,
    col,
    collect_list,
    collect_set,
    count,
    countDistinct,
    current_date,
    current_timestamp,
    datediff,
    desc,
    filter,
    lit,
    max,
    min,
    rank,
    round,
    row_number,
    slice,
    sort_array,
    struct,
    sum,
    when,
    window,
    year,
)

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source table
source_table = "lh_silver.silver_tribal_health_encounters"

# Target tables
patient_360_table = "lh_gold.gold_tribal_patient_360"
population_health_table = "lh_gold.gold_tribal_population_health"
community_kpi_table = "lh_gold.gold_tribal_community_kpis"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Targets:")
print(f"  - {patient_360_table}")
print(f"  - {population_health_table}")
print(f"  - {community_kpi_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Silver Data

# COMMAND ----------

df_silver = spark.table(source_table)

silver_count = df_silver.count()
print(f"Silver records: {silver_count:,}")
print(f"Unique patients: {df_silver.select('patient_id_hash').distinct().count():,}")
print(f"Date range: {df_silver.agg(min('encounter_date'), max('encounter_date')).collect()[0]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 1: Patient 360 View
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Encounter History Aggregation

# COMMAND ----------

df_encounter_summary = df_silver \
    .groupBy("patient_id_hash") \
    .agg(
        count("*").alias("total_encounters"),
        countDistinct("encounter_date").alias("distinct_visit_days"),
        min("encounter_date").alias("first_encounter_date"),
        max("encounter_date").alias("last_encounter_date"),
        countDistinct("facility_name_std").alias("facilities_visited"),
        countDistinct("provider_id").alias("distinct_providers"),

        # Encounter type breakdown
        sum(when(col("encounter_type_std") == "OUTPATIENT", 1).otherwise(0)).alias("outpatient_visits"),
        sum(when(col("encounter_type_std") == "INPATIENT", 1).otherwise(0)).alias("inpatient_visits"),
        sum(when(col("encounter_type_std") == "EMERGENCY", 1).otherwise(0)).alias("emergency_visits"),
        sum(when(col("encounter_type_std") == "TELEHEALTH", 1).otherwise(0)).alias("telehealth_visits"),
        sum(when(col("encounter_type_std") == "DENTAL", 1).otherwise(0)).alias("dental_visits"),
        sum(when(col("encounter_type_std") == "BEHAVIORAL_HEALTH", 1).otherwise(0)).alias("behavioral_health_visits"),
        sum(when(col("encounter_type_std") == "SUBSTANCE_ABUSE", 1).otherwise(0)).alias("substance_abuse_visits"),
        sum(when(col("encounter_type_std") == "IMMUNIZATION", 1).otherwise(0)).alias("immunization_visits"),
        sum(when(col("encounter_type_std") == "WELLNESS", 1).otherwise(0)).alias("wellness_visits"),

        # Visit metrics
        avg("visit_duration_minutes").alias("avg_visit_duration_min"),
        sum(when(col("referral_flag") == True, 1).otherwise(0)).alias("total_referrals"),
        sum(when(col("follow_up_required") == True, 1).otherwise(0)).alias("follow_ups_required"),
        sum(when(col("emergency_flag") == True, 1).otherwise(0)).alias("emergency_encounters"),
    )

print(f"Patient encounter summaries: {df_encounter_summary.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Diagnosis Summary

# COMMAND ----------

# Top diagnoses per patient (collect as array)
df_diagnosis_summary = df_silver \
    .filter(col("icd10_code_clean").isNotNull()) \
    .groupBy("patient_id_hash") \
    .agg(
        countDistinct("icd10_code_clean").alias("distinct_diagnoses"),
        collect_set("icd10_chapter").alias("diagnosis_chapters"),

        # Chronic condition flags
        max(col("is_diabetes_related").cast("int")).alias("has_diabetes"),
        max(col("is_behavioral_health").cast("int")).alias("has_behavioral_health"),
        max(col("is_substance_use").cast("int")).alias("has_substance_use"),

        # Diagnosis category distribution
        collect_set("diagnosis_category").alias("diagnosis_categories"),

        # Top ICD-10 codes (up to 10 most frequent)
        slice(
            sort_array(
                collect_list(
                    struct(lit(1).alias("cnt"), col("icd10_code_clean"), col("icd10_description"))
                ),
                asc=False
            ),
            1, 10
        ).alias("top_diagnoses_raw")
    ) \
    .withColumn("has_diabetes", col("has_diabetes").cast("boolean")) \
    .withColumn("has_behavioral_health", col("has_behavioral_health").cast("boolean")) \
    .withColumn("has_substance_use", col("has_substance_use").cast("boolean"))

print(f"Patient diagnosis summaries: {df_diagnosis_summary.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Medication List

# COMMAND ----------

df_medication_summary = df_silver \
    .filter(col("medication_prescribed").isNotNull()) \
    .groupBy("patient_id_hash") \
    .agg(
        countDistinct("medication_prescribed").alias("distinct_medications"),
        collect_set("medication_prescribed").alias("medication_list"),
        countDistinct("medication_ndc").alias("distinct_ndc_codes"),
    )

print(f"Patients with medications: {df_medication_summary.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Insurance and Demographics

# COMMAND ----------

# Get the most recent insurance and demographic info per patient
from pyspark.sql.window import Window

w_latest = Window.partitionBy("patient_id_hash").orderBy(col("encounter_date").desc())

df_demographics = df_silver \
    .withColumn("rn", row_number().over(w_latest)) \
    .filter(col("rn") == 1) \
    .select(
        "patient_id_hash",
        col("insurance_type_std").alias("current_insurance_type"),
        "tribal_affiliation",
        col("area_office_std").alias("primary_area_office"),
        col("service_unit_std").alias("primary_service_unit"),
        col("facility_name_std").alias("primary_facility"),
        "community_health_rep_id"
    )

print(f"Patient demographic records: {df_demographics.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Join into Patient 360

# COMMAND ----------

df_patient_360 = df_encounter_summary \
    .join(df_diagnosis_summary, "patient_id_hash", "left") \
    .join(df_medication_summary, "patient_id_hash", "left") \
    .join(df_demographics, "patient_id_hash", "left")

# Calculate derived metrics
df_patient_360 = df_patient_360 \
    .withColumn(
        "days_since_last_visit",
        datediff(current_date(), col("last_encounter_date"))
    ) \
    .withColumn(
        "patient_tenure_days",
        datediff(col("last_encounter_date"), col("first_encounter_date"))
    ) \
    .withColumn(
        "encounters_per_year",
        when(col("patient_tenure_days") > 0,
            round(col("total_encounters") * 365.0 / col("patient_tenure_days"), 2)
        ).otherwise(col("total_encounters").cast("double"))
    ) \
    .withColumn(
        "ed_utilization_rate",
        when(col("total_encounters") > 0,
            round(col("emergency_visits") * 100.0 / col("total_encounters"), 2)
        ).otherwise(lit(0.0))
    ) \
    .withColumn(
        "telehealth_adoption",
        when(col("total_encounters") > 0,
            round(col("telehealth_visits") * 100.0 / col("total_encounters"), 2)
        ).otherwise(lit(0.0))
    ) \
    .withColumn(
        "chronic_condition_count",
        coalesce(col("has_diabetes").cast("int"), lit(0)) +
        coalesce(col("has_behavioral_health").cast("int"), lit(0)) +
        coalesce(col("has_substance_use").cast("int"), lit(0))
    ) \
    .withColumn(
        "care_complexity",
        when(col("chronic_condition_count") >= 3, lit("High"))
        .when(col("chronic_condition_count") >= 2, lit("Medium"))
        .when(col("chronic_condition_count") >= 1, lit("Low"))
        .otherwise(lit("Routine"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Patient 360 records: {df_patient_360.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Patient 360

# COMMAND ----------

try:
    if spark.catalog.tableExists(patient_360_table):
        deltaTable = DeltaTable.forName(spark, patient_360_table)
        deltaTable.alias("target").merge(
            df_patient_360.alias("source"),
            "target.patient_id_hash = source.patient_id_hash"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_patient_360.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(patient_360_table)

    print(f"Merged {spark.table(patient_360_table).count():,} records into {patient_360_table}")

    # Optimize for Direct Lake
    spark.sql(f"OPTIMIZE {patient_360_table} ZORDER BY (patient_id_hash, primary_area_office)")
    print("Patient 360 table optimized")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 2: Population Health Metrics by Service Unit
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Population Health Metrics

# COMMAND ----------

# Total unique patients per service unit for denominator
df_service_unit_pop = df_silver \
    .groupBy("service_unit_std", "area_office_std") \
    .agg(
        countDistinct("patient_id_hash").alias("total_patients"),
        count("*").alias("total_encounters"),
    )

# Diabetes prevalence
df_diabetes = df_silver \
    .filter(col("is_diabetes_related") == True) \
    .groupBy("service_unit_std") \
    .agg(
        countDistinct("patient_id_hash").alias("diabetes_patients"),
        count("*").alias("diabetes_encounters"),
    )

# Behavioral health utilization
df_behavioral = df_silver \
    .filter(col("is_behavioral_health") == True) \
    .groupBy("service_unit_std") \
    .agg(
        countDistinct("patient_id_hash").alias("behavioral_health_patients"),
        count("*").alias("behavioral_health_encounters"),
    )

# Emergency department visits
df_ed = df_silver \
    .filter(col("encounter_type_std") == "EMERGENCY") \
    .groupBy("service_unit_std") \
    .agg(
        countDistinct("patient_id_hash").alias("ed_patients"),
        count("*").alias("ed_encounters"),
    )

# Immunization coverage
df_immunization = df_silver \
    .filter(col("encounter_type_std") == "IMMUNIZATION") \
    .groupBy("service_unit_std") \
    .agg(
        countDistinct("patient_id_hash").alias("immunized_patients"),
        count("*").alias("immunization_encounters"),
    )

# Substance use
df_substance = df_silver \
    .filter(col("is_substance_use") == True) \
    .groupBy("service_unit_std") \
    .agg(
        countDistinct("patient_id_hash").alias("substance_use_patients"),
        count("*").alias("substance_use_encounters"),
    )

# Telehealth utilization
df_telehealth = df_silver \
    .filter(col("encounter_type_std") == "TELEHEALTH") \
    .groupBy("service_unit_std") \
    .agg(
        countDistinct("patient_id_hash").alias("telehealth_patients"),
        count("*").alias("telehealth_encounters"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Assemble Population Health Table

# COMMAND ----------

df_pop_health = df_service_unit_pop \
    .join(df_diabetes, "service_unit_std", "left") \
    .join(df_behavioral, "service_unit_std", "left") \
    .join(df_ed, "service_unit_std", "left") \
    .join(df_immunization, "service_unit_std", "left") \
    .join(df_substance, "service_unit_std", "left") \
    .join(df_telehealth, "service_unit_std", "left")

# Fill nulls and calculate rates
df_pop_health = df_pop_health \
    .fillna(0, subset=[
        "diabetes_patients", "diabetes_encounters",
        "behavioral_health_patients", "behavioral_health_encounters",
        "ed_patients", "ed_encounters",
        "immunized_patients", "immunization_encounters",
        "substance_use_patients", "substance_use_encounters",
        "telehealth_patients", "telehealth_encounters",
    ]) \
    .withColumn(
        "diabetes_prevalence_rate",
        round(col("diabetes_patients") * 100.0 / col("total_patients"), 2)
    ) \
    .withColumn(
        "behavioral_health_utilization_rate",
        round(col("behavioral_health_patients") * 100.0 / col("total_patients"), 2)
    ) \
    .withColumn(
        "ed_visit_rate",
        round(col("ed_patients") * 100.0 / col("total_patients"), 2)
    ) \
    .withColumn(
        "estimated_immunization_coverage",
        round(col("immunized_patients") * 100.0 / col("total_patients"), 2)
    ) \
    .withColumn(
        "substance_use_rate",
        round(col("substance_use_patients") * 100.0 / col("total_patients"), 2)
    ) \
    .withColumn(
        "telehealth_adoption_rate",
        round(col("telehealth_patients") * 100.0 / col("total_patients"), 2)
    ) \
    .withColumn(
        "avg_encounters_per_patient",
        round(col("total_encounters") * 1.0 / col("total_patients"), 2)
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Population health records: {df_pop_health.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Population Health

# COMMAND ----------

if spark.catalog.tableExists(population_health_table):
    deltaTable = DeltaTable.forName(spark, population_health_table)
    deltaTable.alias("target").merge(
        df_pop_health.alias("source"),
        "target.service_unit_std = source.service_unit_std"
    ).whenMatchedUpdateAll(
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_pop_health.write.format("delta") \
        .mode("overwrite") \
        .option("overwriteSchema", "true") \
        .saveAsTable(population_health_table)

print(f"Merged {df_pop_health.count():,} records into {population_health_table}")

# Optimize
spark.sql(f"OPTIMIZE {population_health_table} ZORDER BY (service_unit_std, area_office_std)")
print("Population health table optimized")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 3: Community Health KPIs
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Top 10 Diagnoses by Area Office

# COMMAND ----------

from pyspark.sql.window import Window

w_rank = Window.partitionBy("area_office_std").orderBy(col("diagnosis_count").desc())

df_top_diagnoses = df_silver \
    .filter(col("icd10_code_clean").isNotNull()) \
    .groupBy("area_office_std", "icd10_code_clean", "icd10_description", "icd10_chapter") \
    .agg(
        count("*").alias("diagnosis_count"),
        countDistinct("patient_id_hash").alias("affected_patients"),
    ) \
    .withColumn("rank", row_number().over(w_rank)) \
    .filter(col("rank") <= 10)

print(f"Top diagnoses entries: {df_top_diagnoses.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Provider Utilization by Type

# COMMAND ----------

df_provider_util = df_silver \
    .filter(col("provider_type_std").isNotNull()) \
    .groupBy("area_office_std", "provider_type_std") \
    .agg(
        count("*").alias("encounter_count"),
        countDistinct("patient_id_hash").alias("patients_seen"),
        countDistinct("provider_id").alias("distinct_providers"),
        avg("visit_duration_minutes").alias("avg_visit_duration"),
    ) \
    .withColumn(
        "encounters_per_provider",
        round(col("encounter_count") * 1.0 / col("distinct_providers"), 2)
    )

print(f"Provider utilization entries: {df_provider_util.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Insurance Coverage Distribution

# COMMAND ----------

df_insurance = df_silver \
    .groupBy("area_office_std", "insurance_type_std") \
    .agg(
        countDistinct("patient_id_hash").alias("patient_count"),
        count("*").alias("encounter_count"),
    )

# Calculate percentage within each area office
w_area = Window.partitionBy("area_office_std")
df_insurance = df_insurance \
    .withColumn(
        "area_total_patients",
        sum("patient_count").over(w_area)
    ) \
    .withColumn(
        "coverage_pct",
        round(col("patient_count") * 100.0 / col("area_total_patients"), 2)
    )

print(f"Insurance distribution entries: {df_insurance.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Average Encounters per Patient per Year

# COMMAND ----------

# Calculate encounters per patient per year by area office
df_encounters_per_year = df_silver \
    .withColumn("encounter_year", year("encounter_date")) \
    .groupBy("area_office_std", "encounter_year") \
    .agg(
        count("*").alias("total_encounters"),
        countDistinct("patient_id_hash").alias("unique_patients"),
    ) \
    .withColumn(
        "avg_encounters_per_patient",
        round(col("total_encounters") * 1.0 / col("unique_patients"), 2)
    )

print(f"Encounters per patient per year entries: {df_encounters_per_year.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Assemble Community KPIs

# COMMAND ----------

# Area office-level summary KPIs
df_area_kpis = df_silver \
    .groupBy("area_office_std") \
    .agg(
        countDistinct("patient_id_hash").alias("total_patients"),
        count("*").alias("total_encounters"),
        countDistinct("facility_name_std").alias("total_facilities"),
        countDistinct("provider_id").alias("total_providers"),
        countDistinct("service_unit_std").alias("total_service_units"),
        avg("visit_duration_minutes").alias("avg_visit_duration_min"),

        # Chronic disease prevalence
        round(
            countDistinct(when(col("is_diabetes_related"), col("patient_id_hash"))) * 100.0 /
            countDistinct("patient_id_hash"), 2
        ).alias("diabetes_prevalence_pct"),

        round(
            countDistinct(when(col("is_behavioral_health"), col("patient_id_hash"))) * 100.0 /
            countDistinct("patient_id_hash"), 2
        ).alias("behavioral_health_pct"),

        round(
            countDistinct(when(col("is_substance_use"), col("patient_id_hash"))) * 100.0 /
            countDistinct("patient_id_hash"), 2
        ).alias("substance_use_pct"),

        # Encounter type rates
        round(
            sum(when(col("encounter_type_std") == "EMERGENCY", 1).otherwise(0)) * 100.0 /
            count("*"), 2
        ).alias("ed_encounter_rate_pct"),

        round(
            sum(when(col("encounter_type_std") == "TELEHEALTH", 1).otherwise(0)) * 100.0 /
            count("*"), 2
        ).alias("telehealth_rate_pct"),

        round(
            sum(when(col("encounter_type_std") == "IMMUNIZATION", 1).otherwise(0)) * 100.0 /
            count("*"), 2
        ).alias("immunization_rate_pct"),

        # Referral and follow-up rates
        round(
            sum(when(col("referral_flag") == True, 1).otherwise(0)) * 100.0 /
            count("*"), 2
        ).alias("referral_rate_pct"),

        round(
            sum(when(col("follow_up_required") == True, 1).otherwise(0)) * 100.0 /
            count("*"), 2
        ).alias("follow_up_rate_pct"),

        # Insurance coverage
        round(
            sum(when(col("insurance_type_std") == "UNINSURED", 1).otherwise(0)) * 100.0 /
            count("*"), 2
        ).alias("uninsured_rate_pct"),
    ) \
    .withColumn(
        "avg_encounters_per_patient_per_year",
        round(col("total_encounters") * 1.0 / col("total_patients"), 2)
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Community KPI records: {df_area_kpis.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Community KPIs

# COMMAND ----------

if spark.catalog.tableExists(community_kpi_table):
    deltaTable = DeltaTable.forName(spark, community_kpi_table)
    deltaTable.alias("target").merge(
        df_area_kpis.alias("source"),
        "target.area_office_std = source.area_office_std"
    ).whenMatchedUpdateAll(
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_area_kpis.write.format("delta") \
        .mode("overwrite") \
        .option("overwriteSchema", "true") \
        .saveAsTable(community_kpi_table)

print(f"Merged {df_area_kpis.count():,} records into {community_kpi_table}")

# Optimize
spark.sql(f"OPTIMIZE {community_kpi_table} ZORDER BY (area_office_std)")
print("Community KPIs table optimized")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Validation & Summary
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Patient 360 Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as total_patients,
        ROUND(AVG(total_encounters), 2) as avg_encounters,
        ROUND(AVG(encounters_per_year), 2) as avg_encounters_per_year,
        SUM(CASE WHEN has_diabetes THEN 1 ELSE 0 END) as diabetic_patients,
        SUM(CASE WHEN has_behavioral_health THEN 1 ELSE 0 END) as behavioral_health_patients,
        SUM(CASE WHEN has_substance_use THEN 1 ELSE 0 END) as substance_use_patients
    FROM {patient_360_table}
""").show(truncate=False)

# Care complexity distribution
spark.sql(f"""
    SELECT
        care_complexity,
        COUNT(*) as patients,
        ROUND(AVG(total_encounters), 2) as avg_encounters,
        ROUND(AVG(distinct_medications), 2) as avg_medications
    FROM {patient_360_table}
    GROUP BY care_complexity
    ORDER BY
        CASE care_complexity
            WHEN 'High' THEN 1
            WHEN 'Medium' THEN 2
            WHEN 'Low' THEN 3
            WHEN 'Routine' THEN 4
        END
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Population Health Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        service_unit_std as service_unit,
        area_office_std as area_office,
        total_patients,
        diabetes_prevalence_rate,
        behavioral_health_utilization_rate,
        ed_visit_rate,
        estimated_immunization_coverage
    FROM {population_health_table}
    ORDER BY total_patients DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Community KPIs Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        area_office_std as area_office,
        total_patients,
        total_encounters,
        total_facilities,
        diabetes_prevalence_pct,
        behavioral_health_pct,
        ed_encounter_rate_pct,
        telehealth_rate_pct,
        uninsured_rate_pct,
        avg_encounters_per_patient_per_year
    FROM {community_kpi_table}
    ORDER BY total_patients DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Final Record Counts

# COMMAND ----------

print("=" * 60)
print("GOLD LAYER - TRIBAL HEALTHCARE - FINAL SUMMARY")
print("=" * 60)
print(f"  {patient_360_table}: {spark.table(patient_360_table).count():,} records")
print(f"  {population_health_table}: {spark.table(population_health_table).count():,} records")
print(f"  {community_kpi_table}: {spark.table(community_kpi_table).count():,} records")
print("=" * 60)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Table | Description | Key Dimensions |
# MAGIC |-------|-------------|----------------|
# MAGIC | gold_tribal_patient_360 | Complete patient view | patient_id_hash, primary_area_office |
# MAGIC | gold_tribal_population_health | Population metrics by service unit | service_unit_std, area_office_std |
# MAGIC | gold_tribal_community_kpis | Area office-level KPIs | area_office_std |
# MAGIC
# MAGIC ### Key Metrics Available:
# MAGIC - **Diabetes Prevalence Rate** - % of patients with diabetes diagnoses
# MAGIC - **Behavioral Health Utilization** - % of patients accessing behavioral health services
# MAGIC - **ED Visit Rate** - % of patients with emergency department visits
# MAGIC - **Immunization Coverage** - Estimated % of patients with immunization encounters
# MAGIC - **Telehealth Adoption** - % of encounters delivered via telehealth
# MAGIC - **Care Complexity** - Patient stratification by chronic condition burden
# MAGIC
# MAGIC **Ready for:** Power BI Direct Lake, Population Health Dashboards, IHS Reporting
