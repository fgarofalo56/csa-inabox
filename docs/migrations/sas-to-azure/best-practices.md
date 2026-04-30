# SAS to Azure: Migration Best Practices

**Audience:** Migration Program Managers, Data Engineering Leads, Analytics Directors
**Purpose:** Workforce reskilling program, dual-running validation methodology, phased program migration strategy, output reconciliation framework, and CSA-in-a-Box as the unified analytics landing zone.

---

## 1. Workforce reskilling program

### 1.1 The reskilling imperative

SAS programmers are not being replaced --- they are being upskilled. A SAS programmer who adds Python to their skill set becomes a more valuable analyst because they understand both statistical methodology (from SAS training) and modern tooling (from Python). The reskilling program should be framed as a career investment, not a displacement.

### 1.2 Reskilling curriculum

**Phase 1: Python foundations (Weeks 1--2)**

| Topic                        | Hours        | Objective                                 | SAS programmer note                                  |
| ---------------------------- | ------------ | ----------------------------------------- | ---------------------------------------------------- |
| Python syntax and data types | 8            | Write basic Python scripts                | `data _null_; put "Hello";` becomes `print("Hello")` |
| pandas fundamentals          | 12           | Read, filter, transform, merge DataFrames | Replaces DATA Step for most operations               |
| numpy basics                 | 4            | Array operations, mathematical functions  | Replaces SAS functions (mean, std, log, etc.)        |
| Jupyter/Fabric notebooks     | 4            | Interactive analysis workflow             | Replaces SAS Enterprise Guide                        |
| Python functions and modules | 8            | Write reusable code                       | Replaces SAS macros                                  |
| **Total Phase 1**            | **36 hours** |                                           |                                                      |

**Phase 2: Statistics and visualization (Weeks 3--4)**

| Topic                                    | Hours        | Objective                                    | SAS programmer note                              |
| ---------------------------------------- | ------------ | -------------------------------------------- | ------------------------------------------------ |
| scipy.stats                              | 8            | Hypothesis tests, distributions              | Replaces PROC FREQ (chi-square), PROC UNIVARIATE |
| statsmodels regression                   | 12           | Linear, logistic regression with diagnostics | Replaces PROC REG, PROC LOGISTIC                 |
| matplotlib and seaborn                   | 8            | Statistical graphics                         | Replaces PROC SGPLOT, SAS/GRAPH                  |
| plotly (interactive)                     | 4            | Interactive visualizations                   | Enhances SAS VA capabilities                     |
| pandas advanced (groupby, pivot, window) | 8            | Complex data manipulation                    | Replaces PROC MEANS, PROC TRANSPOSE, BY-group    |
| **Total Phase 2**                        | **40 hours** |                                              |                                                  |

**Phase 3: Platform and ML (Weeks 5--6)**

| Topic                | Hours        | Objective                           | SAS programmer note                            |
| -------------------- | ------------ | ----------------------------------- | ---------------------------------------------- |
| PySpark fundamentals | 12           | Large-scale data processing         | Replaces SAS CAS / SAS Grid for large datasets |
| scikit-learn         | 12           | Machine learning pipelines          | Replaces SAS Enterprise Miner                  |
| MLflow basics        | 8            | Experiment tracking, model registry | Replaces SAS Model Manager                     |
| dbt fundamentals     | 8            | SQL transformations, testing        | Replaces SAS DI Studio                         |
| Azure ML workspace   | 4            | Cloud ML platform                   | New capability                                 |
| Fabric notebooks     | 4            | Fabric-specific notebook features   | Replaces SAS Studio                            |
| **Total Phase 3**    | **48 hours** |                                     |                                                |

**Phase 4: Applied migration (Weeks 7--8)**

| Topic                         | Hours        | Objective                          | SAS programmer note             |
| ----------------------------- | ------------ | ---------------------------------- | ------------------------------- |
| Convert 3 real SAS programs   | 20           | Hands-on migration practice        | Use analyst's own programs      |
| Output validation             | 8            | Compare SAS and Python outputs     | Critical skill for dual-running |
| Power BI fundamentals         | 8            | Basic report building              | Replaces SAS VA                 |
| Code review and collaboration | 4            | Git, pull requests, code standards | New workflow for most SAS teams |
| **Total Phase 4**             | **40 hours** |                                    |                                 |

**Total program:** 164 hours (~4 weeks full-time or 8 weeks half-time)

### 1.3 Training delivery recommendations

| Delivery method               | Best for                    | Cost per person    | Notes                                         |
| ----------------------------- | --------------------------- | ------------------ | --------------------------------------------- |
| Instructor-led (in-person)    | Groups of 10--20            | $3K--$5K           | Highest engagement; allows real-time Q&A      |
| Instructor-led (virtual)      | Distributed teams           | $2K--$4K           | Effective if well-structured; record sessions |
| Self-paced online             | Individual learners         | $500--$1K          | Coursera, DataCamp, LinkedIn Learning         |
| Paired programming            | Post-training reinforcement | Internal cost only | Pair SAS programmer with Python mentor        |
| Hackathon / conversion sprint | Post-training application   | Internal cost only | Convert real SAS programs in a team setting   |

### 1.4 Recommended learning resources

| Resource                                   | Cost       | Level        | Notes                                              |
| ------------------------------------------ | ---------- | ------------ | -------------------------------------------------- |
| DataCamp "Python for SAS Users"            | $300/year  | Beginner     | Specifically designed for SAS-to-Python transition |
| Coursera "Python for Data Science" (UMich) | $50/month  | Beginner     | Comprehensive; includes pandas and sklearn         |
| "Python for SAS Users" by Randy Betancourt | $50 (book) | Intermediate | The definitive SAS-to-Python reference book        |
| "Effective Pandas" by Matt Harrison        | $40 (book) | Intermediate | Deep pandas skills                                 |
| Microsoft Learn "Azure ML" path            | Free       | Intermediate | Azure-specific ML training                         |
| Fabric Learn path                          | Free       | Beginner     | Microsoft Fabric training                          |

### 1.5 Measuring reskilling success

| Metric                        | Target                                  | Measurement                                                 |
| ----------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Python proficiency assessment | 80% pass rate                           | Post-training assessment (technical quiz + coding exercise) |
| SAS-to-Python conversion rate | 5 programs/analyst/month after 3 months | Track program conversions per analyst                       |
| Output validation accuracy    | 100% first-pass accuracy                | No validation failures on production conversions            |
| Analyst satisfaction          | 75% positive                            | Survey at 3 months and 6 months post-training               |
| Time-to-productivity          | 80% of SAS productivity by Week 12      | Track task completion rates                                 |

---

## 2. Dual-running validation methodology

### 2.1 Why dual-run

Dual-running means executing both the SAS program and the Python equivalent simultaneously for a validation period (typically 2--4 weeks per program) and comparing outputs. This is the only reliable way to prove that the migration preserves analytical correctness.

### 2.2 Validation levels

| Level                                | Scope                                                      | When to use                                           | Duration |
| ------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------- | -------- |
| **Level 1: Summary**                 | Compare aggregate statistics (means, sums, counts)         | Low-risk reports, descriptive statistics              | 1 week   |
| **Level 2: Row-level sample**        | Compare 1,000 randomly sampled rows                        | Standard analytical programs                          | 2 weeks  |
| **Level 3: Full row-level**          | Compare every row and every column                         | High-risk programs, regulatory outputs, model scoring | 4 weeks  |
| **Level 4: Statistical equivalence** | Formal statistical tests (paired t-test, equivalence test) | Production models, survey estimates                   | 4+ weeks |

### 2.3 Reconciliation framework

```python
import pandas as pd
import numpy as np
from scipy import stats

def reconcile_outputs(sas_output, python_output, key_columns,
                      numeric_tolerance=0.001, report_path=None):
    """Compare SAS and Python outputs for validation.

    Args:
        sas_output: DataFrame from SAS (exported to CSV or Delta)
        python_output: DataFrame from Python
        key_columns: List of columns to join on
        numeric_tolerance: Maximum relative difference for numeric columns
        report_path: Optional path to save HTML report

    Returns:
        Dictionary with validation results
    """
    results = {'passed': True, 'details': []}

    # 1. Row count comparison
    sas_rows = len(sas_output)
    python_rows = len(python_output)
    row_match = sas_rows == python_rows
    results['details'].append({
        'check': 'Row count',
        'sas': sas_rows,
        'python': python_rows,
        'passed': row_match
    })
    if not row_match:
        results['passed'] = False

    # 2. Column comparison
    sas_cols = set(sas_output.columns)
    python_cols = set(python_output.columns)
    missing_in_python = sas_cols - python_cols
    extra_in_python = python_cols - sas_cols
    results['details'].append({
        'check': 'Column match',
        'missing_in_python': list(missing_in_python),
        'extra_in_python': list(extra_in_python),
        'passed': len(missing_in_python) == 0
    })

    # 3. Merge on key columns for row-level comparison
    common_cols = sas_cols & python_cols - set(key_columns)
    merged = pd.merge(sas_output, python_output, on=key_columns,
                       suffixes=('_sas', '_python'), how='outer',
                       indicator=True)

    # Check for unmatched rows
    sas_only = (merged['_merge'] == 'left_only').sum()
    python_only = (merged['_merge'] == 'right_only').sum()
    both = (merged['_merge'] == 'both').sum()
    results['details'].append({
        'check': 'Row matching',
        'matched': both,
        'sas_only': sas_only,
        'python_only': python_only,
        'passed': sas_only == 0 and python_only == 0
    })

    # 4. Numeric column comparison
    for col in common_cols:
        sas_col = f'{col}_sas'
        py_col = f'{col}_python'
        if sas_col not in merged.columns:
            continue

        if merged[sas_col].dtype in ['float64', 'int64', 'float32', 'int32']:
            matched = merged[merged['_merge'] == 'both']
            sas_vals = matched[sas_col].dropna()
            py_vals = matched[py_col].dropna()

            if len(sas_vals) == 0:
                continue

            mae = np.mean(np.abs(sas_vals.values - py_vals.values))
            max_diff = np.max(np.abs(sas_vals.values - py_vals.values))
            sas_mean = sas_vals.mean()
            rel_diff = mae / abs(sas_mean) if sas_mean != 0 else mae

            col_passed = rel_diff < numeric_tolerance
            results['details'].append({
                'check': f'Numeric: {col}',
                'sas_mean': round(sas_mean, 6),
                'python_mean': round(py_vals.mean(), 6),
                'mae': round(mae, 8),
                'max_diff': round(max_diff, 8),
                'relative_diff': round(rel_diff, 8),
                'passed': col_passed
            })
            if not col_passed:
                results['passed'] = False

    # Generate report
    if report_path:
        _generate_html_report(results, report_path)

    return results
```

### 2.4 Handling expected differences

Some differences between SAS and Python are expected and acceptable:

| Difference type                  | Cause                            | Acceptable? | Resolution                                   |
| -------------------------------- | -------------------------------- | ----------- | -------------------------------------------- |
| Floating-point precision (1e-10) | Different LAPACK implementations | Yes         | Within machine epsilon                       |
| Date formatting                  | SAS date values vs ISO dates     | Yes         | Standardize on ISO 8601                      |
| Missing value representation     | SAS `.` vs Python `NaN` / `None` | Yes         | Both represent missing; compare counts       |
| Sort order of ties               | Unstable sort algorithms         | Yes         | Add secondary sort keys if order matters     |
| Random number sequences          | Different PRNG implementations   | Yes         | Compare distributions, not individual values |
| Rounding at display level        | SAS FORMAT vs Python round()     | Yes         | Compare raw values, not displayed values     |
| Case sensitivity                 | SAS is case-insensitive          | Maybe       | Standardize case before comparison           |

---

## 3. Phased program migration strategy

### 3.1 Program classification

Before migrating, classify every SAS program:

| Category        | Description                                               | Migration priority        | Effort                   |
| --------------- | --------------------------------------------------------- | ------------------------- | ------------------------ |
| **Retire**      | Program no longer used or needed                          | Immediate                 | Zero (just decommission) |
| **Trivial**     | Simple DATA Step + PROC MEANS/FREQ; no macros             | High (quick wins)         | XS--S                    |
| **Standard**    | Moderate complexity; some macros; standard PROCs          | Medium                    | S--M                     |
| **Complex**     | Heavy macro usage; many PROCs; inter-program dependencies | Lower priority            | M--L                     |
| **Specialized** | Survey procedures, clinical trial, optimization           | Last or retain on SAS     | L--XL                    |
| **Regulatory**  | Output format required by regulation (FDA, Census)        | Retain on SAS (initially) | N/A (keep)               |

### 3.2 Migration wave planning

```
Wave 1 (Weeks 1-6):    Retire programs + Trivial conversions
                        Target: 30-40% of program inventory
                        Risk: Very Low
                        Validation: Level 1 (summary comparison)

Wave 2 (Weeks 6-14):   Standard conversions (reporting + descriptive)
                        Target: 30-40% of program inventory
                        Risk: Low-Medium
                        Validation: Level 2 (row-level sample)

Wave 3 (Weeks 14-24):  Complex conversions (models + ETL)
                        Target: 15-20% of program inventory
                        Risk: Medium
                        Validation: Level 3 (full row-level)

Wave 4 (Weeks 24-36):  Specialized conversions
                        Target: 5-10% of program inventory
                        Risk: High
                        Validation: Level 4 (statistical equivalence)

Retain:                 Regulatory programs stay on SAS Viya (Azure)
                        Target: 5-10% of program inventory
                        Review annually for migration readiness
```

### 3.3 Program dependency analysis

Before migrating, map program dependencies:

```python
# Example: analyze SAS program dependencies
# Look for: %include, libname references, proc append targets,
# data set references across programs

def analyze_sas_dependencies(sas_program_dir):
    """Analyze SAS program dependencies to determine migration order.

    Programs with no dependencies should be migrated first.
    Programs depended upon by others should be migrated before dependents.
    """
    import re
    from pathlib import Path

    programs = {}
    for sas_file in Path(sas_program_dir).glob('*.sas'):
        content = sas_file.read_text(encoding='latin1')
        deps = set()

        # Find %include references
        for match in re.finditer(r"%include\s+['\"]?(.+?)['\"]?\s*;", content, re.I):
            deps.add(match.group(1))

        # Find dataset references (simplified)
        for match in re.finditer(r"set\s+(\w+\.\w+)", content, re.I):
            deps.add(match.group(1))

        programs[sas_file.stem] = {
            'file': str(sas_file),
            'dependencies': deps,
            'lines': len(content.splitlines())
        }

    return programs
```

---

## 4. Output reconciliation framework

### 4.1 Automated reconciliation pipeline

Set up automated reconciliation as part of the migration CI/CD:

```yaml
# .github/workflows/validate-migration.yml
name: SAS Migration Validation
on:
    pull_request:
        paths:
            - "models/migrated/**"

jobs:
    validate:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4

            - name: Run Python migration
              run: |
                  cd models/migrated
                  python run_migration.py --program ${{ matrix.program }}

            - name: Compare outputs
              run: |
                  python scripts/reconcile.py \
                    --sas-output data/sas_baseline/${{ matrix.program }}.csv \
                    --python-output data/python_output/${{ matrix.program }}.csv \
                    --tolerance 0.001 \
                    --report reports/${{ matrix.program }}_validation.html

            - name: Upload validation report
              uses: actions/upload-artifact@v4
              with:
                  name: validation-${{ matrix.program }}
                  path: reports/
```

### 4.2 Reconciliation metrics dashboard

Track migration progress and validation results in Power BI:

| Metric                     | Description                                       | Target                            |
| -------------------------- | ------------------------------------------------- | --------------------------------- |
| Programs migrated          | Count of programs converted to Python             | Per wave targets                  |
| Programs validated         | Count that passed dual-run validation             | 100% before decommission          |
| Validation failures        | Programs with output differences beyond tolerance | 0 at cutover                      |
| Lines of SAS code migrated | Total SAS code lines converted                    | Track velocity                    |
| SAS licenses reduced       | License count or cost reduction achieved          | Per SAS contract terms            |
| Analyst productivity       | Tasks completed per analyst per week              | >= 80% of SAS baseline by Week 12 |

---

## 5. CSA-in-a-Box as the unified analytics landing zone

### 5.1 Why CSA-in-a-Box for SAS migration

CSA-in-a-Box provides the complete Azure landing zone that a SAS migration requires:

| Migration need                | CSA-in-a-Box component                           | Why it matters                            |
| ----------------------------- | ------------------------------------------------ | ----------------------------------------- |
| Where do Delta tables live?   | ADLS Gen2 + OneLake + medallion architecture     | Pre-configured bronze/silver/gold layers  |
| How are datasets governed?    | Purview + Unity Catalog + data-product contracts | Replaces SAS metadata server governance   |
| How do Python notebooks run?  | Fabric capacity + Databricks workspace           | Managed compute with auto-scaling         |
| How are models managed?       | Azure ML workspace + MLflow                      | Replaces SAS Model Manager                |
| How are reports delivered?    | Power BI Premium + Direct Lake                   | Replaces SAS Visual Analytics             |
| How is ETL orchestrated?      | ADF pipelines + dbt project scaffolding          | Replaces SAS Data Integration Studio      |
| How is compliance maintained? | NIST 800-53, FedRAMP, CMMC, HIPAA YAMLs          | Controls mapped and auditable in IaC      |
| How is the platform deployed? | Bicep modules + `make deploy-dev`                | Repeatable, version-controlled deployment |

### 5.2 Deployment for SAS migration

```bash
# Step 1: Deploy the Data Management Landing Zone
make deploy-dmlz ENV=prod

# Step 2: Deploy a Data Landing Zone for the migrated analytics
make deploy-dlz ENV=prod DOMAIN=analytics

# Step 3: Provision Azure ML workspace
make deploy-ml ENV=prod

# Step 4: Configure Fabric capacity and workspace
# (Follow docs/QUICKSTART.md)

# Step 5: Deploy SAS Viya on AKS (if hybrid)
# (Follow tutorial-sas-viya-azure.md)
```

### 5.3 Folder structure for migrated programs

```
csa-inabox/
├── domains/
│   └── analytics/                    # Migrated SAS domain
│       ├── notebooks/
│       │   ├── survey_analysis.py    # Migrated SAS program
│       │   ├── claims_processing.py
│       │   └── model_scoring.py
│       ├── dbt/
│       │   ├── models/
│       │   │   ├── staging/          # SAS DATA Step cleaning
│       │   │   ├── intermediate/     # SAS multi-step logic
│       │   │   └── gold/             # SAS PROC SUMMARY outputs
│       │   ├── seeds/                # SAS PROC FORMAT lookups
│       │   └── macros/               # SAS macro equivalents
│       ├── pipelines/
│       │   └── adf/                  # SAS scheduling equivalents
│       └── data-products/
│           └── agency_summary/
│               └── contract.yaml     # Data product contract
```

---

## 6. Change management

### 6.1 Communication plan

| Audience                     | Message                                                             | Frequency | Channel                        |
| ---------------------------- | ------------------------------------------------------------------- | --------- | ------------------------------ |
| Executive leadership         | Migration progress, cost savings, risk status                       | Monthly   | Executive dashboard + briefing |
| Analytics team               | Training schedule, program migration timeline, support resources    | Weekly    | Team meetings + email          |
| SAS programmers              | Reskilling benefits, career growth, support commitment              | Biweekly  | 1:1 meetings + team sessions   |
| End users (report consumers) | Transition timeline, training on Power BI, no disruption commitment | Monthly   | Email + lunch-and-learn        |
| ISSO / Security              | ATO status, compliance evidence, risk register                      | Monthly   | Security review meetings       |

### 6.2 Resistance management

| Resistance pattern                | Root cause                  | Response                                                                |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| "SAS is better for statistics"    | Comfort with familiar tool  | Show side-by-side equivalence; acknowledge SAS strengths in niche areas |
| "Python is not validated"         | Regulatory concern          | Reference FDA R Consortium submission; demonstrate IQ/OQ/PQ for Python  |
| "I'll be replaced"                | Job security fear           | Frame as upskilling; show SAS+Python analysts are more valuable         |
| "Migration will break production" | Risk aversion               | Demonstrate dual-running validation; point to rollback plan             |
| "SAS has better support"          | Vendor relationship comfort | Show Azure/Microsoft support model; community support advantages        |

---

## 7. Post-migration operations

### 7.1 Python code standards for former SAS teams

Establish coding standards that feel familiar to SAS programmers:

```python
# Standard header for migrated programs
"""
Program: survey_analysis.py
Purpose: Quarterly employee survey engagement analysis
Migrated from: /sas/programs/survey/quarterly_analysis.sas
Original author: J. Smith (SAS)
Migration author: J. Smith (Python)
Migration date: 2026-05-15
Validation: Level 3 (full row-level), passed 2026-05-28
Schedule: Monthly, 1st business day (ADF trigger)

Change log:
  2026-05-15  Initial migration from SAS
  2026-06-01  Added Copilot integration for NLQ
"""
```

### 7.2 Monitoring migrated programs

```python
# Standard monitoring pattern for migrated programs
import logging
import time
from datetime import datetime

logger = logging.getLogger(__name__)

def run_with_monitoring(program_name, func, *args, **kwargs):
    """Wrapper for migrated SAS programs with standard monitoring."""
    start_time = time.time()
    logger.info(f"Starting {program_name} at {datetime.now().isoformat()}")

    try:
        result = func(*args, **kwargs)
        elapsed = time.time() - start_time
        logger.info(f"Completed {program_name} in {elapsed:.1f}s")

        # Log to Azure Monitor
        # (replaces SAS log monitoring)
        return result

    except Exception as e:
        elapsed = time.time() - start_time
        logger.error(f"Failed {program_name} after {elapsed:.1f}s: {str(e)}")
        raise
```

---

## 8. Key success factors

1. **Executive sponsorship.** The CIO or CDO must own the migration decision and communicate it consistently
2. **Reskilling investment.** Budget 4--8 weeks of training per SAS programmer; this is the highest-ROI investment in the migration
3. **Dual-running discipline.** Every migrated program must pass validation before the SAS version is decommissioned
4. **Incremental value delivery.** Each migration wave should deliver measurable value (cost savings, new capability, performance improvement)
5. **SAS retention for the right reasons.** Keep SAS where there is a genuine technical or regulatory gap; do not keep SAS due to resistance or inertia
6. **CSA-in-a-Box as the landing zone.** Deploy the complete platform first; migrate into a well-governed environment, not ad-hoc Azure resources
7. **Celebrate wins.** Publicly recognize analysts who successfully convert complex SAS programs to Python
8. **Measure and report.** Track migration metrics weekly; share progress with leadership monthly

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
