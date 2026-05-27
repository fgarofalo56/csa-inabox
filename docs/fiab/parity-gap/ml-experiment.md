# ml-experiment — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/ml-experiment/new` (the /new pattern is not appropriate here because experiments are identified by name/id, not Cosmos-backed; an experiment must be referenced)
**Fabric reference**: ai.azure.com → Jobs/Experiments — run list, run detail with metrics chart, parameters table, artifacts pane, parallel-coordinates, scatter
**Loom screenshot**: `temp/parity/ml-experiment-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/ml-experiment` (list) | 200 | 0 jobs, 0 experiments (empty hub) |
| `GET /api/items/ml-experiment/new` | **404** | `{"ok":false,"error":"No job or experiment named \"new\""}` — Loom UI renders "Load failed" MessageBar |

The editor crashes into "Load failed — No job or experiment named 'new'" because the URL pattern `/new` doesn't map to an existing experiment. The runs tree is empty.

## Phase 3 — Fabric vs Loom

| Fabric element | Loom present? | Severity |
|---|---|---|
| Runs left rail (status badge per run) | YES (but empty here) | — |
| Run detail: Overview / Metrics / Parameters / Outputs / Logs / Snapshot tabs | partial — Loom shows flat metrics key/value table only | MAJOR |
| **Metric charts** (line per metric over steps; multi-run overlay) | NO | BLOCKER |
| **Parallel coordinates** ribbon — button visible but dead | button visible (no onClick logic) | MAJOR |
| **Scatter** ribbon — button visible but dead | button visible (no onClick logic) | MAJOR |
| Compare runs (multi-select + diff) | NO | MAJOR |
| Register model from a run | "Register model" button visible but dead | MAJOR |
| Artifacts file browser | NO | MAJOR |
| Log streaming pane | NO | MAJOR |
| Compute / environment / Docker info | NO | MAJOR |

## Functional

- "New ml experiment" URL crashes because no experiment named "new" exists
- Reload button reloads the same /new ID → infinite "Load failed"
- 3 ribbon actions ("Register model", "Parallel coordinates", "Scatter") are all dead — no click handler in source

## Grade — **F**

`/new` is fundamentally broken for this slug because experiments are read-only history aggregates. The editor renders "Load failed" and several dead ribbon buttons that LOOK like Fabric features. **Grade F** (vaporware buttons + broken create flow).

Recommendation: the slug should not be wired as a `/new` flow at all — should be a list view at `/items/ml-experiment` (no `/new`) → click a row → open detail.
