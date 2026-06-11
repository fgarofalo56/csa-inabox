# dbt-job — parity with dbt Cloud IDE / Fabric dbt + Azure-native execution

Source UI:
- dbt Cloud IDE / dbt Fusion — visual project authoring, model graph (DAG), lineage
- Fabric "dbt" graph + [Set up dbt for Fabric Warehouse](https://learn.microsoft.com/fabric/data-warehouse/tutorial-setup-dbt)
- [dbt for Synapse setup](https://docs.getdbt.com/docs/core/connect-data-platform/azuresynapse-setup)
- [Databricks dbt task](https://learn.microsoft.com/azure/databricks/jobs/dbt)
- [dbt project structure](https://docs.getdbt.com/docs/build/projects)

The Loom `dbt-job` item is a **visual dbt model/project builder**: a medallion
DAG on a ReactFlow canvas (sources → bronze → silver → gold models) that
**generates a real dbt Core project** and **runs it Azure-natively** against
Databricks (default) or Synapse / opt-in Fabric. No Microsoft Fabric dependency.

## dbt feature inventory (grounded in dbt + MS Learn)

| # | Capability | Where in real dbt |
|---|------------|-------------------|
| 1 | Define sources (schema/table/freshness) | `models/sources.yml` |
| 2 | Author models with SQL + `ref()`/`source()` | `models/**.sql` |
| 3 | Materializations: view / table / incremental / ephemeral | `{{ config(materialized=…) }}` |
| 4 | Incremental unique_key | `config(unique_key=…)` |
| 5 | Generic tests: unique / not_null / accepted_values / relationships | `schema.yml` |
| 6 | Model DAG / lineage graph | dbt Cloud IDE / `dbt docs` |
| 7 | Medallion layering (bronze/silver/gold) | folder + `+materialized` per path |
| 8 | `dbt_project.yml` + `profiles.yml` generation | project root |
| 9 | Run `dbt deps` / `dbt build` (run + test) | dbt CLI |
| 10 | Run history / per-node results | dbt Cloud runs / `run_results.json` |
| 11 | Target adapter selection (Databricks/Synapse/Fabric) | `profiles.yml` `type:` |
| 12 | BYO existing dbt repo from Git | dbt Cloud repo connection |

## Loom coverage

| # | Capability | Status | Where in Loom |
|---|------------|--------|---------------|
| 1 | Source nodes (name/schema/table/freshness warn+error) | ✅ built | `dbt-model-graph.tsx` SourceInspector |
| 2 | Model nodes with Monaco SQL body + ref/source pickers | ✅ built | ModelInspector + MonacoTextarea |
| 3 | Materialization dropdown (4 strategies) | ✅ built | ModelInspector |
| 4 | Incremental unique_key field | ✅ built | ModelInspector |
| 5 | Tests (unique/not_null/accepted_values/relationships) | ✅ built | ModelInspector tests editor |
| 6 | Visual DAG with ref()/source() lineage edges | ✅ built | `CanvasInner` edges |
| 7 | Bronze/silver/gold layers (color-coded, per-layer folder) | ✅ built | layer dropdown + codegen folders |
| 8 | Generate real `dbt_project.yml`/`profiles.yml`/models/schema.yml | ✅ built | `dbt-codegen.ts` + `/generate` route + Files tab |
| 9 | Run `dbt deps` + `dbt build` (Databricks workspace job) | ✅ built | `dbt-runner.ts` + `/run` route |
| 10 | Run history (Databricks runs) + Synapse dbt log + per-node results | ✅ built | Runs tab + `/runs` route |
| 11 | Adapter target picker (Databricks default / Synapse / opt-in Fabric) | ✅ built | TargetInspector |
| 12 | BYO existing dbt Git repo | ✅ built | Advanced tab (legacy git_source path) |

Zero ❌. The only conditional state is an honest infra-gate (below).

## Backend per control

| Control | Backend |
|---------|---------|
| Builder graph save | `PUT /api/items/dbt-job/[id]` → Cosmos `state.project` |
| Generate files | `GET /api/items/dbt-job/[id]/generate` → `dbt-codegen.generateProject` (pure, real files) |
| Run (Databricks target) | `POST /run` → push project to Databricks workspace folder (`/api/2.0/workspace/import`) → Databricks Job `dbt_task` (`source: WORKSPACE`) → `jobs/run-now` |
| Run (Synapse / Fabric target) | `POST /run` → `loom-dbt-runner` Container App `/run` (dbt-core + dbt-synapse/dbt-fabric + ODBC 18, managed identity) |
| Runs list | `GET /runs` → Databricks `jobs/runs/list` |
| BYO repo run | `POST /run` → Databricks Job `dbt_task` (`source: GIT` + `git_source`) |

## Per-cloud reality (no-fabric-dependency)

| Target | Native dbt runtime? | Loom execution | Default? |
|--------|---------------------|----------------|----------|
| **Databricks** | Yes (Databricks Job dbt_task) | Push generated project to workspace → dbt_task `source=WORKSPACE`. No extra infra. | ✅ default |
| **Synapse dedicated SQL pool** | **No** native dbt task | `loom-dbt-runner` Container App (dbt-synapse + ODBC 18, MSI). Honest gate (`LOOM_DBT_RUNNER_URL`) when not deployed. | Azure-native |
| **Fabric Warehouse** | n/a | Same `loom-dbt-runner` app via dbt-fabric adapter | opt-in only |

The same generated project moves between clouds by swapping only the
`profiles.yml` adapter `type:` — the core portability lever. The Databricks
path is fully functional with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Honest infra-gate (no-vaporware)

When a Synapse/Fabric run is attempted and `LOOM_DBT_RUNNER_URL` is unset, the
`/run` route returns `503 { code: 'not_configured', hint: 'Deploy the
loom-dbt-runner Container App …' }` and the editor surfaces it. Synapse/Fabric
genuinely have no native dbt task — this is an honest Azure infra requirement,
not a Fabric dependency. The Databricks target works with no extra infra.

## Bicep sync

- `platform/fiab/bicep/modules/integration/dbt-runner.bicep` — Container App (dbt-core + dbt-synapse + dbt-fabric + ODBC 18), scale-to-zero, VNet-internal, Console UAMI.
- `admin-plane/main.bicep` — `param dbtRunnerEnabled` + `var dbtRunnerActive` + module + `LOOM_DBT_RUNNER_URL` env on the console.
- `apps/fiab-dbt-runner/` — the runner app (FastAPI + dbt) image source.

## Verification

- `lib/dbt/__tests__/dbt-codegen.test.ts` — 10 golden/behavioral tests (per-adapter profiles, materializations, tests, dangling refs, file set).
- `lib/dbt/__tests__/dbt-runner.test.ts` — 4 tests (workspace job spec, config gate, dir-creation order, file import).
- `lib/editors/__tests__/dbt-job.test.tsx` — editor chrome + ribbon actions.
- `tests/e2e/dbt-job.spec.ts` — editor route renders, primary action present.
