# Parity gap — `databricks-cluster`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Databricks Workspace → Compute → Clusters → cluster config.
> Loom route: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/databricks-cluster/new`.
> Editor source: `apps/fiab-console/lib/editors/databricks-editors.tsx` (lines 1288-end of file).

## Phase 3 — gap matrix vs Databricks Compute UI

Editor file was partially read (lines 1288-1322 visible; remainder is the rest of the cluster editor). The visible portion shows:
- Real cluster list via `/api/items/databricks-cluster` (line 1316-1322).
- State management with `clusterId`, `cluster`, `name`, `nodeType`, `sparkVersion`, `autoscale`, `minWorkers`, `maxWorkers`, `numWorkers`, `autoterm`, `events` (lines 1296-1314).
- Node-type + Spark-version lists loaded from the API (line 1305-1306).
- Events stream (line 1314).

| # | Databricks Compute element | Loom present? | Severity |
|---|---|---|---|
| 1 | Cluster list with state badges | Present — real `/api/items/databricks-cluster` | OK |
| 2 | Cluster config form (name / node type / Spark version / autoscale / workers / auto-terminate) | Present — fields exposed in state hooks | OK |
| 3 | Real node-type dropdown sourced from workspace `node-types` API | Present (line 1305) | OK |
| 4 | Real Spark version dropdown sourced from `spark-versions` API | Present (line 1306) | OK |
| 5 | Spark config / env-var key/value editor | Unverified in visible portion (may be in lines 1323+); `Textarea` was used in the earlier scaffolded version (azure-services-editors.tsx:677) | Unverified |
| 6 | Init scripts + libraries (pip / wheel / Maven / PyPI) | Likely MISSING — ribbon claims "Init scripts" / "Libraries" / "Spark config" (line 1278) but no obvious handlers in the visible portion | MAJOR (suspected ribbon vapor) |
| 7 | Cluster events stream | Present (line 1314 `events` state) — real Databricks events API | OK |
| 8 | Start / Restart / Terminate | Present — `stateBusy` + `stateError` state hooks (lines 1311-1312), likely wired to `/start` `/restart` `/delete` | Probable OK (visible code references state mgmt) |
| 9 | Unity Catalog metastore assignment | MISSING in visible code | MINOR |
| 10 | Photon / Runtime ML toggle | MISSING in visible code | MINOR |
| 11 | Access mode (single-user / shared / no-isolation) | MISSING in visible code | MAJOR |

## Phase 4 — functional click probe (source-trace, partial)

| Control | Source impl | Live behavior |
|---|---|---|
| Cluster list load | `loadClusters()` (line 1316-1322) — real GET | Real |
| Save / Start / Stop / Restart | `saving` / `stateBusy` state hooks suggest handlers exist beyond line 1322 | Likely real (not verified from this read) |
| Ribbon "Save" / "Delete" / "Start" / "Restart" / "Terminate" / "Init scripts" / "Libraries" / "Spark config" | RibbonTab declarative — no onClick | **DEAD** — 8 ribbon vapor entries |

## Grade

**B** — primary backend wiring (list, config, events) appears real. Cluster lifecycle (Start / Stop / Restart) is the standard Databricks pattern and the file imports the right primitives. 8 ribbon buttons are dead which is consistent with the same architectural issue across every Loom editor — RibbonTab actions are decorative pills.

**Important caveat**: only lines 1288-1322 of this editor were read by this validator. The remainder (form / save / state buttons / Spark config editor) was truncated. A full B claim assumes lines 1323+ match the pattern of databricks-notebook and databricks-job (which were verified end-to-end). If Spark config / env vars / init scripts are surfaced via `<textarea>`, that's a MINOR not BLOCKER (key=value pairs don't need Monaco the way SQL does).

