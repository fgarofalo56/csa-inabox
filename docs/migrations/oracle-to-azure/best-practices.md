# Oracle to Azure Migration -- Best Practices

**Assessment methodology, complexity tiers, workload decomposition, application testing strategy, parallel-run validation, and CSA-in-a-Box integration for analytics on migrated Oracle data.**

---

## 1. Assessment methodology

### 1.1 Discovery phase

Before any migration work begins, conduct a thorough Oracle estate discovery:

```bash
# Run SSMA Assessment Report (for Azure SQL MI targets)
# Produces: Conversion statistics, object inventory, complexity scoring

# Run ora2pg assessment (for PostgreSQL targets)
ora2pg -c ora2pg.conf -t SHOW_REPORT --estimate_cost

# Both tools provide:
# - Object count by type (tables, views, procedures, functions, packages)
# - PL/SQL line count and complexity
# - Oracle-specific feature usage
# - Estimated conversion effort
```

### 1.2 Assessment dimensions

| Dimension                    | What to capture                                                     | How to capture                                             |
| ---------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Schema complexity**        | Tables, views, sequences, indexes, constraints                      | SSMA assessment, ora2pg report                             |
| **PL/SQL complexity**        | Procedures, functions, packages (line count, cyclomatic complexity) | SSMA detailed report, manual code review                   |
| **Oracle feature usage**     | RAC, Data Guard, Partitioning, VPD, AQ, Spatial, Oracle Text        | DBA interview + `V$OPTION`, `DBA_FEATURE_USAGE_STATISTICS` |
| **Data volume**              | Database size, table sizes, growth rate                             | `DBA_SEGMENTS`, `DBA_TABLESPACES`                          |
| **Application dependencies** | Applications connecting to each database, connection methods        | Application inventory, TNS listener logs                   |
| **Performance baseline**     | Top SQL, execution frequency, response times                        | AWR reports, ASH data                                      |
| **Security model**           | Users, roles, VPD policies, TDE, audit policies                     | `DBA_USERS`, `DBA_ROLE_PRIVS`, `DBA_POLICIES`              |
| **Integration points**       | Database links, external tables, AQ subscribers, GoldenGate streams | `DBA_DB_LINKS`, `DBA_EXTERNAL_TABLES`                      |

### 1.3 Oracle feature usage query

```sql
-- Run on each Oracle database to discover feature usage
SELECT name, currently_used, detected_usages, first_usage_date, last_usage_date
FROM dba_feature_usage_statistics
WHERE currently_used = 'TRUE'
  AND dbid = (SELECT dbid FROM v$database)
ORDER BY name;

-- Key features to watch for:
-- "Real Application Clusters (RAC)" -> Requires HA architecture decision
-- "Partitioning" -> Map to target partitioning
-- "Virtual Private Database (VPD)" -> Map to RLS
-- "Oracle Advanced Security" -> Map to TDE/Key Vault
-- "Oracle Spatial" -> Map to PostGIS or SQL Server Spatial
-- "Advanced Queuing" -> Map to Service Bus
-- "Oracle Text" -> Map to Full-Text Search
-- "In-Memory Column Store" -> Map to Columnstore indexes
-- "Oracle Data Guard" -> Map to geo-replication/failover groups
```

---

## 2. Complexity tiers

### 2.1 Tier classification

Classify each Oracle database into a complexity tier to guide migration approach and timeline:

| Tier                   | Criteria                                                                              | Migration approach                                             | Timeline     | Risk      |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------ | --------- |
| **Tier 1: Simple**     | < 50 tables, < 10 stored procs, no Oracle-specific features, < 10 GB                  | Automated (SSMA/ora2pg), minimal manual work                   | 4-6 weeks    | Low       |
| **Tier 2: Standard**   | 50-200 tables, 10-100 stored procs, some DECODE/NVL patterns, 10-100 GB               | Automated + manual fixes, focused testing                      | 8-12 weeks   | Medium    |
| **Tier 3: Complex**    | 200+ tables, 100+ stored procs, packages, partitioning, triggers, 100 GB-1 TB         | Automated assessment + significant manual PL/SQL conversion    | 16-24 weeks  | High      |
| **Tier 4: Enterprise** | 500+ tables, complex PL/SQL packages (10K+ lines each), RAC, VPD, AQ, Spatial, > 1 TB | Phased migration, dedicated conversion team, extensive testing | 24-40+ weeks | Very High |

### 2.2 Scoring model

Assign points for each complexity factor:

| Factor                  | Points        | Description                         |
| ----------------------- | ------------- | ----------------------------------- |
| PL/SQL lines: 0-1K      | 1             | Trivial                             |
| PL/SQL lines: 1K-10K    | 3             | Moderate                            |
| PL/SQL lines: 10K-50K   | 7             | Complex                             |
| PL/SQL lines: 50K+      | 15            | Enterprise                          |
| Oracle packages         | 3 per package | Each package requires decomposition |
| CONNECT BY queries      | 2 each        | Recursive CTE conversion            |
| Autonomous transactions | 5 each        | Significant redesign                |
| VPD policies            | 3 each        | RLS policy creation                 |
| Oracle Spatial usage    | 10            | PostGIS or SQL Spatial migration    |
| Advanced Queuing        | 10            | Service Bus architecture            |
| RAC dependency          | 15            | HA architecture redesign            |
| Database links          | 3 each        | Cross-database query refactoring    |

**Total score interpretation:**

| Score | Tier                | Recommended approach                                         |
| ----- | ------------------- | ------------------------------------------------------------ |
| 1-10  | Tier 1 (Simple)     | Automated migration, minimal manual work                     |
| 11-30 | Tier 2 (Standard)   | Automated + focused manual conversion                        |
| 31-60 | Tier 3 (Complex)    | Phased migration, dedicated team                             |
| 61+   | Tier 4 (Enterprise) | Consider Oracle DB@Azure for short-term, phased displacement |

---

## 3. Workload decomposition

### 3.1 Decompose by migration target

Not all databases in an Oracle estate should go to the same target:

```
Oracle Estate (100 databases)
    │
    ├── Tier 1 + Tier 2 (70 databases) ──► Azure SQL MI or PostgreSQL
    │     Standard OLTP, moderate PL/SQL
    │     Timeline: 12-24 weeks (wave-based)
    │
    ├── Tier 3 (20 databases) ──► Azure SQL MI (with dedicated PL/SQL conversion)
    │     Complex PL/SQL, partitioning, triggers
    │     Timeline: 24-36 weeks
    │
    ├── Tier 4 (5 databases) ──► Oracle DB@Azure
    │     EBS, deep PL/SQL, RAC, cannot refactor
    │     Timeline: 8-12 weeks (lift and shift)
    │
    └── Retire (5 databases) ──► Archive and decommission
          Legacy, no active consumers
          Timeline: 4-8 weeks
```

### 3.2 Wave planning

Group databases into migration waves of 3-5 databases each:

| Wave               | Databases              | Criteria                                  | Duration    |
| ------------------ | ---------------------- | ----------------------------------------- | ----------- |
| **Wave 1 (Pilot)** | 2-3 Tier 1 databases   | Lowest risk, highest visibility           | 6-8 weeks   |
| **Wave 2**         | 5 Tier 1-2 databases   | Standard OLTP, growing confidence         | 8-10 weeks  |
| **Wave 3**         | 5-8 Tier 2 databases   | Standard complexity, established patterns | 8-10 weeks  |
| **Wave 4**         | 5-8 Tier 2-3 databases | Increasing complexity                     | 12-16 weeks |
| **Wave 5**         | Remaining Tier 2-3     | All remaining displacement targets        | 12-20 weeks |
| **Wave 6**         | Tier 4 databases       | Oracle DB@Azure (if applicable)           | 8-12 weeks  |

### 3.3 Pilot database selection criteria

Select the pilot database(s) to maximize learning while minimizing risk:

- [ ] Tier 1 or low Tier 2 complexity
- [ ] Non-mission-critical (dev/test acceptable for pilot)
- [ ] Representative of common patterns in the estate
- [ ] Willing application team / stakeholder
- [ ] < 10 GB data volume
- [ ] < 20 stored procedures
- [ ] No Oracle-specific features (RAC, VPD, AQ)
- [ ] Well-documented application with existing test suite

---

## 4. Application testing strategy

### 4.1 Testing layers

```
                    ┌────────────────────┐
                    │   User Acceptance  │  ← Business users validate workflows
                    │   Testing (UAT)    │
                    ├────────────────────┤
                    │   Performance      │  ← Load testing at production scale
                    │   Testing          │
                    ├────────────────────┤
                    │   Integration      │  ← Cross-system data flow validation
                    │   Testing          │
                    ├────────────────────┤
                    │   Functional       │  ← Feature-by-feature validation
                    │   Testing          │
                    ├────────────────────┤
                    │   Unit Testing     │  ← Stored procedure / function testing
                    │   (Database)       │
                    └────────────────────┘
```

### 4.2 Database unit testing

Test every converted stored procedure and function:

```sql
-- Azure SQL MI: tSQLt framework for database unit testing
-- Install tSQLt: https://tsqlt.org

EXEC tSQLt.NewTestClass 'TestEmployeeFunctions';
GO

CREATE PROCEDURE TestEmployeeFunctions.[test get_salary returns correct value]
AS
BEGIN
    -- Arrange
    EXEC tSQLt.FakeTable 'dbo.employees';
    INSERT INTO dbo.employees (employee_id, salary) VALUES (1001, 85000.00);

    -- Act
    DECLARE @result decimal(10,2);
    SET @result = dbo.get_salary(1001);

    -- Assert
    EXEC tSQLt.AssertEquals 85000.00, @result;
END;
GO

-- Run all tests
EXEC tSQLt.RunAll;
```

```sql
-- PostgreSQL: pgTAP framework for database unit testing
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- Test function returns correct value
SELECT is(
    app_schema.get_employee_salary(1001),
    85000.00::numeric,
    'get_salary returns correct value for employee 1001'
);

-- Test function returns NULL for non-existent employee
SELECT is(
    app_schema.get_employee_salary(99999),
    NULL::numeric,
    'get_salary returns NULL for non-existent employee'
);

-- Test procedure raises exception for invalid input
SELECT throws_ok(
    'CALL app_schema.update_salary(99999, 50000)',
    'P0001',
    'Employee not found'
);

SELECT * FROM finish();
```

### 4.3 Data validation queries

Run on both source (Oracle) and target (Azure) to compare:

```sql
-- 1. Row count per table
-- 2. Checksum per table (see data-migration.md)
-- 3. NULL count per column (detect conversion errors)
-- 4. Min/Max/Avg for numeric columns
-- 5. Distinct count for categorical columns
-- 6. Date range validation
-- 7. Foreign key integrity check
-- 8. Business aggregate validation (monthly totals, etc.)
```

### 4.4 Performance testing

```bash
# Use Apache JMeter, k6, or Locust for load testing

# k6 example: Test migrated API endpoint
# k6 run --vus 100 --duration 30m load-test.js

# Compare metrics:
# - Response time (p50, p95, p99)
# - Throughput (requests/second)
# - Error rate
# - Database CPU / memory / IOPS during test
```

---

## 5. Parallel-run validation

### 5.1 Parallel-run architecture

```
                    ┌──────────────┐
                    │  Application │
                    │  (writes to  │
                    │   Oracle)    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Oracle     │ ← Primary (still active)
                    │   Source     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Replication │  CDC / GoldenGate / ADF
                    │  Layer       │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Azure SQL   │ ← Secondary (shadow mode)
                    │  MI / PG     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Validation  │  Row counts, checksums,
                    │  Framework   │  query result comparison
                    └──────────────┘
```

### 5.2 Validation framework

Run automated comparisons during the parallel-run period:

```python
# Parallel-run validation script (Python)
import pyodbc
import cx_Oracle
import hashlib

def compare_table(table_name, oracle_conn, azure_conn):
    """Compare row counts and sample checksums between Oracle and Azure."""

    # Row count
    ora_count = oracle_conn.execute(
        f"SELECT COUNT(*) FROM {table_name}"
    ).fetchone()[0]

    az_count = azure_conn.execute(
        f"SELECT COUNT(*) FROM {table_name}"
    ).fetchone()[0]

    count_match = ora_count == az_count

    # Sample checksum (first 1000 rows by PK)
    # ... implementation depends on table structure

    return {
        "table": table_name,
        "oracle_count": ora_count,
        "azure_count": az_count,
        "count_match": count_match,
        "variance_pct": abs(ora_count - az_count) / max(ora_count, 1) * 100
    }
```

### 5.3 Cutover criteria

Proceed to cutover when all criteria are met:

- [ ] Row counts match within 0.01% variance (accounts for in-flight transactions)
- [ ] Business aggregates match exactly (monthly totals, balances)
- [ ] All automated tests pass on target
- [ ] Performance is within 20% of Oracle baseline (acceptable for cost savings)
- [ ] No P1 or P2 defects open for 5+ consecutive business days
- [ ] Application team sign-off
- [ ] DBA team sign-off
- [ ] Security team sign-off (FedRAMP controls validated)
- [ ] Rollback plan tested and documented

---

## 6. CSA-in-a-Box integration for analytics

### 6.1 Post-migration analytics pattern

After migrating Oracle to Azure, integrate with CSA-in-a-Box for analytics:

```
Migrated Database (Azure SQL MI / PostgreSQL / Oracle DB@Azure)
    │
    ├── Fabric Mirroring (for SQL MI and Oracle DB@Azure)
    │   └── OneLake (Delta Lake tables)
    │
    ├── ADF Pipelines (for PostgreSQL and other sources)
    │   └── OneLake (Delta Lake tables)
    │
    └── CSA-in-a-Box Medallion Architecture
        ├── Bronze: Raw mirrored data (schema-on-read)
        ├── Silver: Cleaned, validated, typed (dbt models)
        ├── Gold: Business-ready aggregates (dbt models + contracts)
        │
        ├── Purview: Classifications, lineage, catalog
        ├── Power BI: Direct Lake semantic model + reports
        └── AI Foundry: Azure OpenAI for NL analytics
```

### 6.2 dbt model for migrated Oracle data

```yaml
# domains/shared/dbt/models/sources.yml
sources:
    - name: oracle_migrated
      description: "Data migrated from Oracle Database to Azure"
      meta:
          migration_date: "2026-04-30"
          source_system: "Oracle 19c FEDDB"
          target_database: "Azure SQL MI"
      tables:
          - name: employees
            description: "Employee records (migrated from Oracle HR)"
            columns:
                - name: employee_id
                  description: "Primary key (was Oracle NUMBER(10))"
                  tests: [not_null, unique]
                - name: salary
                  description: "Employee salary (was Oracle NUMBER(10,2))"
                  tests: [not_null]
```

```sql
-- domains/shared/dbt/models/silver/stg_employees.sql
WITH source AS (
    SELECT * FROM {{ source('oracle_migrated', 'employees') }}
),

cleaned AS (
    SELECT
        employee_id,
        UPPER(TRIM(first_name)) AS first_name,
        UPPER(TRIM(last_name)) AS last_name,
        department_id,
        CAST(salary AS decimal(10,2)) AS salary,
        hire_date,
        CASE status
            WHEN 'A' THEN 'Active'
            WHEN 'I' THEN 'Inactive'
            WHEN 'T' THEN 'Terminated'
            ELSE 'Unknown'
        END AS status_description,
        CURRENT_TIMESTAMP AS _loaded_at
    FROM source
    WHERE employee_id IS NOT NULL
)

SELECT * FROM cleaned
```

### 6.3 Post-migration Purview setup

```python
# Register migrated database in Purview
# Using Purview automation from CSA-in-a-Box:
# csa_platform/csa_platform/governance/purview/purview_automation.py

# 1. Register Azure SQL MI data source in Purview
# 2. Run scan to discover all tables and columns
# 3. Apply classifications:
#    - PII columns (SSN, email, phone) -> pii_classifications.yaml
#    - CUI columns (case data, security) -> government_classifications.yaml
#    - PHI columns (health data) -> phi_classifications.yaml
# 4. Verify lineage: Oracle -> ADF/Mirroring -> OneLake -> dbt -> Power BI
```

---

## 7. Common pitfalls and how to avoid them

| Pitfall                                     | Impact                                | Prevention                                               |
| ------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| **Underestimating PL/SQL complexity**       | Timeline overrun, budget overrun      | Run SSMA/ora2pg assessment before committing to timeline |
| **Ignoring Oracle DATE vs SQL Server DATE** | Data truncation (time component lost) | Map Oracle DATE to datetime2(0), not date                |
| **Not testing at production scale**         | Performance surprises in production   | Load test with production-volume data before cutover     |
| **Migrating analytics to OLTP database**    | Performance degradation on target     | Use Fabric Mirroring + CSA-in-a-Box for analytics        |
| **Forgetting to disable Oracle monitoring** | Alerts from decommissioned Oracle     | Decommission Oracle monitoring agents after cutover      |
| **Not planning for rollback**               | Stuck with broken migration           | Maintain Oracle read-only during parallel run            |
| **Converting everything at once**           | Risk concentration                    | Wave-based approach (3-5 databases per wave)             |
| **Ignoring connection pooling**             | Connection exhaustion on Azure        | Implement PgBouncer or application-level pooling         |
| **Skipping index review**                   | Poor query performance on target      | Review and recreate indexes for target optimizer         |
| **Not updating statistics**                 | Query plan regression                 | Run statistics update after data migration               |

---

## 8. Post-migration optimization checklist

- [ ] **Statistics updated** on all migrated tables
- [ ] **Indexes reviewed** and optimized for target database optimizer
- [ ] **Query Store / pg_stat_statements** enabled and baseline captured
- [ ] **Connection pooling** configured (PgBouncer for PostgreSQL)
- [ ] **Monitoring** configured in Azure Monitor with alerts
- [ ] **Backup retention** verified (35-day PITR)
- [ ] **HA verified** (failover test for SQL MI, zone-redundant for PostgreSQL)
- [ ] **Security validated** (RLS policies, TDE, audit logging)
- [ ] **Fabric Mirroring** or ADF pipelines configured for CSA-in-a-Box
- [ ] **Purview** scan completed with classifications applied
- [ ] **Power BI** semantic model created over OneLake data
- [ ] **Cost optimization** applied (reserved instances, auto-pause dev/test)
- [ ] **Oracle licenses** terminated at next renewal date
- [ ] **Documentation** updated (runbooks, connection strings, architecture diagrams)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
