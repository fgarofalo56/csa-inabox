# SAS to Azure: Complete Feature Mapping

**Audience:** CTO, Chief Analytics Officer, Platform Architecture, SAS Programmers
**Purpose:** Comprehensive mapping of 40+ SAS features and procedures to Azure equivalents with code examples, migration complexity ratings, and gap analysis.

---

## How to read this document

Each mapping includes:

- **SAS feature/procedure:** The SAS capability being mapped
- **Azure equivalent:** The csa-inabox component that replaces it
- **Complexity:** XS (trivial), S (small), M (medium), L (large), XL (very large)
- **Coverage:** Percentage of SAS functionality covered by the Azure equivalent
- **Code example:** Side-by-side SAS and Python/Azure code where applicable

---

## 1. Data management features

### 1.1 DATA Step

| Attribute      | SAS                                      | Azure equivalent                             |
| -------------- | ---------------------------------------- | -------------------------------------------- |
| **Feature**    | DATA Step (row-by-row data manipulation) | Python pandas / PySpark DataFrame operations |
| **Complexity** | M                                        |
| **Coverage**   | 98%                                      |

**SAS:**

```sas
data work.clean;
  set raw.transactions;
  where amount > 0;
  if missing(category) then category = 'UNKNOWN';
  quarter = qtr(transaction_date);
  fiscal_year = year(intnx('month', transaction_date, 3));
  amount_log = log(amount + 1);
  length region $20;
  if state in ('NY','NJ','CT') then region = 'Northeast';
  else if state in ('CA','OR','WA') then region = 'West';
  else region = 'Other';
run;
```

**Python (pandas):**

```python
import pandas as pd
import numpy as np

df = spark.sql("SELECT * FROM raw.transactions").toPandas()

# Filter
df = df[df['amount'] > 0].copy()

# Missing value imputation
df['category'] = df['category'].fillna('UNKNOWN')

# Date calculations
df['quarter'] = df['transaction_date'].dt.quarter
df['fiscal_year'] = (df['transaction_date'] + pd.DateOffset(months=3)).dt.year

# Transformations
df['amount_log'] = np.log(df['amount'] + 1)

# Conditional logic (replaces IF/THEN/ELSE)
conditions = [
    df['state'].isin(['NY', 'NJ', 'CT']),
    df['state'].isin(['CA', 'OR', 'WA'])
]
choices = ['Northeast', 'West']
df['region'] = np.select(conditions, choices, default='Other')
```

**PySpark (for large datasets):**

```python
from pyspark.sql import functions as F
from pyspark.sql.functions import when, col, quarter, year, log, add_months

df = spark.table("raw.transactions")

df_clean = (df
    .filter(col("amount") > 0)
    .withColumn("category", when(col("category").isNull(), "UNKNOWN").otherwise(col("category")))
    .withColumn("quarter", quarter("transaction_date"))
    .withColumn("fiscal_year", year(add_months("transaction_date", 3)))
    .withColumn("amount_log", log(col("amount") + 1))
    .withColumn("region",
        when(col("state").isin("NY", "NJ", "CT"), "Northeast")
        .when(col("state").isin("CA", "OR", "WA"), "West")
        .otherwise("Other"))
)
```

### 1.2 PROC SQL

| Attribute      | SAS                               | Azure equivalent                                 |
| -------------- | --------------------------------- | ------------------------------------------------ |
| **Feature**    | PROC SQL (SQL queries within SAS) | Spark SQL / dbt SQL models / Fabric SQL endpoint |
| **Complexity** | S                                 |
| **Coverage**   | 100%                              |

**SAS:**

```sas
proc sql;
  create table work.summary as
  select region,
         count(*) as n_transactions,
         sum(amount) as total_amount,
         mean(amount) as avg_amount,
         calculated total_amount / (select sum(amount) from work.clean) as pct_total
  from work.clean
  group by region
  having calculated n_transactions >= 100
  order by total_amount desc;
quit;
```

**dbt SQL model:**

```sql
-- models/gold/region_summary.sql
{{ config(materialized='table') }}

WITH base AS (
    SELECT * FROM {{ ref('stg_clean_transactions') }}
),
totals AS (
    SELECT SUM(amount) AS grand_total FROM base
)
SELECT
    region,
    COUNT(*) AS n_transactions,
    SUM(amount) AS total_amount,
    AVG(amount) AS avg_amount,
    SUM(amount) / t.grand_total AS pct_total
FROM base
CROSS JOIN totals t
GROUP BY region, t.grand_total
HAVING COUNT(*) >= 100
ORDER BY total_amount DESC
```

**SAS-specific SQL extensions:**

| SAS SQL extension              | Azure equivalent                              | Notes                                                     |
| ------------------------------ | --------------------------------------------- | --------------------------------------------------------- |
| `INTO :macro_var`              | dbt `{{ var() }}` or Python variable          | Macro variables become dbt vars or Python assignments     |
| `CALCULATED` keyword           | CTE or subquery                               | Standard SQL requires CTE for column reuse                |
| `CONNECTION TO` (pass-through) | Fabric lakehouse federation / linked services | ADF linked services or Databricks connectors              |
| `CREATE INDEX`                 | Delta Z-ORDER / partition                     | Delta tables use partition and Z-ORDER instead of indexes |

### 1.3 PROC SORT

| Attribute      | SAS                                 | Azure equivalent                                                 |
| -------------- | ----------------------------------- | ---------------------------------------------------------------- |
| **Feature**    | PROC SORT (sorting + deduplication) | DataFrame `.sort_values()` / Spark `.orderBy()` / SQL `ORDER BY` |
| **Complexity** | XS                                  |
| **Coverage**   | 100%                                |

**SAS:**

```sas
proc sort data=work.clean out=work.clean_sorted nodupkey;
  by region descending amount;
run;
```

**Python:**

```python
df_sorted = (df
    .sort_values(['region', 'amount'], ascending=[True, False])
    .drop_duplicates(subset=['region'], keep='first'))
```

### 1.4 PROC TRANSPOSE

| Attribute      | SAS                            | Azure equivalent                                              |
| -------------- | ------------------------------ | ------------------------------------------------------------- |
| **Feature**    | PROC TRANSPOSE (pivot/unpivot) | pandas `.pivot()` / `.melt()` / Spark `pivot()` / `unpivot()` |
| **Complexity** | S                              |
| **Coverage**   | 100%                           |

**SAS:**

```sas
proc transpose data=work.quarterly out=work.wide(drop=_name_);
  by region;
  id quarter;
  var total_amount;
run;
```

**Python:**

```python
df_wide = df.pivot_table(
    index='region',
    columns='quarter',
    values='total_amount',
    aggfunc='sum'
).reset_index()
```

### 1.5 SAS Formats and Informats

| Attribute      | SAS                                    | Azure equivalent                                            |
| -------------- | -------------------------------------- | ----------------------------------------------------------- |
| **Feature**    | SAS user-defined formats (PROC FORMAT) | dbt seed tables / Delta lookup tables / Python dictionaries |
| **Complexity** | S                                      |
| **Coverage**   | 95%                                    |

**SAS:**

```sas
proc format;
  value $agencyf
    'DOD' = 'Department of Defense'
    'HHS' = 'Department of Health and Human Services'
    'DOJ' = 'Department of Justice'
    other = 'Other Agency';
  value riskf
    low - 30 = 'Low Risk'
    30 <- 70 = 'Medium Risk'
    70 <- high = 'High Risk';
run;

data work.labeled;
  set work.agencies;
  agency_label = put(agency_code, $agencyf.);
  risk_label = put(risk_score, riskf.);
run;
```

**dbt seed + model:**

```csv
-- seeds/agency_lookup.csv
agency_code,agency_label
DOD,Department of Defense
HHS,Department of Health and Human Services
DOJ,Department of Justice
```

```sql
-- models/staging/stg_labeled_agencies.sql
SELECT
    a.*,
    COALESCE(lu.agency_label, 'Other Agency') AS agency_label,
    CASE
        WHEN risk_score <= 30 THEN 'Low Risk'
        WHEN risk_score <= 70 THEN 'Medium Risk'
        ELSE 'High Risk'
    END AS risk_label
FROM {{ ref('stg_agencies') }} a
LEFT JOIN {{ ref('agency_lookup') }} lu
    ON a.agency_code = lu.agency_code
```

### 1.6 SAS Macro Language

| Attribute      | SAS                                                | Azure equivalent                          |
| -------------- | -------------------------------------------------- | ----------------------------------------- |
| **Feature**    | SAS Macro language (`%MACRO`, `&var`, `%DO` loops) | Python functions + Jinja templates in dbt |
| **Complexity** | M                                                  |
| **Coverage**   | 95%                                                |

**SAS:**

```sas
%macro run_analysis(dataset=, target=, predictors=, output=);
  proc logistic data=&dataset descending;
    model &target = &predictors / lackfit;
    output out=&output p=pred_prob;
  run;
%mend;

%run_analysis(dataset=work.loans, target=default_flag,
              predictors=credit_score debt_ratio loan_amount,
              output=work.scored_loans);
```

**Python:**

```python
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

def run_analysis(df, target, predictors, output_table):
    """Replaces %macro run_analysis."""
    X = df[predictors]
    y = df[target]

    model = LogisticRegression(max_iter=1000)
    model.fit(X, y)

    df['pred_prob'] = model.predict_proba(X)[:, 1]
    spark.createDataFrame(df).write.mode("overwrite").saveAsTable(output_table)
    return model

model = run_analysis(
    df=loans_df,
    target='default_flag',
    predictors=['credit_score', 'debt_ratio', 'loan_amount'],
    output_table='work.scored_loans'
)
```

### 1.7 SAS Libnames

| Attribute      | SAS                                  | Azure equivalent                                             |
| -------------- | ------------------------------------ | ------------------------------------------------------------ |
| **Feature**    | LIBNAME statement (data connections) | Fabric lakehouse references / Unity Catalog / Spark catalogs |
| **Complexity** | M                                    |
| **Coverage**   | 100%                                 |

**SAS:**

```sas
libname raw oracle path="//db-server:1521/PROD" user=&uid pw=&pwd;
libname staging '/sas/data/staging';
libname gold '/sas/data/gold';
```

**Fabric/Spark equivalent:**

```python
# Fabric lakehouses are referenced by catalog.schema.table
# No LIBNAME equivalent needed - tables are in Unity Catalog

# Read from Oracle (via Spark JDBC)
df = spark.read.format("jdbc").options(
    url="jdbc:oracle:thin:@db-server:1521/PROD",
    dbtable="schema.table",
    driver="oracle.jdbc.OracleDriver"
).load()

# Read from lakehouse
df_staging = spark.table("staging.bronze.raw_transactions")
df_gold = spark.table("gold.fact_transactions")
```

### 1.8 SAS Data Integration Studio

| Attribute      | SAS                        | Azure equivalent                  |
| -------------- | -------------------------- | --------------------------------- |
| **Feature**    | SAS DI Studio (visual ETL) | ADF + dbt + Fabric Data Pipelines |
| **Complexity** | L                          |
| **Coverage**   | 95%                        |

See [Data Management Migration](data-management-migration.md) for detailed mapping.

---

## 2. Statistical procedure features

### 2.1 PROC MEANS / PROC SUMMARY

| Attribute      | SAS                                        | Azure equivalent                                                 |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| **Feature**    | Descriptive statistics with CLASS grouping | pandas `.describe()` / `.groupby().agg()` / PySpark `.summary()` |
| **Complexity** | XS                                         |
| **Coverage**   | 100%                                       |

**SAS:**

```sas
proc means data=work.clean n mean std min max median q1 q3 clm;
  class region;
  var amount credit_score;
  output out=work.stats;
run;
```

**Python:**

```python
import scipy.stats as stats

summary = df.groupby('region')[['amount', 'credit_score']].agg(
    ['count', 'mean', 'std', 'min', 'max', 'median']
)

# Add confidence intervals (CLM equivalent)
def confidence_interval(series, confidence=0.95):
    n = len(series)
    mean = series.mean()
    se = stats.sem(series)
    ci = stats.t.interval(confidence, df=n-1, loc=mean, scale=se)
    return pd.Series({'lower_cl': ci[0], 'upper_cl': ci[1]})

ci = df.groupby('region')['amount'].apply(confidence_interval)
```

### 2.2 PROC FREQ

| Attribute      | SAS                                            | Azure equivalent                                                             |
| -------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| **Feature**    | Frequency tables, cross-tabs, chi-square tests | pandas `value_counts()` / `pd.crosstab()` / `scipy.stats.chi2_contingency()` |
| **Complexity** | XS                                             |
| **Coverage**   | 100%                                           |

**SAS:**

```sas
proc freq data=work.clean;
  tables region * risk_level / chisq expected cellchi2 nocol norow;
  tables category / out=work.cat_freq;
run;
```

**Python:**

```python
# Simple frequency table
freq = df['category'].value_counts()

# Cross-tabulation with chi-square
ct = pd.crosstab(df['region'], df['risk_level'])
chi2, p_value, dof, expected = stats.chi2_contingency(ct)
print(f"Chi-square: {chi2:.4f}, p-value: {p_value:.4f}, df: {dof}")
```

### 2.3 PROC UNIVARIATE

| Attribute      | SAS                                                             | Azure equivalent                 |
| -------------- | --------------------------------------------------------------- | -------------------------------- |
| **Feature**    | Distribution analysis, normality tests, percentiles, histograms | scipy.stats + matplotlib/seaborn |
| **Complexity** | S                                                               |
| **Coverage**   | 98%                                                             |

**SAS:**

```sas
proc univariate data=work.clean normal plot;
  var amount;
  histogram amount / normal;
  qqplot amount / normal;
  output out=work.univar pctlpts=1 5 10 25 50 75 90 95 99
         pctlpre=p_;
run;
```

**Python:**

```python
import matplotlib.pyplot as plt
import seaborn as sns
from scipy import stats

# Descriptive statistics
desc = df['amount'].describe(percentiles=[.01, .05, .10, .25, .50, .75, .90, .95, .99])

# Normality tests
shapiro_stat, shapiro_p = stats.shapiro(df['amount'].sample(5000))
ks_stat, ks_p = stats.kstest(df['amount'], 'norm',
                              args=(df['amount'].mean(), df['amount'].std()))

# Histogram with normal overlay
fig, axes = plt.subplots(1, 2, figsize=(14, 5))
sns.histplot(df['amount'], kde=True, stat='density', ax=axes[0])
stats.probplot(df['amount'], dist="norm", plot=axes[1])
plt.tight_layout()
plt.show()
```

### 2.4 PROC REG

| Attribute      | SAS                                | Azure equivalent                                |
| -------------- | ---------------------------------- | ----------------------------------------------- |
| **Feature**    | Linear regression with diagnostics | statsmodels OLS / scikit-learn LinearRegression |
| **Complexity** | S                                  |
| **Coverage**   | 100%                               |

**SAS:**

```sas
proc reg data=work.clean plots(only)=(diagnostics residuals);
  model amount = credit_score debt_ratio loan_term
                 / vif collin dwprob influence r;
  output out=work.reg_results p=predicted r=residual
         student=rstudent cookd=cooksd h=leverage;
run;
```

**Python (statsmodels for diagnostics):**

```python
import statsmodels.api as sm
from statsmodels.stats.outliers_influence import variance_inflation_factor

X = df[['credit_score', 'debt_ratio', 'loan_term']]
X = sm.add_constant(X)
y = df['amount']

model = sm.OLS(y, X).fit()
print(model.summary())  # R-squared, coefficients, p-values, F-statistic

# VIF (collinearity diagnostics)
vif_data = pd.DataFrame({
    'Feature': X.columns[1:],
    'VIF': [variance_inflation_factor(X.values, i+1) for i in range(X.shape[1]-1)]
})

# Durbin-Watson
from statsmodels.stats.stattools import durbin_watson
dw = durbin_watson(model.resid)

# Influence diagnostics (Cook's D, leverage)
influence = model.get_influence()
cooks_d = influence.cooks_distance[0]
leverage = influence.hat_matrix_diag
```

### 2.5 PROC LOGISTIC

| Attribute      | SAS                                                       | Azure equivalent                                    |
| -------------- | --------------------------------------------------------- | --------------------------------------------------- |
| **Feature**    | Logistic regression with concordance, ROC, classification | statsmodels Logit / scikit-learn LogisticRegression |
| **Complexity** | S                                                         |
| **Coverage**   | 98%                                                       |

**SAS:**

```sas
proc logistic data=work.loans descending;
  class credit_grade (ref='A') / param=ref;
  model default_flag = credit_grade credit_score debt_ratio
                       / lackfit rsquare stb ctable pprob=(0.1 to 0.9 by 0.1);
  roc;
  output out=work.scored p=pred_prob;
run;
```

**Python:**

```python
import statsmodels.api as sm
from sklearn.metrics import roc_auc_score, roc_curve, classification_report

# statsmodels for detailed output (concordance, Hosmer-Lemeshow)
X = pd.get_dummies(df[['credit_grade', 'credit_score', 'debt_ratio']],
                   drop_first=True)
X = sm.add_constant(X)
y = df['default_flag']

logit_model = sm.Logit(y, X).fit()
print(logit_model.summary())  # Coefficients, Wald tests, pseudo R-squared

# Concordance (c-statistic = AUC)
pred_prob = logit_model.predict(X)
auc = roc_auc_score(y, pred_prob)
print(f"Concordance (c-statistic): {auc:.4f}")

# Hosmer-Lemeshow test
from statsmodels.stats.diagnostic import acorr_ljungbox
# Custom implementation for HL test
def hosmer_lemeshow(y_true, y_pred, n_groups=10):
    data = pd.DataFrame({'y': y_true, 'p': y_pred})
    data['group'] = pd.qcut(data['p'], n_groups, duplicates='drop')
    obs = data.groupby('group')['y'].agg(['sum', 'count'])
    exp = data.groupby('group')['p'].agg(['sum', 'count'])
    hl_stat = (((obs['sum'] - exp['sum'])**2) /
               (exp['count'] * exp['sum']/exp['count'] *
                (1 - exp['sum']/exp['count']))).sum()
    p_val = 1 - stats.chi2.cdf(hl_stat, n_groups - 2)
    return hl_stat, p_val

hl_stat, hl_p = hosmer_lemeshow(y, pred_prob)

# Classification table at multiple thresholds
for threshold in np.arange(0.1, 1.0, 0.1):
    y_pred = (pred_prob >= threshold).astype(int)
    print(f"\nThreshold: {threshold:.1f}")
    print(classification_report(y, y_pred))
```

### 2.6 PROC GLM / PROC MIXED

| Attribute      | SAS                                        | Azure equivalent                        |
| -------------- | ------------------------------------------ | --------------------------------------- |
| **Feature**    | General linear models, ANOVA, mixed models | statsmodels GLM / MixedLM / scipy.stats |
| **Complexity** | M                                          |
| **Coverage**   | 95%                                        |

**SAS:**

```sas
proc mixed data=work.clinical;
  class treatment center patient;
  model outcome = treatment age baseline_score / solution;
  random intercept / subject=center;
  repeated / subject=patient(center) type=cs;
  lsmeans treatment / diff cl;
run;
```

**Python:**

```python
import statsmodels.formula.api as smf

model = smf.mixedlm(
    "outcome ~ treatment + age + baseline_score",
    data=df,
    groups=df["center"],
    re_formula="~1"  # Random intercept
).fit()

print(model.summary())
```

### 2.7 PROC ARIMA / PROC ESM

| Attribute      | SAS                                                 | Azure equivalent                     |
| -------------- | --------------------------------------------------- | ------------------------------------ |
| **Feature**    | Time series modeling (ARIMA, exponential smoothing) | statsmodels.tsa / pmdarima / prophet |
| **Complexity** | M                                                   |
| **Coverage**   | 100%                                                |

**SAS:**

```sas
proc arima data=work.monthly;
  identify var=revenue(1) nlag=24;
  estimate p=1 q=1 ml;
  forecast lead=12 out=work.forecast;
run;
```

**Python:**

```python
from statsmodels.tsa.arima.model import ARIMA
import pmdarima as pm

# Manual ARIMA
model = ARIMA(df['revenue'], order=(1, 1, 1))
results = model.fit()
forecast = results.forecast(steps=12)

# Auto ARIMA (equivalent to SAS identify + estimate)
auto_model = pm.auto_arima(
    df['revenue'],
    seasonal=True, m=12,
    stepwise=True,
    trace=True
)
forecast = auto_model.predict(n_periods=12)
```

### 2.8 PROC SURVEYSELECT / PROC SURVEYMEANS

| Attribute      | SAS                                  | Azure equivalent                       |
| -------------- | ------------------------------------ | -------------------------------------- |
| **Feature**    | Complex survey sampling and analysis | R `survey` package / Python `samplics` |
| **Complexity** | M                                    |
| **Coverage**   | 85%                                  |

**SAS:**

```sas
proc surveyselect data=work.frame out=work.sample
     method=srs n=1000 seed=42;
  strata region;
run;

proc surveymeans data=work.sample;
  weight sampling_weight;
  strata region;
  cluster psu;
  var income expenditure;
run;
```

**Python (samplics):**

```python
from samplics.estimation import TaylorEstimator

estimator = TaylorEstimator("mean")
estimator.estimate(
    y=df['income'],
    samp_weight=df['sampling_weight'],
    stratum=df['region'],
    psu=df['psu']
)
print(estimator.to_dataframe())
```

**Gap note:** Complex replicate variance estimation (BRR, jackknife) is more mature in R's `survey` package than in Python. For heavy survey work, R on Azure ML is recommended.

---

## 3. Reporting and visualization features

### 3.1 SAS Visual Analytics

| Attribute      | SAS                                                  | Azure equivalent       |
| -------------- | ---------------------------------------------------- | ---------------------- |
| **Feature**    | Interactive dashboards, exploration, geographic maps | Power BI + Direct Lake |
| **Complexity** | M                                                    |
| **Coverage**   | 100%+ (Power BI exceeds SAS VA in many areas)        |

See [Reporting Migration](reporting-migration.md) for detailed mapping.

### 3.2 ODS (Output Delivery System)

| Attribute      | SAS                                       | Azure equivalent                                                     |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| **Feature**    | Formatted output to HTML, PDF, RTF, Excel | Fabric notebooks (HTML/PDF) + Power BI paginated reports (PDF/Excel) |
| **Complexity** | M                                         |
| **Coverage**   | 95%                                       |

**SAS:**

```sas
ods pdf file="/output/quarterly_report.pdf" style=journal;
title "Quarterly Analysis Report";

proc means data=work.clean;
  class region;
  var amount;
run;

proc sgplot data=work.clean;
  vbar region / response=amount stat=sum;
run;

ods pdf close;
```

**Python (notebook-based):**

```python
import matplotlib.pyplot as plt
from IPython.display import display, HTML

# Tables
summary = df.groupby('region')['amount'].agg(['count', 'mean', 'std', 'sum'])
display(summary.style.format("{:,.2f}").set_caption("Quarterly Analysis Report"))

# Charts
fig, ax = plt.subplots(figsize=(10, 6))
df.groupby('region')['amount'].sum().plot(kind='bar', ax=ax)
ax.set_title('Total Amount by Region')
plt.tight_layout()

# Export to PDF
# Use nbconvert or Power BI paginated reports for formatted PDF output
```

### 3.3 SAS/GRAPH

| Attribute      | SAS                                              | Azure equivalent                                 |
| -------------- | ------------------------------------------------ | ------------------------------------------------ |
| **Feature**    | Statistical graphics (PROC SGPLOT, PROC SGPANEL) | matplotlib / seaborn / plotly / Power BI visuals |
| **Complexity** | S                                                |
| **Coverage**   | 100%+                                            |

**SAS:**

```sas
proc sgpanel data=work.clean;
  panelby region / columns=2 rows=2;
  scatter x=credit_score y=amount / group=risk_level;
  loess x=credit_score y=amount;
run;
```

**Python:**

```python
import seaborn as sns

g = sns.FacetGrid(df, col='region', col_wrap=2, height=4)
g.map_dataframe(sns.scatterplot, x='credit_score', y='amount', hue='risk_level')
g.map_dataframe(sns.regplot, x='credit_score', y='amount',
                scatter=False, lowess=True, color='black')
g.add_legend()
plt.tight_layout()
```

---

## 4. Machine learning and model management features

### 4.1 SAS Enterprise Miner / SAS Visual Data Mining and ML

| Attribute      | SAS                                               | Azure equivalent                                       |
| -------------- | ------------------------------------------------- | ------------------------------------------------------ |
| **Feature**    | Visual ML workflow (drag-and-drop model building) | Azure AutoML / Databricks AutoML / Fabric Data Science |
| **Complexity** | M                                                 |
| **Coverage**   | 100%+                                             |

### 4.2 SAS Model Manager

| Attribute      | SAS                                             | Azure equivalent                                     |
| -------------- | ----------------------------------------------- | ---------------------------------------------------- |
| **Feature**    | Model registry, champion/challenger, monitoring | MLflow + Azure ML model registry + managed endpoints |
| **Complexity** | M                                               |
| **Coverage**   | 100%+                                           |

See [Model Migration](model-migration.md) for detailed mapping.

### 4.3 SAS Scoring

| Attribute      | SAS                               | Azure equivalent                                         |
| -------------- | --------------------------------- | -------------------------------------------------------- |
| **Feature**    | Real-time and batch model scoring | Azure ML managed endpoints (real-time) + batch endpoints |
| **Complexity** | M                                 |
| **Coverage**   | 100%+                             |

---

## 5. Platform and infrastructure features

### 5.1 SAS Grid Manager

| Attribute      | SAS                                                 | Azure equivalent                                                      |
| -------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| **Feature**    | Workload distribution across SAS servers            | Databricks auto-scaling / Fabric capacity / Azure ML compute clusters |
| **Complexity** | M                                                   |
| **Coverage**   | 100%+ (auto-scaling is more granular than SAS Grid) |

### 5.2 SAS Management Console

| Attribute      | SAS                                                | Azure equivalent                              |
| -------------- | -------------------------------------------------- | --------------------------------------------- |
| **Feature**    | Server administration, user management, scheduling | Azure Portal + Fabric Admin Portal + Entra ID |
| **Complexity** | M                                                  |
| **Coverage**   | 100%                                               |

### 5.3 SAS Metadata Server

| Attribute      | SAS                                                                         | Azure equivalent                   |
| -------------- | --------------------------------------------------------------------------- | ---------------------------------- |
| **Feature**    | Centralized metadata, security, access control                              | Purview + Unity Catalog + Entra ID |
| **Complexity** | L                                                                           |
| **Coverage**   | 100%+ (Purview + Unity Catalog provide richer governance than SAS metadata) |

### 5.4 SAS Viya (Cloud-Native Architecture)

| Attribute      | SAS                                              | Azure equivalent                                             |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| **Feature**    | Kubernetes-based SAS platform                    | Azure-native services (no single SAS Viya equivalent needed) |
| **Complexity** | L (to replace) / M (to lift-and-shift)           |
| **Coverage**   | 95% (replacement) / 100% (lift-and-shift on AKS) |

---

## 6. Domain-specific features

### 6.1 SAS Drug Development

| Attribute      | SAS                                                         | Azure equivalent                                                           |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Feature**    | CDISC SDTM/ADaM dataset generation, FDA submission packages | R `pharmaverse` + Python `cdisc-rules-engine` + SAS Viya on Azure (hybrid) |
| **Complexity** | XL                                                          |
| **Coverage**   | 70% (recommend hybrid: keep SAS for FDA submissions)        |

### 6.2 SAS Risk Management for Banking

| Attribute      | SAS                                                            | Azure equivalent                                                                     |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Feature**    | IFRS 9, CECL, Basel III/IV credit risk models                  | Custom Python + Azure ML (for new models) + SAS Viya on Azure (for validated models) |
| **Complexity** | XL                                                             |
| **Coverage**   | 60% (validated regulatory models should stay on SAS initially) |

### 6.3 SAS Anti-Money Laundering

| Attribute      | SAS                                                                                   | Azure equivalent                                                          |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Feature**    | Transaction monitoring, alert generation, case management                             | Azure ML anomaly detection + custom models + Power Apps (case management) |
| **Complexity** | XL                                                                                    |
| **Coverage**   | 50% (specialized AML requires significant custom development; consider retaining SAS) |

### 6.4 SAS Fraud Management

| Attribute      | SAS                                                                                  | Azure equivalent                                                   |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Feature**    | Real-time fraud detection, scoring, investigation                                    | Azure ML real-time endpoints + Event Hubs + Azure Stream Analytics |
| **Complexity** | L                                                                                    |
| **Coverage**   | 80% (core detection is replaceable; operational tooling requires custom development) |

---

## 7. Summary gap analysis

### Features with full Azure coverage (safe to migrate)

| SAS feature                | Azure replacement             | Confidence |
| -------------------------- | ----------------------------- | ---------- |
| DATA Step                  | Python/PySpark                | High       |
| PROC SQL                   | Spark SQL / dbt               | High       |
| PROC SORT                  | DataFrame sort                | High       |
| PROC TRANSPOSE             | pivot/melt                    | High       |
| PROC MEANS/FREQ/UNIVARIATE | pandas/scipy                  | High       |
| PROC REG/LOGISTIC/GLM      | statsmodels/sklearn           | High       |
| PROC ARIMA/ESM             | statsmodels/pmdarima          | High       |
| SAS Visual Analytics       | Power BI                      | High       |
| ODS                        | Notebooks + paginated reports | High       |
| SAS/GRAPH                  | matplotlib/plotly/seaborn     | High       |
| SAS Enterprise Miner       | Azure AutoML                  | High       |
| SAS Model Manager          | MLflow + Azure ML             | High       |
| SAS Data Integration       | ADF + dbt                     | High       |
| SAS Formats                | dbt seeds / lookup tables     | High       |
| SAS Macro language         | Python functions / Jinja      | High       |
| SAS Grid Manager           | Auto-scaling compute          | High       |

### Features with partial coverage (migrate with caution)

| SAS feature               | Azure replacement       | Gap          | Recommendation                               |
| ------------------------- | ----------------------- | ------------ | -------------------------------------------- |
| PROC SURVEY\*             | samplics / R survey     | 85% coverage | Use R for complex survey designs             |
| SAS Hash Objects          | PySpark broadcast joins | 90% at scale | Acceptable for most use cases                |
| SAS IML (matrix language) | NumPy / SciPy           | 95% coverage | Minor syntax differences                     |
| PROC OPTMODEL             | PuLP / OR-Tools         | 80% coverage | Complex stochastic optimization stays on SAS |

### Features to retain on SAS (lift-and-shift recommended)

| SAS feature                     | Gap reason                          | Timeline for Azure replacement                      |
| ------------------------------- | ----------------------------------- | --------------------------------------------------- |
| SAS Drug Development            | FDA regulatory acceptance           | 2--4 years (as R pharmaverse matures)               |
| SAS Risk Management for Banking | Validated regulatory models         | 3--5 years (as Python validation frameworks mature) |
| SAS Anti-Money Laundering       | Domain-specific operational tooling | 2--3 years (partial replacement feasible now)       |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
