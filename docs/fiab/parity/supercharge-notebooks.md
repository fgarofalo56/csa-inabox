# supercharge-notebooks — parity with the Supercharge Microsoft Fabric notebooks

**Source UI / corpus:** [github.com/fgarofalo56/Suppercharge_Microsoft_Fabric](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric)
(`notebooks/{bronze,silver,gold,ml,real-time,streaming,hitchhikers-guide,utils}`)

This doc records the 1:1 conversion of all 117 upstream Fabric notebooks into
Loom-native content bundles that run on Azure-native backends (Synapse Spark /
Databricks + ADLS Gen2 + ADX) with **zero hard Microsoft Fabric dependency**
(`.claude/rules/no-fabric-dependency.md`).

## Where it lives

| Artifact | Path |
| --- | --- |
| Converted notebooks (human-editable source / deliverable) | `examples/supercharge-fabric/notebooks/**` |
| Generated bundles (runtime data) | `apps/fiab-console/lib/apps/content-bundles/app-supercharge-*.ts` |
| Generator (deterministic, re-runnable) | `scripts/csa-loom/import-supercharge-notebooks.mjs` |
| Registry + catalog wiring | `content-bundles/index.ts`, `content-bundles/catalog-meta.ts` |
| Contract tests | `content-bundles/__tests__/supercharge-bundles.test.ts` |

Re-import after an upstream change:

```bash
# reset examples/supercharge-fabric/notebooks to pristine upstream, then:
node scripts/csa-loom/import-supercharge-notebooks.mjs
```

## Bundles (7 — one per medallion layer / category)

| appId | Notebooks | Layer |
| --- | --: | --- |
| `app-supercharge-bronze` | 28 | Raw ingestion → ADLS Gen2 Bronze Delta |
| `app-supercharge-silver` | 28 | Cleanse / conform |
| `app-supercharge-gold` | 34 | Business aggregates / dimensions |
| `app-supercharge-ml` | 8 | ML / MLOps (Azure ML / Databricks + ADLS + ADX) |
| `app-supercharge-streaming` | 9 | Streaming + CDC + real-time (8 streaming + 1 real-time) |
| `app-supercharge-utils` | 3 | Shared pipeline utilities (`%run`) |
| `app-supercharge-guide` | 7 | Hitchhiker's Guide platform recipes |
| **Total** | **117** | |

The upstream `real-time/02_kql_casino_floor.kql` is **converted + vendored**
(Fabric Eventhouse → Azure Data Explorer) but is not a notebook item — ADX KQL
querysets surface via the `kql-database` / `kql-dashboard` editors, not the
notebook editor.

## Fabric → Loom-native conversion (feature inventory + coverage)

| Upstream Fabric idiom | Azure-native replacement | Status |
| --- | --- | --- |
| OneLake ABFSS host `…@onelake.dfs.fabric.microsoft.com/…` | ADLS Gen2 `…@{{ADLS_ACCOUNT}}.dfs.core.windows.net/…` (`adls-client`; `LOOM_ADLS_ACCOUNT`) | ✅ built |
| Fabric runtime utils `notebookutils.*` (guides, direct calls) | `mssparkutils.*` (Synapse Spark native) | ✅ built |
| Fabric runtime utils `notebookutils.*` (medallion notebooks) | already shipped portable `try notebookutils / except mssparkutils / except env` — unchanged, runs on Synapse | ✅ built |
| Fabric Variable Library `spark.conf.get("spark.fabric.variable.X")` | Synapse Spark conf `spark.conf.get("spark.loom.variable.X")` (+ pipeline params) | ✅ built |
| OneLake shortcut (S3 / GCS) via Fabric REST `/shortcuts` | Spark direct read (`s3a://` / `gs://`) → ADLS Gen2 Bronze Delta | ✅ built |
| OneLake data-access-roles (RLS/CLS) via Fabric REST `/dataAccessRoles` | Synapse Serverless SQL Row-/Column-Level Security + ADLS RBAC/ACL | ✅ built |
| Fabric admin REST `api.fabric.microsoft.com/v1/workspaces` | Azure Resource Manager `management.azure.com/.../Microsoft.Synapse/workspaces` | ✅ built |
| Power BI dataset refresh `api.powerbi.com/.../refreshes` | Azure Analysis Services REST (or Loom Direct-Lake-Shim refresh) | ✅ built |
| Fabric token scope `api.fabric.microsoft.com/.default` | `management.azure.com/.default` (ARM) + `storage.azure.com/.default` (ADLS) | ✅ built |
| Fabric Eventhouse / RTI Real-Time Dashboard (`.kql`) | Azure Data Explorer (ADX) / Loom Real-Time Dashboard | ✅ built |

A generator guard fails the build if any of `api.fabric.microsoft.com`,
`api.powerbi.com`, or `onelake.dfs.fabric` survives in an emitted bundle; the
contract test re-asserts the same invariant per cell.

## Backend per surface (how they install + run)

- **Install** → `notebookProvisioner` (`lib/install/provisioners/notebook.ts`):
  Azure-native default is **Synapse** (`LOOM_SYNAPSE_WORKSPACE` → nbformat
  artifact) or **Databricks** (`LOOM_DATABRICKS_HOSTNAME` → SOURCE notebook at
  `/Shared/loom-installs/…`). Fabric is opt-in only
  (`LOOM_NOTEBOOK_BACKEND=fabric`). Works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
  **unset**.
- **Execute** → `/api/items/notebook/[id]/execute-spark`
  (`resolveSparkBackend`): AML Serverless Spark (`LOOM_AML_SPARK`, Commercial/GCC)
  or **Synapse Spark via Livy** (`LOOM_SYNAPSE_SPARK_POOL`). GCC-High / IL5 force
  Synapse Livy (AML Spark not offered in Gov). The converted cells avoid
  AML-only APIs so the same bundle runs on a Synapse Spark pool in every cloud.

## Bicep / bootstrap sync

**No new infrastructure.** These bundles reuse already-deployed Synapse Spark
pools, Databricks, ADLS Gen2, and ADX, and the env vars already wired in
`platform/fiab/bicep/modules/admin-plane/main.bicep`
(`LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_SPARK_POOL`, `LOOM_AML_SPARK` —
blanked for GCC-High/IL5, `LOOM_DATABRICKS_HOSTNAME`, `LOOM_ADLS_ACCOUNT`).
No new Azure resource, env var, role assignment, Cosmos container, or tenant
config is introduced, so no bicep or bootstrap change is required.

## Verification

- `npx vitest run lib/apps/content-bundles/__tests__/supercharge-bundles.test.ts`
  — 6 tests green (registry + catalog wiring, 117-notebook count, every item is
  a runnable notebook, zero Fabric/OneLake/Power BI hosts, ADLS-not-OneLake
  routing, install-path resolution).
- `npx tsc --noEmit` — zero errors in the touched files.
- Generator guard — zero forbidden Fabric tokens in emitted bundles.
