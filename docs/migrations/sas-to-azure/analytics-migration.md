# SAS Analytics Migration: Procedures to Python/R

**Audience:** SAS Programmers, Data Scientists, Statistical Analysts
**Purpose:** Side-by-side conversion guide for migrating SAS statistical procedures to Python and R equivalents on Azure ML, Fabric, and Databricks.

---

## 1. Overview

This guide provides concrete, side-by-side code examples for converting SAS statistical procedures to Python equivalents. Each section follows the same pattern: SAS code on the left, Python code on the right, with notes on output differences, validation criteria, and edge cases.

**Key Python packages used throughout:**

| Package                  | SAS equivalent                    | Purpose                                   |
| ------------------------ | --------------------------------- | ----------------------------------------- |
| `pandas`                 | Base SAS DATA Step                | Data manipulation                         |
| `numpy`                  | SAS functions                     | Numerical operations                      |
| `scipy.stats`            | SAS/STAT procedures               | Statistical tests                         |
| `statsmodels`            | SAS/STAT (regression diagnostics) | Statistical modeling with detailed output |
| `scikit-learn`           | SAS Enterprise Miner              | Machine learning                          |
| `matplotlib` / `seaborn` | SAS/GRAPH, PROC SGPLOT            | Visualization                             |
| `pmdarima`               | SAS/ETS PROC ARIMA                | Time series                               |
| `lifelines`              | SAS/STAT PROC LIFETEST, PHREG     | Survival analysis                         |

---

## 2. Descriptive statistics

### 2.1 PROC MEANS to pandas/scipy

**SAS:**

```sas
proc means data=sashelp.heart n mean std stderr min q1 median q3 max
           maxdec=2 clm alpha=0.05;
  class sex smoking_status;
  var cholesterol weight systolic;
  output out=work.heart_stats
    mean= std= min= max= / autoname;
run;
```

**Python:**

```python
import pandas as pd
import numpy as np
from scipy import stats

df = spark.table("health.heart").toPandas()

# Basic descriptive statistics (n, mean, std, min, 25%, 50%, 75%, max)
summary = df.groupby(['sex', 'smoking_status'])[
    ['cholesterol', 'weight', 'systolic']
].describe().round(2)

# Add standard error and confidence intervals
def detailed_stats(group):
    result = {}
    for col in ['cholesterol', 'weight', 'systolic']:
        vals = group[col].dropna()
        n = len(vals)
        mean = vals.mean()
        std = vals.std()
        se = stats.sem(vals)
        ci = stats.t.interval(0.95, df=n-1, loc=mean, scale=se)
        result.update({
            f'{col}_n': n,
            f'{col}_mean': round(mean, 2),
            f'{col}_std': round(std, 2),
            f'{col}_stderr': round(se, 2),
            f'{col}_min': round(vals.min(), 2),
            f'{col}_q1': round(vals.quantile(0.25), 2),
            f'{col}_median': round(vals.median(), 2),
            f'{col}_q3': round(vals.quantile(0.75), 2),
            f'{col}_max': round(vals.max(), 2),
            f'{col}_lclm': round(ci[0], 2),
            f'{col}_uclm': round(ci[1], 2),
        })
    return pd.Series(result)

heart_stats = df.groupby(['sex', 'smoking_status']).apply(detailed_stats)
```

**Validation:** Compare mean, std, and confidence intervals. SAS uses `N-1` for standard deviation (sample std) by default; pandas `.std()` also defaults to `ddof=1`. Values should match within rounding tolerance.

### 2.2 PROC SUMMARY to PySpark aggregation

For large datasets, use PySpark instead of pandas:

**SAS:**

```sas
proc summary data=large.transactions nway;
  class region product_category month;
  var revenue quantity discount;
  output out=work.monthly_summary(drop=_type_ _freq_)
    sum(revenue)=total_revenue
    mean(quantity)=avg_quantity
    sum(discount)=total_discount
    n(revenue)=n_transactions;
run;
```

**PySpark:**

```python
from pyspark.sql import functions as F

monthly_summary = (
    spark.table("large.transactions")
    .groupBy("region", "product_category", "month")
    .agg(
        F.sum("revenue").alias("total_revenue"),
        F.avg("quantity").alias("avg_quantity"),
        F.sum("discount").alias("total_discount"),
        F.count("revenue").alias("n_transactions")
    )
)
monthly_summary.write.mode("overwrite").saveAsTable("work.monthly_summary")
```

---

## 3. Frequency analysis

### 3.1 PROC FREQ to pandas crosstab

**SAS:**

```sas
proc freq data=work.survey;
  tables education * income_bracket / chisq expected
         cellchi2 cramersv measures relrisk
         norow nocol;
  tables health_status / binomial(p=0.5) alpha=0.05;
  weight survey_weight;
run;
```

**Python:**

```python
import pandas as pd
from scipy import stats

# One-way frequency table
freq = df['health_status'].value_counts()
pct = df['health_status'].value_counts(normalize=True) * 100
one_way = pd.DataFrame({'Count': freq, 'Percent': pct, 'Cumulative': pct.cumsum()})

# Binomial test
from scipy.stats import binomtest
n_good = (df['health_status'] == 'Good').sum()
n_total = len(df)
result = binomtest(n_good, n_total, p=0.5)
print(f"Binomial test p-value: {result.pvalue:.4f}")

# Two-way cross-tabulation
ct = pd.crosstab(df['education'], df['income_bracket'])
print("\nCross-tabulation:")
print(ct)

# Chi-square test
chi2, p, dof, expected = stats.chi2_contingency(ct)
print(f"\nChi-square: {chi2:.4f}")
print(f"p-value: {p:.6f}")
print(f"Degrees of freedom: {dof}")

# Cramer's V
n = ct.sum().sum()
cramers_v = np.sqrt(chi2 / (n * (min(ct.shape) - 1)))
print(f"Cramer's V: {cramers_v:.4f}")

# Expected frequencies
expected_df = pd.DataFrame(expected, index=ct.index, columns=ct.columns)
print("\nExpected frequencies:")
print(expected_df.round(1))
```

### 3.2 PROC FREQ with TABLES / OUT= option

**SAS:**

```sas
proc freq data=work.claims noprint;
  tables diagnosis_code / out=work.diag_freq outcum;
run;
```

**Python:**

```python
diag_freq = (df['diagnosis_code']
    .value_counts()
    .reset_index()
    .rename(columns={'index': 'diagnosis_code', 'diagnosis_code': 'count'}))
diag_freq.columns = ['diagnosis_code', 'count']
diag_freq['percent'] = (diag_freq['count'] / diag_freq['count'].sum() * 100).round(2)
diag_freq['cum_count'] = diag_freq['count'].cumsum()
diag_freq['cum_percent'] = diag_freq['percent'].cumsum().round(2)
```

---

## 4. Regression analysis

### 4.1 PROC REG to statsmodels OLS

**SAS:**

```sas
proc reg data=work.housing plots(only)=(diagnostics residuals);
  model price = sqft bedrooms bathrooms age lot_size
                / vif collin dwprob influence r stb;
  output out=work.reg_out p=predicted r=residual
         student=rstudent cookd=cooksd h=leverage
         press=press;
run;
```

**Python (statsmodels for full diagnostics):**

```python
import statsmodels.api as sm
from statsmodels.stats.outliers_influence import variance_inflation_factor
from statsmodels.stats.stattools import durbin_watson
from statsmodels.stats.diagnostic import het_breuschpagan
import matplotlib.pyplot as plt

# Prepare data
predictors = ['sqft', 'bedrooms', 'bathrooms', 'age', 'lot_size']
X = df[predictors]
X = sm.add_constant(X)
y = df['price']

# Fit model
model = sm.OLS(y, X).fit()

# Full summary (equivalent to PROC REG output)
print(model.summary())
# Includes: R-squared, Adj R-squared, F-statistic, AIC/BIC,
# coefficients, std errors, t-values, p-values, confidence intervals

# Standardized coefficients (STB option)
X_std = (X.iloc[:, 1:] - X.iloc[:, 1:].mean()) / X.iloc[:, 1:].std()
X_std = sm.add_constant(X_std)
model_std = sm.OLS((y - y.mean()) / y.std(), X_std).fit()
print("\nStandardized coefficients:")
print(model_std.params[1:])

# VIF (collinearity diagnostics)
vif = pd.DataFrame({
    'Variable': predictors,
    'VIF': [variance_inflation_factor(X.values, i+1)
            for i in range(len(predictors))]
})
print("\nVariance Inflation Factors:")
print(vif)

# Durbin-Watson (autocorrelation)
dw = durbin_watson(model.resid)
print(f"\nDurbin-Watson: {dw:.4f}")

# Influence diagnostics
influence = model.get_influence()
summary_frame = influence.summary_frame()

# Output dataset (equivalent to OUTPUT statement)
df['predicted'] = model.predict(X)
df['residual'] = model.resid
df['rstudent'] = summary_frame['student_resid']
df['cooksd'] = summary_frame['cooks_d']
df['leverage'] = summary_frame['hat_diag']

# Diagnostic plots
fig, axes = plt.subplots(2, 2, figsize=(14, 10))
# Residuals vs Fitted
axes[0,0].scatter(model.fittedvalues, model.resid, alpha=0.5)
axes[0,0].axhline(y=0, color='r', linestyle='--')
axes[0,0].set_xlabel('Fitted Values')
axes[0,0].set_ylabel('Residuals')
axes[0,0].set_title('Residuals vs Fitted')

# Q-Q plot
sm.qqplot(model.resid, line='s', ax=axes[0,1])
axes[0,1].set_title('Normal Q-Q')

# Scale-Location
axes[1,0].scatter(model.fittedvalues, np.sqrt(np.abs(model.resid)), alpha=0.5)
axes[1,0].set_xlabel('Fitted Values')
axes[1,0].set_ylabel('Sqrt(|Residuals|)')
axes[1,0].set_title('Scale-Location')

# Cook's Distance
axes[1,1].stem(range(len(summary_frame['cooks_d'])),
               summary_frame['cooks_d'], markerfmt=',')
axes[1,1].set_xlabel('Observation')
axes[1,1].set_ylabel("Cook's Distance")
axes[1,1].set_title("Cook's Distance")

plt.tight_layout()
plt.show()
```

### 4.2 PROC LOGISTIC to statsmodels/sklearn

**SAS:**

```sas
proc logistic data=work.credit descending;
  class employment_type (ref='Salaried') housing (ref='Own') / param=ref;
  model default = employment_type housing income debt_ratio
                  credit_history age
                  / selection=stepwise slentry=0.05 slstay=0.10
                    lackfit rsquare stb ctable;
  output out=work.credit_scored p=pred_default;
  roc 'Full Model';
run;
```

**Python:**

```python
import statsmodels.api as sm
from sklearn.linear_model import LogisticRegression
from sklearn.feature_selection import SequentialFeatureSelector
from sklearn.metrics import (roc_auc_score, roc_curve,
                              classification_report, confusion_matrix)

# Prepare features (equivalent to CLASS statement with param=ref)
df_encoded = pd.get_dummies(df[['employment_type', 'housing']],
                            drop_first=True)
numeric_cols = ['income', 'debt_ratio', 'credit_history', 'age']
X = pd.concat([df_encoded, df[numeric_cols]], axis=1)
X_const = sm.add_constant(X)
y = df['default']

# Stepwise selection (equivalent to selection=stepwise)
from sklearn.linear_model import LogisticRegression as LR_sklearn
selector = SequentialFeatureSelector(
    LR_sklearn(max_iter=1000),
    n_features_to_select='auto',
    direction='both',
    scoring='roc_auc',
    cv=5
)
selector.fit(X, y)
selected_features = X.columns[selector.get_support()].tolist()
print(f"Selected features: {selected_features}")

# Fit final model with statsmodels (for detailed output)
X_final = sm.add_constant(X[selected_features])
logit_model = sm.Logit(y, X_final).fit()
print(logit_model.summary())
# Includes: pseudo R-squared, log-likelihood, coefficients, z-values, p-values

# Hosmer-Lemeshow test (lackfit equivalent)
pred_prob = logit_model.predict(X_final)
def hosmer_lemeshow_test(y_true, y_pred, n_groups=10):
    data = pd.DataFrame({'y': y_true, 'p': y_pred})
    data['decile'] = pd.qcut(data['p'], n_groups, labels=False, duplicates='drop')
    hl_table = data.groupby('decile').agg(
        obs_events=('y', 'sum'),
        obs_nonevents=('y', lambda x: len(x) - sum(x)),
        exp_events=('p', 'sum'),
        exp_nonevents=('p', lambda x: len(x) - sum(x)),
        n=('y', 'count')
    )
    hl_stat = (
        ((hl_table['obs_events'] - hl_table['exp_events'])**2 / hl_table['exp_events']) +
        ((hl_table['obs_nonevents'] - hl_table['exp_nonevents'])**2 / hl_table['exp_nonevents'])
    ).sum()
    p_value = 1 - stats.chi2.cdf(hl_stat, n_groups - 2)
    return hl_stat, p_value

hl_stat, hl_p = hosmer_lemeshow_test(y, pred_prob)
print(f"\nHosmer-Lemeshow: chi2={hl_stat:.4f}, p={hl_p:.4f}")

# ROC curve
auc = roc_auc_score(y, pred_prob)
fpr, tpr, thresholds = roc_curve(y, pred_prob)
print(f"\nAUC (Concordance): {auc:.4f}")

plt.figure(figsize=(8, 6))
plt.plot(fpr, tpr, label=f'ROC (AUC = {auc:.4f})')
plt.plot([0, 1], [0, 1], 'k--')
plt.xlabel('False Positive Rate')
plt.ylabel('True Positive Rate')
plt.title('ROC Curve')
plt.legend()
plt.show()

# Classification table (ctable equivalent)
for threshold in [0.3, 0.4, 0.5, 0.6, 0.7]:
    y_pred = (pred_prob >= threshold).astype(int)
    cm = confusion_matrix(y, y_pred)
    print(f"\nThreshold: {threshold}")
    print(f"Sensitivity: {cm[1,1]/(cm[1,0]+cm[1,1]):.4f}")
    print(f"Specificity: {cm[0,0]/(cm[0,0]+cm[0,1]):.4f}")
```

### 4.3 PROC GLM to statsmodels

**SAS:**

```sas
proc glm data=work.experiment;
  class treatment block;
  model yield = treatment block treatment*block;
  means treatment / tukey alpha=0.05;
  lsmeans treatment / pdiff cl adjust=tukey;
run;
```

**Python:**

```python
import statsmodels.api as sm
from statsmodels.formula.api import ols
from statsmodels.stats.multicomp import pairwise_tukeyhsd

# Two-way ANOVA
model = ols('yield ~ C(treatment) + C(block) + C(treatment):C(block)',
            data=df).fit()
anova_table = sm.stats.anova_lm(model, typ=2)
print("ANOVA Table:")
print(anova_table)

# Tukey's HSD for treatment means
tukey = pairwise_tukeyhsd(df['yield'], df['treatment'], alpha=0.05)
print("\nTukey HSD Results:")
print(tukey)
print(tukey.summary())
```

---

## 5. Time series analysis

### 5.1 PROC ARIMA to statsmodels/pmdarima

**SAS:**

```sas
proc arima data=work.monthly_sales;
  identify var=revenue(1,12) nlag=36 stationarity=(adf=2);
  estimate p=(1)(12) q=(1)(12) method=ml;
  forecast lead=24 id=month interval=month out=work.forecast;
run;
```

**Python:**

```python
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.seasonal import seasonal_decompose
from statsmodels.tsa.stattools import adfuller
import pmdarima as pm

# Set datetime index
ts = df.set_index('month')['revenue']

# Stationarity test (equivalent to STATIONARITY=(ADF=2))
adf_result = adfuller(ts, maxlag=2)
print(f"ADF Statistic: {adf_result[0]:.4f}")
print(f"p-value: {adf_result[1]:.4f}")

# Seasonal decomposition
decomposition = seasonal_decompose(ts, model='additive', period=12)
decomposition.plot()
plt.show()

# Auto ARIMA (identifies optimal p, d, q, P, D, Q)
auto_model = pm.auto_arima(
    ts,
    seasonal=True, m=12,
    d=1, D=1,
    max_p=3, max_q=3,
    max_P=2, max_Q=2,
    stepwise=True,
    trace=True,
    error_action='ignore',
    suppress_warnings=True
)
print(auto_model.summary())

# Forecast
forecast, conf_int = auto_model.predict(n_periods=24, return_conf_int=True)

# Plot forecast
fig, ax = plt.subplots(figsize=(14, 6))
ax.plot(ts.index, ts.values, label='Actual')
forecast_index = pd.date_range(ts.index[-1], periods=25, freq='MS')[1:]
ax.plot(forecast_index, forecast, label='Forecast', color='red')
ax.fill_between(forecast_index, conf_int[:, 0], conf_int[:, 1],
                alpha=0.2, color='red')
ax.legend()
ax.set_title('Revenue Forecast (24 months)')
plt.show()
```

---

## 6. Survival analysis

### 6.1 PROC LIFETEST to lifelines

**SAS:**

```sas
proc lifetest data=work.patients method=km plots=(survival(cl));
  time follow_up_months * event(0);
  strata treatment;
run;
```

**Python:**

```python
from lifelines import KaplanMeierFitter
from lifelines.statistics import logrank_test

kmf = KaplanMeierFitter()

fig, ax = plt.subplots(figsize=(10, 6))
for treatment in df['treatment'].unique():
    mask = df['treatment'] == treatment
    kmf.fit(df.loc[mask, 'follow_up_months'],
            event_observed=df.loc[mask, 'event'],
            label=treatment)
    kmf.plot_survival_function(ax=ax, ci_show=True)

ax.set_title('Kaplan-Meier Survival Curves')
ax.set_xlabel('Follow-up (months)')
ax.set_ylabel('Survival Probability')
plt.show()

# Log-rank test (equivalent to PROC LIFETEST strata comparison)
groups = df['treatment'].unique()
T1 = df[df['treatment'] == groups[0]]['follow_up_months']
E1 = df[df['treatment'] == groups[0]]['event']
T2 = df[df['treatment'] == groups[1]]['follow_up_months']
E2 = df[df['treatment'] == groups[1]]['event']
results = logrank_test(T1, T2, event_observed_A=E1, event_observed_B=E2)
print(f"Log-rank test: chi2={results.test_statistic:.4f}, p={results.p_value:.4f}")
```

### 6.2 PROC PHREG to lifelines CoxPH

**SAS:**

```sas
proc phreg data=work.patients;
  class treatment (ref='Control') sex (ref='M');
  model follow_up_months * event(0) = treatment sex age tumor_size
        / rl ties=efron;
  hazardratio treatment / diff=ref;
run;
```

**Python:**

```python
from lifelines import CoxPHFitter

# Prepare data (encode categorical variables)
df_cox = pd.get_dummies(df[['follow_up_months', 'event', 'treatment',
                             'sex', 'age', 'tumor_size']],
                        columns=['treatment', 'sex'], drop_first=True)

cph = CoxPHFitter()
cph.fit(df_cox, duration_col='follow_up_months', event_col='event')
cph.print_summary()  # Coefficients, hazard ratios, CIs, p-values

# Hazard ratios
print("\nHazard Ratios:")
print(np.exp(cph.params_))
```

---

## 7. SAS macro to Python function migration patterns

### 7.1 Simple macro variables

**SAS:**

```sas
%let start_date = 01JAN2026;
%let end_date = 31DEC2026;
%let min_sample = 30;

data work.filtered;
  set work.raw;
  where date between "&start_date"d and "&end_date"d;
  if n >= &min_sample;
run;
```

**Python:**

```python
start_date = '2026-01-01'
end_date = '2026-12-31'
min_sample = 30

filtered = df[
    (df['date'] >= start_date) &
    (df['date'] <= end_date) &
    (df['n'] >= min_sample)
]
```

### 7.2 Parameterized macro to function

**SAS:**

```sas
%macro quarterly_report(dataset=, quarter=, output=);
  proc means data=&dataset noprint;
    where qtr(date) = &quarter;
    class region;
    var revenue expenses;
    output out=&output sum= mean= / autoname;
  run;

  proc sgplot data=&output;
    vbar region / response=revenue_sum;
    title "Q&quarter Revenue by Region";
  run;
%mend;

%quarterly_report(dataset=work.financials, quarter=1, output=work.q1_report);
%quarterly_report(dataset=work.financials, quarter=2, output=work.q2_report);
```

**Python:**

```python
def quarterly_report(df, quarter, output_table=None):
    """Generate quarterly summary and visualization.

    Replaces %macro quarterly_report.
    """
    # Filter to quarter
    q_data = df[df['date'].dt.quarter == quarter]

    # Summary statistics
    summary = q_data.groupby('region')[['revenue', 'expenses']].agg(['sum', 'mean'])
    summary.columns = ['_'.join(col) for col in summary.columns]
    summary = summary.reset_index()

    # Visualization
    fig, ax = plt.subplots(figsize=(10, 6))
    summary.plot(x='region', y='revenue_sum', kind='bar', ax=ax)
    ax.set_title(f'Q{quarter} Revenue by Region')
    ax.set_ylabel('Revenue')
    plt.tight_layout()
    plt.show()

    # Optionally save to lakehouse
    if output_table:
        spark.createDataFrame(summary).write.mode("overwrite").saveAsTable(output_table)

    return summary

q1 = quarterly_report(financials_df, quarter=1, output_table='work.q1_report')
q2 = quarterly_report(financials_df, quarter=2, output_table='work.q2_report')
```

### 7.3 Iterative macro (%DO loop) to Python loop

**SAS:**

```sas
%macro process_all_regions;
  proc sql noprint;
    select distinct region into :regions separated by '|'
    from work.master;
  quit;

  %let n = %sysfunc(countw(&regions, |));
  %do i = 1 %to &n;
    %let r = %scan(&regions, &i, |);
    data work.region_&r;
      set work.master;
      where region = "&r";
    run;
    %quarterly_report(dataset=work.region_&r, quarter=1,
                      output=work.q1_&r);
  %end;
%mend;
```

**Python:**

```python
regions = df['region'].unique()

results = {}
for region in regions:
    region_df = df[df['region'] == region]
    results[region] = quarterly_report(region_df, quarter=1,
                                       output_table=f'work.q1_{region.lower()}')
```

---

## 8. Common conversion patterns (quick reference)

| SAS pattern                     | Python equivalent                                            | Notes                |
| ------------------------------- | ------------------------------------------------------------ | -------------------- |
| `data work.x; set work.y; run;` | `x = y.copy()`                                               | DataFrame copy       |
| `if condition then delete;`     | `df = df[~condition]`                                        | Row filtering        |
| `retain var 0;`                 | `df['var'] = df['var'].cumsum()` or loop                     | Accumulator pattern  |
| `first.by_var` / `last.by_var`  | `.groupby().first()` / `.groupby().last()`                   | BY-group processing  |
| `lag(var)`                      | `df['var'].shift(1)`                                         | Lag function         |
| `dif(var)`                      | `df['var'].diff(1)`                                          | Difference function  |
| `intck('month', date1, date2)`  | `(date2.year - date1.year)*12 + (date2.month - date1.month)` | Interval counting    |
| `intnx('month', date, n)`       | `date + pd.DateOffset(months=n)`                             | Date incrementing    |
| `compress(var)`                 | `var.str.replace(r'\s+', '', regex=True)`                    | Remove whitespace    |
| `upcase(var)`                   | `var.str.upper()`                                            | Uppercase            |
| `input(var, 8.)`                | `pd.to_numeric(var)`                                         | Character to numeric |
| `put(var, $fmt.)`               | Lookup table join or `.map()`                                | Format application   |
| `merge a b; by key;`            | `pd.merge(a, b, on='key')`                                   | Dataset merge        |
| `proc append base=a data=b;`    | `pd.concat([a, b])`                                          | Append datasets      |
| `_N_`                           | `len(df)`                                                    | Observation count    |
| `_n_`                           | `df.index` or `range(len(df))`                               | Row number           |

---

## 9. Validation framework

After converting a SAS program to Python, validate using this checklist:

| Check                              | Tolerance                        | Method                                             |
| ---------------------------------- | -------------------------------- | -------------------------------------------------- |
| Row counts                         | Exact match                      | `len(sas_output) == len(python_output)`            |
| Column names                       | Exact match                      | Compare column lists                               |
| Numeric columns (mean)             | Within 0.001%                    | `abs(sas_mean - python_mean) / sas_mean < 0.00001` |
| Numeric columns (sum)              | Within 0.001%                    | Same relative tolerance                            |
| Categorical frequencies            | Exact match                      | Compare value_counts                               |
| Missing value counts               | Exact match                      | Compare null counts per column                     |
| Coefficient estimates (regression) | Within 0.01                      | Compare model coefficients                         |
| Standard errors                    | Within 0.01                      | Compare SE values                                  |
| p-values                           | Same significance level          | Both above or below 0.05 threshold                 |
| AUC / concordance                  | Within 0.005                     | Compare ROC AUC                                    |
| Predicted values                   | Mean absolute difference < 0.005 | Compare prediction arrays                          |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
