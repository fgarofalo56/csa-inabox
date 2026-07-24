# transformation-project — parity with **dbt Cloud IDE** + **SQLMesh (Tobiko)**

> **Scope note — this is a Loom-native item with TWO source UIs.** N4's goal is
> SQLMesh's virtual data environments + Terraform-style plan/apply +
> column-level model diff **WITHOUT dropping dbt** (dbt keeps the ecosystem).
> The item therefore carries a **backend selector** (`dbt` | `sqlmesh`) whose
> **default is `dbt`** for continuity. There is no Microsoft Fabric analog and
> no Fabric dependency: both engines run OSS on Azure Container Apps against
> Synapse / Databricks / DuckDB-over-ADLS.

**Catalog:** `slug: transformation-project`, `restType: TransformationProject`,
category **Data Factory**. Editor:
`apps/fiab-console/lib/editors/transformation-project-editor.tsx`.

**No-Fabric note:** every default path is Azure-native/OSS. `dbt-fabric` is
bundled in the runner image but is only reachable when a project explicitly
selects the Fabric engine. `LOOM_DEFAULT_FABRIC_WORKSPACE` is never read.

Source UIs:
- dbt Cloud IDE / dbt-core project structure: <https://docs.getdbt.com/docs/build/projects>
- dbt state comparison (`state:modified`, deferral): <https://docs.getdbt.com/reference/node-selection/state-comparison-caveats>
- SQLMesh **plans**: <https://sqlmesh.readthedocs.io/en/stable/concepts/plans/>
- SQLMesh **environments**: <https://sqlmesh.readthedocs.io/en/stable/concepts/environments/>
- SQLMesh **change categories** (breaking / non-breaking / forward-only / indirect / metadata): <https://sqlmesh.readthedocs.io/en/stable/concepts/plans/#change-categories>
- SQLMesh **table diff**: <https://sqlmesh.readthedocs.io/en/stable/guides/tablediff/>

## Feature inventory (dbt Cloud IDE + SQLMesh CLI/UI)

| #  | Capability in the source UI | Source |
|----|-----------------------------|--------|
| 1  | Author SQL models with `ref()` / `source()` lineage | dbt IDE |
| 2  | Per-model materialization (view / table / incremental / ephemeral) | dbt IDE |
| 3  | Incremental unique key / merge strategy | dbt IDE |
| 4  | Generic column tests (not_null, unique, accepted_values, relationships) | dbt IDE |
| 5  | Source declarations (`sources.yml`) + descriptions | dbt IDE |
| 6  | Generated project files preview (`dbt_project.yml`, `profiles.yml`, models, schema.yml) | dbt IDE |
| 7  | Run commands (`deps`, `seed`, `run`, `build`, `test`, `snapshot`, `docs generate`) | dbt IDE |
| 8  | Model DAG / lineage graph | dbt IDE (Lineage) |
| 9  | `state:modified` deferred comparison against a deployed manifest | dbt CLI |
| 10 | **Virtual data environments** (an environment is a view swap over shared physical tables) | SQLMesh |
| 11 | **`plan <env>`** — preview before anything is written | SQLMesh |
| 12 | **Change categorization** — BREAKING / NON_BREAKING / FORWARD_ONLY / INDIRECT_BREAKING / INDIRECT_NON_BREAKING / METADATA | SQLMesh |
| 13 | **Indirectly-modified downstream set** per change | SQLMesh |
| 14 | **Missing-interval / backfill preview** on the plan | SQLMesh |
| 15 | **`apply`** — view swap + only the required backfill | SQLMesh |
| 16 | **`run <env>`** — execute the models whose cron cadence is due | SQLMesh |
| 17 | **`table_diff`** — column added/removed/retyped + row counts between two environments | SQLMesh |
| 18 | Per-model cron cadence + owner metadata | SQLMesh `MODEL(...)` |
| 19 | Audits (SQLMesh's equivalent of dbt generic tests) | SQLMesh |
| 20 | Environment list with plan id / expiry / model count | SQLMesh state store |
| 21 | Production safety prompt before applying to `prod` | SQLMesh CLI prompt |
| 22 | Plan/apply history + who applied what | dbt Cloud run history / Tobiko Cloud |

## Loom coverage

Backends: `POST /api/transform/{plan,apply,run,diff,environments}` →
`loom-transform-runner` ACA app (dbt-core **and** SQLMesh + ODBC Driver 18),
managed-identity auth, internal ingress. Plan history →
`loom-transform-plans` (Cosmos) + `_auditLog`.

| #  | Loom coverage | Status | Backend per control |
|----|---------------|--------|---------------------|
| 1  | Build tab — model list + `ref()`/`source()` multi-select pickers; Monaco SQL body | ✅ | client model → `transform-codegen` |
| 2  | Materialization dropdown (layer-defaulted) | ✅ | codegen `{{ config(materialized=…) }}` / `MODEL(kind …)` |
| 3  | Unique-key field shown for incremental models | ✅ | codegen `unique_key` / `INCREMENTAL_BY_UNIQUE_KEY` |
| 4  | Column tests on the model inspector | ✅ | dbt `schema.yml` / SQLMesh `AUDIT(...)` |
| 5  | Source nodes with group / schema / table / description | ✅ | dbt `sources.yml` / SQLMesh `external_models.yaml` |
| 6  | **Generated files** tab renders every real file that is sent to the runner | ✅ | `generateTransformProject()` |
| 7  | Run step — the canonical dbt command list (allow-listed, no freeform string) | ✅ | `POST /api/transform/run` → runner `/run` |
| 8  | **Model DAG** tab on `canvas-node-kit` (compact nodes, ≤1 badge, hover actions, `CanvasRightRail`, `SplitPane` + `ResizableCanvasRegion`) | ✅ | `buildTransformDag()` / `layoutTransformDag()` |
| 9  | dbt plan = compile + diff the fresh `target/manifest.json` against the deployed-state manifest | ✅ | runner `dbt_engine.plan()` |
| 10 | Environment picker merges the project's declared environments with the engine's REAL state store | ✅ | `POST /api/transform/environments` |
| 11 | **Plan** button — writes nothing, returns the impact grid | ✅ | runner `sqlmesh_engine.plan()` (`Context.plan(auto_apply=False)`) |
| 12 | Impact grid **Impact** column shows the shared severity + the engine's own category string | ✅ | `parseSqlMeshPlan()` / `severityFromSqlMeshCategory()` |
| 13 | Impact grid **Downstream** column + the DAG blast-radius overlay | ✅ | `plan.indirectly_modified` / dbt `child_map` |
| 14 | Backfill-interval badges on the plan summary | ✅ | `plan.missing_intervals` |
| 15 | **Apply** — SQLMesh view swap + backfill; dbt `deps` + `build` (stated plainly) | ✅ | `POST /api/transform/apply` |
| 16 | Run against a SQLMesh environment's cadence | ✅ | runner `Context.run(environment=…)` |
| 17 | **Diff** — column added/removed/retyped + row counts | ✅ | `POST /api/transform/diff` → `Context.table_diff()` |
| 18 | Cadence + owner pickers on the model inspector; carried into the asset record | ✅ | `MODEL(cron …, owner …)` |
| 19 | Audits generated from the visual test picker (not_null / unique / accepted_values) | ✅ | `audits/loom_audits.sql` |
| 20 | Environment list shows name, prod flag, materialized model count, and "not created yet" | ✅ | `state_reader.get_environments()` |
| 21 | Production apply requires an explicit checkbox **and** a server-side `confirmProd` (409 otherwise) | ✅ | `/api/transform/apply` |
| 22 | **History** tab — every plan previewed and every apply authorized, with who + the exact impact rows | ✅ | `loom-transform-plans` + `_auditLog` |

**Zero ❌.** The only non-functional state is the honest gate on
`LOOM_TRANSFORM_RUNNER_URL` (`svc-transform-runner`, registered in the gate
registry with a Fix-it) — and even then Build, Generated files, Model DAG, and
History render in full.

## Deltas vs the source UIs (deliberate, stated)

| Delta | Why |
|-------|-----|
| dbt-backed projects get **no** virtual environments and **no** cross-environment table diff | dbt genuinely has neither. The wizard says so and the `/diff` route answers 409 naming the remedy (switch the engine) rather than fabricating a diff. |
| No dbt Cloud "Develop" web terminal | Loom's Build tab + Generated files preview + allow-listed command picker cover authoring without shipping a shell into the VNet. |
| No Tobiko Cloud / dbt Cloud run history SaaS | Plan/apply history is Loom-native in the deployment's own Cosmos — required for IL5, and the audit evidence lives with the rest of the estate's `_auditLog`. |

## Sovereignty (IL5 / disconnected)

Both engines are OSS Python on ACA with internal ingress, inside the
deployment's own VNet, against customer-owned Synapse / Databricks / ADLS.
SQLMesh state lives in the target engine's own `sqlmesh_state` schema; plan
history lives in the deployment's own Cosmos. **No dbt Cloud, no Tobiko Cloud,
no external control plane** — the whole plan/apply/diff capability runs
air-gapped in an IL5 enclave. DuckDB-over-ADLS is the in-boundary engine for a
fully disconnected enclave with no SQL warehouse.

## Related

- `docs/fiab/parity/dbt-job.md` (if present) — the pre-N4 dbt-only item, still
  supported and unchanged.
- L6 dbt manifest lineage (`apps/fiab-console/lib/dbt/dbt-manifest-lineage.ts`)
  — N4 surfaces `target/manifest.json` in exactly the shape L6 already parses;
  the parser is **not** forked.
