# Databricks notebook source
# MAGIC %md
# MAGIC # Population Health Dashboard
# MAGIC
# MAGIC IHS population health analytics for tribal communities:
# MAGIC - Patient demographic analysis by tribe and service unit
# MAGIC - Disease prevalence and encounter patterns
# MAGIC - Facility utilization and capacity assessment
# MAGIC - Health disparity identification
# MAGIC
# MAGIC **IMPORTANT:** All data is ENTIRELY SYNTHETIC. No real PHI.
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - Synthetic RPMS patient demographics (silver layer)
# MAGIC - Synthetic clinical encounters (silver layer)
# MAGIC - IHS facility reference data (silver layer)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

import warnings

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

warnings.filterwarnings("ignore")

from pyspark.sql.functions import *

plt.style.use("seaborn-v0_8")
sns.set_palette("husl")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------


def load_health_data():
    """Load all tribal health datasets."""
    patients = spark.table("silver.slv_patient_demographics").toPandas()
    encounters = spark.table("silver.slv_encounters").toPandas()
    facilities = spark.table("silver.slv_facilities").toPandas()

    encounters["encounter_date"] = pd.to_datetime(encounters["encounter_date"])

    print(f"Patients: {len(patients):,}")
    print(f"Encounters: {len(encounters):,}")
    print(f"Facilities: {len(facilities):,}")
    print(f"Tribes: {patients['tribal_affiliation'].nunique()}")
    print(f"Service Units: {patients['service_unit'].nunique()}")
    return patients, encounters, facilities


df_patients, df_encounters, df_facilities = load_health_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Demographic Analysis

# COMMAND ----------


def analyze_demographics(patients):
    """Analyze patient demographics."""
    fig, axes = plt.subplots(2, 2, figsize=(18, 12))

    # Population by tribe
    tribe_counts = patients["tribal_affiliation"].value_counts().head(10)
    tribe_counts.plot(kind="barh", ax=axes[0, 0], color=sns.color_palette("viridis", len(tribe_counts)))
    axes[0, 0].set_title("Patient Population by Tribal Affiliation", fontweight="bold")
    axes[0, 0].set_xlabel("Patient Count")
    axes[0, 0].grid(True, alpha=0.3)

    # Age group distribution
    age_order = ["0-4", "5-14", "15-24", "25-34", "35-44", "45-54", "55-64", "65-74", "75+"]
    age_data = patients["age_group"].value_counts().reindex(age_order).fillna(0)
    axes[0, 1].bar(age_data.index, age_data.values, color=sns.color_palette("coolwarm", len(age_data)))
    axes[0, 1].set_title("Age Group Distribution", fontweight="bold")
    axes[0, 1].set_xlabel("Age Group")
    axes[0, 1].set_ylabel("Count")
    axes[0, 1].tick_params(axis="x", rotation=45)
    axes[0, 1].grid(True, alpha=0.3)

    # Gender distribution by service unit
    gender_by_su = patients.groupby(["service_unit", "gender"]).size().unstack(fill_value=0)
    gender_by_su.head(10).plot(kind="bar", ax=axes[1, 0], stacked=True)
    axes[1, 0].set_title("Gender by Service Unit", fontweight="bold")
    axes[1, 0].set_ylabel("Count")
    axes[1, 0].tick_params(axis="x", rotation=45)
    axes[1, 0].legend(title="Gender")
    axes[1, 0].grid(True, alpha=0.3)

    # Eligibility status
    status_counts = patients["eligibility_status"].value_counts()
    axes[1, 1].pie(
        status_counts.values,
        labels=status_counts.index,
        autopct="%1.1f%%",
        colors=sns.color_palette("Set2", len(status_counts)),
    )
    axes[1, 1].set_title("Eligibility Status", fontweight="bold")

    plt.tight_layout()
    plt.savefig("/tmp/tribal_demographics.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_demographics(df_patients)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Disease Prevalence Analysis

# COMMAND ----------


def analyze_disease_prevalence(encounters):
    """Analyze disease prevalence from ICD-10 codes."""
    # ICD-10 chapter mapping
    icd10_chapters = {
        "E": "Endocrine/Metabolic",
        "I": "Circulatory",
        "J": "Respiratory",
        "F": "Mental/Behavioral",
        "M": "Musculoskeletal",
        "K": "Digestive",
        "N": "Genitourinary",
        "L": "Skin",
        "H": "Eye/Ear",
        "S": "Injury",
        "Z": "Factors/Health Status",
        "R": "Symptoms/Signs",
    }

    encounters_with_chapter = encounters.copy()
    encounters_with_chapter["dx_chapter"] = encounters_with_chapter["primary_dx_icd10"].str[0]
    encounters_with_chapter["dx_category"] = encounters_with_chapter["dx_chapter"].map(icd10_chapters).fillna("Other")

    fig, axes = plt.subplots(2, 2, figsize=(18, 12))

    # Top diagnoses
    dx_counts = encounters_with_chapter["dx_category"].value_counts()
    dx_counts.plot(kind="barh", ax=axes[0, 0], color=sns.color_palette("mako", len(dx_counts)))
    axes[0, 0].set_title("Encounter Volume by Diagnosis Category", fontweight="bold")
    axes[0, 0].set_xlabel("Encounter Count")
    axes[0, 0].grid(True, alpha=0.3)

    # Top specific ICD-10 codes
    top_dx = encounters["primary_dx_icd10"].value_counts().head(15)
    top_dx.plot(kind="barh", ax=axes[0, 1], color="steelblue")
    axes[0, 1].set_title("Top 15 ICD-10 Diagnosis Codes", fontweight="bold")
    axes[0, 1].set_xlabel("Count")
    axes[0, 1].grid(True, alpha=0.3)

    # Encounter type distribution
    enc_type = encounters["encounter_type"].value_counts()
    axes[1, 0].pie(
        enc_type.values, labels=enc_type.index, autopct="%1.1f%%", colors=sns.color_palette("Set3", len(enc_type))
    )
    axes[1, 0].set_title("Encounter Type Distribution", fontweight="bold")

    # Encounters over time
    encounters_with_chapter["year_month"] = encounters_with_chapter["encounter_date"].dt.to_period("M")
    monthly_enc = encounters_with_chapter.groupby("year_month").size()
    monthly_enc.index = monthly_enc.index.to_timestamp()
    axes[1, 1].plot(monthly_enc.index, monthly_enc.values, marker=".", linewidth=1.5, color="teal")
    axes[1, 1].fill_between(monthly_enc.index, monthly_enc.values, alpha=0.3)
    axes[1, 1].set_title("Monthly Encounter Volume", fontweight="bold")
    axes[1, 1].set_xlabel("Date")
    axes[1, 1].set_ylabel("Encounters")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/disease_prevalence.png", dpi=300, bbox_inches="tight")
    plt.show()

    # Diabetes prevalence by tribe
    diabetes = encounters[encounters["primary_dx_icd10"].str.startswith("E11", na=False)]
    diabetes_by_tribe = diabetes.merge(df_patients[["patient_id", "tribal_affiliation"]], on="patient_id")
    tribe_diabetes = diabetes_by_tribe["tribal_affiliation"].value_counts()
    tribe_total = df_patients["tribal_affiliation"].value_counts()
    diabetes_rate = (tribe_diabetes / tribe_total * 1000).dropna().sort_values(ascending=False)

    if len(diabetes_rate) > 0:
        fig2, ax2 = plt.subplots(figsize=(12, 6))
        diabetes_rate.plot(kind="barh", ax=ax2, color="darkred")
        ax2.set_title("Type 2 Diabetes Rate per 1,000 Patients by Tribe", fontweight="bold")
        ax2.set_xlabel("Rate per 1,000")
        ax2.grid(True, alpha=0.3)
        plt.tight_layout()
        plt.savefig("/tmp/diabetes_by_tribe.png", dpi=300, bbox_inches="tight")
        plt.show()


analyze_disease_prevalence(df_encounters)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Facility Utilization

# COMMAND ----------


def analyze_facilities(facilities, encounters):
    """Analyze facility utilization."""
    facility_encounters = (
        encounters.groupby("facility_id")
        .agg(
            encounter_count=("encounter_id", "count"),
            unique_patients=("patient_id", "nunique"),
            avg_daily=("encounter_date", lambda x: len(x) / max((x.max() - x.min()).days, 1)),
        )
        .reset_index()
    )

    merged = facilities.merge(facility_encounters, on="facility_id", how="left").fillna(0)

    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    # Encounters per facility
    merged_sorted = merged.sort_values("encounter_count", ascending=False).head(15)
    colors = {"HOSPITAL": "steelblue", "HEALTH_CENTER": "green", "SATELLITE": "orange"}
    bar_colors = [colors.get(ft, "gray") for ft in merged_sorted["facility_type"]]

    axes[0].barh(merged_sorted["facility_name"].str[:30], merged_sorted["encounter_count"], color=bar_colors)
    axes[0].set_title("Top Facilities by Encounter Volume", fontweight="bold")
    axes[0].set_xlabel("Encounters")
    axes[0].grid(True, alpha=0.3)

    # Provider to patient ratio
    merged["patients_per_provider"] = (merged["unique_patients"] / merged["provider_count"].clip(lower=1)).round(1)
    merged_hosp = merged[merged["facility_type"] == "HOSPITAL"].sort_values("patients_per_provider", ascending=False)

    if len(merged_hosp) > 0:
        axes[1].barh(merged_hosp["facility_name"].str[:30], merged_hosp["patients_per_provider"], color="coral")
        axes[1].set_title("Patients per Provider (Hospitals)", fontweight="bold")
        axes[1].set_xlabel("Ratio")
        axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/facility_utilization.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_facilities(df_facilities, df_encounters)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results

# COMMAND ----------

# Aggregate health metrics and save
health_summary = df_encounters.merge(
    df_patients[["patient_id", "tribal_affiliation", "service_unit", "age_group", "gender"]],
    on="patient_id",
    how="left",
)

summary_agg = (
    health_summary.groupby(["tribal_affiliation", "service_unit"])
    .agg(
        total_encounters=("encounter_id", "count"),
        unique_patients=("patient_id", "nunique"),
        diabetes_encounters=("primary_dx_icd10", lambda x: x.str.startswith("E11", na=False).sum()),
        ed_visits=("encounter_type", lambda x: (x == "ED").sum()),
        telehealth_visits=("encounter_type", lambda x: (x == "TELEHEALTH").sum()),
    )
    .reset_index()
)

summary_spark = spark.createDataFrame(summary_agg)
summary_spark = summary_spark.withColumn("analysis_date", current_date())

(summary_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_population_health_summary"))

print("Saved to gold.gld_population_health_summary")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("POPULATION HEALTH DASHBOARD - INITIAL RESULTS")
print("=" * 65)
print(f"\nPatients: {len(df_patients):,}")
print(f"Encounters: {len(df_encounters):,}")
print(f"Facilities: {len(df_facilities):,}")
print(f"Tribes: {df_patients['tribal_affiliation'].nunique()}")
print(f"Service Units: {df_patients['service_unit'].nunique()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Demographic Trend Analysis

# COMMAND ----------

import numpy as np


def analyze_demographic_trends(patients, encounters):
    """Analyze demographic trends and population growth across service units."""
    enc_copy = encounters.copy()
    enc_copy["encounter_date"] = pd.to_datetime(enc_copy["encounter_date"])
    enc_copy["year_month"] = enc_copy["encounter_date"].dt.to_period("M")
    enc_copy["year"] = enc_copy["encounter_date"].dt.year
    enc_copy["quarter"] = enc_copy["encounter_date"].dt.quarter

    # Merge demographics
    enc_demo = enc_copy.merge(
        patients[["patient_id", "tribal_affiliation", "service_unit", "age_group", "gender"]],
        on="patient_id",
        how="left",
    )

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Patient growth by service unit over time
    su_quarterly = enc_demo.groupby(["service_unit", "year", "quarter"])["patient_id"].nunique().reset_index()
    su_quarterly["period"] = su_quarterly["year"].astype(str) + "Q" + su_quarterly["quarter"].astype(str)
    for su in patients["service_unit"].unique()[:6]:
        su_data = su_quarterly[su_quarterly["service_unit"] == su]
        axes[0, 0].plot(range(len(su_data)), su_data["patient_id"], marker="o", label=su[:20], linewidth=1.5)
    axes[0, 0].set_title("Unique Patients by Service Unit (Quarterly)", fontweight="bold")
    axes[0, 0].set_xlabel("Quarter")
    axes[0, 0].set_ylabel("Unique Patients")
    axes[0, 0].legend(fontsize=7)
    axes[0, 0].grid(True, alpha=0.3)

    # Age distribution shifts
    age_order = ["0-4", "5-14", "15-24", "25-34", "35-44", "45-54", "55-64", "65-74", "75+"]
    tribe_age = patients.groupby(["tribal_affiliation", "age_group"]).size().unstack(fill_value=0)
    tribe_age = tribe_age.reindex(columns=[a for a in age_order if a in tribe_age.columns])
    tribe_age_pct = tribe_age.div(tribe_age.sum(axis=1), axis=0) * 100
    tribe_age_pct.head(6).plot(kind="bar", stacked=True, ax=axes[0, 1], cmap="viridis")
    axes[0, 1].set_title("Age Distribution by Tribe (Top 6)", fontweight="bold")
    axes[0, 1].set_ylabel("Percentage")
    axes[0, 1].tick_params(axis="x", rotation=45)
    axes[0, 1].legend(fontsize=7, bbox_to_anchor=(1.05, 1))
    axes[0, 1].grid(True, alpha=0.3)

    # Gender ratio by tribe
    gender_ratio = patients.groupby("tribal_affiliation")["gender"].value_counts(normalize=True).unstack(fill_value=0)
    if "F" in gender_ratio.columns and "M" in gender_ratio.columns:
        gender_ratio["female_pct"] = gender_ratio["F"] * 100
        gender_ratio = gender_ratio.sort_values("female_pct")
        axes[1, 0].barh(gender_ratio.index, gender_ratio["female_pct"], color="coral", label="Female %")
        axes[1, 0].axvline(x=50, color="black", linestyle="--", alpha=0.5)
        axes[1, 0].set_title("Female Percentage by Tribe", fontweight="bold")
        axes[1, 0].set_xlabel("Female %")
        axes[1, 0].grid(True, alpha=0.3)

    # Monthly encounter trend with moving average
    monthly = enc_copy.groupby("year_month").size()
    monthly.index = monthly.index.to_timestamp()
    axes[1, 1].plot(monthly.index, monthly.values, alpha=0.5, linewidth=1, color="steelblue")
    if len(monthly) >= 3:
        rolling = monthly.rolling(window=3, min_periods=1).mean()
        axes[1, 1].plot(monthly.index, rolling.values, linewidth=2, color="red", label="3-month MA")
    axes[1, 1].set_title("Monthly Encounter Trend with Moving Average", fontweight="bold")
    axes[1, 1].set_xlabel("Date")
    axes[1, 1].set_ylabel("Encounter Count")
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/demographic_trends.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_demographic_trends(df_patients, df_encounters)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Healthcare Utilization Patterns

# COMMAND ----------


def analyze_utilization_patterns(encounters, patients, facilities):
    """Analyze healthcare utilization patterns across encounter types and facilities."""
    enc_demo = encounters.merge(
        patients[["patient_id", "tribal_affiliation", "service_unit", "age_group"]], on="patient_id", how="left"
    )
    enc_demo["encounter_date"] = pd.to_datetime(enc_demo["encounter_date"])

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Encounter type by age group
    type_age = enc_demo.groupby(["age_group", "encounter_type"]).size().unstack(fill_value=0)
    age_order = ["0-4", "5-14", "15-24", "25-34", "35-44", "45-54", "55-64", "65-74", "75+"]
    type_age = type_age.reindex([a for a in age_order if a in type_age.index])
    type_age_pct = type_age.div(type_age.sum(axis=1), axis=0) * 100
    type_age_pct.plot(kind="bar", stacked=True, ax=axes[0, 0])
    axes[0, 0].set_title("Encounter Type Mix by Age Group (%)", fontweight="bold")
    axes[0, 0].set_ylabel("Percentage")
    axes[0, 0].tick_params(axis="x", rotation=45)
    axes[0, 0].legend(fontsize=7)
    axes[0, 0].grid(True, alpha=0.3)

    # ED visit frequency distribution
    ed_per_patient = enc_demo[enc_demo["encounter_type"] == "ED"].groupby("patient_id").size()
    axes[0, 1].hist(
        ed_per_patient, bins=range(1, ed_per_patient.max() + 2), edgecolor="black", alpha=0.7, color="coral"
    )
    axes[0, 1].set_title("ED Visit Frequency Distribution", fontweight="bold")
    axes[0, 1].set_xlabel("Number of ED Visits per Patient")
    axes[0, 1].set_ylabel("Patient Count")
    axes[0, 1].grid(True, alpha=0.3)
    # Annotate heavy users
    heavy_ed = (ed_per_patient >= 5).sum()
    axes[0, 1].annotate(
        f"Heavy users (>=5): {heavy_ed}",
        xy=(0.95, 0.95),
        xycoords="axes fraction",
        ha="right",
        va="top",
        bbox={"boxstyle": "round", "facecolor": "wheat"},
    )

    # Telehealth adoption over time
    enc_demo["month"] = enc_demo["encounter_date"].dt.to_period("M")
    monthly_type = enc_demo.groupby(["month", "encounter_type"]).size().unstack(fill_value=0)
    monthly_type.index = monthly_type.index.to_timestamp()
    if "TELEHEALTH" in monthly_type.columns:
        monthly_type["telehealth_pct"] = monthly_type["TELEHEALTH"] / monthly_type.sum(axis=1) * 100
        axes[1, 0].plot(monthly_type.index, monthly_type["telehealth_pct"], marker=".", linewidth=1.5, color="teal")
        axes[1, 0].fill_between(monthly_type.index, monthly_type["telehealth_pct"], alpha=0.2)
        axes[1, 0].set_title("Telehealth Adoption Rate Over Time", fontweight="bold")
        axes[1, 0].set_xlabel("Date")
        axes[1, 0].set_ylabel("Telehealth % of All Encounters")
        axes[1, 0].grid(True, alpha=0.3)

    # Facility utilization rate
    fac_enc = (
        encounters.groupby("facility_id")
        .agg(encounters=("encounter_id", "count"), unique_patients=("patient_id", "nunique"))
        .reset_index()
    )
    fac_merged = facilities.merge(fac_enc, on="facility_id", how="left").fillna(0)
    fac_merged["utilization_rate"] = (fac_merged["encounters"] / fac_merged["bed_count"].clip(lower=1) / 365).round(2)

    fac_sorted = fac_merged.sort_values("utilization_rate", ascending=False).head(15)
    colors_fac = ["red" if u > 0.8 else "orange" if u > 0.5 else "green" for u in fac_sorted["utilization_rate"]]
    axes[1, 1].barh(fac_sorted["facility_name"].str[:25], fac_sorted["utilization_rate"], color=colors_fac)
    axes[1, 1].set_title("Facility Utilization Rate (red = overloaded)", fontweight="bold")
    axes[1, 1].set_xlabel("Utilization Rate")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/utilization_patterns.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_utilization_patterns(df_encounters, df_patients, df_facilities)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Preventive Care Gap Analysis

# COMMAND ----------


def analyze_preventive_care_gaps(encounters, patients):
    """Identify preventive care gaps by analyzing visit patterns and chronic disease screening."""
    enc_copy = encounters.copy()
    enc_copy["encounter_date"] = pd.to_datetime(enc_copy["encounter_date"])

    # Patient-level care metrics
    patient_care = (
        enc_copy.groupby("patient_id")
        .agg(
            last_visit=("encounter_date", "max"),
            total_visits=("encounter_id", "count"),
            visit_types=("encounter_type", "nunique"),
            has_wellness=("encounter_type", lambda x: "WELLNESS" in x.values or "OUTPATIENT" in x.values),
            has_chronic_dx=(
                "primary_dx_icd10",
                lambda x: any(x.str.startswith(p, na=False).any() for p in ["E11", "I10", "E66"]),
            ),
            ed_only=("encounter_type", lambda x: all(v == "ED" for v in x)),
            first_visit=("encounter_date", "min"),
        )
        .reset_index()
    )

    patient_care = patient_care.merge(
        patients[["patient_id", "age_group", "tribal_affiliation", "service_unit", "gender"]],
        on="patient_id",
        how="left",
    )

    ref_date = enc_copy["encounter_date"].max()
    patient_care["days_since_last"] = (ref_date - patient_care["last_visit"]).dt.days
    patient_care["overdue_visit"] = patient_care["days_since_last"] > 180  # 6 months

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Overdue rate by tribe
    overdue_by_tribe = (
        patient_care.groupby("tribal_affiliation")
        .agg(overdue_rate=("overdue_visit", "mean"), n_patients=("patient_id", "count"))
        .sort_values("overdue_rate", ascending=True)
        .reset_index()
    )

    colors_od = ["red" if r > 0.4 else "orange" if r > 0.2 else "green" for r in overdue_by_tribe["overdue_rate"]]
    axes[0, 0].barh(overdue_by_tribe["tribal_affiliation"], overdue_by_tribe["overdue_rate"] * 100, color=colors_od)
    axes[0, 0].set_title("Overdue Visit Rate by Tribe (>6 months)", fontweight="bold")
    axes[0, 0].set_xlabel("Overdue Rate (%)")
    axes[0, 0].grid(True, alpha=0.3)

    # Care gap by age group
    gap_by_age = (
        patient_care.groupby("age_group")
        .agg(
            overdue_rate=("overdue_visit", "mean"),
            ed_only_rate=("ed_only", "mean"),
            wellness_rate=("has_wellness", "mean"),
        )
        .reset_index()
    )
    age_order = ["0-4", "5-14", "15-24", "25-34", "35-44", "45-54", "55-64", "65-74", "75+"]
    gap_by_age = (
        gap_by_age.set_index("age_group")
        .reindex([a for a in age_order if a in gap_by_age["age_group"].values])
        .reset_index()
    )

    x = range(len(gap_by_age))
    w = 0.25
    axes[0, 1].bar(x, gap_by_age["overdue_rate"] * 100, width=w, label="Overdue", color="red", alpha=0.7)
    axes[0, 1].bar(
        [i + w for i in x], gap_by_age["ed_only_rate"] * 100, width=w, label="ED-Only", color="orange", alpha=0.7
    )
    axes[0, 1].bar(
        [i + 2 * w for i in x],
        gap_by_age["wellness_rate"] * 100,
        width=w,
        label="Has Wellness",
        color="green",
        alpha=0.7,
    )
    axes[0, 1].set_xticks([i + w for i in x])
    axes[0, 1].set_xticklabels(gap_by_age["age_group"], rotation=45)
    axes[0, 1].set_title("Care Gap Indicators by Age Group (%)", fontweight="bold")
    axes[0, 1].set_ylabel("Rate (%)")
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Chronic disease patients without regular follow-up
    chronic_no_followup = patient_care[(patient_care["has_chronic_dx"]) & (patient_care["overdue_visit"])]
    gap_by_su = (
        patient_care[patient_care["has_chronic_dx"]]
        .groupby("service_unit")
        .agg(total_chronic=("patient_id", "count"), overdue_chronic=("overdue_visit", "sum"))
        .reset_index()
    )
    gap_by_su["overdue_pct"] = (gap_by_su["overdue_chronic"] / gap_by_su["total_chronic"] * 100).round(1)
    gap_by_su = gap_by_su.sort_values("overdue_pct", ascending=True)

    axes[1, 0].barh(gap_by_su["service_unit"], gap_by_su["overdue_pct"], color="darkred")
    axes[1, 0].set_title("Chronic Patients Overdue for Follow-Up by SU (%)", fontweight="bold")
    axes[1, 0].set_xlabel("Overdue %")
    axes[1, 0].grid(True, alpha=0.3)

    # Days since last visit distribution
    axes[1, 1].hist(patient_care["days_since_last"], bins=40, edgecolor="black", alpha=0.7, color="steelblue")
    axes[1, 1].axvline(x=180, color="red", linestyle="--", label="6-month threshold")
    axes[1, 1].axvline(x=365, color="darkred", linestyle="--", label="1-year threshold")
    axes[1, 1].set_title("Days Since Last Visit Distribution", fontweight="bold")
    axes[1, 1].set_xlabel("Days")
    axes[1, 1].set_ylabel("Patient Count")
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/preventive_care_gaps.png", dpi=300, bbox_inches="tight")
    plt.show()

    print(f"\nOverall overdue rate: {patient_care['overdue_visit'].mean() * 100:.1f}%")
    print(f"Chronic patients overdue: {len(chronic_no_followup)}")

    return patient_care


care_gaps = analyze_preventive_care_gaps(df_encounters, df_patients)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Community Health Scoring Model

# COMMAND ----------

from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler


def build_community_health_scores(encounters, patients, facilities):
    """Build composite community health scores by service unit."""
    # Aggregate to service unit level
    enc_merged = encounters.merge(
        patients[["patient_id", "service_unit", "age_group", "gender", "tribal_affiliation"]],
        on="patient_id",
        how="left",
    )
    enc_merged["encounter_date"] = pd.to_datetime(enc_merged["encounter_date"])

    su_health = (
        enc_merged.groupby("service_unit")
        .agg(
            total_patients=("patient_id", "nunique"),
            total_encounters=("encounter_id", "count"),
            ed_rate=("encounter_type", lambda x: (x == "ED").mean()),
            telehealth_rate=("encounter_type", lambda x: (x == "TELEHEALTH").mean()),
            diabetes_rate=("primary_dx_icd10", lambda x: x.str.startswith("E11", na=False).mean()),
            hypertension_rate=("primary_dx_icd10", lambda x: x.str.startswith("I10", na=False).mean()),
            depression_rate=("primary_dx_icd10", lambda x: x.str.startswith("F32", na=False).mean()),
            unique_dx_codes=("primary_dx_icd10", "nunique"),
            n_facilities=("facility_id", "nunique"),
            encounters_per_patient=("encounter_id", lambda x: len(x)),
        )
        .reset_index()
    )

    su_health["encounters_per_patient"] = (
        su_health["total_encounters"] / su_health["total_patients"].clip(lower=1)
    ).round(2)

    # Composite community health score (0-100, higher = healthier)
    su_health["chronic_burden"] = (
        su_health["diabetes_rate"] + su_health["hypertension_rate"] + su_health["depression_rate"]
    )
    su_health["access_index"] = (
        su_health["telehealth_rate"].rank(pct=True) * 25
        + su_health["encounters_per_patient"].rank(pct=True) * 25
        + su_health["n_facilities"].rank(pct=True) * 25
        + (1 - su_health["ed_rate"].rank(pct=True)) * 25
    )
    su_health["burden_index"] = (1 - su_health["chronic_burden"].rank(pct=True)) * 100
    su_health["community_health_score"] = (su_health["access_index"] * 0.5 + su_health["burden_index"] * 0.5).round(1)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Community health score ranking
    su_sorted = su_health.sort_values("community_health_score", ascending=True)
    colors_hs = ["red" if s < 35 else "orange" if s < 50 else "green" for s in su_sorted["community_health_score"]]
    axes[0, 0].barh(su_sorted["service_unit"], su_sorted["community_health_score"], color=colors_hs)
    axes[0, 0].set_title("Community Health Score by Service Unit", fontweight="bold")
    axes[0, 0].set_xlabel("Health Score (0-100, higher = healthier)")
    axes[0, 0].grid(True, alpha=0.3)

    # Access vs burden scatter
    axes[0, 1].scatter(
        su_health["access_index"], su_health["burden_index"], s=su_health["total_patients"] / 5, alpha=0.7, c="teal"
    )
    for _, row in su_health.iterrows():
        axes[0, 1].annotate(row["service_unit"][:10], (row["access_index"], row["burden_index"]), fontsize=7)
    axes[0, 1].set_title("Access Index vs Disease Burden (size = patients)", fontweight="bold")
    axes[0, 1].set_xlabel("Access Index")
    axes[0, 1].set_ylabel("Health Burden Index (higher = lower burden)")
    axes[0, 1].grid(True, alpha=0.3)

    # Key metrics radar-style comparison
    metrics_cols = ["ed_rate", "telehealth_rate", "diabetes_rate", "hypertension_rate", "depression_rate"]
    for su in su_health["service_unit"].head(5):
        row = su_health[su_health["service_unit"] == su][metrics_cols].values.flatten()
        axes[1, 0].plot(metrics_cols, row, marker="o", label=su[:20])
    axes[1, 0].set_title("Key Health Metrics Comparison (Top 5 SUs)", fontweight="bold")
    axes[1, 0].set_ylabel("Rate")
    axes[1, 0].tick_params(axis="x", rotation=45)
    axes[1, 0].legend(fontsize=7)
    axes[1, 0].grid(True, alpha=0.3)

    # Score distribution
    axes[1, 1].hist(su_health["community_health_score"], bins=15, edgecolor="black", alpha=0.7, color="teal")
    axes[1, 1].axvline(
        x=su_health["community_health_score"].median(),
        color="red",
        linestyle="--",
        label=f"Median: {su_health['community_health_score'].median():.0f}",
    )
    axes[1, 1].set_title("Community Health Score Distribution", fontweight="bold")
    axes[1, 1].set_xlabel("Health Score")
    axes[1, 1].set_ylabel("Count")
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/community_health_scores.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nCommunity Health Scores:")
    print(
        su_health[["service_unit", "total_patients", "community_health_score", "access_index", "burden_index"]]
        .sort_values("community_health_score", ascending=False)
        .to_string(index=False)
    )

    return su_health


community_scores = build_community_health_scores(df_encounters, df_patients, df_facilities)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Age-Standardized Rates Calculation
# MAGIC
# MAGIC Direct standardization using the US 2000 Standard Population to enable
# MAGIC valid comparisons of disease prevalence across tribes and service units
# MAGIC with different age distributions.

# COMMAND ----------


def calculate_age_standardized_rates(encounters, patients):
    """
    Calculate age-standardized disease rates using direct standardization.

    Uses the US 2000 Standard Population weights to remove the confounding
    effect of different age distributions when comparing disease rates
    across tribal communities. This is the method recommended by CDC/NCHS.
    """
    # US 2000 Standard Population weights (CDC/NCHS reference)
    us_2000_standard = {
        "0-4": 0.0691,
        "5-14": 0.1453,
        "15-24": 0.1383,
        "25-34": 0.1351,
        "35-44": 0.1620,
        "45-54": 0.1340,
        "55-64": 0.0867,
        "65-74": 0.0661,
        "75+": 0.0634,
    }

    # Merge encounters with demographics
    enc_demo = encounters.merge(
        patients[["patient_id", "tribal_affiliation", "service_unit", "age_group"]], on="patient_id", how="left"
    )

    # Define target conditions with ICD-10 prefixes
    conditions = {
        "Diabetes (E11)": "E11",
        "Hypertension (I10)": "I10",
        "Depression (F32)": "F32",
        "Obesity (E66)": "E66",
        "Asthma (J45)": "J45",
        "CKD (N18)": "N18",
    }

    results = []
    for group_col in ["tribal_affiliation", "service_unit"]:
        for group_name in enc_demo[group_col].dropna().unique():
            group_data = enc_demo[enc_demo[group_col] == group_name]
            group_patients = patients[patients[group_col] == group_name]

            for cond_name, icd_prefix in conditions.items():
                age_specific_rates = []
                weighted_rate = 0.0

                for age_grp, weight in us_2000_standard.items():
                    pop_in_age = len(group_patients[group_patients["age_group"] == age_grp])
                    cases_in_age = group_data[
                        (group_data["age_group"] == age_grp)
                        & (group_data["primary_dx_icd10"].str.startswith(icd_prefix, na=False))
                    ]["patient_id"].nunique()

                    if pop_in_age > 0:
                        crude_rate = cases_in_age / pop_in_age * 1000
                        weighted_rate += crude_rate * weight
                        age_specific_rates.append(crude_rate)

                results.append(
                    {
                        "group_type": group_col,
                        "group_name": group_name,
                        "condition": cond_name,
                        "age_std_rate_per_1000": round(weighted_rate, 2),
                        "n_age_groups_with_data": len(age_specific_rates),
                    }
                )

    asr_df = pd.DataFrame(results)

    # Visualization: age-standardized rates comparison
    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Diabetes ASR by tribe
    diabetes_tribe = asr_df[
        (asr_df["condition"] == "Diabetes (E11)") & (asr_df["group_type"] == "tribal_affiliation")
    ].sort_values("age_std_rate_per_1000", ascending=True)

    axes[0, 0].barh(diabetes_tribe["group_name"], diabetes_tribe["age_std_rate_per_1000"], color="darkred", alpha=0.8)
    axes[0, 0].set_title("Age-Standardized Diabetes Rate by Tribe", fontweight="bold")
    axes[0, 0].set_xlabel("Rate per 1,000 (US 2000 Std Pop)")
    axes[0, 0].grid(True, alpha=0.3)

    # Multi-condition comparison by service unit
    for _i, cond in enumerate(["Diabetes (E11)", "Hypertension (I10)", "Depression (F32)"]):
        su_data = (
            asr_df[(asr_df["condition"] == cond) & (asr_df["group_type"] == "service_unit")]
            .sort_values("age_std_rate_per_1000", ascending=False)
            .head(10)
        )
        if len(su_data) > 0:
            axes[0, 1].barh(
                [f"{su[:15]}" for su in su_data["group_name"]], su_data["age_std_rate_per_1000"], alpha=0.6, label=cond
            )
    axes[0, 1].set_title("Top ASR by Service Unit (3 Conditions)", fontweight="bold")
    axes[0, 1].set_xlabel("Rate per 1,000")
    axes[0, 1].legend(fontsize=7)
    axes[0, 1].grid(True, alpha=0.3)

    # Crude vs age-standardized comparison for diabetes
    tribe_crude = encounters.merge(patients[["patient_id", "tribal_affiliation"]], on="patient_id", how="left")
    crude_rates = {}
    for tribe in patients["tribal_affiliation"].unique():
        tribe_pop = len(patients[patients["tribal_affiliation"] == tribe])
        tribe_cases = tribe_crude[
            (tribe_crude["tribal_affiliation"] == tribe)
            & (tribe_crude["primary_dx_icd10"].str.startswith("E11", na=False))
        ]["patient_id"].nunique()
        if tribe_pop > 0:
            crude_rates[tribe] = tribe_cases / tribe_pop * 1000

    crude_df = pd.DataFrame({"tribe": list(crude_rates.keys()), "crude_rate": list(crude_rates.values())})
    std_df = diabetes_tribe.rename(columns={"group_name": "tribe", "age_std_rate_per_1000": "std_rate"})
    comparison = crude_df.merge(std_df[["tribe", "std_rate"]], on="tribe", how="inner")

    if len(comparison) > 0:
        axes[1, 0].scatter(comparison["crude_rate"], comparison["std_rate"], s=80, alpha=0.7, c="teal")
        for _, row in comparison.iterrows():
            axes[1, 0].annotate(row["tribe"][:12], (row["crude_rate"], row["std_rate"]), fontsize=7)
        max_val = max(comparison["crude_rate"].max(), comparison["std_rate"].max()) * 1.1
        axes[1, 0].plot([0, max_val], [0, max_val], "k--", alpha=0.4, label="Parity line")
        axes[1, 0].set_title("Crude vs Age-Standardized Diabetes Rates", fontweight="bold")
        axes[1, 0].set_xlabel("Crude Rate per 1,000")
        axes[1, 0].set_ylabel("Age-Std Rate per 1,000")
        axes[1, 0].legend()
        axes[1, 0].grid(True, alpha=0.3)

    # Heatmap of ASR across conditions and tribes
    pivot = asr_df[asr_df["group_type"] == "tribal_affiliation"].pivot_table(
        index="group_name", columns="condition", values="age_std_rate_per_1000", aggfunc="first"
    )
    if len(pivot) > 0 and len(pivot.columns) > 0:
        sns.heatmap(pivot, annot=True, fmt=".1f", cmap="YlOrRd", ax=axes[1, 1], cbar_kws={"label": "Rate per 1,000"})
        axes[1, 1].set_title("ASR Heatmap: Conditions x Tribes", fontweight="bold")
        axes[1, 1].tick_params(axis="x", rotation=45)

    plt.tight_layout()
    plt.savefig("/tmp/age_standardized_rates.png", dpi=300, bbox_inches="tight")
    plt.show()

    print(f"\nConditions analyzed: {len(conditions)}")
    print(f"Total ASR records: {len(asr_df)}")

    return asr_df


asr_results = calculate_age_standardized_rates(df_encounters, df_patients)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Health Equity Index
# MAGIC
# MAGIC Composite equity index combining healthcare access, utilization quality,
# MAGIC and chronic disease burden to identify communities needing targeted
# MAGIC resource allocation.

# COMMAND ----------


def build_health_equity_index(encounters, patients, facilities, asr_df):
    """
    Build a Health Equity Index (HEI) for each tribal community.

    The HEI combines four domains:
      1. Access Score - provider ratios, facility proximity, telehealth availability
      2. Utilization Score - preventive vs ED usage patterns
      3. Outcome Score - chronic disease burden (inverted from ASR)
      4. Continuity Score - follow-up rates, care plan adherence
    Each domain is scored 0-25, totaling 0-100 (higher = more equitable).
    """
    enc_demo = encounters.merge(
        patients[["patient_id", "tribal_affiliation", "service_unit", "age_group"]], on="patient_id", how="left"
    )
    enc_demo["encounter_date"] = pd.to_datetime(enc_demo["encounter_date"])

    equity_rows = []
    for tribe in patients["tribal_affiliation"].dropna().unique():
        tribe_patients = patients[patients["tribal_affiliation"] == tribe]
        tribe_enc = enc_demo[enc_demo["tribal_affiliation"] == tribe]
        n_patients = len(tribe_patients)

        if n_patients < 10:
            continue

        # Domain 1: Access Score (0-25)
        n_encounters = len(tribe_enc)
        encounters_per_capita = n_encounters / n_patients
        telehealth_pct = (tribe_enc["encounter_type"] == "TELEHEALTH").mean() * 100
        n_facilities_used = tribe_enc["facility_id"].nunique()

        access_raw = (
            min(encounters_per_capita / 5.0, 1.0) * 10
            + min(telehealth_pct / 20.0, 1.0) * 8
            + min(n_facilities_used / 3.0, 1.0) * 7
        )
        access_score = min(access_raw, 25.0)

        # Domain 2: Utilization Score (0-25)
        ed_pct = (tribe_enc["encounter_type"] == "ED").mean() * 100
        wellness_pct = tribe_enc["encounter_type"].isin(["WELLNESS", "OUTPATIENT"]).mean() * 100
        visit_diversity = tribe_enc["encounter_type"].nunique()

        util_raw = (
            max(0, (1 - ed_pct / 50.0)) * 10 + min(wellness_pct / 40.0, 1.0) * 10 + min(visit_diversity / 4.0, 1.0) * 5
        )
        utilization_score = min(util_raw, 25.0)

        # Domain 3: Outcome Score (0-25) - inverse of disease burden
        tribe_asr = asr_df[(asr_df["group_type"] == "tribal_affiliation") & (asr_df["group_name"] == tribe)]
        avg_asr = tribe_asr["age_std_rate_per_1000"].mean() if len(tribe_asr) > 0 else 0
        outcome_score = max(0, 25 - (avg_asr / 10.0))

        # Domain 4: Continuity Score (0-25)
        ref_date = tribe_enc["encounter_date"].max()
        last_visits = tribe_enc.groupby("patient_id")["encounter_date"].max()
        days_since = (ref_date - last_visits).dt.days
        pct_within_6mo = (days_since <= 180).mean() * 100
        repeat_visits = tribe_enc.groupby("patient_id").size()
        avg_visits = repeat_visits.mean()

        cont_raw = min(pct_within_6mo / 80.0, 1.0) * 15 + min(avg_visits / 5.0, 1.0) * 10
        continuity_score = min(cont_raw, 25.0)

        hei_total = round(access_score + utilization_score + outcome_score + continuity_score, 1)

        equity_rows.append(
            {
                "tribal_affiliation": tribe,
                "n_patients": n_patients,
                "access_score": round(access_score, 1),
                "utilization_score": round(utilization_score, 1),
                "outcome_score": round(outcome_score, 1),
                "continuity_score": round(continuity_score, 1),
                "health_equity_index": hei_total,
                "encounters_per_capita": round(encounters_per_capita, 2),
                "telehealth_pct": round(telehealth_pct, 1),
                "ed_pct": round(ed_pct, 1),
                "avg_asr": round(avg_asr, 2),
                "pct_within_6mo": round(pct_within_6mo, 1),
            }
        )

    hei_df = pd.DataFrame(equity_rows)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # HEI ranking
    hei_sorted = hei_df.sort_values("health_equity_index", ascending=True)
    colors_hei = ["red" if h < 40 else "orange" if h < 60 else "green" for h in hei_sorted["health_equity_index"]]
    axes[0, 0].barh(hei_sorted["tribal_affiliation"], hei_sorted["health_equity_index"], color=colors_hei)
    axes[0, 0].set_title("Health Equity Index by Tribe (red = needs attention)", fontweight="bold")
    axes[0, 0].set_xlabel("HEI Score (0-100)")
    axes[0, 0].grid(True, alpha=0.3)

    # Domain breakdown stacked bar
    domains = ["access_score", "utilization_score", "outcome_score", "continuity_score"]
    domain_labels = ["Access", "Utilization", "Outcome", "Continuity"]
    hei_sorted_top = hei_sorted.head(12)
    bottom = np.zeros(len(hei_sorted_top))
    for d, label in zip(domains, domain_labels):
        axes[0, 1].barh(hei_sorted_top["tribal_affiliation"], hei_sorted_top[d], left=bottom, label=label, alpha=0.8)
        bottom += hei_sorted_top[d].values
    axes[0, 1].set_title("HEI Domain Breakdown", fontweight="bold")
    axes[0, 1].set_xlabel("Score")
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # ED rate vs HEI scatter
    axes[1, 0].scatter(
        hei_df["ed_pct"], hei_df["health_equity_index"], s=hei_df["n_patients"] / 3, alpha=0.7, c="coral"
    )
    for _, row in hei_df.iterrows():
        axes[1, 0].annotate(row["tribal_affiliation"][:10], (row["ed_pct"], row["health_equity_index"]), fontsize=7)
    axes[1, 0].set_title("ED Rate vs Health Equity (size = population)", fontweight="bold")
    axes[1, 0].set_xlabel("ED Visit %")
    axes[1, 0].set_ylabel("Health Equity Index")
    axes[1, 0].grid(True, alpha=0.3)

    # HEI distribution
    axes[1, 1].hist(hei_df["health_equity_index"], bins=12, edgecolor="black", alpha=0.7, color="teal")
    axes[1, 1].axvline(
        x=hei_df["health_equity_index"].median(),
        color="red",
        linestyle="--",
        label=f"Median: {hei_df['health_equity_index'].median():.0f}",
    )
    axes[1, 1].set_title("Health Equity Index Distribution", fontweight="bold")
    axes[1, 1].set_xlabel("HEI Score")
    axes[1, 1].set_ylabel("Tribe Count")
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/health_equity_index.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nHealth Equity Index Summary:")
    print(
        hei_df[
            [
                "tribal_affiliation",
                "n_patients",
                "health_equity_index",
                "access_score",
                "utilization_score",
                "outcome_score",
                "continuity_score",
            ]
        ]
        .sort_values("health_equity_index", ascending=False)
        .to_string(index=False)
    )

    return hei_df


hei_results = build_health_equity_index(df_encounters, df_patients, df_facilities, asr_results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## HEDIS-Aligned Quality Measures
# MAGIC
# MAGIC Healthcare Effectiveness Data and Information Set (HEDIS) measures
# MAGIC adapted for IHS tribal health populations. These standardized metrics
# MAGIC enable benchmarking against national quality targets.

# COMMAND ----------


def calculate_hedis_measures(encounters, patients):
    """
    Calculate HEDIS-aligned quality measures for tribal health populations.

    Measures implemented:
      1. Comprehensive Diabetes Care (CDC) - HbA1c testing rate
      2. Controlling High Blood Pressure (CBP) - follow-up rate
      3. Follow-Up After ED Visit (FUA) - 7-day follow-up
      4. Initiation of Alcohol/Drug Treatment (IET)
      5. Prenatal Care Timeliness (PPC) - first trimester visit
      6. Well-Child Visits (W34) - ages 3-6 annual visit rate
    """
    enc_copy = encounters.copy()
    enc_copy["encounter_date"] = pd.to_datetime(enc_copy["encounter_date"])

    enc_demo = enc_copy.merge(
        patients[["patient_id", "tribal_affiliation", "service_unit", "age_group", "gender"]],
        on="patient_id",
        how="left",
    )

    hedis_results = []

    # --- Measure 1: Comprehensive Diabetes Care (CDC) ---
    diabetes_patients = enc_demo[enc_demo["primary_dx_icd10"].str.startswith("E11", na=False)]["patient_id"].unique()
    n_diabetic = len(diabetes_patients)

    # Proxy: patients with >1 diabetes encounter assumed to have HbA1c testing
    if n_diabetic > 0:
        diabetic_encounters = enc_demo[enc_demo["patient_id"].isin(diabetes_patients)]
        visit_counts = diabetic_encounters.groupby("patient_id")["encounter_id"].count()
        with_followup = (visit_counts >= 2).sum()
        cdc_rate = with_followup / n_diabetic * 100
    else:
        cdc_rate = 0.0

    hedis_results.append(
        {
            "measure": "Comprehensive Diabetes Care",
            "code": "CDC",
            "numerator": int(with_followup) if n_diabetic > 0 else 0,
            "denominator": n_diabetic,
            "rate": round(cdc_rate, 1),
            "benchmark": 85.0,
            "met_benchmark": cdc_rate >= 85.0,
        }
    )

    # --- Measure 2: Controlling High Blood Pressure (CBP) ---
    htn_patients = enc_demo[enc_demo["primary_dx_icd10"].str.startswith("I10", na=False)]["patient_id"].unique()
    n_htn = len(htn_patients)

    if n_htn > 0:
        htn_enc = enc_demo[enc_demo["patient_id"].isin(htn_patients)]
        htn_followups = htn_enc.groupby("patient_id").agg(
            n_visits=("encounter_id", "count"), has_outpatient=("encounter_type", lambda x: "OUTPATIENT" in x.values)
        )
        cbp_met = ((htn_followups["n_visits"] >= 2) & (htn_followups["has_outpatient"])).sum()
        cbp_rate = cbp_met / n_htn * 100
    else:
        cbp_met, cbp_rate = 0, 0.0

    hedis_results.append(
        {
            "measure": "Controlling High BP",
            "code": "CBP",
            "numerator": int(cbp_met),
            "denominator": n_htn,
            "rate": round(cbp_rate, 1),
            "benchmark": 60.0,
            "met_benchmark": cbp_rate >= 60.0,
        }
    )

    # --- Measure 3: Follow-Up After ED Visit (FUA) - 7-day ---
    ed_visits = enc_demo[enc_demo["encounter_type"] == "ED"].copy()
    n_ed = len(ed_visits["patient_id"].unique())
    followup_count = 0

    if n_ed > 0:
        for pid in ed_visits["patient_id"].unique()[:500]:  # Sample for performance
            p_ed = ed_visits[ed_visits["patient_id"] == pid]["encounter_date"].min()
            p_all = enc_demo[
                (enc_demo["patient_id"] == pid)
                & (enc_demo["encounter_type"] != "ED")
                & (enc_demo["encounter_date"] > p_ed)
                & (enc_demo["encounter_date"] <= p_ed + pd.Timedelta(days=7))
            ]
            if len(p_all) > 0:
                followup_count += 1
        fua_rate = followup_count / min(n_ed, 500) * 100
    else:
        fua_rate = 0.0

    hedis_results.append(
        {
            "measure": "ED Follow-Up (7-day)",
            "code": "FUA",
            "numerator": followup_count,
            "denominator": min(n_ed, 500),
            "rate": round(fua_rate, 1),
            "benchmark": 50.0,
            "met_benchmark": fua_rate >= 50.0,
        }
    )

    # --- Measure 4: Substance Abuse Treatment Initiation (IET) ---
    sud_patients = enc_demo[enc_demo["primary_dx_icd10"].str.startswith(("F10", "F11", "F12", "F13"), na=False)][
        "patient_id"
    ].unique()
    n_sud = len(sud_patients)

    if n_sud > 0:
        sud_enc = enc_demo[enc_demo["patient_id"].isin(sud_patients)]
        sud_followup = sud_enc.groupby("patient_id")["encounter_id"].count()
        iet_met = (sud_followup >= 2).sum()
        iet_rate = iet_met / n_sud * 100
    else:
        iet_met, iet_rate = 0, 0.0

    hedis_results.append(
        {
            "measure": "SUD Treatment Initiation",
            "code": "IET",
            "numerator": int(iet_met),
            "denominator": n_sud,
            "rate": round(iet_rate, 1),
            "benchmark": 40.0,
            "met_benchmark": iet_rate >= 40.0,
        }
    )

    # --- Measure 5: Well-Child Visits (W34) ages 3-6 ---
    child_patients = patients[patients["age_group"].isin(["0-4", "5-14"])]
    n_children = len(child_patients)

    if n_children > 0:
        child_enc = enc_demo[
            enc_demo["patient_id"].isin(child_patients["patient_id"])
            & enc_demo["encounter_type"].isin(["WELLNESS", "OUTPATIENT"])
        ]
        children_with_wellness = child_enc["patient_id"].nunique()
        w34_rate = children_with_wellness / n_children * 100
    else:
        children_with_wellness, w34_rate = 0, 0.0

    hedis_results.append(
        {
            "measure": "Well-Child Visits",
            "code": "W34",
            "numerator": int(children_with_wellness),
            "denominator": n_children,
            "rate": round(w34_rate, 1),
            "benchmark": 70.0,
            "met_benchmark": w34_rate >= 70.0,
        }
    )

    # --- Measure 6: Adult BMI Assessment (ABA) proxy ---
    adult_patients = patients[~patients["age_group"].isin(["0-4", "5-14", "15-24"])]
    n_adults = len(adult_patients)

    if n_adults > 0:
        adult_enc = enc_demo[
            enc_demo["patient_id"].isin(adult_patients["patient_id"])
            & enc_demo["encounter_type"].isin(["WELLNESS", "OUTPATIENT"])
        ]
        adults_with_checkup = adult_enc["patient_id"].nunique()
        aba_rate = adults_with_checkup / n_adults * 100
    else:
        adults_with_checkup, aba_rate = 0, 0.0

    hedis_results.append(
        {
            "measure": "Adult Preventive Visit",
            "code": "ABA",
            "numerator": int(adults_with_checkup),
            "denominator": n_adults,
            "rate": round(aba_rate, 1),
            "benchmark": 75.0,
            "met_benchmark": aba_rate >= 75.0,
        }
    )

    hedis_df = pd.DataFrame(hedis_results)

    # Visualization
    fig, axes = plt.subplots(1, 2, figsize=(18, 7))

    # Rate vs benchmark
    x = range(len(hedis_df))
    axes[0].bar(x, hedis_df["rate"], width=0.35, label="Actual", color="steelblue", alpha=0.8)
    axes[0].bar([i + 0.35 for i in x], hedis_df["benchmark"], width=0.35, label="Benchmark", color="green", alpha=0.5)
    axes[0].set_xticks([i + 0.175 for i in x])
    axes[0].set_xticklabels(hedis_df["code"], rotation=45)
    axes[0].set_title("HEDIS Quality Measures: Actual vs Benchmark", fontweight="bold")
    axes[0].set_ylabel("Rate (%)")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # Gap from benchmark
    hedis_df["gap"] = hedis_df["rate"] - hedis_df["benchmark"]
    colors_gap = ["green" if g >= 0 else "red" for g in hedis_df["gap"]]
    axes[1].barh(hedis_df["measure"], hedis_df["gap"], color=colors_gap, alpha=0.8)
    axes[1].axvline(x=0, color="black", linewidth=0.8)
    axes[1].set_title("Gap from HEDIS Benchmark (green = met)", fontweight="bold")
    axes[1].set_xlabel("Percentage Points from Benchmark")
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/hedis_quality_measures.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nHEDIS Quality Measures:")
    print(
        hedis_df[["measure", "code", "numerator", "denominator", "rate", "benchmark", "met_benchmark"]].to_string(
            index=False
        )
    )
    met_count = hedis_df["met_benchmark"].sum()
    print(f"\nMeasures meeting benchmark: {met_count}/{len(hedis_df)}")

    return hedis_df


hedis_results = calculate_hedis_measures(df_encounters, df_patients)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Extended Results

# COMMAND ----------

# Save community health scores
chs_spark = spark.createDataFrame(community_scores)
chs_spark = chs_spark.withColumn("analysis_date", current_date())

(chs_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_community_health_scores"))

print("Saved to gold.gld_community_health_scores")

# COMMAND ----------

# Save age-standardized rates
asr_spark = spark.createDataFrame(asr_results)
asr_spark = asr_spark.withColumn("analysis_date", current_date())

(asr_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_age_standardized_rates"))

print("Saved to gold.gld_age_standardized_rates")

# COMMAND ----------

# Save health equity index
hei_spark = spark.createDataFrame(hei_results)
hei_spark = hei_spark.withColumn("analysis_date", current_date())

(hei_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_health_equity_index"))

print("Saved to gold.gld_health_equity_index")

# COMMAND ----------

# Save HEDIS quality measures
hedis_spark = spark.createDataFrame(hedis_results)
hedis_spark = hedis_spark.withColumn("analysis_date", current_date())

(hedis_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_hedis_quality_measures"))

print("Saved to gold.gld_hedis_quality_measures")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("POPULATION HEALTH DASHBOARD - COMPREHENSIVE SUMMARY")
print("=" * 65)
print(f"\nPatients: {len(df_patients):,}")
print(f"Encounters: {len(df_encounters):,}")
print(f"Facilities: {len(df_facilities):,}")
print(f"Tribes: {df_patients['tribal_affiliation'].nunique()}")
print(f"Service Units: {df_patients['service_unit'].nunique()}")
print(f"\nOverdue visit rate: {care_gaps['overdue_visit'].mean() * 100:.1f}%")
print(f"Avg community health score: {community_scores['community_health_score'].mean():.1f}")
print(f"Avg health equity index: {hei_results['health_equity_index'].mean():.1f}")
hedis_met = hedis_results["met_benchmark"].sum()
print(f"HEDIS measures meeting benchmark: {hedis_met}/{len(hedis_results)}")
print(f"Age-standardized rate records: {len(asr_results)}")
print("\nAll data is SYNTHETIC - no real PHI")
print("\nOutputs:")
print("  gold.gld_population_health_summary")
print("  gold.gld_community_health_scores")
print("  gold.gld_age_standardized_rates")
print("  gold.gld_health_equity_index")
print("  gold.gld_hedis_quality_measures")
print("=" * 65)
