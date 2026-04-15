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

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

from scipy import stats
from pyspark.sql import SparkSession
from pyspark.sql.functions import *

plt.style.use('seaborn-v0_8')
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

    encounters['encounter_date'] = pd.to_datetime(encounters['encounter_date'])

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
    tribe_counts = patients['tribal_affiliation'].value_counts().head(10)
    tribe_counts.plot(kind='barh', ax=axes[0, 0], color=sns.color_palette('viridis', len(tribe_counts)))
    axes[0, 0].set_title('Patient Population by Tribal Affiliation', fontweight='bold')
    axes[0, 0].set_xlabel('Patient Count')
    axes[0, 0].grid(True, alpha=0.3)

    # Age group distribution
    age_order = ['0-4', '5-14', '15-24', '25-34', '35-44', '45-54', '55-64', '65-74', '75+']
    age_data = patients['age_group'].value_counts().reindex(age_order).fillna(0)
    axes[0, 1].bar(age_data.index, age_data.values, color=sns.color_palette('coolwarm', len(age_data)))
    axes[0, 1].set_title('Age Group Distribution', fontweight='bold')
    axes[0, 1].set_xlabel('Age Group')
    axes[0, 1].set_ylabel('Count')
    axes[0, 1].tick_params(axis='x', rotation=45)
    axes[0, 1].grid(True, alpha=0.3)

    # Gender distribution by service unit
    gender_by_su = patients.groupby(['service_unit', 'gender']).size().unstack(fill_value=0)
    gender_by_su.head(10).plot(kind='bar', ax=axes[1, 0], stacked=True)
    axes[1, 0].set_title('Gender by Service Unit', fontweight='bold')
    axes[1, 0].set_ylabel('Count')
    axes[1, 0].tick_params(axis='x', rotation=45)
    axes[1, 0].legend(title='Gender')
    axes[1, 0].grid(True, alpha=0.3)

    # Eligibility status
    status_counts = patients['eligibility_status'].value_counts()
    axes[1, 1].pie(status_counts.values, labels=status_counts.index, autopct='%1.1f%%',
                   colors=sns.color_palette('Set2', len(status_counts)))
    axes[1, 1].set_title('Eligibility Status', fontweight='bold')

    plt.tight_layout()
    plt.savefig('/tmp/tribal_demographics.png', dpi=300, bbox_inches='tight')
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
        'E': 'Endocrine/Metabolic', 'I': 'Circulatory', 'J': 'Respiratory',
        'F': 'Mental/Behavioral', 'M': 'Musculoskeletal', 'K': 'Digestive',
        'N': 'Genitourinary', 'L': 'Skin', 'H': 'Eye/Ear',
        'S': 'Injury', 'Z': 'Factors/Health Status', 'R': 'Symptoms/Signs'
    }

    encounters_with_chapter = encounters.copy()
    encounters_with_chapter['dx_chapter'] = encounters_with_chapter['primary_dx_icd10'].str[0]
    encounters_with_chapter['dx_category'] = encounters_with_chapter['dx_chapter'].map(icd10_chapters).fillna('Other')

    fig, axes = plt.subplots(2, 2, figsize=(18, 12))

    # Top diagnoses
    dx_counts = encounters_with_chapter['dx_category'].value_counts()
    dx_counts.plot(kind='barh', ax=axes[0, 0], color=sns.color_palette('mako', len(dx_counts)))
    axes[0, 0].set_title('Encounter Volume by Diagnosis Category', fontweight='bold')
    axes[0, 0].set_xlabel('Encounter Count')
    axes[0, 0].grid(True, alpha=0.3)

    # Top specific ICD-10 codes
    top_dx = encounters['primary_dx_icd10'].value_counts().head(15)
    top_dx.plot(kind='barh', ax=axes[0, 1], color='steelblue')
    axes[0, 1].set_title('Top 15 ICD-10 Diagnosis Codes', fontweight='bold')
    axes[0, 1].set_xlabel('Count')
    axes[0, 1].grid(True, alpha=0.3)

    # Encounter type distribution
    enc_type = encounters['encounter_type'].value_counts()
    axes[1, 0].pie(enc_type.values, labels=enc_type.index, autopct='%1.1f%%',
                   colors=sns.color_palette('Set3', len(enc_type)))
    axes[1, 0].set_title('Encounter Type Distribution', fontweight='bold')

    # Encounters over time
    encounters_with_chapter['year_month'] = encounters_with_chapter['encounter_date'].dt.to_period('M')
    monthly_enc = encounters_with_chapter.groupby('year_month').size()
    monthly_enc.index = monthly_enc.index.to_timestamp()
    axes[1, 1].plot(monthly_enc.index, monthly_enc.values, marker='.', linewidth=1.5, color='teal')
    axes[1, 1].fill_between(monthly_enc.index, monthly_enc.values, alpha=0.3)
    axes[1, 1].set_title('Monthly Encounter Volume', fontweight='bold')
    axes[1, 1].set_xlabel('Date')
    axes[1, 1].set_ylabel('Encounters')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/disease_prevalence.png', dpi=300, bbox_inches='tight')
    plt.show()

    # Diabetes prevalence by tribe
    diabetes = encounters[encounters['primary_dx_icd10'].str.startswith('E11', na=False)]
    diabetes_by_tribe = diabetes.merge(df_patients[['patient_id', 'tribal_affiliation']], on='patient_id')
    tribe_diabetes = diabetes_by_tribe['tribal_affiliation'].value_counts()
    tribe_total = df_patients['tribal_affiliation'].value_counts()
    diabetes_rate = (tribe_diabetes / tribe_total * 1000).dropna().sort_values(ascending=False)

    if len(diabetes_rate) > 0:
        fig2, ax2 = plt.subplots(figsize=(12, 6))
        diabetes_rate.plot(kind='barh', ax=ax2, color='darkred')
        ax2.set_title('Type 2 Diabetes Rate per 1,000 Patients by Tribe', fontweight='bold')
        ax2.set_xlabel('Rate per 1,000')
        ax2.grid(True, alpha=0.3)
        plt.tight_layout()
        plt.savefig('/tmp/diabetes_by_tribe.png', dpi=300, bbox_inches='tight')
        plt.show()

analyze_disease_prevalence(df_encounters)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Facility Utilization

# COMMAND ----------

def analyze_facilities(facilities, encounters):
    """Analyze facility utilization."""
    facility_encounters = encounters.groupby('facility_id').agg(
        encounter_count=('encounter_id', 'count'),
        unique_patients=('patient_id', 'nunique'),
        avg_daily=('encounter_date', lambda x: len(x) / max((x.max() - x.min()).days, 1))
    ).reset_index()

    merged = facilities.merge(facility_encounters, on='facility_id', how='left').fillna(0)

    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    # Encounters per facility
    merged_sorted = merged.sort_values('encounter_count', ascending=False).head(15)
    colors = {'HOSPITAL': 'steelblue', 'HEALTH_CENTER': 'green', 'SATELLITE': 'orange'}
    bar_colors = [colors.get(ft, 'gray') for ft in merged_sorted['facility_type']]

    axes[0].barh(merged_sorted['facility_name'].str[:30], merged_sorted['encounter_count'], color=bar_colors)
    axes[0].set_title('Top Facilities by Encounter Volume', fontweight='bold')
    axes[0].set_xlabel('Encounters')
    axes[0].grid(True, alpha=0.3)

    # Provider to patient ratio
    merged['patients_per_provider'] = (merged['unique_patients'] / merged['provider_count'].clip(lower=1)).round(1)
    merged_hosp = merged[merged['facility_type'] == 'HOSPITAL'].sort_values('patients_per_provider', ascending=False)

    if len(merged_hosp) > 0:
        axes[1].barh(merged_hosp['facility_name'].str[:30], merged_hosp['patients_per_provider'], color='coral')
        axes[1].set_title('Patients per Provider (Hospitals)', fontweight='bold')
        axes[1].set_xlabel('Ratio')
        axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/facility_utilization.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_facilities(df_facilities, df_encounters)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results

# COMMAND ----------

# Aggregate health metrics and save
health_summary = df_encounters.merge(
    df_patients[['patient_id', 'tribal_affiliation', 'service_unit', 'age_group', 'gender']],
    on='patient_id', how='left'
)

summary_agg = health_summary.groupby(['tribal_affiliation', 'service_unit']).agg(
    total_encounters=('encounter_id', 'count'),
    unique_patients=('patient_id', 'nunique'),
    diabetes_encounters=('primary_dx_icd10', lambda x: x.str.startswith('E11', na=False).sum()),
    ed_visits=('encounter_type', lambda x: (x == 'ED').sum()),
    telehealth_visits=('encounter_type', lambda x: (x == 'TELEHEALTH').sum())
).reset_index()

summary_spark = spark.createDataFrame(summary_agg)
summary_spark = summary_spark.withColumn("analysis_date", current_date())

(summary_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_population_health_summary"))

print("Saved to gold.gld_population_health_summary")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("POPULATION HEALTH DASHBOARD - SUMMARY")
print("=" * 65)
print(f"\nPatients: {len(df_patients):,}")
print(f"Encounters: {len(df_encounters):,}")
print(f"Facilities: {len(df_facilities):,}")
print(f"Tribes: {df_patients['tribal_affiliation'].nunique()}")
print(f"Service Units: {df_patients['service_unit'].nunique()}")
print(f"\nAll data is SYNTHETIC - no real PHI")
print(f"Output: gold.gld_population_health_summary")
print("=" * 65)
