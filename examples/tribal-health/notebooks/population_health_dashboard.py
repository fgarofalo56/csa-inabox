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

warnings.filterwarnings('ignore')

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
    enc_copy['encounter_date'] = pd.to_datetime(enc_copy['encounter_date'])
    enc_copy['year_month'] = enc_copy['encounter_date'].dt.to_period('M')
    enc_copy['year'] = enc_copy['encounter_date'].dt.year
    enc_copy['quarter'] = enc_copy['encounter_date'].dt.quarter

    # Merge demographics
    enc_demo = enc_copy.merge(
        patients[['patient_id', 'tribal_affiliation', 'service_unit', 'age_group', 'gender']],
        on='patient_id', how='left'
    )

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Patient growth by service unit over time
    su_quarterly = enc_demo.groupby(['service_unit', 'year', 'quarter'])['patient_id'].nunique().reset_index()
    su_quarterly['period'] = su_quarterly['year'].astype(str) + 'Q' + su_quarterly['quarter'].astype(str)
    for su in patients['service_unit'].unique()[:6]:
        su_data = su_quarterly[su_quarterly['service_unit'] == su]
        axes[0, 0].plot(range(len(su_data)), su_data['patient_id'], marker='o',
                       label=su[:20], linewidth=1.5)
    axes[0, 0].set_title('Unique Patients by Service Unit (Quarterly)', fontweight='bold')
    axes[0, 0].set_xlabel('Quarter')
    axes[0, 0].set_ylabel('Unique Patients')
    axes[0, 0].legend(fontsize=7)
    axes[0, 0].grid(True, alpha=0.3)

    # Age distribution shifts
    age_order = ['0-4', '5-14', '15-24', '25-34', '35-44', '45-54', '55-64', '65-74', '75+']
    tribe_age = patients.groupby(['tribal_affiliation', 'age_group']).size().unstack(fill_value=0)
    tribe_age = tribe_age.reindex(columns=[a for a in age_order if a in tribe_age.columns])
    tribe_age_pct = tribe_age.div(tribe_age.sum(axis=1), axis=0) * 100
    tribe_age_pct.head(6).plot(kind='bar', stacked=True, ax=axes[0, 1],
                               cmap='viridis')
    axes[0, 1].set_title('Age Distribution by Tribe (Top 6)', fontweight='bold')
    axes[0, 1].set_ylabel('Percentage')
    axes[0, 1].tick_params(axis='x', rotation=45)
    axes[0, 1].legend(fontsize=7, bbox_to_anchor=(1.05, 1))
    axes[0, 1].grid(True, alpha=0.3)

    # Gender ratio by tribe
    gender_ratio = patients.groupby('tribal_affiliation')['gender'].value_counts(normalize=True).unstack(fill_value=0)
    if 'F' in gender_ratio.columns and 'M' in gender_ratio.columns:
        gender_ratio['female_pct'] = gender_ratio['F'] * 100
        gender_ratio = gender_ratio.sort_values('female_pct')
        axes[1, 0].barh(gender_ratio.index, gender_ratio['female_pct'], color='coral', label='Female %')
        axes[1, 0].axvline(x=50, color='black', linestyle='--', alpha=0.5)
        axes[1, 0].set_title('Female Percentage by Tribe', fontweight='bold')
        axes[1, 0].set_xlabel('Female %')
        axes[1, 0].grid(True, alpha=0.3)

    # Monthly encounter trend with moving average
    monthly = enc_copy.groupby('year_month').size()
    monthly.index = monthly.index.to_timestamp()
    axes[1, 1].plot(monthly.index, monthly.values, alpha=0.5, linewidth=1, color='steelblue')
    if len(monthly) >= 3:
        rolling = monthly.rolling(window=3, min_periods=1).mean()
        axes[1, 1].plot(monthly.index, rolling.values, linewidth=2, color='red',
                       label='3-month MA')
    axes[1, 1].set_title('Monthly Encounter Trend with Moving Average', fontweight='bold')
    axes[1, 1].set_xlabel('Date')
    axes[1, 1].set_ylabel('Encounter Count')
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/demographic_trends.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_demographic_trends(df_patients, df_encounters)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Healthcare Utilization Patterns

# COMMAND ----------

def analyze_utilization_patterns(encounters, patients, facilities):
    """Analyze healthcare utilization patterns across encounter types and facilities."""
    enc_demo = encounters.merge(
        patients[['patient_id', 'tribal_affiliation', 'service_unit', 'age_group']],
        on='patient_id', how='left'
    )
    enc_demo['encounter_date'] = pd.to_datetime(enc_demo['encounter_date'])

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Encounter type by age group
    type_age = enc_demo.groupby(['age_group', 'encounter_type']).size().unstack(fill_value=0)
    age_order = ['0-4', '5-14', '15-24', '25-34', '35-44', '45-54', '55-64', '65-74', '75+']
    type_age = type_age.reindex([a for a in age_order if a in type_age.index])
    type_age_pct = type_age.div(type_age.sum(axis=1), axis=0) * 100
    type_age_pct.plot(kind='bar', stacked=True, ax=axes[0, 0])
    axes[0, 0].set_title('Encounter Type Mix by Age Group (%)', fontweight='bold')
    axes[0, 0].set_ylabel('Percentage')
    axes[0, 0].tick_params(axis='x', rotation=45)
    axes[0, 0].legend(fontsize=7)
    axes[0, 0].grid(True, alpha=0.3)

    # ED visit frequency distribution
    ed_per_patient = enc_demo[enc_demo['encounter_type'] == 'ED'].groupby('patient_id').size()
    axes[0, 1].hist(ed_per_patient, bins=range(1, ed_per_patient.max() + 2),
                   edgecolor='black', alpha=0.7, color='coral')
    axes[0, 1].set_title('ED Visit Frequency Distribution', fontweight='bold')
    axes[0, 1].set_xlabel('Number of ED Visits per Patient')
    axes[0, 1].set_ylabel('Patient Count')
    axes[0, 1].grid(True, alpha=0.3)
    # Annotate heavy users
    heavy_ed = (ed_per_patient >= 5).sum()
    axes[0, 1].annotate(f'Heavy users (>=5): {heavy_ed}',
                        xy=(0.95, 0.95), xycoords='axes fraction',
                        ha='right', va='top',
                        bbox={'boxstyle': 'round', 'facecolor': 'wheat'})

    # Telehealth adoption over time
    enc_demo['month'] = enc_demo['encounter_date'].dt.to_period('M')
    monthly_type = enc_demo.groupby(['month', 'encounter_type']).size().unstack(fill_value=0)
    monthly_type.index = monthly_type.index.to_timestamp()
    if 'TELEHEALTH' in monthly_type.columns:
        monthly_type['telehealth_pct'] = (
            monthly_type['TELEHEALTH'] / monthly_type.sum(axis=1) * 100
        )
        axes[1, 0].plot(monthly_type.index, monthly_type['telehealth_pct'],
                       marker='.', linewidth=1.5, color='teal')
        axes[1, 0].fill_between(monthly_type.index, monthly_type['telehealth_pct'], alpha=0.2)
        axes[1, 0].set_title('Telehealth Adoption Rate Over Time', fontweight='bold')
        axes[1, 0].set_xlabel('Date')
        axes[1, 0].set_ylabel('Telehealth % of All Encounters')
        axes[1, 0].grid(True, alpha=0.3)

    # Facility utilization rate
    fac_enc = encounters.groupby('facility_id').agg(
        encounters=('encounter_id', 'count'),
        unique_patients=('patient_id', 'nunique')
    ).reset_index()
    fac_merged = facilities.merge(fac_enc, on='facility_id', how='left').fillna(0)
    fac_merged['utilization_rate'] = (
        fac_merged['encounters'] / fac_merged['bed_count'].clip(lower=1) / 365
    ).round(2)

    fac_sorted = fac_merged.sort_values('utilization_rate', ascending=False).head(15)
    colors_fac = ['red' if u > 0.8 else 'orange' if u > 0.5 else 'green'
                  for u in fac_sorted['utilization_rate']]
    axes[1, 1].barh(fac_sorted['facility_name'].str[:25], fac_sorted['utilization_rate'],
                   color=colors_fac)
    axes[1, 1].set_title('Facility Utilization Rate (red = overloaded)', fontweight='bold')
    axes[1, 1].set_xlabel('Utilization Rate')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/utilization_patterns.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_utilization_patterns(df_encounters, df_patients, df_facilities)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Preventive Care Gap Analysis

# COMMAND ----------

def analyze_preventive_care_gaps(encounters, patients):
    """Identify preventive care gaps by analyzing visit patterns and chronic disease screening."""
    enc_copy = encounters.copy()
    enc_copy['encounter_date'] = pd.to_datetime(enc_copy['encounter_date'])

    # Patient-level care metrics
    patient_care = enc_copy.groupby('patient_id').agg(
        last_visit=('encounter_date', 'max'),
        total_visits=('encounter_id', 'count'),
        visit_types=('encounter_type', 'nunique'),
        has_wellness=('encounter_type', lambda x: ('WELLNESS' in x.values or 'OUTPATIENT' in x.values)),
        has_chronic_dx=('primary_dx_icd10', lambda x: any(
            x.str.startswith(p, na=False).any() for p in ['E11', 'I10', 'E66']
        )),
        ed_only=('encounter_type', lambda x: all(v == 'ED' for v in x)),
        first_visit=('encounter_date', 'min')
    ).reset_index()

    patient_care = patient_care.merge(
        patients[['patient_id', 'age_group', 'tribal_affiliation', 'service_unit', 'gender']],
        on='patient_id', how='left'
    )

    ref_date = enc_copy['encounter_date'].max()
    patient_care['days_since_last'] = (ref_date - patient_care['last_visit']).dt.days
    patient_care['overdue_visit'] = patient_care['days_since_last'] > 180  # 6 months

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Overdue rate by tribe
    overdue_by_tribe = patient_care.groupby('tribal_affiliation').agg(
        overdue_rate=('overdue_visit', 'mean'),
        n_patients=('patient_id', 'count')
    ).sort_values('overdue_rate', ascending=True).reset_index()

    colors_od = ['red' if r > 0.4 else 'orange' if r > 0.2 else 'green'
                 for r in overdue_by_tribe['overdue_rate']]
    axes[0, 0].barh(overdue_by_tribe['tribal_affiliation'],
                   overdue_by_tribe['overdue_rate'] * 100, color=colors_od)
    axes[0, 0].set_title('Overdue Visit Rate by Tribe (>6 months)', fontweight='bold')
    axes[0, 0].set_xlabel('Overdue Rate (%)')
    axes[0, 0].grid(True, alpha=0.3)

    # Care gap by age group
    gap_by_age = patient_care.groupby('age_group').agg(
        overdue_rate=('overdue_visit', 'mean'),
        ed_only_rate=('ed_only', 'mean'),
        wellness_rate=('has_wellness', 'mean')
    ).reset_index()
    age_order = ['0-4', '5-14', '15-24', '25-34', '35-44', '45-54', '55-64', '65-74', '75+']
    gap_by_age = gap_by_age.set_index('age_group').reindex(
        [a for a in age_order if a in gap_by_age['age_group'].values]
    ).reset_index()

    x = range(len(gap_by_age))
    w = 0.25
    axes[0, 1].bar(x, gap_by_age['overdue_rate'] * 100, width=w, label='Overdue', color='red', alpha=0.7)
    axes[0, 1].bar([i + w for i in x], gap_by_age['ed_only_rate'] * 100, width=w,
                  label='ED-Only', color='orange', alpha=0.7)
    axes[0, 1].bar([i + 2*w for i in x], gap_by_age['wellness_rate'] * 100, width=w,
                  label='Has Wellness', color='green', alpha=0.7)
    axes[0, 1].set_xticks([i + w for i in x])
    axes[0, 1].set_xticklabels(gap_by_age['age_group'], rotation=45)
    axes[0, 1].set_title('Care Gap Indicators by Age Group (%)', fontweight='bold')
    axes[0, 1].set_ylabel('Rate (%)')
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Chronic disease patients without regular follow-up
    chronic_no_followup = patient_care[
        (patient_care['has_chronic_dx']) & (patient_care['overdue_visit'])
    ]
    gap_by_su = patient_care[patient_care['has_chronic_dx']].groupby('service_unit').agg(
        total_chronic=('patient_id', 'count'),
        overdue_chronic=('overdue_visit', 'sum')
    ).reset_index()
    gap_by_su['overdue_pct'] = (gap_by_su['overdue_chronic'] / gap_by_su['total_chronic'] * 100).round(1)
    gap_by_su = gap_by_su.sort_values('overdue_pct', ascending=True)

    axes[1, 0].barh(gap_by_su['service_unit'], gap_by_su['overdue_pct'], color='darkred')
    axes[1, 0].set_title('Chronic Patients Overdue for Follow-Up by SU (%)', fontweight='bold')
    axes[1, 0].set_xlabel('Overdue %')
    axes[1, 0].grid(True, alpha=0.3)

    # Days since last visit distribution
    axes[1, 1].hist(patient_care['days_since_last'], bins=40, edgecolor='black',
                   alpha=0.7, color='steelblue')
    axes[1, 1].axvline(x=180, color='red', linestyle='--', label='6-month threshold')
    axes[1, 1].axvline(x=365, color='darkred', linestyle='--', label='1-year threshold')
    axes[1, 1].set_title('Days Since Last Visit Distribution', fontweight='bold')
    axes[1, 1].set_xlabel('Days')
    axes[1, 1].set_ylabel('Patient Count')
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/preventive_care_gaps.png', dpi=300, bbox_inches='tight')
    plt.show()

    print(f"\nOverall overdue rate: {patient_care['overdue_visit'].mean()*100:.1f}%")
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
        patients[['patient_id', 'service_unit', 'age_group', 'gender', 'tribal_affiliation']],
        on='patient_id', how='left'
    )
    enc_merged['encounter_date'] = pd.to_datetime(enc_merged['encounter_date'])

    su_health = enc_merged.groupby('service_unit').agg(
        total_patients=('patient_id', 'nunique'),
        total_encounters=('encounter_id', 'count'),
        ed_rate=('encounter_type', lambda x: (x == 'ED').mean()),
        telehealth_rate=('encounter_type', lambda x: (x == 'TELEHEALTH').mean()),
        diabetes_rate=('primary_dx_icd10', lambda x: x.str.startswith('E11', na=False).mean()),
        hypertension_rate=('primary_dx_icd10', lambda x: x.str.startswith('I10', na=False).mean()),
        depression_rate=('primary_dx_icd10', lambda x: x.str.startswith('F32', na=False).mean()),
        unique_dx_codes=('primary_dx_icd10', 'nunique'),
        n_facilities=('facility_id', 'nunique'),
        encounters_per_patient=('encounter_id', lambda x: len(x))
    ).reset_index()

    su_health['encounters_per_patient'] = (
        su_health['total_encounters'] / su_health['total_patients'].clip(lower=1)
    ).round(2)

    # Composite community health score (0-100, higher = healthier)
    su_health['chronic_burden'] = (
        su_health['diabetes_rate'] + su_health['hypertension_rate'] + su_health['depression_rate']
    )
    su_health['access_index'] = (
        su_health['telehealth_rate'].rank(pct=True) * 25 +
        su_health['encounters_per_patient'].rank(pct=True) * 25 +
        su_health['n_facilities'].rank(pct=True) * 25 +
        (1 - su_health['ed_rate'].rank(pct=True)) * 25
    )
    su_health['burden_index'] = (
        (1 - su_health['chronic_burden'].rank(pct=True)) * 100
    )
    su_health['community_health_score'] = (
        su_health['access_index'] * 0.5 + su_health['burden_index'] * 0.5
    ).round(1)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Community health score ranking
    su_sorted = su_health.sort_values('community_health_score', ascending=True)
    colors_hs = ['red' if s < 35 else 'orange' if s < 50 else 'green'
                 for s in su_sorted['community_health_score']]
    axes[0, 0].barh(su_sorted['service_unit'], su_sorted['community_health_score'], color=colors_hs)
    axes[0, 0].set_title('Community Health Score by Service Unit', fontweight='bold')
    axes[0, 0].set_xlabel('Health Score (0-100, higher = healthier)')
    axes[0, 0].grid(True, alpha=0.3)

    # Access vs burden scatter
    axes[0, 1].scatter(su_health['access_index'], su_health['burden_index'],
                      s=su_health['total_patients'] / 5, alpha=0.7, c='teal')
    for _, row in su_health.iterrows():
        axes[0, 1].annotate(row['service_unit'][:10],
                           (row['access_index'], row['burden_index']), fontsize=7)
    axes[0, 1].set_title('Access Index vs Disease Burden (size = patients)', fontweight='bold')
    axes[0, 1].set_xlabel('Access Index')
    axes[0, 1].set_ylabel('Health Burden Index (higher = lower burden)')
    axes[0, 1].grid(True, alpha=0.3)

    # Key metrics radar-style comparison
    metrics_cols = ['ed_rate', 'telehealth_rate', 'diabetes_rate', 'hypertension_rate', 'depression_rate']
    for su in su_health['service_unit'].head(5):
        row = su_health[su_health['service_unit'] == su][metrics_cols].values.flatten()
        axes[1, 0].plot(metrics_cols, row, marker='o', label=su[:20])
    axes[1, 0].set_title('Key Health Metrics Comparison (Top 5 SUs)', fontweight='bold')
    axes[1, 0].set_ylabel('Rate')
    axes[1, 0].tick_params(axis='x', rotation=45)
    axes[1, 0].legend(fontsize=7)
    axes[1, 0].grid(True, alpha=0.3)

    # Score distribution
    axes[1, 1].hist(su_health['community_health_score'], bins=15, edgecolor='black',
                   alpha=0.7, color='teal')
    axes[1, 1].axvline(x=su_health['community_health_score'].median(), color='red',
                       linestyle='--', label=f'Median: {su_health["community_health_score"].median():.0f}')
    axes[1, 1].set_title('Community Health Score Distribution', fontweight='bold')
    axes[1, 1].set_xlabel('Health Score')
    axes[1, 1].set_ylabel('Count')
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/community_health_scores.png', dpi=300, bbox_inches='tight')
    plt.show()

    print("\nCommunity Health Scores:")
    print(su_health[['service_unit', 'total_patients', 'community_health_score',
                     'access_index', 'burden_index']].sort_values(
        'community_health_score', ascending=False).to_string(index=False))

    return su_health

community_scores = build_community_health_scores(df_encounters, df_patients, df_facilities)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Extended Results

# COMMAND ----------

# Save community health scores
chs_spark = spark.createDataFrame(community_scores)
chs_spark = chs_spark.withColumn("analysis_date", current_date())

(chs_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_community_health_scores"))

print("Saved to gold.gld_community_health_scores")

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
print(f"\nOverdue visit rate: {care_gaps['overdue_visit'].mean()*100:.1f}%")
print(f"Avg community health score: {community_scores['community_health_score'].mean():.1f}")
print("\nAll data is SYNTHETIC - no real PHI")
print("\nOutputs:")
print("  gold.gld_population_health_summary")
print("  gold.gld_community_health_scores")
print("=" * 65)
