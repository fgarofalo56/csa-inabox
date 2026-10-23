# L6 — Data Plane & Backends

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 1
**Rigor:** FULL mutation-proof (data)
**Suggested concurrency:** up to **4** agents in this lane simultaneously.
**Inventory:** **34 open issues** (16 bugs, 3 epics, 0 labelled security).

## 1. Thesis

Azure-native parity is the product. Every capability must work with NO real Fabric tenant and identically in every sovereign boundary.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `apps/fiab-console/lib/azure/**`
- `apps/loom-*/**`
- `apps/fiab-*/** (excluding fiab-console)`
- `domains/**`
- `csa_platform/**`
- `azure-functions/**`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `apps/fiab-console/app/** (L3/L4/L5)`
- `apps/fiab-console/lib/auth/** (L1)`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `pnpm vitest run <client suites>`
- `make validate-python`
- `make test-dbt where dbt is touched`
- `a real backend response in the receipt — no mock arrays, no `return []``

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- No capability may hard-depend on real Microsoft Fabric. `fabricWorkspaceId` reads need an Azure-native fallback in the SAME function.
- Databricks Unity Catalog does NOT exist in Azure Government — Loom Unity IS the catalog story there, so Commercial-only is INCOMPLETE, not 'Commercial-first'.
- A capability that works in Commercial and not in Gov is incomplete. Per-cloud receipts or the claim is unstated.
- Iceberg 500s traced UPSTREAM, not to the overlay — verify which layer before filing.

## 5. Fan-out plan

1. **Triage pass first (1 agent, sp:1).** Walk the inventory in §7 and split it into
   `real` / `stale` / `duplicate` / `already-fixed`. Verify "already-fixed" by measurement
   — several issues in this repo claim a current failure that is no longer true, and
   several claim a fix that never deployed. Record the verdict as an issue comment.
2. **Batch the survivors by shared file.** Two items touching the same file become ONE
   work item, or they run sequentially. This is the step that prevents the merge
   treadmill, and it is where most of the wall-clock is won or lost.
3. **Fan out to 4 concurrent agents**, each in its own worktree, each owning a
   disjoint file set from step 2.
4. **Serialize the merges.** Branch protection is `strict`, so every merge invalidates
   the branches behind it. Merge one, re-verify, merge the next. Prefer batching several
   fixes per PR over one PR per issue: with strict protection, N PRs cost N CI cycles.

## 6. Definition of done for this lane

- Every §7 issue is closed, or re-scoped with its reason recorded, or explicitly deferred
  by the operator.
- Every closure is on DEPLOYED-and-verified evidence, never on a merge.
- No guard introduced by this lane passes when its subject is mutated.
- The lane's own landmine list in §4 has been extended with anything new it learned.

## 7. Issue inventory (34)

| # | title | labels |
|---|---|---|
| #3878 | cosmos-items: two response-envelope conventions interleaved under /api/ — 7 dead `j.ok` reads across 4 editors |  |
| #3841 | Gov: OSS Unity federation returns zero metastores — loom-unity workspace errors, and the message asserts 'unre |  |
| #3775 | OpenSharing management plane: shares, recipients, network policies, cross-boundary approval (Delta Sharing 202 | csa-feature-request,csa-loom,enhancement,lane:dataplane,spri |
| #3773 | EPIC — Loom Connect: managed ingestion connector hub (Lakeflow Connect parity, exceeds via ADF connector libra | csa-feature-request,csa-loom,enhancement,epic,lane:dataplane |
| #3772 | EPIC — Analysis Spaces: curated NL data-analysis rooms over warehouse/lakehouse/eventhouse (Genie parity) | csa-feature-request,csa-loom,enhancement,epic,lane:console,s |
| #3771 | EPIC — Loom Agent Foundry: declarative agent builder with eval-driven auto-optimization (Agent Bricks parity,  | csa-feature-request,csa-loom,enhancement,epic,lane:dataplane |
| #3769 | Notebook platform 2026 bundle: runtime selector, custom live pools, Event Hubs streaming source, AI error diag | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3767 | Pipeline designer: dbt as an in-canvas activity type (Fabric 2026 parity) | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3766 | Mirroring: change-feed export to Event Hubs (Fabric June 2026 'Mirrored DB change feed connector' parity) | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3737 | admin/usage 'Most active items' table never resolves Type/Workspace — Unity Catalog/system audit noise dominat | bug,csa-loom,lane:console,sprint:next |
| #3728 | fix(api): /api/items 504s at the edge for lakehouse + warehouse — unpaginated, returns every item | lane:console,sprint:next |
| #3719 | databricks-pipeline (Lakeflow/DLT): 31 missing capability rows, the worst breadth gap in the catalog, untracke | csa-loom,enhancement,lane:console,sprint:next |
| #3718 | lakehouse-shortcut: 13 freeform ARM/path sites (largest untracked footprint in the item catalog) | bug,csa-loom,lane:console,sprint:next |
| #3697 | Canvas collaboration endpoints 404 on every canvas open — comments, presence and collab/stream are non-functio | bug,lane:console,sprint:active |
| #3694 | auto-bind: eventstream, kql-database and lakehouse carry the same #3549 empty-backing-resource shape | bug,lane:console,sprint:next |
| #3688 | P0: the entire Power Platform family (6 item types + Copilot Studio) is blocked by ONE missing Dataverse Appli | bug,csa-loom,lane:dataplane,sprint:active |
| #3669 | Layer 1 on databricks-sql-warehouse is a floor, not a bound — needs a server-attested item→warehouse binding + | bug,csa-loom,lane:console,sprint:next |
| #3668 | databricks-sql-warehouse: 10 routes still take a caller-supplied warehouseId with session-only auth (GHSA-v2g8 | bug,csa-loom,lane:console,sprint:active |
| #3640 | Post-exposure rotation remainder: RisingWave root password, DuckLake DSN, and two inert vault entries that nee | lane:dataplane,sprint:next |
| #3586 | auto-bind: the migrate page asks for a Databricks workspace URL that listDatabricksWorkspaces() already enumer | bug,lane:console,sprint:next |
| #3571 | loom-duckdb serving tier cold start exceeds client's 20s timeout — first query in a session fails | bug,lane:dataplane,sprint:next |
| #3570 | spark-job-definition: red 'Operation failed — spec.pool is not configured' error shows on first open of a fres | bug,lane:console,sprint:next |
| #3549 | P0: data-pipeline activities are silently empty for the vast majority of pipelines in the factory — core orche | lane:dataplane,sprint:active |
| #3546 | Streaming SQL 'Materialize' reproducibly times out live; generic timeout message asserts an unverified cause ( | lane:dataplane,sprint:next |
| #3538 | Lakehouse ribbon missing 'Update all variables' action (Fabric parity gap) | csa-loom,enhancement,lane:console,sprint:next |
| #3537 | Real-Time Dashboard tiles fail with 'table not resolved' even though the exact same query succeeds directly in | bug,csa-loom,lane:dataplane,sprint:next |
| #3530 | App-installed notebooks fail on Run with ModuleNotFoundError — no Spark environment/libraries attached by defa | bug,csa-loom,lane:dataplane,sprint:next |
| #3522 | feature-table editor requires typing catalog/schema/table names by hand instead of reusing the existing Unity  | bug,csa-loom,lane:console,sprint:next |
| #3517 | stream-analytics output wiring shows Loom's own known resource names as placeholders instead of defaulting/sel | bug,csa-loom,lane:console,sprint:next |
| #3511 | mirrored-database requires hand-typed source table list; could auto-discover via information_schema.tables | bug,csa-loom,lane:dataplane,sprint:next |
| #3351 | Agentic retrieval (AI Search) + Cosmos DB vector as first-class RAG backends | csa-feature-request,csa-loom,lane:dataplane,sprint:next |
| #3339 | Iceberg external-engine federation returns 403 in the UI — root cause unproven | csa-bug,csa-loom,lane:dataplane,sprint:next |
| #2626 | LU-8: live E2E receipt for the OpenLineage emitters (G1) — operator walk | lane:dataplane,sprint:blocked |
| #1483 | FEATURE (backlog): multi-library domain designer + federated data-mesh — Federal Civ / Defense & IC / Public S | lane:console,sprint:blocked |

