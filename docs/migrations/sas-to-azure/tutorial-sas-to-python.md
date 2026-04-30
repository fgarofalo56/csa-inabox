# Tutorial: Convert a SAS Program to Python on Fabric

**Time to complete:** 2--4 hours
**Prerequisites:** Fabric workspace, lakehouse with sample data, basic Python knowledge
**Outcome:** A complete SAS program (data prep, statistical analysis, reporting) converted to a Python notebook in Fabric, with output validation and ADF scheduling

---

## Overview

This tutorial takes a realistic SAS program --- one that reads raw data, cleans it, performs statistical analysis, generates summary reports, and produces visualizations --- and converts it step-by-step to a Python notebook running on Microsoft Fabric. You will validate that the Python output matches the SAS output and then schedule the notebook in ADF.

---

## The SAS program we are converting

This SAS program analyzes federal employee survey data (similar to the Federal Employee Viewpoint Survey):

```sas
/***********************************************
 * Federal Employee Survey Analysis
 * Purpose: Quarterly engagement analysis
 * Author: Analytics Division
 * Schedule: Monthly, 1st business day
 ***********************************************/

/* Configuration */
%let survey_year = 2026;
%let min_responses = 30;
%let output_path = /sas/output/survey;

/* Step 1: Read and clean data */
libname raw '/sas/data/raw';
libname staging '/sas/data/staging';
libname gold '/sas/data/gold';

data staging.survey_clean;
  set raw.employee_survey;
  where survey_year = &survey_year
    and response_status = 'Complete';

  /* Recode missing values */
  array q_items q1-q20;
  do over q_items;
    if q_items < 1 or q_items > 5 then q_items = .;
  end;

  /* Calculate composite scores */
  engagement_score = mean(of q1-q5);
  satisfaction_score = mean(of q6-q10);
  leadership_score = mean(of q11-q15);
  worklife_score = mean(of q16-q20);
  overall_score = mean(engagement_score, satisfaction_score,
                       leadership_score, worklife_score);

  /* Demographic groupings */
  length tenure_group $20 age_group $15;
  if years_service < 2 then tenure_group = 'New (< 2 yrs)';
  else if years_service < 5 then tenure_group = 'Early (2-5 yrs)';
  else if years_service < 15 then tenure_group = 'Mid (5-15 yrs)';
  else tenure_group = 'Senior (15+ yrs)';

  if age < 30 then age_group = 'Under 30';
  else if age < 45 then age_group = '30-44';
  else if age < 55 then age_group = '45-54';
  else age_group = '55+';

  format engagement_score satisfaction_score leadership_score
         worklife_score overall_score 5.2;
run;

/* Step 2: Agency-level summary statistics */
proc means data=staging.survey_clean noprint;
  class agency division;
  var engagement_score satisfaction_score leadership_score
      worklife_score overall_score;
  output out=gold.agency_summary(where=(_type_=3) drop=_type_)
    n= mean= std= median= q1= q3= / autoname;
run;

/* Step 3: Demographic analysis */
proc freq data=staging.survey_clean noprint;
  tables agency * tenure_group / out=work.tenure_dist;
  tables agency * age_group / out=work.age_dist;
run;

/* Step 4: Regression analysis - what predicts engagement? */
proc reg data=staging.survey_clean;
  model engagement_score = satisfaction_score leadership_score
                           worklife_score years_service age
                           / vif stb;
  output out=gold.engagement_model p=predicted r=residual;
run;

/* Step 5: Trend analysis (if historical data available) */
proc sort data=gold.agency_summary; by agency division; run;

proc sgplot data=gold.agency_summary;
  vbar agency / response=overall_score_mean group=division
               groupdisplay=cluster;
  yaxis label="Overall Score (1-5)" grid;
  title "Overall Engagement by Agency and Division";
run;

/* Step 6: Export results */
ods pdf file="&output_path/quarterly_survey_report.pdf" style=journal;
title "Federal Employee Survey Analysis - &survey_year";

proc print data=gold.agency_summary(obs=20) noobs;
  var agency division engagement_score_n engagement_score_mean
      satisfaction_score_mean leadership_score_mean overall_score_mean;
  format engagement_score_mean satisfaction_score_mean
         leadership_score_mean overall_score_mean 5.2;
run;

proc print data=gold.engagement_model(obs=10) noobs;
  var engagement_score predicted residual;
run;

ods pdf close;
```

---

## Step 1: Set up the Fabric notebook

Create a new notebook in your Fabric workspace. Name it `survey_analysis`.

### Cell 1: Configuration and imports

```python
# survey_analysis notebook
# Purpose: Quarterly engagement analysis (migrated from SAS)
# Schedule: Monthly, 1st business day via ADF

# Configuration (replaces %let macro variables)
SURVEY_YEAR = 2026
MIN_RESPONSES = 30
OUTPUT_PATH = "/lakehouse/default/Files/output/survey"

# Imports
import pandas as pd
import numpy as np
from scipy import stats
import statsmodels.api as sm
from statsmodels.stats.outliers_influence import variance_inflation_factor
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime
import os

# Ensure output directory exists
os.makedirs(OUTPUT_PATH, exist_ok=True)

print(f"Survey Analysis - Year: {SURVEY_YEAR}")
print(f"Run timestamp: {datetime.now().isoformat()}")
```

### Cell 2: Read and clean data (replaces DATA Step)

```python
# Step 1: Read and clean data
# Replaces: data staging.survey_clean; set raw.employee_survey; ...

# Read from lakehouse (replaces LIBNAME raw + SET)
df_raw = spark.sql(f"""
    SELECT *
    FROM raw.employee_survey
    WHERE survey_year = {SURVEY_YEAR}
      AND response_status = 'Complete'
""").toPandas()

print(f"Raw records: {len(df_raw)}")

# Recode missing values (replaces array/do-over loop)
q_columns = [f'q{i}' for i in range(1, 21)]
for col in q_columns:
    df_raw[col] = df_raw[col].where(
        (df_raw[col] >= 1) & (df_raw[col] <= 5), other=np.nan
    )

# Calculate composite scores (replaces MEAN() function)
df_raw['engagement_score'] = df_raw[['q1','q2','q3','q4','q5']].mean(axis=1)
df_raw['satisfaction_score'] = df_raw[['q6','q7','q8','q9','q10']].mean(axis=1)
df_raw['leadership_score'] = df_raw[['q11','q12','q13','q14','q15']].mean(axis=1)
df_raw['worklife_score'] = df_raw[['q16','q17','q18','q19','q20']].mean(axis=1)
df_raw['overall_score'] = df_raw[['engagement_score', 'satisfaction_score',
                                   'leadership_score', 'worklife_score']].mean(axis=1)

# Demographic groupings (replaces IF/THEN/ELSE)
def tenure_group(years):
    if pd.isna(years):
        return 'Unknown'
    elif years < 2:
        return 'New (< 2 yrs)'
    elif years < 5:
        return 'Early (2-5 yrs)'
    elif years < 15:
        return 'Mid (5-15 yrs)'
    else:
        return 'Senior (15+ yrs)'

def age_group(age):
    if pd.isna(age):
        return 'Unknown'
    elif age < 30:
        return 'Under 30'
    elif age < 45:
        return '30-44'
    elif age < 55:
        return '45-54'
    else:
        return '55+'

df_raw['tenure_group'] = df_raw['years_service'].apply(tenure_group)
df_raw['age_group'] = df_raw['age'].apply(age_group)

# Round scores to match SAS FORMAT 5.2
score_cols = ['engagement_score', 'satisfaction_score',
              'leadership_score', 'worklife_score', 'overall_score']
for col in score_cols:
    df_raw[col] = df_raw[col].round(2)

df_clean = df_raw.copy()
print(f"Clean records: {len(df_clean)}")
print(f"\nScore distributions:")
print(df_clean[score_cols].describe().round(2))

# Save to staging lakehouse (replaces: data staging.survey_clean)
spark.createDataFrame(df_clean).write.mode("overwrite").saveAsTable(
    "staging.survey_clean"
)
```

### Cell 3: Agency-level summary (replaces PROC MEANS)

```python
# Step 2: Agency-level summary statistics
# Replaces: proc means class agency division; var ...; output ...

def detailed_summary(group):
    """Calculate n, mean, std, median, q1, q3 for each score column."""
    result = {}
    for col in score_cols:
        vals = group[col].dropna()
        if len(vals) >= MIN_RESPONSES:
            result[f'{col}_n'] = len(vals)
            result[f'{col}_mean'] = round(vals.mean(), 2)
            result[f'{col}_std'] = round(vals.std(), 2)
            result[f'{col}_median'] = round(vals.median(), 2)
            result[f'{col}_q1'] = round(vals.quantile(0.25), 2)
            result[f'{col}_q3'] = round(vals.quantile(0.75), 2)
    return pd.Series(result)

agency_summary = (df_clean
    .groupby(['agency', 'division'])
    .apply(detailed_summary)
    .reset_index())

# Filter groups with sufficient responses
agency_summary = agency_summary.dropna(subset=['overall_score_n'])

print(f"Agency-division combinations: {len(agency_summary)}")
print("\nTop 10 by overall score:")
print(agency_summary.nlargest(10, 'overall_score_mean')[
    ['agency', 'division', 'overall_score_n', 'overall_score_mean',
     'engagement_score_mean']
].to_string(index=False))

# Save to gold lakehouse (replaces: output out=gold.agency_summary)
spark.createDataFrame(agency_summary).write.mode("overwrite").saveAsTable(
    "gold.agency_summary"
)
```

### Cell 4: Demographic analysis (replaces PROC FREQ)

```python
# Step 3: Demographic analysis
# Replaces: proc freq; tables agency * tenure_group / out=...

# Tenure distribution by agency
tenure_dist = pd.crosstab(
    df_clean['agency'], df_clean['tenure_group'],
    margins=True, margins_name='Total'
)
tenure_pct = pd.crosstab(
    df_clean['agency'], df_clean['tenure_group'],
    normalize='index'
) * 100

print("Tenure Distribution by Agency (%):")
print(tenure_pct.round(1).to_string())

# Age distribution by agency
age_dist = pd.crosstab(
    df_clean['agency'], df_clean['age_group'],
    margins=True, margins_name='Total'
)

print("\nAge Distribution by Agency (counts):")
print(age_dist.to_string())

# Chi-square test for independence
chi2, p_val, dof, expected = stats.chi2_contingency(
    pd.crosstab(df_clean['agency'], df_clean['tenure_group'])
)
print(f"\nChi-square test (Agency x Tenure): chi2={chi2:.2f}, p={p_val:.4f}")
```

### Cell 5: Regression analysis (replaces PROC REG)

```python
# Step 4: Regression analysis - what predicts engagement?
# Replaces: proc reg; model engagement_score = ...

# Prepare data (drop rows with missing values in any predictor)
predictors = ['satisfaction_score', 'leadership_score', 'worklife_score',
              'years_service', 'age']
reg_data = df_clean[['engagement_score'] + predictors].dropna()

X = reg_data[predictors]
X = sm.add_constant(X)
y = reg_data['engagement_score']

# Fit model
model = sm.OLS(y, X).fit()
print("=" * 70)
print("REGRESSION RESULTS (replaces PROC REG output)")
print("=" * 70)
print(model.summary())

# VIF (collinearity diagnostics, replaces / vif option)
print("\nVariance Inflation Factors:")
vif_data = pd.DataFrame({
    'Variable': predictors,
    'VIF': [variance_inflation_factor(X.values, i+1) for i in range(len(predictors))]
})
print(vif_data.to_string(index=False))

# Standardized coefficients (replaces / stb option)
X_std = (X.iloc[:, 1:] - X.iloc[:, 1:].mean()) / X.iloc[:, 1:].std()
X_std = sm.add_constant(X_std)
model_std = sm.OLS(y, X_std).fit()
print("\nStandardized Coefficients:")
for var, coef in zip(predictors, model_std.params[1:]):
    print(f"  {var}: {coef:.4f}")

# Output predicted and residual (replaces OUTPUT statement)
reg_data['predicted'] = model.predict(X)
reg_data['residual'] = model.resid

# Save to gold (replaces: output out=gold.engagement_model)
spark.createDataFrame(reg_data).write.mode("overwrite").saveAsTable(
    "gold.engagement_model"
)
```

### Cell 6: Visualizations (replaces PROC SGPLOT)

```python
# Step 5: Visualizations
# Replaces: proc sgplot vbar agency / response=overall_score_mean

fig, axes = plt.subplots(2, 2, figsize=(16, 12))

# Plot 1: Overall engagement by agency (bar chart)
top_agencies = agency_summary.nlargest(15, 'overall_score_n')
ax1 = axes[0, 0]
agencies = top_agencies['agency'].values
divisions = top_agencies['division'].values
scores = top_agencies['overall_score_mean'].values

ax1.barh(range(len(agencies)), scores, color='steelblue')
ax1.set_yticks(range(len(agencies)))
ax1.set_yticklabels([f"{a} - {d}" for a, d in zip(agencies, divisions)],
                     fontsize=8)
ax1.set_xlabel('Overall Score (1-5)')
ax1.set_title('Overall Engagement by Agency/Division')
ax1.set_xlim(1, 5)

# Plot 2: Score distributions (box plot)
ax2 = axes[0, 1]
df_clean[score_cols].plot(kind='box', ax=ax2, vert=True)
ax2.set_ylabel('Score (1-5)')
ax2.set_title('Score Distributions')
ax2.set_xticklabels(['Engage', 'Satisfy', 'Leader', 'WorkLife', 'Overall'],
                      rotation=45, fontsize=9)

# Plot 3: Engagement by tenure group
ax3 = axes[1, 0]
tenure_order = ['New (< 2 yrs)', 'Early (2-5 yrs)', 'Mid (5-15 yrs)',
                'Senior (15+ yrs)']
tenure_scores = df_clean.groupby('tenure_group')['engagement_score'].mean()
tenure_scores = tenure_scores.reindex(tenure_order)
tenure_scores.plot(kind='bar', ax=ax3, color='darkorange')
ax3.set_ylabel('Mean Engagement Score')
ax3.set_title('Engagement by Tenure Group')
ax3.set_xticklabels(tenure_order, rotation=30, fontsize=9)

# Plot 4: Residual diagnostic (Q-Q plot)
ax4 = axes[1, 1]
sm.qqplot(model.resid, line='s', ax=ax4)
ax4.set_title('Regression Residual Q-Q Plot')

plt.suptitle(f'Federal Employee Survey Analysis - {SURVEY_YEAR}',
             fontsize=14, fontweight='bold', y=1.02)
plt.tight_layout()
plt.savefig(f'{OUTPUT_PATH}/survey_analysis_{SURVEY_YEAR}.png',
            dpi=150, bbox_inches='tight')
plt.show()
```

### Cell 7: Generate report (replaces ODS PDF)

```python
# Step 6: Generate PDF report (replaces ODS PDF)
# For production PDF, use Power BI paginated reports
# For notebook-based HTML report, use display()

from IPython.display import display, HTML

report_html = f"""
<h1>Federal Employee Survey Analysis - {SURVEY_YEAR}</h1>
<p>Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}</p>
<p>Total respondents: {len(df_clean):,}</p>
<hr>
<h2>Agency Summary (Top 20)</h2>
"""

top_20 = agency_summary.nlargest(20, 'overall_score_n')[
    ['agency', 'division', 'engagement_score_n', 'engagement_score_mean',
     'satisfaction_score_mean', 'leadership_score_mean', 'overall_score_mean']
]
report_html += top_20.to_html(index=False, float_format=lambda x: f'{x:.2f}')

report_html += f"""
<h2>Regression Results</h2>
<p>R-squared: {model.rsquared:.4f}</p>
<p>F-statistic: {model.fstatistic[0]:.2f} (p={model.f_pvalue:.6f})</p>
"""

coef_df = pd.DataFrame({
    'Variable': predictors,
    'Coefficient': model.params[1:].round(4),
    'Std Error': model.bse[1:].round(4),
    'p-value': model.pvalues[1:].round(4),
    'VIF': vif_data['VIF'].round(2)
})
report_html += coef_df.to_html(index=False)

display(HTML(report_html))

# Save HTML report
with open(f'{OUTPUT_PATH}/survey_report_{SURVEY_YEAR}.html', 'w') as f:
    f.write(report_html)

print(f"\nReport saved to: {OUTPUT_PATH}/survey_report_{SURVEY_YEAR}.html")
```

---

## Step 2: Validate output equivalence

### Cell 8: Validation

```python
# Validation: Compare Python output with SAS output
# Load SAS output (previously exported or available in lakehouse)

print("=" * 60)
print("OUTPUT VALIDATION")
print("=" * 60)

# Validation 1: Row counts
print(f"\n1. Row count: {len(df_clean)}")
print(f"   SAS expected: [compare with SAS log]")

# Validation 2: Score means
print(f"\n2. Score means:")
for col in score_cols:
    python_mean = df_clean[col].mean()
    print(f"   {col}: Python={python_mean:.4f}")
    # Compare with SAS PROC MEANS output

# Validation 3: Regression coefficients
print(f"\n3. Regression coefficients:")
for var, coef in zip(predictors, model.params[1:]):
    print(f"   {var}: Python={coef:.6f}")
    # Compare with SAS PROC REG output

# Validation 4: R-squared
print(f"\n4. R-squared: Python={model.rsquared:.6f}")

# Validation 5: Agency summary spot-check
print(f"\n5. Agency summary records: {len(agency_summary)}")

print("\nValidation complete. Compare values with SAS output.")
print("Tolerance: means within 0.01, coefficients within 0.001")
```

---

## Step 3: Schedule in ADF

### 3.1 Create ADF pipeline

```json
{
    "name": "pipeline_monthly_survey_analysis",
    "properties": {
        "description": "Monthly employee survey analysis (migrated from SAS)",
        "activities": [
            {
                "name": "run_survey_analysis",
                "type": "SynapseNotebook",
                "typeProperties": {
                    "notebook": {
                        "referenceName": "survey_analysis",
                        "type": "NotebookReference"
                    },
                    "parameters": {
                        "survey_year": {
                            "value": "@formatDateTime(pipeline().TriggerTime, 'yyyy')",
                            "type": "string"
                        }
                    },
                    "sparkPool": {
                        "referenceName": "defaultPool",
                        "type": "BigDataPoolReference"
                    }
                }
            },
            {
                "name": "notify_completion",
                "type": "WebActivity",
                "dependsOn": [
                    {
                        "activity": "run_survey_analysis",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "url": "https://hooks.teams.microsoft.com/...",
                    "method": "POST",
                    "body": {
                        "text": "Survey analysis completed successfully for @{pipeline().TriggerTime}"
                    }
                }
            }
        ]
    }
}
```

### 3.2 Create schedule trigger

```json
{
    "name": "trigger_monthly_survey",
    "properties": {
        "type": "ScheduleTrigger",
        "typeProperties": {
            "recurrence": {
                "frequency": "Month",
                "interval": 1,
                "startTime": "2026-02-01T06:00:00Z",
                "timeZone": "Eastern Standard Time",
                "schedule": {
                    "monthlyOccurrences": [{ "day": "Monday", "occurrence": 1 }]
                }
            }
        },
        "pipelines": [
            {
                "pipelineReference": {
                    "referenceName": "pipeline_monthly_survey_analysis"
                }
            }
        ]
    }
}
```

---

## Summary

| SAS component                 | Python/Fabric equivalent            | Status     |
| ----------------------------- | ----------------------------------- | ---------- |
| `%let` macro variables        | Python constants                    | Converted  |
| `LIBNAME` + `DATA Step` clean | Spark SQL + pandas transforms       | Converted  |
| `PROC MEANS` summary          | pandas `.groupby().apply()`         | Converted  |
| `PROC FREQ` crosstabs         | `pd.crosstab()` + `scipy.stats`     | Converted  |
| `PROC REG` regression         | `statsmodels.OLS`                   | Converted  |
| `PROC SGPLOT` charts          | matplotlib + seaborn                | Converted  |
| `ODS PDF` report              | HTML report + Power BI (production) | Converted  |
| Platform LSF schedule         | ADF Schedule Trigger                | Configured |

**Total conversion effort:** 2--4 hours for a program of this complexity.

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
