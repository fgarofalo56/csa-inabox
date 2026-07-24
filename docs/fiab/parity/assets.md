<!-- parity-doc-meta
Reviewed-on: 2026-07-23
Validated-against:
  - apps/fiab-console/app/assets/page.tsx
  - apps/fiab-console/lib/components/assets/assets-canvas.tsx
  - apps/fiab-console/lib/components/assets/freshness-policy-editor.tsx
  - apps/fiab-console/lib/assets/asset-graph.ts
  - apps/fiab-console/lib/assets/asset-registry.ts
  - apps/fiab-console/lib/assets/freshness.ts
  - apps/fiab-console/lib/assets/reconciler-core.ts
  - apps/fiab-console/lib/assets/materialize.ts
  - apps/fiab-console/lib/assets/asset-signals.ts
  - apps/fiab-console/lib/azure/asset-registry-model.ts
  - apps/fiab-console/app/api/assets
  - apps/fiab-console/app/api/internal/assets/reconcile/route.ts
  - platform/fiab/bicep/modules/admin-plane/asset-reconciler-job.bicep
-->

# assets — parity with **Dagster software-defined assets** (semantics only)

> **Scope note.** N5 adopts Dagster's *software-defined asset* SEMANTICS
> natively — asset keys, declared deps, freshness policies, data-aware
> (upstream-changed) scheduling, and materialize — with **NO Dagster runtime**
> anywhere in the deployment. There is no Dagster daemon, no dagster-webserver,
> no code location, and no Dagster Cloud. The scheduler is a Loom Container App
> Job; the materializers are the Synapse / Databricks / SQLMesh clients Loom
> already ships. There is **no Microsoft Fabric analog and no Fabric
> dependency**: the graph is derived from Azure-native lineage and
> `LOOM_DEFAULT_FABRIC_WORKSPACE` is never read (OneLake paths are explicitly
> excluded from the signal reader).

**Surface:** `/assets` (rail: Analyze → Assets).
**FLAG0:** `n5-assets-canvas` (canvas), `n5-asset-reconciler` (worker) — both
default-ON.

Source UIs / concepts:

- Dagster **software-defined assets**: <https://docs.dagster.io/concepts/assets/software-defined-assets>
- Dagster **asset graph / global asset lineage**: <https://docs.dagster.io/concepts/webserver/ui#global-asset-lineage>
- Dagster **freshness policies**: <https://docs.dagster.io/concepts/assets/asset-checks/freshness-checks>
- Dagster **declarative automation / auto-materialize**: <https://docs.dagster.io/concepts/automation/declarative-automation>
- Delta transaction log (the data-change signal): <https://learn.microsoft.com/azure/databricks/delta/history>
- Event Hubs Capture (the streaming signal): <https://learn.microsoft.com/azure/event-hubs/event-hubs-capture-overview>

## Feature inventory → Loom coverage

| #  | Capability in the source concept/UI | Loom | Backend |
|----|--------------------------------------|------|---------|
| 1  | Asset key — a stable, engine-neutral identifier per data artifact | ✅ `assetKeyFromIdentity` (`table:` / `path:` / `item:` / `model:` / `source:`) | derived from unified-lineage's collapsed identity |
| 2  | Declared upstream deps per asset | ✅ derived, never hand-authored | `deriveAssetGraph` over `getUnifiedLineage` (Purview/Atlas + Unity Catalog + Weave) |
| 3  | Deps inferred from column-level lineage | ✅ a column→column mapping yields a table-grain dep (`via: column-mapping`) | `ThreadEdge.columnMappings` / UC `system.access.column_lineage` / Purview `columnEdges`, via `synthesizeColumnGraph` |
| 4  | Ops/jobs distinct from assets (an op materializes an asset) | ✅ process contraction — notebook/job/pipeline nodes become `producedBy` + `dep.via`, never assets | `isProcessNode` + the contraction pass |
| 5  | Global asset lineage graph UI | ✅ `/assets` canvas (canvas-node-kit nodes, layered layout, minimap, shared right rail) | `GET /api/assets/lineage` |
| 6  | Asset catalog / list with filters | ✅ status + group + text filters, KPI rollup band | `GET /api/assets` |
| 7  | Asset detail pane (key, group, owners, tags, columns, upstream, last run) | ✅ docked inspector | same snapshot as the canvas |
| 8  | Asset groups / medallion grouping | ✅ `group` from the medallion layer or the lineage source | derived |
| 9  | Owners + tags on an asset | ✅ carried through from the N4 `TransformAsset` descriptor | `lib/transform/transform-dag.ts` |
| 10 | Freshness policy (cadence + tolerated lateness) | ✅ dropdown-only editor: cadence, grace, mode, alert severity | `PUT /api/assets/freshness` → `loom-assets` (Cosmos) |
| 11 | Freshness status (fresh / late / never) | ✅ `fresh` / `stale` / `overdue` / `never` / `unmanaged`, boundary-pinned | `lib/assets/freshness.ts` (pure) |
| 12 | Freshness alerting | ✅ overdue assets alert at the declared severity | O1 `dispatchAlert` → `LOOM_ALERT_ACTION_GROUP_ID` (one shared action group) |
| 13 | Materialize an asset on demand | ✅ Materialize action runs the REAL backing job | `POST /api/assets/materialize` → `runnerRun` (SQLMesh/dbt) \| `runPipeline` (Synapse) \| `runJob` (Databricks) |
| 14 | Auto-materialize when an upstream changes (data-aware) | ✅ `upstream-changed` / `self-changed` triggers | real Delta commit versions from `_delta_log`; Event Hubs Capture watermarks |
| 15 | Auto-materialize when an asset is late | ✅ `overdue` / `never-materialized` triggers | `planReconcile` |
| 16 | Scheduled evaluation daemon | ✅ `loom-asset-reconciler` Container App Job (default every 15 min, in-VNet, console UAMI) | `asset-reconciler-job.bicep` → `POST /api/internal/assets/reconcile` |
| 17 | Run history / last materialization + failure detail per asset | ✅ `lastRunOutcome`, `lastRunId`, `lastDetail`, `consecutiveFailures` | `loom-assets` sidecar, written by BOTH the manual and automatic paths |
| 18 | Backfill / blast-radius view | ✅ transitive `downstreamClosure` from the selected asset | pure, from the derived deps |
| 19 | Run concurrency / thrash protection | ✅ in-flight suppression + per-cadence cooldown + exponential failure backoff + a hard per-pass dispatch bound | `lib/assets/reconciler-core.ts` guards, all unit-pinned |
| 20 | Asset checks (data-quality assertions on an asset) | ⚠️ honest gap — Loom's data-quality plane (`/governance/data-quality`) owns assertions today; N5 does not duplicate it. Freshness IS implemented as a first-class check. | — |
| 21 | Partitions / partitioned assets | ⚠️ honest gap — SQLMesh backfill intervals cover the transform case (N4 plan/apply); N5 tracks the asset at whole-table grain. | — |
| 22 | Multi-code-location / repository management | ➖ N/A — there is no external orchestrator runtime to register code locations with. | — |

**Zero ❌.** Rows 20/21 are stated gaps with the surface that owns them today,
not stub banners; row 22 does not apply to a runtime-free adoption.

## Backend per control

| Control | Call |
|---------|------|
| Page load (graph) | `GET /api/assets/lineage` → `getAssetRegistry` → `getUnifiedLineage` × bounded roots + `buildTransformDag` per transformation project |
| KPI band + incident lists | `GET /api/assets/status` |
| Asset list / filters | `GET /api/assets` |
| Freshness policy read | `GET /api/assets/freshness` (also returns the dropdown option sets) |
| Save policy | `PUT /api/assets/freshness` → `saveAssetPolicy` → Cosmos `loom-assets` + `_auditLog` row + `emitAuditEvent` |
| Materialize (SQLMesh/dbt) | `POST /api/assets/materialize` → `runnerRun` on `LOOM_TRANSFORM_RUNNER_URL` |
| Materialize (Synapse) | `runPipeline(name)` — Synapse Studio dev REST `createRun` |
| Materialize (Databricks) | `runJob(jobId)` — `jobs/2.1 run-now`, Entra token, idempotency token |
| Reconciler pass | `POST /api/internal/assets/reconcile` (internal token) from the ACA Job |
| Data signals | `listDeltaVersions` on `_delta_log`; `listPaths` newest-object watermark |
| Overdue alert | `dispatchAlert` → the ONE shared action group |

## Honest gates

| Gate | Behaviour |
|------|-----------|
| A lineage source is unconfigured (Purview / Unity Catalog) | The gate text is surfaced verbatim in a MessageBar and **the graph still renders from every other source**. Weave (Cosmos) has no infra gate, so a deployment always has a graph. |
| No materializer bound | Materialize is disabled with a tooltip naming what to bind; the reconciler reports `no-materializer` rather than silently skipping. |
| `LOOM_TRANSFORM_RUNNER_URL` unset | `svc-transform-runner` gate text, 503 with `gated: true`. Everything else on the page keeps working. |
| Synapse / Databricks unconfigured | The existing `synapseConfigGate` / `databricksConfigGate` message, naming the exact env var. |
| Empty estate | Guided `EmptyState` with two CTAs — never sample assets. |

## Sovereign / IL5

Fully in-boundary. Policies live in this deployment's Cosmos; data versions are
read from the `_delta_log` in the customer's own ADLS Gen2; streaming watermarks
come from the deployment's own Event Hubs Capture landing path; materialization
runs on the customer's own Synapse / Databricks / transform-runner Container App;
alerts go to the deployment's own Azure Monitor action group. There is no SaaS
orchestrator control plane (no Dagster Cloud), no Fabric, and no Power BI in any
path, so the **full capability runs disconnected in an IL5 air-gapped enclave**.
Commercial / GCC-High / IL5 behaviour is identical.
