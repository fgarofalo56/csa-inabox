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
| Lakehouse Monitoring (profile/drift) | ✅ Monitors tab — create snapshot monitor + refresh | `dq-monitor-client` GA REST `/api/data-quality/v1/monitors` (table UUID) — see below |
| Monitor refresh history | ✅ Monitors tab | `listRefreshes` (`/api/data-quality/v1/monitors/table/{id}/refreshes`) |
| Honest infra gate (engine not wired) | ✅ MessageBar names the exact env var | `dqRunConfigGate` / `dqMonitorConfigGate` |
| Lakeflow `@dlt.expect` pipeline expectations | ⚠️ out of scope v1 (documented forward option) | — |

Zero ❌ — every inventory row is built ✅ or an honest-gate ⚠️.

## Data-profiling monitor API (GA, keyed by table UUID)

The data-profiling Monitors path uses the **GA `data-quality` API** by default,
grounded in Microsoft Learn "Create a data profile using the API" (databricks-sdk
≥ 0.68.0, `w.data_quality.create_monitor(...)`) and the REST reference
`https://docs.databricks.com/api/azure/workspace/dataquality`:

| Operation | REST | Notes |
|---|---|---|
| create | `POST /api/data-quality/v1/monitors` | body `{object_type:'table', object_id:<table_id>, data_profiling_config:{output_schema_id, assets_dir, snapshot \| time_series}}` |
| get | `GET /api/data-quality/v1/monitors/table/{table_id}` | — |
| delete | `DELETE /api/data-quality/v1/monitors/table/{table_id}` | — |
| refresh | `POST /api/data-quality/v1/monitors/table/{table_id}/refreshes` | — |
| list refreshes | `GET /api/data-quality/v1/monitors/table/{table_id}/refreshes` | — |

`createMonitor`/`getMonitor`/`refreshMonitor`/`deleteMonitor`/`listRefreshes`
keep their name-based signatures: the client resolves the table UUID (`table_id`)
and the output-schema UUID (`schema_id`) via the UC `GET /api/2.1/unity-catalog/tables|schemas/{name}`
API, and maps `granularities` like `"1 day"` onto the GA
`AGGREGATION_GRANULARITY_1_DAY` enum.

The earlier `quality_monitors` surface (`/api/2.1/unity-catalog/tables/{name}/monitor`)
is **deprecated** ("Use the `data-quality` commands instead") and is retained as
an operator-selectable fallback — set `LOOM_DBX_DQ_MONITOR_API=legacy` for any
sovereign region where the GA API is not yet enabled.

Required UC permissions for the caller (Console UAMI): `MANAGE` + `USE_CATALOG`
+ `USE_SCHEMA` + `SELECT` on the monitored table's catalog/schema/table.

## Per-cloud matrix

| Backend | Commercial | GCC-High | IL5 / DoD |
|---|---|---|---|
| Delta CHECK / NOT NULL constraints | ✅ | ✅ | ✅ |
| SQL rule run (Databricks / Synapse) | ✅ | ✅ | ✅ |
| ADX/Kusto rule run | ✅ | ✅ (gov endpoint) | ✅ (gov endpoint) |
| Data-profiling monitor — GA `data-quality` API | ✅ | ⚠️ verify GA availability; else `LOOM_DBX_DQ_MONITOR_API=legacy` + Delta constraints/SQL run | ⚠️ verify GA availability; else `LOOM_DBX_DQ_MONITOR_API=legacy` + Delta constraints/SQL run |

When a backend is unavailable, the config-gate MessageBar names the exact missing
env var rather than hiding the control.

## Notes
- DQ score formula = mean of per-rule pass% (grounded in Purview "Review data
  quality scores"). Regex on Synapse T-SQL is honestly reported as unsupported
  (run on Databricks or Kusto) — T-SQL has no native regex.
- Bicep: reuses `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` / `LOOM_SYNAPSE_WORKSPACE` /
  `LOOM_KUSTO_CLUSTER_URI` (admin-plane/main.bicep) + existing storage RBAC. Adds
  one OPTIONAL knob `LOOM_DBX_DQ_MONITOR_API` (default '' = GA `data-quality`) —
  no new resource or role.
