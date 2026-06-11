# data-quality-run-results — parity with Databricks Lakehouse Monitoring + Delta constraints + Purview DQ

Source UI:
- Microsoft Purview — Review data quality scores: https://learn.microsoft.com/purview/data-quality-overview
- Databricks Lakehouse Monitoring (data profiling): https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-quality-monitoring/
- Delta constraints: https://learn.microsoft.com/azure/databricks/tables/constraints

Surface: `app/governance/data-quality/page.tsx` (tabs Rules / Run / Results / Monitors).
This **extends** the pre-existing Loom-native DQ rule store with the missing
run + results + always-on enforcement surface. Azure-native; works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (no Fabric / Power BI dependency).

## Azure/Fabric feature inventory → Loom coverage

| Capability (Azure/Databricks/Purview) | Loom coverage | Backend per control |
|---|---|---|
| Author DQ rules (not-null/unique/range/regex/freshness) | ✅ Rules tab (shared store) | Cosmos `dq-rules:<tenantId>` (`/api/dq/rules`) |
| Run rules / compute a quality score | ✅ Run tab — composite score + per-rule pass% | `/api/dq/run` → `runDqRules` (real KQL / Spark SQL / T-SQL) |
| Choose execution engine | ✅ Kusto · Databricks SQL · Synapse SQL (serverless/dedicated) | `kusto-client` · `databricks-client.executeStatement` · `synapse-sql-client.executeQuery` |
| Run history / score over time | ✅ Results tab | Cosmos `dq-runs:<tenantId>` (`/api/dq/results`) |
| Enforced constraints (write-time) | ✅ Monitors tab → Delta CHECK / NOT NULL | `dq-monitor-client.applyDeltaConstraint` (ALTER TABLE) |
| List / drop enforced constraints | ✅ Monitors tab | `SHOW TBLPROPERTIES` / `ALTER TABLE … DROP CONSTRAINT` |
| Lakehouse Monitoring (profile/drift) | ✅ Monitors tab — create snapshot monitor + refresh | `dq-monitor-client` GA REST `/api/2.1/unity-catalog/tables/{t}/monitor` |
| Monitor refresh history | ✅ Monitors tab | `listRefreshes` |
| Honest infra gate (engine not wired) | ✅ MessageBar names the exact env var | `dqRunConfigGate` / `dqMonitorConfigGate` |
| Lakeflow `@dlt.expect` pipeline expectations | ⚠️ out of scope v1 (documented forward option) | — |

Zero ❌ — every inventory row is built ✅ or an honest-gate ⚠️.

## Per-cloud matrix

| Backend | Commercial | GCC-High | IL5 / DoD |
|---|---|---|---|
| Delta CHECK / NOT NULL constraints | ✅ | ✅ | ✅ |
| SQL rule run (Databricks / Synapse) | ✅ | ✅ | ✅ |
| ADX/Kusto rule run | ✅ | ✅ (gov endpoint) | ✅ (gov endpoint) |
| Lakehouse Monitoring (serverless) | ✅ | ⚠️ region-gated — fall back to Delta constraints + SQL run | ⚠️ region-gated — fall back to Delta constraints + SQL run |

When a backend is unavailable, the config-gate MessageBar names the exact missing
env var rather than hiding the control.

## Notes
- DQ score formula = mean of per-rule pass% (grounded in Purview "Review data
  quality scores"). Regex on Synapse T-SQL is honestly reported as unsupported
  (run on Databricks or Kusto) — T-SQL has no native regex.
- Bicep: reuses `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` / `LOOM_SYNAPSE_WORKSPACE` /
  `LOOM_KUSTO_CLUSTER_URI` (admin-plane/main.bicep) + existing storage RBAC. No
  new env var or resource.
